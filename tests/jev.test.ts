import { test } from "node:test";
import assert from "node:assert/strict";
import { JevService } from "../apps/api/src/jev";
import {
  jevContext,
  jevCommentary,
  jevContrarianComment,
  type JevResult,
} from "../packages/shared/src/jev";
import { emptyMarket, type Candle } from "../packages/shared/src/market";

const now = 90000000;
const candle = (time: number, price: number): Candle => ({
  time,
  open: price,
  close: price + 0.001,
  high: price + 0.002,
  low: price - 0.001,
  volume: 2,
  closed: true,
});
const market = () => ({
  ...emptyMarket("BTCUSDT"),
  ready: true,
  updatedAt: now,
  seconds: Array.from({ length: 300 }, (_, i) =>
    candle(now / 1000 - 300 + i, 100 + i / 1000),
  ),
  minutes: Array.from({ length: 60 }, (_, i) =>
    candle(now / 1000 - 3600 + i * 60, 100 + i / 1000),
  ),
  five: Array.from({ length: 250 }, (_, i) =>
    candle(now / 1000 - 75000 + i * 300, 100 + i / 1000),
  ),
});
const answer = (choice = "wait") => ({
  model: "jev-test",
  answers: {
    action: {
      type: "choice",
      choice,
      confidence: 0.8,
      probabilities: { long: 0.1, short: 0.1, wait: 0.8 },
    },
  },
});

test("context covers five minutes, preserves tiny changes, rejects gaps and stale/future feeds", () => {
  const m = market();
  const context = jevContext(m, now)!;
  assert.equal(context.bars5s.length, 60);
  assert.equal(context.windowStart, now - 300000);
  assert.equal(context.fiveMinuteSession.start, now);
  assert.equal(context.fiveMinuteSession.end, now + 300000);
  assert.equal(context.fiveMinuteSession.remainingSeconds, 300);
  assert.equal(context.decisionWindow.type, "near_term_scalp");
  assert.ok(context.changePct.s5 > 0 && context.changePct.s5 < 0.01);
  assert.ok(context.indicators5m.sma200);
  assert.deepEqual(
    context.timeframeTrends.map((trend) => trend.minutes),
    [15, 30, 60],
  );
  assert.equal(jevContext({ ...m, seconds: m.seconds.slice(1) }, now), null);
  assert.equal(jevContext({ ...m, updatedAt: now - 10000 }, now), null);
  assert.equal(jevContext({ ...m, updatedAt: now + 1 }, now), null);
  assert.equal(jevContext({ ...m, five: m.five.slice(-100) }, now), null);
});

test("Jev batches one action, coalesces concurrent requests, caches, and never calls without a key", async () => {
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(init!.body as string);
    assert.deepEqual(Object.keys(body.questions), ["action"]);
    assert.equal(body.state.bars5s.length, 60);
    assert.equal(body.state.leverage, 100);
    assert.equal(typeof body.state.leveragedChangePct.s30, "number");
    assert.equal(body.state.directionByWindow.s5, "up");
    assert.equal(body.state.timeframeTrends[2].direction, "Bullish");
    assert.equal(body.state.fiveMinuteSession.remainingSeconds, 300);
    assert.equal(body.state.decisionWindow.type, "near_term_scalp");
    assert.match(
      body.questions.action.instructions,
      /Every non-flat price change matters/,
    );
    assert.match(body.questions.action.instructions, /100x nominal leverage/);
    assert.match(
      body.questions.action.criteria.wait.not_for,
      /Do not choose wait merely because the raw move is small/,
    );
    return Response.json(answer());
  };
  const service = new JevService("test", request, () => now);
  const results = await Promise.all([
    service.recommend(market()),
    service.recommend(market()),
  ]);
  assert.equal(calls, 1);
  assert.equal(results[0].available, true);
  assert.equal(results[0].expiresAt, now + 15000);
  await service.recommend(market());
  assert.equal(calls, 1);
  assert.equal(
    (await new JevService("", request).recommend(market())).available,
    false,
  );
  assert.equal(calls, 1);
  // Even a cache hit must not conceal a feed outage.
  assert.equal(
    (await service.recommend({ ...market(), ready: false })).available,
    false,
  );
});

test("malformed output and provider failure produce unavailable states with cooldown", async () => {
  for (const payload of [
    answer("invented"),
    { answers: {} },
    {
      ...answer(),
      answers: { action: { ...answer().answers.action, confidence: 2 } },
    },
  ]) {
    let calls = 0;
    const service = new JevService(
      "test",
      async () => {
        calls++;
        return Response.json(payload);
      },
      () => now,
    );
    assert.equal((await service.recommend(market())).available, false);
    assert.equal((await service.recommend(market())).available, false);
    assert.equal(calls, 1);
  }
  const service = new JevService(
    "test",
    async () => new Response("unavailable", { status: 429 }),
    () => now,
  );
  assert.equal((await service.recommend(market())).available, false);
});

test("entry context changes the judgment; exit wording respects short positions", async () => {
  const position = {
    symbol: "BTCUSDT" as const,
    side: "short" as const,
    entryPrice: 101,
    openedAt: now - 121000,
    extreme: 100,
  };
  const service = new JevService(
    "test",
    async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      assert.equal(body.state.position.elapsedSeconds, 121);
      assert.equal(body.state.leverage, 100);
      assert.equal(body.state.decisionWindow.type, "current_5m_session");
      assert.equal(body.state.decisionWindow.remainingSeconds, 300);
      assert.equal(body.state.position.openedDuringCurrentSession, false);
      assert.equal(
        typeof body.state.position.leveragedGrossReturnPct,
        "number",
      );
      assert.deepEqual(Object.keys(body.questions.action.criteria), [
        "exit",
        "wait",
      ]);
      assert.match(
        body.questions.action.instructions,
        /Choose only exit or wait.*current 5m session/s,
      );
      assert.match(
        body.questions.action.criteria.exit.choose_when,
        /Take profit or close.*current 5m session/,
      );
      assert.match(
        body.questions.action.criteria.wait.choose_when,
        /wait until the current 5m session ends/,
      );
      return Response.json({
        answers: {
          action: {
            type: "choice",
            choice: "exit",
            confidence: 0.8,
            probabilities: { exit: 0.9, wait: 0.1 },
          },
        },
      });
    },
    () => now,
  );
  const result = await service.recommend(market(), position);
  assert.match(result.commentary!, /Buy to cover/);
  assert.match(jevCommentary("wait", result.context!), /current 5m session ends/);
});

test("contrarian position comment calls out disagreement with the pre-entry signal", () => {
  const position = {
    symbol: "BTCUSDT" as const,
    side: "short" as const,
    entryPrice: 100,
    openedAt: now,
    extreme: 100,
  };
  const result = {
    symbol: "BTCUSDT" as const,
    asOf: now - 1,
    expiresAt: now + 15000,
    available: true,
    action: "long" as const,
  } satisfies JevResult;
  assert.match(
    jevContrarianComment(position, result)!,
    /Jev said long; you went short/,
  );
  assert.equal(
    jevContrarianComment({ ...position, side: "long" }, result),
    null,
  );
  assert.equal(
    jevContrarianComment(position, {
      ...result,
      context: jevContext(market(), now, position)!,
    }),
    null,
  );
});

test("global cap bounds unique-position spending", async () => {
  let calls = 0;
  const service = new JevService(
    "test",
    async () => {
      calls++;
      return Response.json({
        answers: {
          action: {
            type: "choice",
            choice: "wait",
            confidence: 0.8,
            probabilities: { exit: 0.1, wait: 0.9 },
          },
        },
      });
    },
    () => now,
  );
  for (let i = 0; i < 13; i++) {
    const result = await service.recommend(market(), {
      symbol: "BTCUSDT",
      side: "long",
      entryPrice: 100,
      extreme: 101,
      openedAt: now - i,
    });
    assert.equal(result.available, i < 12);
  }
  assert.equal(calls, 12);
});
