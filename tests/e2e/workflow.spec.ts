import { expect, test, type Page } from "@playwright/test";
import {
  defaultPreferences,
  type Cloth,
  type Plan,
  type UploadGrant,
  type ClothesDeletionReceipt,
} from "../../packages/schemas/src/index";
import { jstDate, weekStart } from "../../packages/domain/src/index";

test.skip(
  !process.env.E2E_AUTH_MOCKS,
  "Authenticated UI suite needs fixture-configured web server; API/Auth are explicitly mocked.",
);
const top: Cloth = {
  id: "11111111-1111-4111-8111-111111111111",
  category: "top",
  subtype: "shirt",
  color: "白",
  seasons: ["spring", "summer", "autumn", "winter"],
  thickness: "normal",
  wear_limit: 1,
  wears_since_wash: 0,
  state: "available",
  classification_state: "manual",
};
const bottom: Cloth = {
  ...top,
  id: "22222222-2222-4222-8222-222222222222",
  category: "bottom",
  subtype: "slacks",
  color: "黒",
  wear_limit: 3,
};
const uploadGrant: UploadGrant = {
  upload_id: "44444444-4444-4444-8444-444444444444",
  upload_url: "/api/uploads/44444444-4444-4444-8444-444444444444",
  method: "PUT",
  expires_at: "2026-10-14T00:00:00Z",
  headers: { "Content-Type": "image/webp" },
};

async function fixture(
  page: Page,
  options: { locked?: boolean; partial?: boolean; quota?: number } = {},
) {
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 300;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 200, 300);
      ctx.fillStyle = "navy";
      ctx.fillRect(20, 30, 160, 240);
      return canvas.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  const today = jstDate(),
    clothes = structuredClone([top, bottom]);
  const deletions: (ClothesDeletionReceipt & { cloth: Cloth })[] = [];
  const mutations: {
    method: string;
    path: string;
    body: any;
    key: string | undefined;
  }[] = [];
  const plan: Plan = {
    id: "66666666-6666-4666-8666-666666666666",
    target_date: today,
    outfit_id: "33333333-3333-4333-8333-333333333333",
    mode: options.locked ? "manual_lock" : "auto",
    source: options.locked ? "manual" : "rule",
    plan_status: options.partial ? "partial" : "proposed",
    reason_short: "朝の気温に合わせた組み合わせです",
    items: clothes.map((c) => ({
      clothes_id: c.id,
      slot: c.category,
      clothes: c,
    })),
    warnings: options.locked
      ? ["固定した服に洗濯待ちの服があります"]
      : ["靴とアウターは未登録です"],
    weather: {
      date: today,
      min_c: 15,
      max_c: 23,
      rain_probability: 20,
      source: "seasonal",
      fetched_at: null,
      provisional: true,
    },
  };
  await page.addInitScript(() => {
    const user = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      aud: "authenticated",
      role: "authenticated",
      email: "fixture@example.test",
      app_metadata: { provider: "email" },
      user_metadata: {},
      created_at: new Date().toISOString(),
    };
    localStorage.setItem(
      "sb-outfit-test-auth-token",
      JSON.stringify({
        access_token: "fixture.access.token",
        refresh_token: "fixture-refresh",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user,
      }),
    );
  });
  await page.route("https://outfit-test.supabase.co/**", (route) =>
    route.fulfill({
      json: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        email: "fixture@example.test",
      },
    }),
  );
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    expect(req.headers().authorization).toBe("Bearer fixture.access.token");
    if (method !== "GET") {
      let body: any;
      try {
        body = req.postDataJSON();
      } catch {
        body = req.postDataBuffer();
      }
      mutations.push({
        method,
        path,
        body,
        key: req.headers()["idempotency-key"],
      });
      expect(req.headers()["idempotency-key"]).toBeTruthy();
    }
    let data: any = {};
    if (path.endsWith("/image"))
      return route.fulfill({
        body: png,
        contentType: "image/png",
        headers: { "Cache-Control": "private, no-store" },
      });
    if (path === "/api/me/preferences")
      data = { ...defaultPreferences, onboarding_completed: true };
    else if (path === "/api/me/usage")
      data = {
        daily_regens_remaining: options.quota ?? 3,
        weekly_regens_remaining: 2,
        daily_reset_at: "2026-10-14T15:00:00Z",
        weekly_reset_at: "2026-10-18T15:00:00Z",
      };
    else if (path === "/api/outfits/today") data = plan;
    else if (path === "/api/plans/weekly")
      data = { week: weekStart(today), days: [plan] };
    else if (path.startsWith("/api/me/day-overrides/"))
      data =
        method === "GET"
          ? {
              override: {
                target_date: today,
                is_workday: true,
                occasion: "external_visit",
                mood: "きれいめ",
              },
            }
          : { target_date: today, ...req.postDataJSON() };
    else if (path === "/api/clothes/deletions") {
      const server_now = new Date().toISOString();
      data = {
        items: deletions
          .filter((r) => Date.parse(r.undo_until) > Date.now())
          .map(({ cloth, ...receipt }) => ({ ...receipt, server_now })),
        server_now,
      };
    } else if (path === "/api/clothes/upload-url") data = uploadGrant;
    else if (path.startsWith("/api/uploads/"))
      data = { ok: true, upload_id: path.split("/").at(-1) };
    else if (path === "/api/clothes") {
      if (method === "POST") {
        const payload = req.postDataJSON();
        data = {
          ...top,
          ...payload,
          id: "55555555-5555-4555-8555-555555555555",
          classification_state: "manual",
        };
        clothes.push(data);
      } else
        data = { items: clothes, total: clothes.length, page: 1, limit: 100 };
    } else if (path === "/api/wear-logs" && method === "POST") {
      plan.plan_status = "confirmed";
      clothes[0].wears_since_wash = 1;
      clothes[0].state = "laundry";
      clothes[1].wears_since_wash = 1;
      data = {
        id: "77777777-7777-4777-8777-777777777777",
        target_date: today,
        outfit_id: plan.outfit_id,
        confirmed_at: `${today}T00:00:00Z`,
      };
    } else if (path === "/api/wear-logs")
      data = {
        items:
          plan.plan_status === "confirmed"
            ? [
                {
                  id: "77777777-7777-4777-8777-777777777777",
                  target_date: today,
                  outfit_id: plan.outfit_id,
                  confirmed_at: `${today}T00:00:00Z`,
                  items: plan.items,
                },
              ]
            : [],
      };
    else if (path.endsWith("/washed")) {
      const c = clothes.find((c) => path.includes(c.id))!;
      c.wears_since_wash = 0;
      c.state = "available";
      data = c;
    } else if (path.endsWith("/restore")) {
      const receipt = deletions.find(
        (r) =>
          path.includes(r.clothes_id) &&
          r.deletion_token === req.postDataJSON().deletion_token,
      );
      if (!receipt || Date.parse(receipt.undo_until) <= Date.now())
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "UNDO_EXPIRED",
              message: "取り消せる時間を過ぎました",
              request_id: crypto.randomUUID(),
            },
          },
        });
      data = receipt.cloth;
      clothes.push(data);
      deletions.splice(deletions.indexOf(receipt), 1);
    } else if (path.startsWith("/api/clothes/")) {
      data = clothes.find((c) => path.includes(c.id));
      if (method === "PATCH") Object.assign(data, req.postDataJSON());
      if (method === "DELETE") {
        const server_now = new Date().toISOString();
        const receipt = {
          ok: true as const,
          category: data.category,
          color: data.color,
          clothes_id: data.id,
          deletion_token: crypto.randomUUID(),
          server_now,
          undo_until: new Date(Date.now() + 30_000).toISOString(),
        };
        deletions.push({ ...receipt, cloth: structuredClone(data) });
        clothes.splice(clothes.indexOf(data), 1);
        data = receipt;
      }
    } else if (path.startsWith("/api/plans/")) data = plan;
    return route.fulfill({ json: data });
  });
  return { mutations, clothes, plan, today, png, deletions };
}

async function deleteTop(page: Page) {
  await page.goto(`/closet/${top.id}`);
  await page.getByRole("button", { name: "この服を削除", exact: true }).click();
  await expect(
    page.getByText("この服を削除しますか？", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "削除する", exact: true }).click();
  await expect(page).toHaveURL(/\/closet$/);
}

test("deletion Undo survives reload and restores the original laundry state", async ({
  page,
}) => {
  const s = await fixture(page);
  s.clothes[0].state = "laundry";
  s.clothes[0].wears_since_wash = 1;
  await deleteTop(page);
  await expect(
    page.getByRole("button", { name: "削除を取り消す", exact: true }),
  ).toBeEnabled();
  expect(s.clothes.map((c) => c.id)).not.toContain(top.id);
  await page.reload();
  await page
    .getByRole("button", { name: "削除を取り消す", exact: true })
    .click();
  await expect(
    page.getByText("削除を取り消しました", { exact: true }),
  ).toBeVisible();
  expect(s.clothes.find((c) => c.id === top.id)).toMatchObject({
    state: "laundry",
    wears_since_wash: 1,
  });
  const restores = s.mutations.filter((m) => m.path.endsWith("/restore"));
  expect(restores).toHaveLength(1);
  expect(restores[0].body).toEqual({ deletion_token: expect.any(String) });
  await page.goto(`/closet/${top.id}`);
  await expect(page.getByText("洗濯待ち", { exact: true })).toBeVisible();
  expect(s.mutations.some((m) => m.path.endsWith("/washed"))).toBe(false);
});

test("lost deletion response recovers server receipt and offers Undo", async ({
  page,
}) => {
  const s = await fixture(page);
  const deleteKeys: string[] = [];
  await page.route(`**/api/clothes/${top.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deleteKeys.push(route.request().headers()["idempotency-key"]);
    if (deleteKeys.length > 1) return route.fallback();
    const cloth = s.clothes.splice(0, 1)[0];
    const server_now = new Date().toISOString();
    s.deletions.push({
      ok: true,
      category: cloth.category,
      color: cloth.color,
      clothes_id: cloth.id,
      cloth,
      deletion_token: crypto.randomUUID(),
      server_now,
      undo_until: new Date(Date.now() + 30_000).toISOString(),
    });
    return route.abort("failed");
  });
  await deleteTop(page);
  await expect(
    page.getByRole("button", { name: "削除を取り消す", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "削除を取り消す", exact: true })
    .click();
  await expect(
    page.getByText("削除を取り消しました", { exact: true }),
  ).toBeVisible();
  await deleteTop(page);
  expect(deleteKeys).toHaveLength(2);
  expect(deleteKeys[1]).not.toBe(deleteKeys[0]);
  expect(s.clothes.map((c) => c.id)).not.toContain(top.id);
});

test("successful restoration with an unreadable response survives receipt refresh and confirms after the Undo deadline", async ({
  page,
}) => {
  const s = await fixture(page);
  await page.clock.install();
  const keys: string[] = [];
  let restored: Cloth;
  await page.route(`**/api/clothes/${top.id}/restore`, (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 1) {
      restored = s.deletions.splice(0, 1)[0].cloth;
      s.clothes.push(restored);
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!DOCTYPE html><html></html>",
      });
    }
    return route.fulfill({ json: restored });
  });
  await deleteTop(page);
  await page
    .getByRole("button", { name: "削除を取り消す", exact: true })
    .click();
  const confirmation = page.getByRole("button", {
    name: "取り消し結果を確認",
    exact: true,
  });
  await expect(confirmation).toBeEnabled();
  const manualRefresh = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/clothes/deletions",
  );
  await page
    .getByRole("button", { name: "削除状態を再確認", exact: true })
    .click();
  expect((await (await manualRefresh).json()).items).toEqual([]);
  await expect(confirmation).toBeEnabled();
  const visibilityRefresh = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/clothes/deletions",
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  expect((await (await visibilityRefresh).json()).items).toEqual([]);
  await expect(confirmation).toBeEnabled();
  await page.clock.fastForward(31_000);
  await expect(confirmation).toBeEnabled();
  await confirmation.click();
  await expect(
    page.getByText("削除を取り消しました", { exact: true }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(s.clothes.filter((c) => c.id === top.id)).toHaveLength(1);
});

test("manual closet navigation recovers deletion after its response and detail recovery both fail without reusing the old key", async ({
  page,
}) => {
  const s = await fixture(page);
  const deleteKeys: string[] = [];
  let failedRecovery = false;
  await page.route("**/api/clothes/deletions", (route) => {
    if (deleteKeys.length === 1 && !failedRecovery) {
      failedRecovery = true;
      return route.abort("failed");
    }
    return route.fallback();
  });
  await page.route(`**/api/clothes/${top.id}`, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deleteKeys.push(route.request().headers()["idempotency-key"]);
    if (deleteKeys.length > 1) return route.fallback();
    const cloth = s.clothes.splice(0, 1)[0],
      server_now = new Date().toISOString();
    s.deletions.push({
      ok: true,
      category: cloth.category,
      color: cloth.color,
      clothes_id: cloth.id,
      cloth,
      deletion_token: crypto.randomUUID(),
      server_now,
      undo_until: new Date(Date.now() + 30_000).toISOString(),
    });
    return route.abort("failed");
  });
  await page.goto(`/closet/${top.id}`);
  await page.getByRole("button", { name: "この服を削除", exact: true }).click();
  await page.getByRole("button", { name: "削除する", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(failedRecovery).toBe(true);
  await page.getByRole("link", { name: "クローゼット", exact: true }).click();
  await page
    .getByRole("button", { name: "削除を取り消す", exact: true })
    .click();
  await expect(
    page.getByText("削除を取り消しました", { exact: true }),
  ).toBeVisible();
  await deleteTop(page);
  expect(deleteKeys).toHaveLength(2);
  expect(deleteKeys[0]).toBeTruthy();
  expect(deleteKeys[1]).not.toBe(deleteKeys[0]);
});

test("failed restoration keeps Undo retryable and reuses its operation key", async ({
  page,
}) => {
  const s = await fixture(page);
  const operationKeys: string[] = [];
  await page.route(`**/api/clothes/${top.id}/restore`, (route) => {
    operationKeys.push(route.request().headers()["idempotency-key"]);
    if (operationKeys.length === 1) return route.abort("failed");
    return route.fallback();
  });
  await deleteTop(page);
  await page
    .getByRole("button", { name: "削除を取り消す", exact: true })
    .click();
  await expect(
    page.getByText("取り消し結果を確認できませんでした。", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "取り消し結果を確認", exact: true })
    .click();
  await expect(
    page.getByText("削除を取り消しました", { exact: true }),
  ).toBeVisible();
  expect(operationKeys).toHaveLength(2);
  expect(operationKeys[0]).toBeTruthy();
  expect(operationKeys[1]).toBe(operationKeys[0]);
  expect(s.clothes.filter((c) => c.id === top.id)).toHaveLength(1);
});

test("Undo countdown uses server duration even when the device clock is wrong", async ({
  page,
}) => {
  const s = await fixture(page);
  const server_now = "2026-01-01T00:00:00Z";
  await page.route("**/api/clothes/deletions", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            ok: true,
            category: "top",
            color: "白",
            clothes_id: top.id,
            deletion_token: "99999999-9999-4999-8999-999999999999",
            server_now,
            undo_until: "2026-01-01T00:00:01Z",
          },
        ],
        server_now,
      },
    }),
  );
  await page.goto("/closet");
  const undo = page.getByRole("button", {
    name: "削除を取り消す",
    exact: true,
  });
  await expect(undo).toBeEnabled();
  await expect(undo).toBeDisabled();
  await expect(
    page.getByText("削除を取り消せる時間を過ぎました。", { exact: true }),
  ).toBeVisible();
  expect(s.mutations.filter((m) => m.path.endsWith("/restore"))).toEqual([]);
});

test("capacity failure explains the limit and leaves Undo available for another attempt", async ({
  page,
}) => {
  await fixture(page);
  let attempts = 0;
  await page.route(`**/api/clothes/${top.id}/restore`, (route) => {
    if (++attempts > 1) return route.fallback();
    return route.fulfill({
      status: 429,
      json: {
        error: {
          code: "CLOTHES_LIMIT",
          message: "登録上限に達しています。別の服を削除すると取り消せます",
          request_id: crypto.randomUUID(),
        },
      },
    });
  });
  await deleteTop(page);
  const undo = page.getByRole("button", {
    name: "削除を取り消す",
    exact: true,
  });
  await undo.click();
  await expect(page.getByRole("alert")).toContainText("登録上限");
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(
    page.getByText("削除を取り消しました", { exact: true }),
  ).toBeVisible();
});

test("today → confirm → reload → history → wash workflow", async ({
  page,
}, testInfo) => {
  const s = await fixture(page);
  await page.goto("/today");
  await expect(
    page.getByRole("heading", { name: "今日の服は、これ。" }),
  ).toBeVisible();
  await expect(page.getByText("靴とアウターは未登録です")).toBeVisible();
  if (testInfo.project.name === "mobile-chromium") {
    const button = page.getByRole("button", {
      name: "これを着た",
      exact: true,
    });
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize()!;
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    expect(
      await button.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return hit !== null && el.contains(hit);
      }),
    ).toBe(true);
  }
  await page.getByRole("button", { name: "これを着た", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "今日の着用を記録しました" }),
  ).toBeDisabled();
  expect(s.mutations.filter((m) => m.path === "/api/wear-logs")).toHaveLength(
    1,
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "今日の着用を記録しました" }),
  ).toBeDisabled();
  expect(s.mutations.filter((m) => m.path === "/api/wear-logs")).toHaveLength(
    1,
  );
  await page.goto("/history");
  await expect(page.getByRole("button", { name: "記録を訂正" })).toBeVisible();
  await page
    .getByRole("button", { name: "白のトップスを洗濯済みにする" })
    .click();
  await expect(
    page.getByText("洗濯済みにしました。次の提案に使えます。"),
  ).toBeVisible();
  expect(s.clothes[0].wears_since_wash).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("manual lock and laundry warning disable AI replacement", async ({
  page,
}) => {
  await fixture(page, { locked: true });
  await page.goto("/today");
  await expect(page.getByText("手動固定", { exact: true })).toBeVisible();
  await expect(
    page.getByText("固定した服に洗濯待ちの服があります"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /別の服にする/ }),
  ).toBeDisabled();
});

test("quota exhaustion and incomplete outfit disable unsafe actions", async ({
  page,
}) => {
  await fixture(page, { quota: 0, partial: true });
  await page.goto("/today");
  await expect(
    page.getByRole("button", { name: "これを着た", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /別の服にする/ }),
  ).toBeDisabled();
});

for (const [label, contentType, body] of [
  [
    "HTML returned as a successful API response",
    "text/html",
    "<!DOCTYPE html><html><body>private-response-marker</body></html>",
  ],
  ["invalid JSON", "application/json", '{"target_date":'],
  ["JSON outside the shared plan contract", "application/json", '{"items":{}}'],
] as const) {
  test(`${label} shows Japanese guidance without leaking response data`, async ({
    page,
  }) => {
    await fixture(page);
    const exceptions: string[] = [];
    page.on("pageerror", (error) => exceptions.push(error.message));
    await page.route("**/api/outfits/today", (route) =>
      route.fulfill({ status: 200, contentType, body }),
    );
    await page.goto("/today");
    await expect(page.getByRole("alert")).toContainText(
      "データを読み取れませんでした",
    );
    await expect(page.getByRole("alert")).not.toContainText(
      /Unexpected token|DOCTYPE|private-response-marker/,
    );
    await expect(
      page.getByRole("status").filter({ hasText: "読み込み中です" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "これを着た", exact: true }),
    ).toHaveCount(0);
    expect(exceptions).toEqual([]);
  });
}

test("HTML in an image response shows a placeholder and leaves outfit actions usable", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/clothes/*/image", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!DOCTYPE html><html></html>",
    }),
  );
  await page.goto("/today");
  await expect(page.getByText("写真を読み込めません")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "これを着た", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("img", { name: /のトップス|のボトムス/ }),
  ).toHaveCount(0);
});

test("today retries failed reads and recovers without requiring another login", async ({
  page,
}) => {
  const s = await fixture(page);
  let attempts = 0;
  await page.route("**/api/outfits/today", (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!DOCTYPE html><html></html>",
        })
      : route.fulfill({ json: s.plan });
  });
  await page.goto("/today");
  await expect(page.getByRole("alert")).toContainText(
    "データを読み取れませんでした",
  );
  await page
    .getByRole("button", { name: "もう一度読み込む", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "これを着た", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(s.mutations).toEqual([]);
});

test("an undecodable image with a valid MIME type recovers to its placeholder", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/clothes/*/image", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/webp",
      body: Buffer.from("invalid image bytes"),
    }),
  );
  await page.goto("/today");
  await expect(page.getByText("写真を読み込めません")).toHaveCount(2);
  await expect(
    page.getByRole("img", { name: /のトップス|のボトムス/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "これを着た", exact: true }),
  ).toBeEnabled();
});

test("successful regeneration followed by an unreadable usage response retries only reads", async ({
  page,
}) => {
  const s = await fixture(page);
  let regens = 0;
  let usageReads = 0;
  await page.route("**/api/outfits/today/regenerate", (route) => {
    regens++;
    s.plan.reason_short = "再提案が完了しました";
    return route.fulfill({ json: { ...s.plan, daily_regens_remaining: 2 } });
  });
  await page.route("**/api/me/usage", (route) => {
    usageReads++;
    if (usageReads === 2)
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!DOCTYPE html><html></html>",
      });
    return route.fulfill({
      json: {
        daily_regens_remaining: regens ? 2 : 3,
        weekly_regens_remaining: 2,
        daily_reset_at: "2026-10-14T15:00:00Z",
        weekly_reset_at: "2026-10-18T15:00:00Z",
      },
    });
  });
  await page.goto("/today");
  await expect(
    page.getByRole("button", { name: /別の服にする/ }),
  ).toBeEnabled();
  await page.getByRole("button", { name: /別の服にする/ }).click();
  await page
    .getByRole("button", { name: "もう一度提案する", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "データを読み取れませんでした",
  );
  await expect(
    page.getByRole("button", { name: "もう一度提案する", exact: true }),
  ).toHaveCount(0);
  expect(regens).toBe(1);
  await page
    .getByRole("button", { name: "もう一度読み込む", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("再提案が完了しました")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /別の服にする/ }),
  ).toContainText("あと2回");
  expect(usageReads).toBe(3);
  expect(regens).toBe(1);
});

test("a legitimate absent plan finishes loading and offers useful navigation", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/outfits/today", (route) =>
    route.fulfill({ contentType: "application/json", body: "null" }),
  );
  await page.goto("/today");
  await expect(
    page.getByRole("heading", { name: "今日の服がまだありません。" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "読み込み中です" }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "これを着た", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "今日の予定を確認" }),
  ).toBeVisible();
});

test("successful weekly regeneration recovers from unreadable usage using GET only", async ({
  page,
}) => {
  const s = await fixture(page);
  let regens = 0;
  let usageReads = 0;
  await page.route("**/api/plans/weekly/regenerate", (route) => {
    regens++;
    s.plan.reason_short = "週間の再提案が完了しました";
    return route.fulfill({
      json: {
        week: weekStart(s.today),
        days: [s.plan],
        weekly_regens_remaining: 1,
      },
    });
  });
  await page.route("**/api/me/usage", (route) => {
    usageReads++;
    if (usageReads === 2)
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!DOCTYPE html><html></html>",
      });
    return route.fulfill({
      json: {
        daily_regens_remaining: 3,
        weekly_regens_remaining: regens ? 1 : 2,
        daily_reset_at: "2026-10-14T15:00:00Z",
        weekly_reset_at: "2026-10-18T15:00:00Z",
      },
    });
  });
  await page.goto("/week");
  const regenerate = page.getByRole("button", {
    name: "一週間を作り直す",
    exact: true,
  });
  await expect(regenerate).toBeEnabled();
  await regenerate.click();
  await expect(page.getByRole("alert")).toContainText(
    "データを読み取れませんでした",
  );
  await expect(regenerate).toBeDisabled();
  expect(regens).toBe(1);
  await page
    .getByRole("button", { name: "もう一度読み込む", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("週間の再提案が完了しました")).toBeVisible();
  await expect(page.getByText("今週あと1回。", { exact: false })).toBeVisible();
  await expect(regenerate).toBeEnabled();
  expect(usageReads).toBe(3);
  expect(regens).toBe(1);
});

test("day editor loads saved override and sends manual fixed outfit", async ({
  page,
}) => {
  const s = await fixture(page);
  await page.goto(`/week/${s.today}`);
  await expect(page.getByLabel("特別な予定")).toHaveValue("external_visit");
  await expect(page.getByLabel("気分（任意）")).toHaveValue("きれいめ");
  await page.getByRole("button", { name: "このコーデで固定" }).click();
  await expect(page).toHaveURL(/\/week$/);
  const saved = s.mutations.find((m) => m.path === `/api/plans/${s.today}`);
  expect(saved?.body.items).toEqual([
    { slot: "top", clothes_id: top.id },
    { slot: "bottom", clothes_id: bottom.id },
  ]);
});

test("manual photo registration compresses to WebP and saves explicit metadata", async ({
  page,
}) => {
  const s = await fixture(page);
  await page.goto("/closet/new");
  await page
    .getByLabel("服の写真")
    .setInputFiles({ name: "shirt.png", mimeType: "image/png", buffer: s.png });
  await page.getByLabel("種類・色・季節を自分で入力する").check();
  await page.getByLabel("色", { exact: true }).fill("白");
  await page.getByRole("button", { name: "この服を登録", exact: true }).click();
  await expect(page.getByText(/服を登録しました/)).toBeVisible();
  const upload = s.mutations.find((m) => m.path.startsWith("/api/uploads/"));
  expect(Buffer.isBuffer(upload?.body)).toBe(true);
  expect((upload!.body as Buffer).subarray(0, 4).toString()).toBe("RIFF");
  expect((upload!.body as Buffer).subarray(8, 12).toString()).toBe("WEBP");
  expect(
    s.mutations.find((m) => m.path === "/api/clothes")?.body,
  ).toMatchObject({ category: "top", color: "白" });
  await expect(
    page.getByRole("button", { name: "この服で、まず試す" }),
  ).toBeEnabled();
});

test("availability toggle does not pretend an item was washed or change its wear counter", async ({
  page,
}) => {
  const s = await fixture(page);
  s.clothes[0].state = "laundry";
  s.clothes[0].wears_since_wash = 1;
  await page.goto(`/closet/${top.id}`);
  await expect(
    page.getByText("洗濯待ち", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("提案に使える状態").click();
  await expect(page.getByLabel("提案に使える状態")).not.toBeChecked();
  const mutation = s.mutations.find((m) => m.method === "PATCH");
  expect(mutation?.body).toEqual({ is_available: false });
  expect(s.mutations.some((m) => m.path.endsWith("/washed"))).toBe(false);
});

test("deletion receipt remains accessible after logout and shows actual completion", async ({
  page,
}) => {
  await fixture(page);
  const receipt = "66666666-6666-4666-8666-666666666666";
  await page.route("**/api/account/delete", (route) =>
    route.fulfill({
      status: 202,
      json: { status: "deleting", job_id: receipt },
    }),
  );
  await page.route(`**/api/account/deletion-status/${receipt}`, (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({ json: { status: "completed" } });
  });
  await page.goto("/account/delete");
  await page.getByLabel("すべてのデータが削除されることを確認しました").check();
  await page.getByLabel("確認のため「退会する」と入力").fill("退会する");
  await page
    .getByRole("button", { name: "退会してデータを削除", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/account/deletion-status\\?receipt=${receipt}`),
  );
  await expect(
    page.getByRole("heading", { name: "データを削除しました" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("sb-outfit-test-auth-token")),
    )
    .toBeNull();
});

test("uncertain upload completion retries one logical garment with the same grant and key", async ({
  page,
}) => {
  const s = await fixture(page);
  let reserveCount = 0;
  const creates: { key: string; upload_id: string }[] = [];
  await page.route("**/api/clothes/upload-url", (route) => {
    reserveCount++;
    return route.fulfill({ json: uploadGrant });
  });
  await page.route("**/api/clothes", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    creates.push({
      key: route.request().headers()["idempotency-key"],
      upload_id: route.request().postDataJSON().upload_id,
    });
    if (creates.length === 1) return route.abort("connectionreset");
    return route.fulfill({
      json: { ...top, id: "55555555-5555-4555-8555-555555555555" },
    });
  });
  await page.goto("/closet/new");
  await page
    .getByLabel("服の写真")
    .setInputFiles({ name: "shirt.png", mimeType: "image/png", buffer: s.png });
  await page.getByRole("button", { name: "この服を登録", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "この服を登録", exact: true }).click();
  await expect(page.getByText(/服を登録しました/)).toBeVisible();
  expect(reserveCount).toBe(1);
  expect(creates).toHaveLength(2);
  expect(creates[1]).toEqual(creates[0]);
});

test("PKCE callback exchanges once and rejects arbitrary redirect targets", async ({
  page,
}) => {
  await fixture(page);
  let exchanges = 0;
  await page.addInitScript(() => {
    localStorage.setItem(
      "sb-outfit-test-auth-token-code-verifier",
      JSON.stringify("test-code-verifier"),
    );
  });
  await page.route(
    "https://outfit-test.supabase.co/auth/v1/token**",
    (route) => {
      exchanges++;
      return route.fulfill({
        json: {
          access_token: "fixture.access.token",
          refresh_token: "fixture-refresh",
          token_type: "bearer",
          expires_in: 3600,
          user: {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            aud: "authenticated",
            role: "authenticated",
            email: "fixture@example.test",
            app_metadata: {},
            user_metadata: {},
            created_at: new Date().toISOString(),
          },
        },
      });
    },
  );
  await page.goto(
    "/auth/callback?code=one-time-test-code&next=https://evil.example/",
  );
  await expect(page).toHaveURL(/\/today$/);
  await expect(
    page.getByRole("heading", { name: "今日の服は、これ。" }),
  ).toBeVisible();
  expect(exchanges).toBe(1);
});

test("capture reviewed desktop landing and mobile today visual artifacts", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "desktop-chromium") {
    await page.goto("/");
    await page.screenshot({
      path: ".local/screenshots/desktop-landing.png",
      fullPage: true,
    });
  } else {
    await fixture(page);
    await page.goto("/today");
    await expect(
      page.getByRole("button", { name: "これを着た", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: ".local/screenshots/mobile-today-mocked.png",
      fullPage: true,
    });
  }
});
