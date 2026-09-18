import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  emptyMarket,
  type Candle,
} from "../packages/shared/src/market";
import {
  indicators,
  multiTimeframeTrends,
  HeuristicProvider,
  PREDICTION_HORIZONS,
  positionReturn,
  guidance,
  type Position,
} from "../packages/shared/src/analysis";
const candle = (time: number, close: number, volume = 1): Candle => ({
  time,
  open: close - 1,
  high: close + 2,
  low: close - 2,
  close,
  volume,
  closed: true,
});
test("UTC buckets replace duplicates, sum volume, and close only complete buckets", () => {
  const data = Array.from({ length: 10 }, (_, i) => candle(300 + i, 100 + i));
  const bars = aggregate([...data, { ...data[2], volume: 5 }], 5);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].time, 300);
  assert.equal(bars[0].open, 99);
  assert.equal(bars[0].close, 104);
  assert.equal(bars[0].high, 106);
  assert.equal(bars[0].low, 98);
  assert.equal(bars[0].volume, 9);
  assert.equal(bars[0].closed, true);
  assert.equal(aggregate(data.slice(1), 5)[0].closed, false);
  assert.equal(
    aggregate([...data.slice(0, 4), { ...data[4], closed: false }], 5)[0]
      .closed,
    false,
  );
});
test("flat and rising indicator fixtures, including Wilder RSI and SMA", () => {
  const flat = Array.from({ length: 250 }, (_, i) => ({
    ...candle(i * 300, 100),
    open: 100,
    high: 100,
    low: 100,
  }));
  const a = indicators(flat)!;
  assert.equal(a.rsi, 50);
  assert.equal(a.atr, 0);
  assert.equal(a.adx, 0);
  assert.equal(a.sma200, 100);
  assert.equal(a.histogram, 0);
  assert.equal(a.relativeVolume, 1);
  const rising = indicators(
    flat.map((c, i) => ({
      ...c,
      open: i + 1,
      close: i + 1,
      high: i + 1,
      low: i + 1,
    })),
  )!;
  assert.equal(rising.rsi, 100);
  assert.equal(rising.sma200, 150.5);
  assert.equal(rising.trend, "Bullish");
  assert.equal(rising.adx, 100);
  assert.equal(indicators(flat.slice(0, 199)), null);
});
test("15m, 30m, and 1h trends use exact closed 1m paths, including tiny moves", () => {
  const rising = Array.from({ length: 60 }, (_, i) => ({
    ...candle(i * 60, 100 + i * 0.00001),
    open: 100 + i * 0.00001,
    close: 100 + (i + 1) * 0.00001,
  }));
  const trends = multiTimeframeTrends(rising);
  assert.deepEqual(
    trends.map((trend) => [trend.minutes, trend.direction, trend.available]),
    [
      [15, "Bullish", true],
      [30, "Bullish", true],
      [60, "Bullish", true],
    ],
  );
  assert.ok(trends.every((trend) => trend.changePct > 0));
  const falling = multiTimeframeTrends(
    rising.map((bar, i) => ({
      ...bar,
      open: 100 - i * 0.001,
      close: 100 - (i + 1) * 0.001,
    })),
  );
  assert.ok(falling.every((trend) => trend.direction === "Bearish"));
  const gapped = rising.filter((_, i) => i !== 30);
  assert.equal(multiTimeframeTrends(gapped).at(-1)!.available, false);
});
test("forecast timestamps, stale data, gaps, and future-data isolation", () => {
  const now = 90000000,
    m = {
      ...emptyMarket("BTCUSDT"),
      ready: true,
      updatedAt: now,
      seconds: Array.from({ length: 400 }, (_, i) =>
        candle(now / 1000 - 400 + i, 10000 + i),
      ),
      five: Array.from({ length: 250 }, (_, i) =>
        candle(now / 1000 - 75000 + i * 300, 10000 + i),
      ),
    };
  const provider = new HeuristicProvider(),
    f = provider.predict(m, now);
  assert.equal(f.available, true);
  assert.deepEqual(
    f.horizons.map((h) => h.targetTime - now),
    PREDICTION_HORIZONS.map((seconds) => seconds * 1000),
  );
  assert.equal(
    provider.predict({ ...m, updatedAt: now - 11000 }, now).available,
    false,
  );
  assert.equal(
    provider.predict(
      { ...m, seconds: m.seconds.filter((_, i) => i !== 380) },
      now,
    ).available,
    false,
  );
  assert.deepEqual(
    provider.predict(
      {
        ...m,
        seconds: [...m.seconds, candle(now / 1000 + 1, 999999)],
        five: [...m.five, candle(now / 1000, 999999)],
      },
      now,
    ),
    f,
  );
});
test("position return signs and missing forecast guidance", () => {
  const p: Position = {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 100,
    openedAt: 1,
    extreme: 110,
  };
  assert.ok(Math.abs(positionReturn(p, 110) - 10) < 1e-10);
  assert.ok(
    Math.abs(positionReturn({ ...p, side: "short" }, 110) + 10) < 1e-10,
  );
  assert.equal(
    guidance(p, 110, null, null, Date.now()),
    "Waiting for fresh analysis",
  );
});
