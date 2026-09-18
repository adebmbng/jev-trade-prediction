# Jev Trade

Mobile-first BTCUSDT / ETHUSDT dashboard: live candles, 5m opening-price sections, technical indicators, backend heuristic forecasts, and browser-local paper positions.

## Run

Node.js 22.12+ (24 recommended), pnpm 9+:

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173. The API runs at http://127.0.0.1:3001. Binance must be reachable from both your browser and server; unavailable feeds pause entries and predictions rather than generating prices.

Feeds use Binance's official public-market-data endpoints: `https://data-api.binance.vision` and `wss://data-stream.binance.vision` (standard port 443). These avoid the general trading API hostname and port 9443. See [Binance public-data documentation](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md).

```sh
pnpm test
pnpm lint
pnpm build
pnpm exec playwright install chromium
pnpm test:ui
pnpm start
```

After building, `pnpm start` serves both web and API on port 3001. Optional variables are in `.env.example`; export them or start with `node --env-file=.env --import tsx apps/api/src/index.ts`. For deployment, use HTTPS and disable proxy buffering on `/api/predictions/stream`. Default binding is local; set `HOST=0.0.0.0` when deploying.

## Docker Compose deployment

On a server with Docker Engine and the Compose plugin installed, copy this repository and run:

```sh
docker compose up -d --build
docker compose logs -f app
```

Open `http://SERVER_IP:8080` (or `http://localhost:8080` locally). One container serves both the built frontend and the API, including SSE. No database or volume is required; positions remain in each visitor's browser. Changing domain or port uses a different browser storage location.

Optional `.env` settings: `APP_PORT=8080`, `BIND_ADDRESS=0.0.0.0`, and the Binance overrides in `.env.example`. The container always listens on port 3001 internally.

For a public domain, place an HTTPS reverse proxy in front of port 8080. When the proxy runs on the same host, set `BIND_ADDRESS=127.0.0.1`. Disable response buffering and allow long connections for `/api/predictions/stream`; the backend also sends `X-Accel-Buffering: no`. Browser WebSocket connections go directly to Binance. Set `TRUSTED_PROXIES` to the proxy IP/CIDR as seen by the container (comma-separated if needed), and have the proxy set `X-Forwarded-For`, so client limits apply to individual visitors. Leave this unset for direct access; only trust your own proxy addresses.

After updating source, rerun `docker compose up -d --build`. Check health with `docker compose ps` and `curl http://localhost:8080/api/health`. Container health checks API availability; inspect `feeds` for Binance status. Stop with `docker compose down`.

## Structure

- `apps/web`: React, mobile UI, direct Binance feed, Lightweight Charts, local positions.
- `apps/api`: Fastify, shared server feeds, bounded SSE clients, heuristic provider.
- `packages/shared`: aggregation, indicators, forecasting, position math, chronological replay.
- `tests`: deterministic core tests and a browser test with explicitly mocked market data.

The frontend derives 5s/30s candles from 1s klines and uses native 1m/5m history. Gold horizontal segments mark each 5m opening; dotted vertical lines mark its boundaries. Chart controls do not change the 5m analysis timeframe.

Predictions cover rolling +5s/+30s/+1m/+2m/+5m horizons. The backend refreshes all five heuristic forecasts every 5 seconds. Each refresh gets a new reference price and target timestamp. Strength is an uncalibrated heuristic score.

## Jev recommendation

Set `TYPESAFE_API_KEY` on the API server (or in `.env` for Compose) and restart. The separate **Jev recommendation** section uses TypeSafe's `jev-latest` via `POST /v1/systemone`. The key never goes to the browser. Without a key, the section shows a configuration message and the heuristic dashboard still works.

Jev receives the preceding 300 continuous closed 1s candles compressed into 5s OHLCV bars, exact 5/30/60/120/300-second percentage changes, the current reference price, and all existing technical indicators from closed 5m history. Its objective is a 60–120 second paper scalp. `JEV_LEVERAGE` defaults to 100 and is included in the prompt and state: every price move is treated as material, with raw percentage changes translated into approximate gross margin impact before costs. After entry it also receives the position side, entry, age, raw return, leveraged impact, and observed price extreme/giveback. It selects long/short/wait before entry and exit/wait afterward. Short exits are labeled buy to cover. The expanded section shows all supplied indicators.

Jev returns typed judgments, not generated prose. Sarcastic commentary is assembled locally from its decision and measured trade facts, with no additional text-generation model. Confidence is model answer concentration, not a validated trading success probability. At 100×, a roughly 1% adverse raw move can consume the initial margin before maintenance margin, fees, funding, and liquidation mechanics; the app does not model those mechanics or place orders. Trading costs and order-book information are unavailable.

If a paper position takes the opposite side from Jev's last pre-entry long/short call, the position card shows a sarcastic mismatch note. That note uses the retained previous call while the post-entry Jev request is refreshing, then clears when the matching result arrives.

The browser requests Jev while its feed is fresh, immediately on entry or symbol change and then every 15 seconds after completion. The UI keeps the last successful call visible with a spinner and previous-call label while the replacement is in flight; a result from another symbol or position is never presented as current. The server coalesces identical in-flight requests and caches for 15 seconds from the market snapshot, validates answers, times out after 6 seconds, and imposes a global 12-call/minute cap per process with a 30-second cooldown after errors. No automatic retries within a request. Each request contains one judgment. Expired results and incomplete/stale feeds cannot be presented as current recommendations. Limits are request caps, not currency budgets; multiple server replicas multiply the cap. A public deployment should add authentication if access must be restricted.

TypeSafe's project skill is installed in `.agents/skills/typesafe-ai`; `AGENTS.md` directs future integration work to it. API reference: https://docs.typesafe.ai/api.md.

Positions are paper trades, one per symbol, stored in localStorage. Return excludes fees/slippage. Observed favorable extremes can miss disconnected periods. Closing removes the local open position; there is no order execution or trade-history database.

`replay()` accepts historical 1s candles plus preceding 5m warm-up history, and reports per-horizon coverage, accuracy, momentum/neutral baselines, and hypothetical returns after costs. No real-market validation or parameter optimization has been claimed. Signals can be wrong, especially over five seconds.

Data references: [Binance WebSocket](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams), [Binance REST](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints). Charts use [TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/docs).
