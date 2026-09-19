import {
  indicators,
  multiTimeframeTrends,
  positionReturn,
  type Position,
} from "./analysis";
import { aggregate, type Market, type SymbolName } from "./market";

export const DEFAULT_JEV_LEVERAGE = 100;

export type JevResult = {
  symbol: SymbolName;
  asOf: number;
  expiresAt: number;
  available: boolean;
  message?: string;
  model?: string;
  action?: "long" | "short" | "wait" | "exit";
  confidence?: number;
  commentary?: string;
  context?: NonNullable<ReturnType<typeof jevContext>>;
};

// Keep the five-minute path precise enough for scalping while removing noisy
// floating-point tails from the request payload.
const compact = (value: number) => Math.round(value * 1e8) / 1e8;

export function jevContext(
  m: Market,
  now: number,
  position?: Position,
  leverage = DEFAULT_JEV_LEVERAGE,
) {
  const effectiveLeverage =
    Number.isFinite(leverage) && leverage >= 1
      ? compact(leverage)
      : DEFAULT_JEV_LEVERAGE;
  const sessionStart = Math.floor(now / 300000) * 300000;
  const sessionEnd = sessionStart + 300000;
  const sessionElapsedSeconds = compact(
    Math.max(0, (now - sessionStart) / 1000),
  );
  const sessionRemainingSeconds = compact(
    Math.max(0, (sessionEnd - now) / 1000),
  );
  const end = Math.floor(now / 1000);
  const seconds = m.seconds.filter(
    (c) => c.closed && c.time >= end - 300 && c.time < end,
  );
  const technical = indicators(
    m.five.filter((c) => c.time * 1000 + 300000 <= now),
  );
  const price = m.seconds.filter((c) => c.time * 1000 <= now).at(-1)?.close;
  if (
    !m.ready ||
    now - m.updatedAt >= 10000 ||
    m.updatedAt > now ||
    !technical ||
    !price ||
    seconds.length !== 300 ||
    seconds.some((c, i) => c.time !== end - 300 + i)
  )
    return null;
  const change = (n: number) =>
    compact((price / seconds.at(-n)!.open - 1) * 100);
  const changes = {
    s5: change(5),
    s30: change(30),
    s60: change(60),
    s120: change(120),
    s300: change(300),
  };
  const directionByWindow = Object.fromEntries(
    Object.entries(changes).map(([key, value]) => [
      key,
      value > 0 ? "up" : value < 0 ? "down" : "flat",
    ]),
  );
  const indicators5m = Object.fromEntries(
    Object.entries(technical).map(([key, value]) => [
      key,
      typeof value === "number" ? compact(value) : value,
    ]),
  );
  const timeframeTrends = multiTimeframeTrends(m.minutes).map((trend) => ({
    ...trend,
    changePct: compact(trend.changePct),
    efficiency: compact(trend.efficiency),
  }));
  return {
    symbol: m.symbol,
    asOf: now,
    objectiveSeconds: position ? [300] : [60, 120],
    decisionWindow: position
      ? {
          type: "current_5m_session",
          endAt: sessionEnd,
          remainingSeconds: sessionRemainingSeconds,
        }
      : {
          type: "near_term_scalp",
          endAt: null,
          remainingSeconds: null,
        },
    leverage: effectiveLeverage,
    price: compact(price),
    windowStart: (end - 300) * 1000,
    windowEnd: end * 1000,
    changePct: changes,
    directionByWindow,
    leveragedChangePct: Object.fromEntries(
      Object.entries(changes).map(([key, value]) => [
        key,
        compact(value * effectiveLeverage),
      ]),
    ),
    // Preserve small moves and intrabar ranges without sending 300 verbose rows.
    barColumns: ["time", "open", "high", "low", "close", "volume"],
    bars5s: aggregate(seconds, 5).map((c) => [
      c.time,
      compact(c.open),
      compact(c.high),
      compact(c.low),
      compact(c.close),
      compact(c.volume),
    ]),
    indicators5m,
    timeframeTrends,
    fiveMinuteSession: {
      start: sessionStart,
      end: sessionEnd,
      elapsedSeconds: sessionElapsedSeconds,
      remainingSeconds: sessionRemainingSeconds,
    },
    position: position
      ? {
          ...position,
          openedDuringCurrentSession: position.openedAt >= sessionStart,
          elapsedSeconds: Math.max(0, (now - position.openedAt) / 1000),
          grossReturnPct: positionReturn(position, price),
          leveragedGrossReturnPct: compact(
            positionReturn(position, price) * effectiveLeverage,
          ),
          givebackPct:
            (Math.abs(position.extreme - price) / position.entryPrice) * 100,
        }
      : null,
    limitations: `${effectiveLeverage}x nominal leverage is assumed. Leveraged percentages are rough gross margin impact before fees, spread, slippage, maintenance margin, funding, and liquidation; no liquidation engine or order book is available. Timeframe trends use closed 1m candles; indicators use closed 5m warm-up history; bars cover the last five minutes. No guaranteed future returns.`,
  };
}

export function jevCommentary(
  action: NonNullable<JevResult["action"]>,
  context: NonNullable<JevResult["context"]>,
) {
  const p = context.position;
  const move = `Last 30s: ${context.changePct.s30.toFixed(4)}% raw, about ${context.leveragedChangePct.s30.toFixed(2)}% at ${context.leverage}x before costs.`;
  if (!p)
    return `${action === "long" ? "Long bias" : action === "short" ? "Short bias" : "Wait"} for the next 1–2 minutes. ${move} ${action === "wait" ? "Apparently doing nothing is also a strategy. Shocking." : "A tiny move is still a move. Fees, tragically, also exist."}`;
  const status = `${p.side} at ${p.entryPrice}; ${p.grossReturnPct.toFixed(4)}% raw, about ${p.leveragedGrossReturnPct.toFixed(2)}% at ${context.leverage}x before costs, after ${Math.floor(p.elapsedSeconds)}s.`;
  const session = `The current 5m session ends in ${Math.ceil(context.fiveMinuteSession.remainingSeconds)}s.`;
  if (action === "exit")
    return `${p.side === "long" ? "Sell / close" : "Buy to cover / close"} now bias. ${status} Realize the position now rather than wait for the session end. The plan was a scalp, not a lifelong emotional attachment. ${move}`;
  return `Wait / hold until the current 5m session ends. ${status} Keep watching; the candle has not signed a loyalty contract. ${move} ${session}`;
}

export function jevContrarianComment(
  position: Position,
  result: JevResult | null,
): string | null {
  if (
    !result?.available ||
    result.symbol !== position.symbol ||
    (result.action !== "long" && result.action !== "short") ||
    result.asOf > position.openedAt ||
    result.context?.position
  )
    return null;
  if (result.action === position.side) return null;
  return `Jev said ${result.action}; you went ${position.side}. Bold strategy—disagree with the signal, then ask the market to respect your confidence. At least the chart enjoys the plot twist.`;
}
