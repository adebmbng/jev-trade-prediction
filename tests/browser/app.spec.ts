import { test, expect } from "@playwright/test";
test("mobile live chart, intervals, positions, refresh and symbol isolation", async ({
  page,
}) => {
  const errors: string[] = [];
  let jevCalls = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/jev", async (route) => {
    jevCalls++;
    if (jevCalls === 2)
      await new Promise((resolve) => setTimeout(resolve, 500));
    const { symbol, position } = route.request().postDataJSON();
    return route.fulfill({
      json: {
        symbol,
        asOf: Date.now(),
        expiresAt: Date.now() + 15000,
        available: true,
        action: position ? "exit" : "wait",
        confidence: 0.8,
        model: "jev-test",
        commentary: position
          ? `${position.side === "long" ? "Sell / close" : "Buy to cover / close"}. The plan was a scalp, not a lifelong emotional attachment.`
          : "Wait for a clearer move.",
      },
    });
  });
  await page.route("https://data-api.binance.vision/**", async (route) => {
    const url = new URL(route.request().url()),
      interval = url.searchParams.get("interval"),
      step = interval === "1s" ? 1000 : interval === "1m" ? 60000 : 300000;
    const end = Number(url.searchParams.get("endTime") ?? Date.now()),
      count = Number(url.searchParams.get("limit"));
    const last = Math.floor(end / step) * step - step;
    const rows = Array.from({ length: count }, (_, i) => {
      const time = last - (count - 1 - i) * step;
      const price = 60000 + Math.sin(time / 100000) * 20;
      return [
        time,
        String(price),
        String(price + 5),
        String(price - 5),
        String(price + 1),
        "10",
        time + step - 1,
        "0",
        1,
        "0",
        "0",
        "0",
      ];
    });
    await route.fulfill({ json: rows });
  });
  await page.routeWebSocket(/data-stream\.binance\.vision/, (socket) => {
    const timer = setInterval(() => {
      const time = Math.floor(Date.now() / 1000) * 1000;
      socket.send(
        JSON.stringify({
          data: {
            E: Date.now(),
            k: {
              i: "1s",
              t: time,
              o: "60000",
              h: "60005",
              l: "59995",
              c: "60001",
              v: "2",
              x: false,
            },
          },
        }),
      );
    }, 200);
    socket.onClose(() => clearInterval(timer));
  });
  await page.route("**/api/predictions/stream?*", (route) => {
    const symbol = new URL(route.request().url()).searchParams.get("symbol"),
      now = Date.now();
    return route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ symbol, asOf: now, referencePrice: 60000, provider: "Heuristic", modelVersion: "test", available: true, horizons: [5, 30, 60, 120, 300].map((seconds) => ({ seconds, targetTime: now + seconds * 1000, expiresAt: now + 12000, direction: "up", strength: 40, reasons: [] })) })}\n\n`,
    });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Go long" })).toBeEnabled();
  await expect(page.getByText("40 strength").first()).toBeVisible();
  await expect(page.getByText("5 min")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Jev recommendation" }),
  ).toBeVisible();
  await expect(page.getByText("Wait for a clearer move.")).toBeVisible();
  await page.getByRole("button", { name: "30s", exact: true }).click();
  await page.getByRole("button", { name: "1m", exact: true }).click();
  await page.getByRole("button", { name: "5s", exact: true }).click();
  await page.getByRole("button", { name: "Go long" }).click();
  await expect(page.getByText("Refreshing", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Reading the previous call while Jev refreshes it…"),
  ).toBeVisible();
  await expect(page.getByText(/Sell \/ close\. The plan/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your position" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Close position" }),
  ).toBeVisible();
  await page.getByLabel("Trading pair").selectOption("ETHUSDT");
  await expect(page.getByRole("button", { name: "Go short" })).toBeEnabled();
  await page.getByRole("button", { name: "Go short" }).click();
  await expect(
    page.getByText(/Buy to cover \/ close\. The plan/),
  ).toBeVisible();
  await page.getByLabel("Trading pair").selectOption("BTCUSDT");
  await expect(
    page.getByRole("button", { name: "Close position" }),
  ).toBeVisible();
  await expect(page.locator(".status")).toHaveText("Live");
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLCanvasElement>(".chart canvas")].some(
          (canvas) => {
            const ctx = canvas.getContext("2d");
            if (!ctx) return false;
            const pixels = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            for (let i = 0; i < pixels.length; i += 4)
              if (
                pixels[i] === 110 &&
                pixels[i + 1] === 211 &&
                pixels[i + 2] === 187
              )
                return true;
            return false;
          },
        ),
      ),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Close position" }).click();
  await expect(page.getByRole("button", { name: "Go long" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
