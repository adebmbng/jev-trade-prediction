# Jev Trade — initialization plan

## Scope and defaults

Mobile-first, dark trading dashboard with live Binance Spot prices, deterministic technical analysis, backend direction forecasts, and local paper positions. Default: BTCUSDT / 5s; alternatives: ETHUSDT and 30s / 1m. No authentication, exchange orders, or database for the MVP. Long/short buttons track hypothetical positions.

## 1. Initialize the repository

- TypeScript throughout; pnpm workspace.
- `apps/web`: React + Vite, lightweight candlestick chart, responsive CSS.
- `apps/api`: Node.js + Fastify, Binance ingestion, prediction engine, SSE endpoint.
- `packages/shared`: candle aggregation, indicator functions, forecast schemas, shared types.
- Add environment examples, dev/build/typecheck/lint scripts, and focused tests. Deploy web and API behind one origin; configure the proxy to support unbuffered SSE.

## 2. Market data and communication

- FE connects directly to Binance WebSocket for the selected symbol. BE maintains its own shared feeds for both symbols; forecasts never depend on client-supplied prices.
- Use Binance `kline_1s` to derive 5s and 30s candles; native 1m and 5m candles provide longer history and context. Binance has no native 5s/30s candle interval. [WebSocket documentation](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams)
- Bootstrap recent chart history with REST 1s klines and at least 250 closed 5m candles for indicator warm-up. Paginate history; buffer live events during bootstrap, then merge by symbol and opening timestamp. [REST documentation](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints)
- Aggregate UTC-aligned buckets with `floor(timestamp / intervalMs) * intervalMs`: first open, maximum high, minimum low, last close, summed volume. Replace repeated source-candle updates before recomputing; never add cumulative volume twice.
- Reconnect with backoff, repair missing history, and mark unavailable data as gaps. Display feed age and disable entry/forecast guidance while stale. Dispose old subscriptions when switching symbols.
- FE receives backend forecasts through `GET /api/predictions/stream?symbol=BTCUSDT` using SSE. Send an immediate snapshot, subsequent updates, event IDs, and heartbeats. Reconnecting clients receive the latest snapshot.

## 3. Mobile screen and chart

- Top bar: symbol selector, 5s / 30s / 1m selector, current price, connection status.
- Chart directly below, approximately `40dvh`, with touch pan/zoom and a return-to-live control.
- Draw vertical separators at every UTC 5m boundary. Inside each section, draw a horizontal segment at that 5m candle's opening price, clipped to that section. Keep these overlays aligned during scrolling, zooming, and interval changes.
- Below chart: compact trend summary, prediction cards, then position controls. Use labels/icons alongside green/red colors.

## 4. Deterministic trend analysis in the FE

Compute the main trend from **5m candles regardless of the displayed chart interval**. Use closed candles for stable signals; label forming-candle previews as provisional. The following are starting parameters to validate, not a proven best configuration.

| Group         | Initial indicators                              | Compact display                         |
| ------------- | ----------------------------------------------- | --------------------------------------- |
| Trend         | EMA 9/21/50; SMA 200                            | Bullish / bearish / mixed; MA alignment |
| Momentum      | RSI 14; MACD 12/26/9                            | RSI value and momentum direction        |
| Participation | Volume / SMA(volume, 20); OBV slope over 5 bars | Relative volume and accumulation bias   |
| Strength      | ADX 14 with +DI/-DI                             | Trending / ranging                      |
| Volatility    | ATR 14; Bollinger Bands 20, 2 deviations        | ATR%, band position, expansion          |
| Levels        | Previous 5m high/low; rolling 20-bar high/low   | Nearest support/resistance              |

Show one summary row plus expandable indicator details. Group correlated signals so several moving averages do not count as independent evidence. Extend the indicator registry later rather than crowding the first screen with every possible indicator.

## 5. Backend predictions

- Define a `PredictionProvider` interface; implement `HeuristicProvider` first. Add a TypesafeAI Jev adapter after access and its actual API contract become available. Keep credentials server-side.
- Predict price direction at **now + 5s, + 30s, + 1m, + 2m, + 5m**, relative to the captured reference price; these are rolling horizons, not candle-close predictions.
- Initial deterministic baseline: combine volatility-normalized short-term returns, EMA slope, RSI momentum, relative volume, and 5m trend context. Give each horizon separate configurable weights and a neutral threshold. Return up/down/neutral; insufficient or stale data returns unavailable.
- Recompute all horizons every closed 5s candle. Refresh every horizon together so each uses the newest reference price and context; do not hold old 30s–5m values while waiting for their target time. Return `symbol`, `asOf`, `referencePrice`, `provider`, `modelVersion`, and per-horizon `targetTime`, `direction`, `strength`, `reasons`, `expiresAt`. Strength is an uncalibrated score, not a probability.
- Validate with chronological walk-forward replay, using only information available at prediction time. Compare against neutral and momentum baselines; measure directional accuracy, signal coverage, and outcomes after assumed costs. Tune parameters separately by horizon and symbol without promising predictive accuracy.
- Share one forecast computation per symbol across visitors; bound client connections and rate-limit public endpoints.

## 6. Local position tracking and exit guidance

- Initially show **Go long / Go short**. A click captures the latest fresh displayed price and timestamp, places an entry marker/line, and stores `{symbol, side, entryPrice, openedAt}` in versioned localStorage.
- Allow one open position per symbol. Restore after refresh; symbol changes reveal the corresponding position. While open, show **Close position**, entry, directional return%, and elapsed time. Do not silently replace an open position.
- Keep positions entirely in the FE. Combine the shared BE forecasts with local position state to show hold / momentum weakening / consider taking profit, with short reasons.
- Flag potential pullbacks for longs and rebounds for shorts using nearby levels, weakening momentum, Bollinger extension, and adverse forecast agreement. RSI extremes alone must not trigger an exit signal.
- Track the favorable price extreme since entry and show an optional ATR-based trailing reference, initially 1× 5m ATR and subject to validation. Refresh gaps mean the exact intervening extreme is unknown; label it accordingly.
- Guidance identifies possible exit zones, not an exact market top/bottom. Display gross price return unless fees/slippage are configured; no automatic execution.

## Build order and completion checks

1. **Foundation:** workspace, mobile shell, shared data types, health endpoint.
2. **Live chart:** history + streaming, all intervals, symbol switching, 5m overlays.
3. **Trend panel:** indicator engine, warm-up states, compact summary/details.
4. **Predictions:** deterministic provider, SSE, freshness handling, replay evaluation.
5. **Positions:** local persistence, entry overlays, return tracking, exit guidance.
6. **Verify:** candle boundaries and duplicate updates; history/live reconciliation; indicator fixtures; forecast horizon timestamps and absence of future-data leakage; long/short return signs; refresh/reconnect behavior; usable layout at 360px width.

MVP is complete when both symbols work live, chart intervals preserve 5m segmentation, all five forecast horizons update, and local positions survive refresh with meaningful position-aware guidance.
