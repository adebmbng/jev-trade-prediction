export const SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
export type SymbolName = (typeof SYMBOLS)[number];
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
};
export type Market = {
  symbol: SymbolName;
  seconds: Candle[];
  minutes: Candle[];
  five: Candle[];
  updatedAt: number;
  ready: boolean;
  error: string;
};
export const emptyMarket = (symbol: SymbolName): Market => ({
  symbol,
  seconds: [],
  minutes: [],
  five: [],
  updatedAt: 0,
  ready: false,
  error: "",
});
export function aggregate(input: Candle[], interval: number): Candle[] {
  const unique = [...new Map(input.map((c) => [c.time, c])).values()].sort(
    (a, b) => a.time - b.time,
  );
  const buckets = new Map<number, Candle>();
  const counts = new Map<number, number>();
  for (const c of unique) {
    const time = Math.floor(c.time / interval) * interval;
    const old = buckets.get(time);
    if (!old) buckets.set(time, { ...c, time });
    else {
      old.high = Math.max(old.high, c.high);
      old.low = Math.min(old.low, c.low);
      old.close = c.close;
      old.volume += c.volume;
      old.closed = old.closed && c.closed;
    }
    counts.set(time, (counts.get(time) ?? 0) + 1);
  }
  return [...buckets.values()].map((c) => ({
    ...c,
    closed: c.closed && counts.get(c.time) === interval,
  }));
}
export function connectMarket(
  symbol: SymbolName,
  emit: (m: Market) => void,
  config: { rest?: string; ws?: string } = {},
) {
  const rest = config.rest ?? "https://data-api.binance.vision";
  const ws = config.ws ?? "wss://data-stream.binance.vision";
  const maps = {
    "1s": new Map<number, Candle>(),
    "1m": new Map<number, Candle>(),
    "5m": new Map<number, Candle>(),
  };
  let stopped = false,
    socket: WebSocket,
    retry: ReturnType<typeof setTimeout>,
    attempt = 0,
    generation = 0;
  let state = emptyMarket(symbol);
  const controller = new AbortController();
  const publish = () => {
    const values = (key: keyof typeof maps, limit: number) => {
      const all = [...maps[key].values()].sort((a, b) => a.time - b.time);
      for (const c of all.slice(0, -limit)) maps[key].delete(c.time);
      return all.slice(-limit);
    };
    state = {
      ...state,
      seconds: values("1s", 3600),
      minutes: values("1m", 500),
      five: values("5m", 300),
    };
    emit(state);
  };
  async function history(interval: keyof typeof maps, endTime?: number) {
    const url = new URL("/api/v3/klines", rest);
    url.search = new URLSearchParams({
      symbol,
      interval,
      limit: interval === "1s" ? "1000" : interval === "5m" ? "300" : "500",
      ...(endTime ? { endTime: String(endTime) } : {}),
    }).toString();
    const response = await fetch(url, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    });
    if (!response.ok)
      throw new Error(`Binance history unavailable (${response.status})`);
    const rows = (await response.json()) as (number | string)[][];
    const now = Date.now();
    for (const r of rows) {
      const c = {
        time: Number(r[0]) / 1000,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
        closed: Number(r[6]) < now,
      };
      if (
        !maps[interval].has(c.time) ||
        (!maps[interval].get(c.time)!.closed && c.closed)
      )
        maps[interval].set(c.time, c);
    }
    return Number(rows[0]?.[0]);
  }
  function open() {
    if (stopped) return;
    const run = ++generation;
    state = { ...state, ready: false, error: "Connecting to Binance…" };
    publish();
    socket = new WebSocket(
      `${ws}/stream?streams=${["1s", "1m", "5m"].map((i) => `${symbol.toLowerCase()}@kline_${i}`).join("/")}`,
    );
    socket.onmessage = (event) => {
      if (stopped || run !== generation) return;
      try {
        const { data } = JSON.parse(String(event.data));
        const k = data.k;
        const interval = k.i as keyof typeof maps;
        if (!maps[interval]) return;
        const c = {
          time: k.t / 1000,
          open: +k.o,
          high: +k.h,
          low: +k.l,
          close: +k.c,
          volume: +k.v,
          closed: Boolean(k.x),
        };
        const previous = maps[interval].get(c.time);
        if (!previous?.closed || c.closed) maps[interval].set(c.time, c);
        if (interval === "1s")
          state = { ...state, updatedAt: Math.min(Date.now(), Number(data.E)) };
        publish();
      } catch {
        /* Ignore malformed upstream messages. */
      }
    };
    socket.onopen = async () => {
      try {
        const end = Date.now();
        await Promise.all([
          history("1s", end),
          history("1s", end - 1000000),
          history("1s", end - 2000000),
          history("1m"),
          history("5m"),
        ]);
        if (stopped || run !== generation) return;
        state = { ...state, ready: true, error: "" };
        attempt = 0;
        publish();
      } catch {
        if (!stopped && run === generation) {
          state = {
            ...state,
            ready: false,
            error: "History unavailable. Retrying…",
          };
          publish();
          socket.close();
        }
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (stopped || run !== generation) return;
      generation++;
      state = {
        ...state,
        ready: false,
        error: "Feed disconnected. Reconnecting…",
      };
      publish();
      retry = setTimeout(open, Math.min(30000, 1000 * 2 ** attempt++));
    };
  }
  open();
  const watchdog = setInterval(() => {
    if (state.ready && Date.now() - state.updatedAt > 15000) socket.close();
  }, 5000);
  return () => {
    stopped = true;
    controller.abort();
    clearTimeout(retry);
    clearInterval(watchdog);
    socket?.close();
  };
}
