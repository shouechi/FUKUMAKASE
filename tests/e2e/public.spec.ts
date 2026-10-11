import { expect, test } from "@playwright/test";

test("landing page provides registration and login without horizontal overflow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: /登録|はじめる|始める/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /ログイン/ }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("signup collects only email/password and offers Google authentication", async ({
  page,
}) => {
  await page.goto("/signup");
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]').first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Google/ })).toBeVisible();
  await expect(
    page.locator(
      'input[type="tel"], input[type="date"], input[name="name"], input[name="display_name"], input[name="address"]',
    ),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("login and password recovery are accessible", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /Google/ })).toBeVisible();
  await page.getByRole("link", { name: /パスワード/ }).click();
  await expect(page).toHaveURL(/forgot-password/);
  await expect(page.locator('input[type="email"]')).toBeVisible();
});

test("public policy explains external processing, deletion and backup retention", async ({
  page,
}) => {
  await page.goto("/privacy");
  for (const text of [
    "Supabase",
    "Cloudflare",
    "OpenAI",
    "削除",
    "バックアップ",
  ]) {
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
  }
  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: /利用規約/ })).toBeVisible();
});

test("unauthenticated private routes do not display clothing data", async ({
  page,
}) => {
  await page.goto("/today");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("button", { name: "ログイン", exact: true }),
  ).toBeVisible();
  await expect(page.locator('img[src*="private/"]')).toHaveCount(0);
});
