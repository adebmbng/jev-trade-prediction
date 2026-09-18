import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import serveStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SYMBOLS,
  connectMarket,
  emptyMarket,
  type SymbolName,
} from "../../../packages/shared/src/market";
import {
  HeuristicProvider,
  type Forecast,
} from "../../../packages/shared/src/analysis";
import type { ServerResponse } from "node:http";
import { JevService } from "./jev";
import type { Position } from "../../../packages/shared/src/analysis";
const app = Fastify({
  logger: true,
  trustProxy: process.env.TRUSTED_PROXIES
    ? process.env.TRUSTED_PROXIES.split(",").map((value) => value.trim())
    : false,
});
await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });
const provider = new HeuristicProvider();
const jev = new JevService();
const markets = new Map(SYMBOLS.map((s) => [s, emptyMarket(s)]));
const clients = new Map<ServerResponse, SymbolName>();
const clientIps = new Map<ServerResponse, string>();
const snapshots = new Map<SymbolName, Forecast>();
const stops = SYMBOLS.map((s) =>
  connectMarket(s, (m) => markets.set(s, m), {
    rest: process.env.BINANCE_REST,
    ws: process.env.BINANCE_WS,
  }),
);
app.post<{ Body: { symbol: SymbolName; position?: Position } }>(
  "/api/jev",
  {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["symbol"],
        properties: {
          symbol: { type: "string", enum: [...SYMBOLS] },
          position: {
            type: "object",
            additionalProperties: false,
            required: ["symbol", "side", "entryPrice", "openedAt", "extreme"],
            properties: {
              symbol: { type: "string", enum: [...SYMBOLS] },
              side: { type: "string", enum: ["long", "short"] },
              entryPrice: { type: "number", exclusiveMinimum: 0 },
              openedAt: { type: "number", exclusiveMinimum: 0 },
              extreme: { type: "number", exclusiveMinimum: 0 },
            },
          },
        },
      },
    },
  },
  async (request, reply) => {
    const { symbol, position } = request.body;
    if (
      position &&
      (position.symbol !== symbol ||
        position.openedAt > Date.now() ||
        (position.side === "long"
          ? position.extreme < position.entryPrice
          : position.extreme > position.entryPrice))
    )
      return reply.code(400).send({ error: "Invalid position" });
    reply.header("Cache-Control", "no-store");
    return jev.recommend(markets.get(symbol)!, position);
  },
);
function send(response: ServerResponse, f: Forecast) {
  if (response.destroyed) return;
  if (!response.write(`id: ${f.asOf}\ndata: ${JSON.stringify(f)}\n\n`))
    response.destroy();
}
const PREDICTION_REFRESH_MS = 5000;
const ticker = setInterval(() => {
  for (const s of SYMBOLS) {
    const f = provider.predict(markets.get(s)!);
    snapshots.set(s, f);
    for (const [client, symbol] of clients) if (symbol === s) send(client, f);
  }
}, PREDICTION_REFRESH_MS);
const heartbeat = setInterval(() => {
  for (const client of clients.keys())
    if (!client.write(": heartbeat\n\n")) client.destroy();
}, 15000);
app.get("/api/health", () => ({
  ok: true,
  feeds: SYMBOLS.map((s) => ({
    symbol: s,
    ready: markets.get(s)!.ready,
    ageMs: Date.now() - markets.get(s)!.updatedAt,
  })),
}));
app.get<{ Querystring: { symbol?: string } }>(
  "/api/predictions/stream",
  (request, reply) => {
    const symbol = request.query.symbol as SymbolName;
    if (!SYMBOLS.includes(symbol))
      return reply.code(400).send({ error: "Use BTCUSDT or ETHUSDT" });
    const ip = request.ip;
    const sameIp = [...clientIps.values()].filter(
      (value) => value === ip,
    ).length;
    if (clients.size >= 200 || sameIp >= 5)
      return reply.code(429).send({ error: "Too many streams" });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    clients.set(reply.raw, symbol);
    clientIps.set(reply.raw, ip);
    reply.raw.on("close", () => {
      clients.delete(reply.raw);
      clientIps.delete(reply.raw);
    });
    send(
      reply.raw,
      snapshots.get(symbol) ?? provider.predict(markets.get(symbol)!),
    );
  },
);
const root = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(root)) await app.register(serveStatic, { root });
async function shutdown() {
  clearInterval(ticker);
  clearInterval(heartbeat);
  stops.forEach((stop) => stop());
  for (const c of clients.keys()) c.end();
  await app.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await app.listen({
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "127.0.0.1",
});
