import {
  DEFAULT_JEV_LEVERAGE,
  jevContext,
  jevCommentary,
  type JevResult,
} from "../../../packages/shared/src/jev";
import type { Position } from "../../../packages/shared/src/analysis";
import type { Market } from "../../../packages/shared/src/market";

export class JevService {
  private cache = new Map<string, JevResult>();
  private pending = new Map<string, Promise<JevResult>>();
  private calls: number[] = [];
  private backoffUntil = 0;
  private leverage: number;
  constructor(
    private apiKey = process.env.TYPESAFE_API_KEY,
    private request: typeof fetch = fetch,
    private clock = Date.now,
    leverage = Number(process.env.JEV_LEVERAGE ?? DEFAULT_JEV_LEVERAGE),
  ) {
    this.leverage =
      Number.isFinite(leverage) && leverage >= 1 && leverage <= 1000
        ? leverage
        : DEFAULT_JEV_LEVERAGE;
  }

  async recommend(market: Market, position?: Position): Promise<JevResult> {
    const now = this.clock();
    const unavailable = (message: string): JevResult => ({
      symbol: market.symbol,
      asOf: now,
      expiresAt: now,
      available: false,
      message,
    });
    if (!this.apiKey)
      return unavailable(
        "Jev is not configured. Set TYPESAFE_API_KEY on the server.",
      );
    const context = jevContext(market, now, position, this.leverage);
    if (!context)
      return unavailable("Waiting for fresh, continuous five-minute history.");
    const key = JSON.stringify([
      market.symbol,
      position?.side,
      position?.entryPrice,
      position?.openedAt,
    ]);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached;
    const pending = this.pending.get(key);
    if (pending) return pending;
    this.calls = this.calls.filter((t) => now - t < 60000);
    if (this.calls.length >= 12 || now < this.backoffUntil)
      return unavailable(
        "Jev is cooling down to limit requests. Try again shortly.",
      );
    this.calls.push(now);
    const run = async (): Promise<JevResult> => {
      try {
        const criteria = position
          ? {
              exit: "Close the existing position because reversal, adverse movement or elapsed 1–2 minute objective favors exiting.",
              wait: "Briefly retain the existing position; evidence still supports its side, or is too uncertain to justify an exit judgment.",
            }
          : {
              long: "Evidence favors a near-term upward move.",
              short: "Evidence favors a near-term downward move.",
              wait: "Conflicting or insufficient evidence; no defensible directional edge.",
            };
        const response = await this.request(
          "https://api.typesafe.ai/v1/systemone",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            signal: AbortSignal.timeout(6000),
            body: JSON.stringify({
              model: "jev-latest",
              state: context,
              questions: {
                action: {
                  type: "choice",
                  instructions: `Choose the ${position ? "existing paper position's next action" : "entry"} for a 60–120 second scalp. This paper trade assumes ${context.leverage}x nominal leverage: every price change matters, and a 0.01% raw move is about ${(context.leverage * 0.01).toFixed(2)}% gross margin impact before costs. Weigh recent momentum, reversals, uncertainty, and trading costs; prioritize protecting margin from adverse moves. If present, use position side, age, raw return, leveraged impact, and giveback. Do not invent liquidation prices or treat leverage as extra predictive edge. This is a judgment, not a guaranteed forecast.`,
                  criteria,
                },
              },
            }),
          },
        );
        if (!response.ok) throw new Error("Provider unavailable");
        const body = await response.json();
        const a = body?.answers?.action;
        const probabilities = a?.probabilities;
        if (
          a?.type !== "choice" ||
          !Object.hasOwn(criteria, a.choice) ||
          typeof a.confidence !== "number" ||
          !Number.isFinite(a.confidence) ||
          a.confidence < 0 ||
          a.confidence > 1 ||
          !probabilities ||
          Object.keys(criteria).some(
            (k) =>
              typeof probabilities[k] !== "number" ||
              !Number.isFinite(probabilities[k]) ||
              probabilities[k] < 0 ||
              probabilities[k] > 1,
          ) ||
          Math.abs(
            Object.keys(criteria).reduce(
              (sum, k) => sum + probabilities[k],
              0,
            ) - 1,
          ) > 0.02
        )
          throw new Error("Invalid answer");
        if (this.clock() >= now + 15000)
          return unavailable(
            "Jev response expired; waiting for a fresh evaluation.",
          );
        const result: JevResult = {
          symbol: market.symbol,
          available: true,
          asOf: now,
          expiresAt: now + 15000,
          model: typeof body.model === "string" ? body.model : "jev-latest",
          action: a.choice,
          confidence: a.confidence,
          commentary: jevCommentary(a.choice, context),
          context,
        };
        for (const [k, v] of this.cache)
          if (v.expiresAt <= now) this.cache.delete(k);
        this.cache.set(key, result);
        return result;
      } catch {
        this.backoffUntil = this.clock() + 30000;
        return unavailable(
          "Jev is unavailable. Retrying after a short cooldown.",
        );
      } finally {
        this.pending.delete(key);
      }
    };
    const task = run();
    this.pending.set(key, task);
    return task;
  }
}
