import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  createSeriesMarkers,
  type UTCTimestamp,
  type Logical,
} from "lightweight-charts";
import type { Candle } from "../../../packages/shared/src/market";
import type { Position } from "../../../packages/shared/src/analysis";
export function Chart({
  candles,
  five,
  position,
  interval,
  symbol,
}: {
  candles: Candle[];
  five: Candle[];
  position?: Position;
  interval: number;
  symbol: string;
}) {
  const host = useRef<HTMLDivElement>(null),
    overlay = useRef<HTMLCanvasElement>(null);
  const current = useRef({ candles, five, position });
  current.current = { candles, five, position };
  const live = useRef<() => void>(() => {});
  useEffect(() => {
    const chart = createChart(host.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#10151e" },
        textColor: "#9ba9bd",
        fontFamily: "system-ui",
        fontSize: 10,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "#1b2533" } },
      rightPriceScale: { borderVisible: false, minimumWidth: 65 },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: interval < 60,
        rightOffset: 4,
      },
      crosshair: {
        vertLine: { color: "#8092ab" },
        horzLine: { color: "#8092ab" },
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#6ed3bb",
      downColor: "#e88b98",
      wickUpColor: "#6ed3bb",
      wickDownColor: "#e88b98",
      borderVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    const markers = createSeriesMarkers(series, []);
    let previous: Candle[] | undefined,
      previousPosition: Position | undefined,
      entry: ReturnType<typeof series.createPriceLine> | undefined;
    let frame = 0,
      lastDraw = 0,
      initialized = false;
    live.current = () => chart.timeScale().scrollToRealTime();
    function paint(now: number) {
      frame = requestAnimationFrame(paint);
      if (now - lastDraw < 60) return;
      lastDraw = now;
      const { candles: data, five: sections, position: p } = current.current;
      if (data !== previous && data.length) {
        const points = data.map((c) => ({
          ...c,
          time: c.time as UTCTimestamp,
        }));
        const priorLast = previous?.at(-1);
        if (
          previous &&
          data.length >= previous.length &&
          data[0].time === previous[0]?.time &&
          priorLast &&
          data.at(-1)!.time >= priorLast.time
        ) {
          // Also update the prior last candle, which may have closed since the last render.
          for (const point of points.filter((c) => c.time >= priorLast.time))
            series.update(point);
        } else series.setData(points);
        if (!initialized) {
          chart
            .timeScale()
            .setVisibleLogicalRange({
              from: Math.max(0, data.length - 70),
              to: data.length + 4,
            });
          initialized = true;
        }
        previous = data;
      }
      if (p !== previousPosition) {
        if (entry) series.removePriceLine(entry);
        entry = p
          ? series.createPriceLine({
              price: p.entryPrice,
              color: "#d8b778",
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: p.side === "long" ? "Long" : "Short",
            })
          : undefined;
        previousPosition = p;
      }
      const marker = p
        ? data.find(
            (c) =>
              c.time <= p.openedAt / 1000 &&
              c.time + interval > p.openedAt / 1000,
          )
        : undefined;
      markers.setMarkers(
        marker && p
          ? [
              {
                time: marker.time as UTCTimestamp,
                position: p.side === "long" ? "belowBar" : "aboveBar",
                shape: p.side === "long" ? "arrowUp" : "arrowDown",
                color: "#d8b778",
                text: "Entry",
              },
            ]
          : [],
      );
      const canvas = overlay.current!,
        w = host.current!.clientWidth,
        h = host.current!.clientHeight,
        dpr = devicePixelRatio || 1;
      if (
        canvas.width !== Math.round(w * dpr) ||
        canvas.height !== Math.round(h * dpr)
      ) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!data.length) return;
      const coordinate = (time: number) => {
        const direct = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
        if (direct !== null) return direct;
        let i = data.findIndex((c) => c.time >= time);
        if (i < 0) i = data.length - 1;
        return (
          chart
            .timeScale()
            .logicalToCoordinate(
              (i + (time - data[i].time) / interval) as Logical,
            ) ?? 0
        );
      };
      const plotWidth = chart.paneSize().width,
        plotHeight = chart.paneSize().height;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotWidth, plotHeight);
      ctx.clip();
      for (const section of sections) {
        const x = coordinate(section.time),
          end = coordinate(section.time + 300),
          y = series.priceToCoordinate(section.open);
        if (end < 0 || x > plotWidth || y === null) continue;
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = "#596681";
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, plotHeight);
        ctx.stroke();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "#d8b778";
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(end, y);
        ctx.stroke();
      }
      ctx.restore();
    }
    frame = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(frame);
      markers.detach();
      chart.remove();
    };
  }, [interval, symbol]);
  return (
    <div className="chart-wrap">
      <div ref={host} className="chart" />
      <canvas ref={overlay} className="chart-overlay" aria-hidden="true" />
      <button className="live-button" onClick={() => live.current()}>
        Return to live
      </button>
    </div>
  );
}
