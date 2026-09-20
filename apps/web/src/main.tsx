import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  aggregate,
  connectMarket,
  emptyMarket,
  SYMBOLS,
  type SymbolName,
} from "../../../packages/shared/src/market";
import {
  FAST_RSI_PERIOD,
  guidance,
  indicators,
  multiTimeframeTrends,
  paperTradeCloseAt,
  PREDICTION_HORIZONS,
  positionReturn,
  tradeOutcome,
  type Forecast,
  type Position,
  type TradeRecord,
} from "../../../packages/shared/src/analysis";
import {
  DEFAULT_JEV_LEVERAGE,
  jevContrarianComment,
  type JevResult,
} from "../../../packages/shared/src/jev";
import { Chart } from "./Chart";
import { JevRecommendation } from "./JevRecommendation";
import "./style.css";
const SHOW_JEV_RECOMMENDATION =
  import.meta.env.VITE_SHOW_JEV?.trim().toLowerCase() === "true";
const key = "jev.positions.v1";
const historyKey = "jev.trade-history.v1";
const MAX_TRADE_HISTORY = 100;
const money = (n: number | undefined) =>
  n === undefined
    ? "—"
    : n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
function loadPositions(): Partial<Record<SymbolName, Position>> {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? "{}");
    return Object.fromEntries(
      SYMBOLS.filter((s) => {
        const p = data?.[s];
        return (
          p &&
          p.symbol === s &&
          ["long", "short"].includes(p.side) &&
          [p.entryPrice, p.openedAt, p.extreme].every(
            (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
          )
        );
      }).map((s) => [s, data[s]]),
    );
  } catch {
    return {};
  }
}
function loadTradeHistory(): TradeRecord[] {
  try {
    const data = JSON.parse(localStorage.getItem(historyKey) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (trade): trade is TradeRecord =>
          trade &&
          typeof trade.id === "string" &&
          SYMBOLS.includes(trade.symbol) &&
          ["long", "short"].includes(trade.side) &&
          [
            trade.entryPrice,
            trade.exitPrice,
            trade.openedAt,
            trade.closedAt,
            trade.pnlPct,
          ].every((v) => typeof v === "number" && Number.isFinite(v)) &&
          ["win", "lose"].includes(trade.outcome) &&
          ["manual", "timeout"].includes(trade.closeReason),
      )
      .slice(0, MAX_TRADE_HISTORY);
  } catch {
    return [];
  }
}
function createTradeRecord(
  position: Position,
  exitPrice: number,
  closedAt: number,
  closeReason: TradeRecord["closeReason"],
): TradeRecord {
  const pnlPct = positionReturn(position, exitPrice);
  return {
    id: `${position.symbol}-${position.openedAt}-${closedAt}`,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    openedAt: position.openedAt,
    closedAt,
    pnlPct,
    outcome: tradeOutcome(pnlPct),
    closeReason,
  };
}
function App() {
  const [symbol, setSymbol] = useState<SymbolName>("BTCUSDT"),
    [interval, setIntervalValue] = useState(5);
  const [market, setMarket] = useState(emptyMarket(symbol)),
    [forecast, setForecast] = useState<Forecast | null>(null),
    [jevResult, setJevResult] = useState<JevResult | null>(null);
  const [positions, setPositions] = useState(loadPositions),
    [tradeHistory, setTradeHistory] = useState(loadTradeHistory),
    [now, setNow] = useState(Date.now()),
    [storageError, setStorageError] = useState(false);
  const [restored] = useState(() => new Set(Object.keys(positions)));
  const autoClosed = useRef<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setMarket(emptyMarket(symbol));
    return connectMarket(symbol, setMarket);
  }, [symbol]);
  useEffect(() => {
    setForecast(null);
    const source = new EventSource(`/api/predictions/stream?symbol=${symbol}`);
    source.onmessage = (e) => {
      try {
        const f = JSON.parse(e.data) as Forecast;
        if (f.symbol === symbol) setForecast(f);
      } catch {
        setForecast(null);
      }
    };
    source.onerror = () => {
      /* EventSource reconnects; existing forecasts expire independently. */
    };
    return () => source.close();
  }, [symbol]);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(positions));
      localStorage.setItem(historyKey, JSON.stringify(tradeHistory));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [positions, tradeHistory]);
  const matches = market.symbol === symbol;
  const price = matches ? market.seconds.at(-1)?.close : undefined;
  const fresh =
    matches &&
    market.ready &&
    now - market.updatedAt < 10000 &&
    price !== undefined;
  const candles = useMemo(
    () =>
      !matches
        ? []
        : interval === 60
          ? market.minutes
          : aggregate(market.seconds, interval),
    [market.seconds, market.minutes, matches, interval],
  );
  const analysis = useMemo(
    () => (matches ? indicators(market.five) : null),
    [market.five, matches],
  );
  const timeframeTrends = useMemo(
    () =>
      matches ? multiTimeframeTrends(market.minutes, market.five) : [],
    [market.five, market.minutes, matches],
  );
  const position = positions[symbol];
  useEffect(() => {
    if (!fresh || !position || price === undefined) return;
    const extreme =
      position.side === "long"
        ? Math.max(position.extreme, price)
        : Math.min(position.extreme, price);
    if (extreme !== position.extreme)
      setPositions((p) => ({ ...p, [symbol]: { ...position, extreme } }));
  }, [fresh, price, position, symbol]);
  useEffect(() => {
    if (!position || price === undefined || now < paperTradeCloseAt(position.openedAt))
      return;
    const closeKey = `${symbol}:${position.openedAt}`;
    if (autoClosed.current === closeKey) return;
    autoClosed.current = closeKey;
    const trade = createTradeRecord(position, price, now, "timeout");
    setTradeHistory((history) => [trade, ...history].slice(0, MAX_TRADE_HISTORY));
    setPositions((current) => {
      if (current[symbol]?.openedAt !== position.openedAt) return current;
      const next = { ...current };
      delete next[symbol];
      return next;
    });
  }, [now, position, price, symbol]);
  const activeForecast =
    forecast?.symbol === symbol &&
    forecast.available &&
    forecast.horizons.length === PREDICTION_HORIZONS.length &&
    PREDICTION_HORIZONS.every((seconds) =>
      forecast.horizons.some((h) => h.seconds === seconds && h.expiresAt > now),
    )
      ? forecast
      : null;
  function enter(side: "long" | "short") {
    if (
      !fresh ||
      positions[symbol] ||
      price === undefined ||
      Date.now() - market.updatedAt >= 10000
    )
      return;
    setPositions((p) => ({
      ...p,
      [symbol]: {
        symbol,
        side,
        entryPrice: price,
        openedAt: Date.now(),
        extreme: price,
      },
    }));
  }
  const pnl =
    position && price !== undefined ? positionReturn(position, price) : null;
  const leveragedPnl = pnl === null ? null : pnl * DEFAULT_JEV_LEVERAGE;
  const contrarianComment = position
    ? jevContrarianComment(position, jevResult)
    : null;
  const wins = tradeHistory.filter((trade) => trade.outcome === "win").length;
  const losses = tradeHistory.length - wins;
  function closePosition() {
    if (!position || price === undefined) return;
    const trade = createTradeRecord(position, price, Date.now(), "manual");
    setTradeHistory((history) => [trade, ...history].slice(0, MAX_TRADE_HISTORY));
    setPositions((current) => {
      if (current[symbol]?.openedAt !== position.openedAt) return current;
      const next = { ...current };
      delete next[symbol];
      return next;
    });
  }
  return (
    <main>
      <header>
        <a className="brand" href="/" aria-label="Jev home">
          jev<span>/</span>
        </a>
        <span className="descriptor">Market direction</span>
        <span className={`status ${fresh ? "up" : ""}`}>
          <i />
          {fresh ? "Live" : market.updatedAt ? "Reconnecting" : "Connecting"}
        </span>
      </header>
      <section className="market-bar" aria-label="Chart settings">
        <div>
          <label className="sr-only" htmlFor="symbol">
            Trading pair
          </label>
          <select
            id="symbol"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value as SymbolName)}
          >
            {SYMBOLS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <span className="venue">Binance spot</span>
        </div>
        <div className="intervals" aria-label="Candle interval">
          {[5, 30, 60].map((v) => (
            <button
              key={v}
              aria-pressed={interval === v}
              onClick={() => setIntervalValue(v)}
            >
              {v === 60 ? "1m" : `${v}s`}
            </button>
          ))}
        </div>
      </section>
      <div className="price-row">
        <strong>
          {money(price)} <small>USDT</small>
        </strong>
        <span>
          5m opening levels <b className="gold">—</b>
        </span>
      </div>
      <Chart
        candles={candles}
        five={matches ? market.five : []}
        position={position}
        interval={interval}
        symbol={symbol}
      />
      {!fresh && (
        <p className="feed-note" role="status">
          {market.error || "Waiting for a fresh market tick…"} Entries pause
          until the feed is ready.
        </p>
      )}
      <div className={SHOW_JEV_RECOMMENDATION ? "analysis-grid" : undefined}>
        <section className="analysis section">
          <div className="section-heading">
            <h2>Multi-timeframe trend</h2>
            <span>5m + closed 1m candles</span>
          </div>
          <div className="timeframe-trends">
            {timeframeTrends.map((trend) => (
              <article key={trend.minutes}>
                <span>
                  {trend.minutes === 60 ? "1h" : `${trend.minutes}m`}
                </span>
                <strong
                  className={
                    trend.direction === "Bullish"
                      ? "up"
                      : trend.direction === "Bearish"
                        ? "down"
                        : ""
                  }
                >
                  {trend.available
                    ? `${trend.direction === "Bullish" ? "↗" : trend.direction === "Bearish" ? "↘" : "↔"} ${trend.direction}`
                    : "Warming up"}
                </strong>
                <small>
                  {trend.available
                    ? `${trend.changePct >= 0 ? "+" : ""}${trend.changePct.toFixed(3)}% · ${(trend.efficiency * 100).toFixed(0)}% clean`
                    : trend.minutes === 5
                      ? "Need 5 closed 5m bars"
                      : `Need ${trend.minutes} closed 1m bars`}
                </small>
              </article>
            ))}
          </div>
          <div className="trend-row broader-trend">
            <strong>5m EMA context</strong>
            <span
              className={
                analysis?.trend === "Bullish"
                  ? "up"
                  : analysis?.trend === "Bearish"
                    ? "down"
                    : ""
              }
            >
              {analysis
                ? `${analysis.trend} · ${analysis.adx >= 25 ? "Trending" : "Ranging"} · ADX ${analysis.adx.toFixed(0)}`
                : "Loading history"}
            </span>
          </div>
          <div className="metrics">
            <div>
              <span>RSI {FAST_RSI_PERIOD} · 5m</span>
              <b>{analysis?.rsi.toFixed(1) ?? "—"}</b>
            </div>
            <div>
              <span>Rel. volume</span>
              <b>{analysis ? `${analysis.relativeVolume.toFixed(2)}×` : "—"}</b>
            </div>
            <div>
              <span>ATR 14</span>
              <b>
                {analysis
                  ? `${((analysis.atr / analysis.price) * 100).toFixed(2)}%`
                  : "—"}
              </b>
            </div>
            <div>
              <span>MACD</span>
              <b className={analysis && analysis.histogram > 0 ? "up" : ""}>
                {analysis
                  ? analysis.histogram >= 0
                    ? "Positive"
                    : "Negative"
                  : "—"}
              </b>
            </div>
          </div>
          <details>
            <summary>All indicators & levels</summary>
            {analysis && (
              <dl>
                {Object.entries({
                  "EMA 9": money(analysis.ema9),
                  "EMA 21": money(analysis.ema21),
                  "EMA 50": money(analysis.ema50),
                  "SMA 200": money(analysis.sma200),
                  [`RSI ${FAST_RSI_PERIOD} (fast)`]: analysis.rsi.toFixed(1),
                  "DI+ / DI−": `${analysis.diPlus.toFixed(1)} / ${analysis.diMinus.toFixed(1)}`,
                  "OBV (5 bars)":
                    analysis.obvSlope > 0 ? "Accumulation" : "Distribution",
                  "Bollinger low / high": `${money(analysis.lower)} / ${money(analysis.upper)}`,
                  "20-bar support": money(analysis.support),
                  "20-bar resistance": money(analysis.resistance),
                  "Previous 5m high / low": `${money(analysis.previousHigh)} / ${money(analysis.previousLow)}`,
                }).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p>
              Starting parameters, not optimized. Signals use closed candles.
            </p>
          </details>
        </section>
        {SHOW_JEV_RECOMMENDATION && (
          <JevRecommendation
            symbol={symbol}
            position={position}
            fresh={fresh}
            now={now}
            onResult={setJevResult}
          />
        )}
      </div>
      <section className="section">
        <div className="section-heading">
          <h2>Next direction</h2>
          <span>Heuristic baseline</span>
        </div>
        <div className="forecasts">
          {PREDICTION_HORIZONS.map((seconds) => {
            const h = fresh
              ? activeForecast?.horizons.find((h) => h.seconds === seconds)
              : undefined;
            return (
              <article key={seconds}>
                <span>
                  {seconds < 60 ? `${seconds} sec` : `${seconds / 60} min`}
                </span>
                <strong
                  className={
                    h?.direction === "up"
                      ? "up"
                      : h?.direction === "down"
                        ? "down"
                        : ""
                  }
                >
                  {h
                    ? `${h.direction === "up" ? "↗" : h.direction === "down" ? "↘" : "→"} ${h.direction}`
                    : "—"}
                </strong>
                <div className="strength">
                  <i style={{ width: `${h?.strength ?? 0}%` }} />
                </div>
                <small>{h ? `${h.strength} strength` : "Waiting"}</small>
              </article>
            );
          })}
        </div>
        <p className="caption">
          {activeForecast
            ? `From ${money(activeForecast.referencePrice)} · ${new Date(activeForecast.asOf).toLocaleTimeString()} · scores are not probabilities.`
            : "Forecasts resume when the backend has fresh, complete history."}
        </p>
      </section>
      <section className="section position">
        <div className="section-heading">
          <h2>{position ? "Your position" : "Take a position"}</h2>
          <span>Local paper trade</span>
        </div>
        {position ? (
          <>
            <div className="position-row">
              <strong>
                {position.side === "long" ? "↗ Long" : "↘ Short"}{" "}
                <small>@ {money(position.entryPrice)}</small>
              </strong>
              <strong className={pnl !== null && pnl >= 0 ? "up" : "down"}>
                {pnl === null
                  ? "—"
                  : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)}%`}
              </strong>
            </div>
            <p className="guidance">
              Heuristic check:{" "}
              {fresh && price !== undefined
                ? guidance(position, price, analysis, activeForecast, now)
                : "Waiting for fresh prices"}
            </p>
            {contrarianComment && (
              <p className="guidance jev-contrarian" role="status">
                {contrarianComment}
              </p>
            )}
            <p className="caption">
              {Math.max(0, Math.floor((now - position.openedAt) / 60000))}m open
              · Auto-closes at the next 5m close in {Math.max(0, Math.ceil((paperTradeCloseAt(position.openedAt) - now) / 1000))}s
              · Raw price return
              {analysis
                ? ` · ATR trail ${money(position.extreme + (position.side === "long" ? -analysis.atr : analysis.atr))}`
                : ""}
            </p>
            <p className="caption">
              Approx. {DEFAULT_JEV_LEVERAGE}× gross margin impact:{" "}
              {leveragedPnl === null
                ? "—"
                : `${leveragedPnl >= 0 ? "+" : ""}${leveragedPnl.toFixed(2)}%`}
              . Fees, funding, maintenance margin, and liquidation are not
              modeled.
            </p>
            <p className="caption">
              Observed price extreme only
              {restored.has(symbol)
                ? "; refresh may have missed price movement."
                : "; disconnected periods may miss price movement."}
            </p>
            <button
              className="close-button"
              onClick={closePosition}
            >
              Close position
            </button>
          </>
        ) : (
          <>
            <p className="caption">Mark this price. Follow the move.</p>
            <div className="actions">
              <button
                className="long"
                disabled={!fresh}
                onClick={() => enter("long")}
              >
                ↗ Go long
              </button>
              <button
                className="short"
                disabled={!fresh}
                onClick={() => enter("short")}
              >
                ↘ Go short
              </button>
            </div>
          </>
        )}
        {storageError && (
          <p role="alert">
            Storage unavailable. This position will not survive refresh.
          </p>
        )}
      </section>
      <section className="section trade-history">
        <div className="section-heading">
          <h2>Trade history</h2>
          <span>
            {wins} win{wins === 1 ? "" : "s"} · {losses} lose
            {losses === 1 ? "" : "s"}
          </span>
        </div>
        {tradeHistory.length ? (
          <ul className="history-list">
            {tradeHistory.slice(0, 8).map((trade) => (
              <li key={trade.id}>
                <div>
                  <strong>
                    {trade.symbol} · {trade.side === "long" ? "↗ Long" : "↘ Short"}
                  </strong>
                  <small>
                    {new Date(trade.closedAt).toLocaleString()} · {trade.closeReason === "timeout" ? "5m auto-close" : "Manual close"}
                  </small>
                </div>
                <strong className={trade.outcome === "win" ? "up" : "down"}>
                  {trade.outcome === "win" ? "Win" : "Lose"} · {trade.pnlPct >= 0 ? "+" : ""}
                  {trade.pnlPct.toFixed(3)}%
                </strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="caption">Closed paper trades will appear here.</p>
        )}
      </section>
      <footer>
        <p>
          Experimental signals. No orders placed. Fees and slippage excluded.
        </p>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          Charts by TradingView
        </a>
        <p>
          TradingView Lightweight Charts™ · Copyright © 2026 TradingView, Inc.
        </p>
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
