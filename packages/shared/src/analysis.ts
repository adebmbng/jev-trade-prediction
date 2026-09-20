import { aggregate, type Candle, type Market, type SymbolName } from "./market";
const mean = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
const last = (a: number[]) => a[a.length - 1];

export type WindowTrend = {
  minutes: 5 | 15 | 30 | 60;
  direction: "Bullish" | "Bearish" | "Mixed";
  changePct: number;
  efficiency: number;
  available: boolean;
};

export const TREND_WINDOWS = [15, 30, 60] as const;

export const FAST_RSI_PERIOD = 7;
export const PAPER_TRADE_DURATION_MS = 5 * 60 * 1000;

export type TradeRecord = {
  id: string;
  symbol: SymbolName;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  openedAt: number;
  closedAt: number;
  pnlPct: number;
  outcome: "win" | "lose";
  closeReason: "manual" | "timeout";
};

export const paperTradeCloseAt = (openedAt: number) =>
  openedAt + PAPER_TRADE_DURATION_MS;

export const tradeOutcome = (pnlPct: number): TradeRecord["outcome"] =>
  pnlPct > 0 ? "win" : "lose";

function trendForWindow(
  input: Candle[],
  minutes: WindowTrend["minutes"],
  intervalSeconds: number,
): WindowTrend {
  const closed = input.filter((c) => c.closed).sort((a, b) => a.time - b.time);
  const bars = closed.slice(-minutes);
  const continuous =
    bars.length === minutes &&
    bars.every(
      (bar, i) => i === 0 || bar.time - bars[i - 1].time === intervalSeconds,
    );
  if (!continuous)
    return {
      minutes,
      direction: "Mixed",
      changePct: 0,
      efficiency: 0,
      available: false,
    };

  const start = bars[0].open;
  const end = bars.at(-1)!.close;
  const center = (bars.length - 1) / 2;
  const slope =
    bars.reduce((sum, bar, i) => sum + (i - center) * bar.close, 0) /
    bars.reduce((sum, _bar, i) => sum + (i - center) ** 2, 0);
  const path = bars.reduce(
    (sum, bar, i) =>
      sum + Math.abs(bar.close - (i === 0 ? start : bars[i - 1].close)),
    0,
  );
  const changePct = start ? (end / start - 1) * 100 : 0;
  const efficiency = path ? Math.min(1, Math.abs(end - start) / path) : 0;
  const direction =
    changePct > 0 && slope > 0
      ? "Bullish"
      : changePct < 0 && slope < 0
        ? "Bearish"
        : "Mixed";
  return { minutes, direction, changePct, efficiency, available: true };
}

export function multiTimeframeTrends(
  input: Candle[],
  fiveMinuteInput?: Candle[],
): WindowTrend[] {
  const five = fiveMinuteInput
    ? [trendForWindow(fiveMinuteInput, 5, 300)]
    : [];
  return [
    ...five,
    ...TREND_WINDOWS.map((minutes) => trendForWindow(input, minutes, 60)),
  ];
}

function smooth(a: number[], n: number, alpha = 2 / (n + 1)) {
  if (a.length < n) return [];
  const out = [mean(a.slice(0, n))];
  for (const v of a.slice(n)) out.push(last(out) + alpha * (v - last(out)));
  return out;
}

/* RSI-7 reacts within roughly 35 minutes of 5m candles, versus 70 minutes for RSI-14. */
function fastRsi(prices: number[]) {
  const changes = prices.slice(1).map((v, i) => v - prices[i]);
  const gain = last(
    smooth(
      changes.map((v) => Math.max(v, 0)),
      FAST_RSI_PERIOD,
      1 / FAST_RSI_PERIOD,
    ),
  );
  const loss = last(
    smooth(
      changes.map((v) => Math.max(-v, 0)),
      FAST_RSI_PERIOD,
      1 / FAST_RSI_PERIOD,
    ),
  );
  return loss === 0
    ? gain === 0
      ? 50
      : 100
    : 100 - 100 / (1 + gain / loss);
}

export function indicators(input: Candle[]) {
  const c = input.filter((x) => x.closed);
  if (c.length < 200) return null;
  const p = c.map((x) => x.close),
    price = last(p),
    ema = (n: number) => last(smooth(p, n));
  const rsi = fastRsi(p);
  const tr = c
    .slice(1)
    .map((v, i) =>
      Math.max(
        v.high - v.low,
        Math.abs(v.high - c[i].close),
        Math.abs(v.low - c[i].close),
      ),
    );
  const atrs = smooth(tr, 14, 1 / 14),
    atr = last(atrs);
  const plus = smooth(
    c
      .slice(1)
      .map((v, i) =>
        v.high - c[i].high > c[i].low - v.low
          ? Math.max(0, v.high - c[i].high)
          : 0,
      ),
    14,
    1 / 14,
  );
  const minus = smooth(
    c
      .slice(1)
      .map((v, i) =>
        c[i].low - v.low > v.high - c[i].high
          ? Math.max(0, c[i].low - v.low)
          : 0,
      ),
    14,
    1 / 14,
  );
  const diPlus = atrs.map((a, i) => (a ? (100 * plus[i]) / a : 0)),
    diMinus = atrs.map((a, i) => (a ? (100 * minus[i]) / a : 0));
  const adx = last(
    smooth(
      diPlus.map((v, i) =>
        v + diMinus[i]
          ? (100 * Math.abs(v - diMinus[i])) / (v + diMinus[i])
          : 0,
      ),
      14,
      1 / 14,
    ),
  );
  const fast = smooth(p, 12),
    slow = smooth(p, 26),
    macds = slow.map((v, i) => fast[i + 14] - v);
  const macd = last(macds),
    histogram = macd - last(smooth(macds, 9));
  const mid = mean(p.slice(-20)),
    deviation = Math.sqrt(mean(p.slice(-20).map((v) => (v - mid) ** 2)));
  const ema9 = ema(9),
    ema21 = ema(21),
    ema50 = ema(50);
  return {
    price,
    ema9,
    ema21,
    ema50,
    sma200: mean(p.slice(-200)),
    rsi,
    rsiPeriod: FAST_RSI_PERIOD,
    macd,
    histogram,
    atr,
    adx,
    diPlus: last(diPlus),
    diMinus: last(diMinus),
    upper: mid + 2 * deviation,
    lower: mid - 2 * deviation,
    relativeVolume:
      c.at(-1)!.volume / (mean(c.slice(-21, -1).map((v) => v.volume)) || 1),
    obvSlope: c
      .slice(-5)
      .reduce(
        (s, v, i) =>
          s + Math.sign(v.close - c[c.length - 6 + i].close) * v.volume,
        0,
      ),
    support: Math.min(...c.slice(-20).map((v) => v.low)),
    resistance: Math.max(...c.slice(-20).map((v) => v.high)),
    previousHigh: c.at(-1)!.high,
    previousLow: c.at(-1)!.low,
    trend:
      ema9 > ema21 && ema21 > ema50
        ? "Bullish"
        : ema9 < ema21 && ema21 < ema50
          ? "Bearish"
          : "Mixed",
  };
}
export type Forecast = {
  symbol: SymbolName;
  asOf: number;
  referencePrice: number;
  provider: string;
  modelVersion: string;
  available: boolean;
  horizons: {
    seconds: number;
    targetTime: number;
    expiresAt: number;
    direction: "up" | "down" | "neutral";
    strength: number;
    reasons: string[];
  }[];
};
// Rolling targets. A new snapshot is published every 5 seconds for each horizon.
export const PREDICTION_HORIZONS = [5, 30, 60, 120, 300] as const;
const HORIZON_LOOKBACKS = [1, 6, 12, 24, 60] as const;
const HORIZON_MOMENTUM_WEIGHTS = [0.85, 0.75, 0.65, 0.5, 0.4] as const;
export interface PredictionProvider {
  predict(market: Market, now?: number): Forecast;
}
export class HeuristicProvider implements PredictionProvider {
  predict(m: Market, now = Date.now()): Forecast {
    const context = indicators(
      m.five.filter((c) => c.time * 1000 + 300000 <= now),
    );
    const bars = aggregate(
      m.seconds.filter((c) => c.time * 1000 + 1000 <= now),
      5,
    ).filter((c) => c.closed);
    const price =
      m.seconds.filter((c) => c.time * 1000 <= now).at(-1)?.close ?? 0;
    const requiredBars = Math.max(...HORIZON_LOOKBACKS) + 1;
    const recent = bars.slice(-requiredBars);
    const continuous =
      recent.length === requiredBars &&
      recent.every((c, i) => i === 0 || c.time - recent[i - 1].time === 5);
    const available = Boolean(
      m.ready &&
      context &&
      continuous &&
      now - m.updatedAt < 10000 &&
      m.updatedAt <= now &&
      now - (bars.at(-1)!.time + 5) * 1000 < 10000,
    );
    const horizons = available
      ? PREDICTION_HORIZONS.map((seconds, i) => {
          const lookback = HORIZON_LOOKBACKS[i],
            end = bars.at(-1)!,
            start = bars.at(-1 - lookback)!;
          const volatility = Math.max(
            context!.atr * Math.sqrt(seconds / 300),
            price * 0.00005,
          );
          const momentum = Math.tanh((end.close - start.close) / volatility);
          const trend = Math.tanh(
            (context!.ema9 - context!.ema21) / (context!.atr || 1),
          );
          const score =
            (HORIZON_MOMENTUM_WEIGHTS[i] * momentum +
              (1 - HORIZON_MOMENTUM_WEIGHTS[i]) * trend) *
            Math.min(1.2, Math.max(0.5, context!.relativeVolume));
          return {
            seconds,
            targetTime: now + seconds * 1000,
            expiresAt: now + 12000,
            direction:
              Math.abs(score) < 0.15
                ? ("neutral" as const)
                : score > 0
                  ? ("up" as const)
                  : ("down" as const),
            strength: Math.round(Math.min(1, Math.abs(score)) * 100),
            reasons: [
              `5m trend ${context!.trend.toLowerCase()}`,
              `${seconds}s momentum ${momentum >= 0 ? "positive" : "negative"}`,
            ],
          };
        })
      : [];
    return {
      symbol: m.symbol,
      asOf: now,
      referencePrice: price,
      provider: "Heuristic",
      modelVersion: "baseline-1",
      available,
      horizons,
    };
  }
}
export type Position = {
  symbol: SymbolName;
  side: "long" | "short";
  entryPrice: number;
  openedAt: number;
  extreme: number;
};
export const positionReturn = (p: Position, price: number) =>
  (price / p.entryPrice - 1) * (p.side === "long" ? 1 : -1) * 100;
export function guidance(
  p: Position,
  price: number,
  a: ReturnType<typeof indicators>,
  f: Forecast | null,
  now: number,
) {
  if (!a || !f?.available || f.horizons.some((h) => h.expiresAt < now))
    return "Waiting for fresh analysis";
  const long = p.side === "long",
    adverse = f.horizons.filter(
      (h) => h.direction === (long ? "down" : "up"),
    ).length;
  const extended = long
    ? price >= a.upper || Math.abs(price - a.resistance) < a.atr * 0.2
    : price <= a.lower || Math.abs(price - a.support) < a.atr * 0.2;
  const weakening = long ? a.histogram < 0 : a.histogram > 0;
  const trail = long ? price < p.extreme - a.atr : price > p.extreme + a.atr;
  if (
    positionReturn(p, price) > 0 &&
    ((extended && (weakening || adverse >= 2)) || trail)
  )
    return "Consider taking profit · reversal signals";
  if (adverse >= 2 || trail) return "Momentum weakening · review your position";
  return "Hold bias · monitor the next forecast";
}
