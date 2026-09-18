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
              exit: {
                choose_when:
                  "The newest micro-movement is adverse to the held side, momentum has reversed, giveback is growing, or the 60–120 second objective has elapsed.",
                sensitivity:
                  "At the configured leverage, a small adverse raw move is meaningful; a dramatic reversal is not required.",
              },
              wait: {
                choose_when:
                  "The newest micro-movement still supports the held side and no credible reversal or material giveback is visible.",
                not_for:
                  "Do not retain only because the raw movement looks small; judge its leveraged impact.",
              },
            }
          : {
              long: {
                choose_when:
                  "Upward micro-momentum is stronger than downward micro-momentum for the next 60–120 seconds.",
                evidence:
                  "Even small positive 5s/30s movement, rising recent closes, a rebound, or short-window agreement can qualify.",
                not_required:
                  "Do not require a large breakout or agreement from every slower 5m indicator.",
              },
              short: {
                choose_when:
                  "Downward micro-momentum is stronger than upward micro-momentum for the next 60–120 seconds.",
                evidence:
                  "Even small negative 5s/30s movement, falling recent closes, a rejection, or short-window agreement can qualify.",
                not_required:
                  "Do not require a large breakdown or agreement from every slower 5m indicator.",
              },
              wait: {
                choose_only_when:
                  "The recent 5s/30s/60s path is genuinely flat, alternating, or contradictory enough that neither direction is stronger.",
                not_for:
                  "Do not choose wait merely because the raw move is small, confidence is imperfect, or trading costs exist. If one side has a modest coherent micro-edge, choose that side.",
              },
            };
        const instructions = position
          ? `Choose exit or wait for this existing 60–120 second scalp at ${context.leverage}x nominal leverage. React to small adverse price changes because 0.01% raw is about ${(context.leverage * 0.01).toFixed(2)}% gross margin impact before costs. Use position side, age, raw and leveraged return, giveback, the newest 5s/30s movement, and reversal evidence. Protect margin without inventing a liquidation price.`
          : `Choose the stronger near-term direction for a 60–120 second scalp at ${context.leverage}x nominal leverage. First compare long versus short using the newest 5s and 30s movement, recent closes, and 60s/120s context. Every non-flat price change matters: 0.01% raw is about ${(context.leverage * 0.01).toFixed(2)}% gross impact before costs. Prefer the stronger directional micro-bias even when the raw move is small. Use wait only when the path is truly flat, alternating, or directionally tied—not merely uncertain. Slow 5m indicators provide context but must not veto coherent recent movement. Leverage increases impact, not predictive edge.`;
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
                  instructions,
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
