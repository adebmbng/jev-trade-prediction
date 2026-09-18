import { HeuristicProvider, PREDICTION_HORIZONS } from "./analysis";
import { type Candle, type SymbolName } from "./market";
// Input must contain historical 1s candles plus >=250 preceding 5m candles.
// Outcomes are measured only after predictions; costs are configurable round-trip bps.
export function replay(
  symbol: SymbolName,
  seconds: Candle[],
  five: Candle[],
  costBps = 10,
) {
  const provider = new HeuristicProvider(),
    byTime = new Map(seconds.map((c) => [c.time, c]));
  const rows = PREDICTION_HORIZONS.map((horizon) => ({
    horizon,
    total: 0,
    signals: 0,
    hits: 0,
    netBps: 0,
    momentumHits: 0,
    neutralHits: 0,
  }));
  for (
    let i = 199;
    i < seconds.length - Math.max(...PREDICTION_HORIZONS);
    i += 5
  ) {
    const c = seconds[i],
      now = (c.time + 1) * 1000;
    const m = {
      symbol,
      seconds: seconds.slice(Math.max(0, i - 3599), i + 1),
      five: five.filter((x) => x.time + 300 <= now / 1000),
      minutes: [],
      ready: true,
      updatedAt: now,
      error: "",
    };
    const f = provider.predict(m, now);
    if (!f.available) continue;
    for (const h of f.horizons) {
      const target = byTime.get(c.time + h.seconds);
      if (!target) continue;
      const row = rows.find((r) => r.horizon === h.seconds)!;
      row.total++;
      const outcome = Math.sign(target.close - c.close),
        side = h.direction === "up" ? 1 : h.direction === "down" ? -1 : 0;
      row.neutralHits += Number(outcome === 0);
      row.momentumHits += Number(
        Math.sign(c.close - seconds[i - 1].close) === outcome,
      );
      if (side) {
        row.signals++;
        row.hits += Number(side === outcome);
        row.netBps += side * (target.close / c.close - 1) * 10000 - costBps;
      }
    }
  }
  return rows.map((r) => ({
    ...r,
    coverage: r.total ? r.signals / r.total : 0,
    accuracy: r.signals ? r.hits / r.signals : null,
    meanNetBps: r.signals ? r.netBps / r.signals : null,
  }));
}
