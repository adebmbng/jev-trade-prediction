import { useEffect, useRef, useState } from "react";
import type { Position } from "../../../packages/shared/src/analysis";
import type { JevResult } from "../../../packages/shared/src/jev";
import type { SymbolName } from "../../../packages/shared/src/market";

export function JevRecommendation({
  symbol,
  position,
  fresh,
  now,
  onResult,
}: {
  symbol: SymbolName;
  position?: Position;
  fresh: boolean;
  now: number;
  onResult?: (result: JevResult) => void;
}) {
  const [result, setResult] = useState<JevResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const positionRef = useRef(position);
  positionRef.current = position;
  const identity = JSON.stringify([
    symbol,
    position?.openedAt,
    position?.side,
    position?.entryPrice,
  ]);
  const [resultIdentity, setResultIdentity] = useState("");
  const lastGoodResult = useRef<JevResult | null>(null);
  useEffect(() => {
    setError("");
    if (!fresh) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      setLoading(true);
      try {
        const response = await fetch("/api/jev", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol, position: positionRef.current }),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(6500),
          ]),
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Request failed");
        const next = (await response.json()) as JevResult;
        if (!controller.signal.aborted && next.symbol === symbol) {
          if (next.available) {
            lastGoodResult.current = next;
            setResult(next);
            setResultIdentity(identity);
            onResult?.(next);
            setError("");
          } else if (!lastGoodResult.current) {
            setResult(next);
            setResultIdentity(identity);
            setError(next.message ?? "Jev is unavailable.");
          } else {
            setError(next.message ?? "Jev is unavailable. Retrying shortly.");
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          setError("Jev unavailable. Retrying shortly.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
        if (!controller.signal.aborted)
          timer = setTimeout(() => void update(), 15000);
      }
    }
    void update();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [symbol, identity, fresh, onResult]);
  const previous = result?.available ? result : null;
  const matching =
    resultIdentity === identity && result?.available ? result : null;
  const stale = Boolean(
    previous && (!fresh || !matching || previous.expiresAt <= now),
  );
  const active = previous;
  return (
    <section
      className="section jev-recommendation"
      aria-label="Jev recommendation"
      aria-busy={loading}
    >
      <div className="section-heading">
        <h2>Jev recommendation</h2>
        <span className="jev-status" aria-live="polite">
          {loading ? (
            <span className="jev-loading">
              <i aria-hidden="true" /> Refreshing
            </span>
          ) : matching ? (
            <span className={stale ? "jev-previous" : "jev-ready"}>
              {stale ? "◷ Previous" : "✓ Ready"}
            </span>
          ) : (
            "1–2 minute scalp"
          )}
        </span>
      </div>
      {active ? (
        <>
          {loading && (
            <p className="jev-refresh-note" role="status">
              <span className="jev-loading">
                <i aria-hidden="true" />
              </span>{" "}
              Reading the previous call while Jev refreshes it…
            </p>
          )}
          {stale && !loading && (
            <p className="jev-refresh-note" role="status">
              ◷ Showing the previous call until the fresh one arrives.
            </p>
          )}
          {error && (
            <p className="jev-refresh-note" role="status">
              ⚠ {error} The previous call remains visible.
            </p>
          )}
          <div className="trend-row">
            <strong>
              {active.action === "exit"
                ? active.context?.position?.side === "short"
                  ? "Buy to cover / close"
                  : "Sell / close"
                : active.action === "wait"
                  ? active.context?.position
                    ? "Wait / hold"
                    : "Wait"
                  : `${active.action} bias`}
            </strong>
            <span>
              {((active.confidence ?? 0) * 100).toFixed(0)}% model confidence
            </span>
          </div>
          <p className="guidance">{active.commentary}</p>
          <p className="caption">
            As of {new Date(active.asOf).toLocaleTimeString()} · {active.model}{" "}
            · Confidence is not a win probability. Commentary is assembled from
            Jev’s decision and observed data.
          </p>
          {active.context && (
            <details>
              <summary>Five-minute context & all technical indicators</summary>
              <p>
                From {new Date(active.context.windowStart).toLocaleTimeString()}{" "}
                to {new Date(active.context.windowEnd).toLocaleTimeString()}.
                Reference price: {active.context.price}. Nominal leverage:{" "}
                {active.context.leverage}×.
              </p>
              <dl>
                {Object.entries(active.context.changePct).map(
                  ([label, value]) => (
                    <div key={label}>
                      <dt>{label.slice(1)}s change</dt>
                      <dd>{value.toFixed(4)}%</dd>
                    </div>
                  ),
                )}
              </dl>
              <p>
                Leveraged gross impact:{" "}
                {Object.entries(active.context.leveragedChangePct)
                  .map(
                    ([label, value]) =>
                      `${label.slice(1)}s ${value.toFixed(2)}%`,
                  )
                  .join(" · ")}
                . This excludes fees, funding, maintenance margin, and
                liquidation.
              </p>
              <p>
                Indicators below use closed 5m candles with longer warm-up
                history.
              </p>
              <dl>
                {Object.entries(active.context.indicators5m).map(
                  ([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>
                        {typeof value === "number" ? value.toFixed(4) : value}
                      </dd>
                    </div>
                  ),
                )}
              </dl>
            </details>
          )}
        </>
      ) : (
        <p role="status">
          {!fresh
            ? "Waiting for fresh market data."
            : error ||
              (resultIdentity === identity && result?.message) ||
              (loading ? "Asking Jev…" : "Waiting for Jev…")}
        </p>
      )}
    </section>
  );
}
