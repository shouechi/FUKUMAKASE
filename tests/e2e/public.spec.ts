import { expect, test, type Page } from "@playwright/test";

async function waitForAuthHydration(page: Page) {
  // The development server sends usable-looking SSR controls before React loads.
  // Wait for their client handlers, not an arbitrary delay, before exercising state.
  await page.waitForFunction(() => {
    const input = document.querySelector("#auth-password") as
      (HTMLInputElement & Record<string, unknown>) | null;
    return (
      input &&
      Object.keys(input).some((key) => {
        const props = input[key] as { onChange?: unknown } | undefined;
        return (
          key.startsWith("__reactProps$") &&
          typeof props?.onChange === "function"
        );
      })
    );
  });
}

const newPasswordRequirement =
  "8文字以上で、英小文字・英大文字・数字・記号をそれぞれ1文字以上含めてください。";
const maximumPasswordRequirement =
  "パスワードが長すぎます。72バイト以内（半角英数字・記号なら72文字以内）に短くしてください。";

for (const path of ["/signup", "/reset-password"]) {
  test(`UTF-8 maximum blocks 73+ bytes and sends exactly 72 bytes on ${path}`, async ({
    page,
  }) => {
    const user = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      aud: "authenticated",
      role: "authenticated",
      email: "auth-regression@example.test",
      app_metadata: {},
      user_metadata: {},
      identities: [],
      created_at: new Date().toISOString(),
    };
    if (path === "/reset-password") {
      await page.addInitScript((user) => {
        localStorage.setItem(
          "sb-outfit-test-auth-token",
          JSON.stringify({
            access_token: "fixture.access.token",
            refresh_token: "fixture-refresh",
            token_type: "bearer",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            expires_in: 3600,
            user,
          }),
        );
      }, user);
    }
    const requests: string[] = [];
    const passwords: string[] = [];
    await page.route("**/auth/v1/**", (route) => {
      requests.push(route.request().method());
      const body = route.request().postDataJSON();
      if (body?.password) passwords.push(body.password);
      return route.fulfill({ json: user });
    });
    await page.goto(path);
    await waitForAuthHydration(page);
    const password = page.getByLabel("パスワード", { exact: true });
    const submit = page.getByRole("button", {
      name: path === "/signup" ? "無料で登録" : "パスワードを更新",
      exact: true,
    });
    if (path === "/signup")
      await page.getByLabel("メールアドレス", { exact: true }).fill(user.email);

    for (const invalid of [
      `Aa1!${"a".repeat(69)}`,
      `Aa1!${"あ".repeat(22)}aaa`,
      `Aa1!${"😀".repeat(16)}aaaaa`,
      `Aa1!${"a".repeat(76)}`,
    ]) {
      expect(new TextEncoder().encode(invalid).byteLength).toBeGreaterThan(72);
      const before = requests.length;
      await password.fill(invalid);
      await submit.click();
      await expect(page.getByRole("alert")).toHaveText(
        maximumPasswordRequirement,
      );
      await expect(password).toHaveAttribute("aria-invalid", "true");
      await expect(password).toHaveValue(invalid);
      if (path === "/signup")
        await expect(
          page.getByLabel("メールアドレス", { exact: true }),
        ).toHaveValue(user.email);
      expect(requests).toHaveLength(before);
    }
    expect(passwords).toEqual([]);
    const validValues = [
      `Aa1!${"a".repeat(68)}`,
      `Aa1!${"あ".repeat(22)}aa`,
      `Aa1!${"😀".repeat(16)}aaaa`,
    ];
    for (const valid of validValues) {
      expect(new TextEncoder().encode(valid).byteLength).toBe(72);
      if (path === "/signup")
        await page
          .getByLabel("メールアドレス", { exact: true })
          .fill(user.email);
      await password.fill(valid);
      await expect(password).toHaveAttribute("aria-invalid", "false");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await submit.click();
      await expect
        .poll(() => passwords.length)
        .toBe(validValues.indexOf(valid) + 1);
      await expect(submit).toBeEnabled();
      await expect(page.getByRole("status")).toHaveText(
        path === "/signup"
          ? "メールが届いた場合は、本文のリンクから登録を完了してください。"
          : "パスワードを更新しました。",
      );
    }
    expect(passwords).toEqual(validValues);
  });
}

for (const path of ["/signup", "/reset-password"]) {
  test(`new password policy blocks invalid values before Auth on ${path}`, async ({
    page,
  }) => {
    let authRequests = 0;
    await page.route("**/auth/v1/**", (route) => {
      authRequests++;
      return route.fulfill({
        status: 400,
        json: { msg: "Unexpected Auth request" },
      });
    });
    await page.goto(path);
    await waitForAuthHydration(page);
    if (path === "/signup")
      await page
        .getByLabel("メールアドレス", { exact: true })
        .fill("auth-regression@example.test");
    const password = page.getByLabel("パスワード", { exact: true });
    const submit = page.getByRole("button", {
      name: path === "/signup" ? "無料で登録" : "パスワードを更新",
      exact: true,
    });
    for (const invalid of [
      "Aa1!aaa",
      "AA1!AAAA",
      "aa1!aaaa",
      "AaA!aaaa",
      "Aa12aaaa",
      "Aa1 aaaa",
      "Aa1！aaaa",
      "Aa1😀aaaa",
    ]) {
      await password.fill(invalid);
      await submit.click();
      await expect(page.getByRole("alert")).toHaveText(newPasswordRequirement);
      await expect(password).toHaveAttribute("aria-invalid", "true");
      await expect(password).toHaveValue(invalid);
      if (path === "/signup")
        await expect(
          page.getByLabel("メールアドレス", { exact: true }),
        ).toHaveValue("auth-regression@example.test");
      expect(authRequests).toBe(0);
    }
    await password.fill("Aa1!aaaa");
    await expect(password).toHaveAttribute("aria-invalid", "false");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(authRequests).toBe(0);
  });
}

test("new password policy permits shortest valid signup password to reach Auth", async ({
  page,
}) => {
  const passwords: string[] = [];
  await page.route("**/auth/v1/signup**", (route) => {
    passwords.push(route.request().postDataJSON().password);
    return route.fulfill({
      json: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        email: "auth-regression@example.test",
        identities: [],
      },
    });
  });
  await page.goto("/signup");
  await waitForAuthHydration(page);
  await page
    .getByLabel("メールアドレス", { exact: true })
    .fill("auth-regression@example.test");
  await page.getByLabel("パスワード", { exact: true }).fill("Aa1!aaaa");
  await page.getByRole("button", { name: "無料で登録", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "メールが届いた場合は、本文のリンクから登録を完了してください。",
  );
  expect(passwords).toEqual(["Aa1!aaaa"]);
});

test("new password policy permits shortest valid reset password to reach Auth", async ({
  page,
}) => {
  const user = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    aud: "authenticated",
    role: "authenticated",
    email: "auth-regression@example.test",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
  await page.addInitScript((user) => {
    localStorage.setItem(
      "sb-outfit-test-auth-token",
      JSON.stringify({
        access_token: "fixture.access.token",
        refresh_token: "fixture-refresh",
        token_type: "bearer",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600,
        user,
      }),
    );
  }, user);
  const passwords: string[] = [];
  await page.route("**/auth/v1/**", (route) => {
    if (route.request().method() === "PUT")
      passwords.push(route.request().postDataJSON().password);
    return route.fulfill({ json: user });
  });
  await page.goto("/reset-password");
  await waitForAuthHydration(page);
  await page.getByLabel("パスワード", { exact: true }).fill("Aa1!aaaa");
  await page
    .getByRole("button", { name: "パスワードを更新", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "パスワードを更新しました。",
  );
  expect(passwords).toEqual(["Aa1!aaaa"]);
});

test("login still sends a legacy weak password without the new-password policy", async ({
  page,
}) => {
  const passwords: string[] = [];
  await page.route("**/auth/v1/token**", (route) => {
    passwords.push(route.request().postDataJSON().password);
    return route.fulfill({
      status: 400,
      json: { code: "invalid_credentials", msg: "Invalid login credentials" },
    });
  });
  await page.goto("/login");
  await waitForAuthHydration(page);
  const password = page.getByLabel("パスワード", { exact: true });
  await page
    .getByLabel("メールアドレス", { exact: true })
    .fill("auth-regression@example.test");
  const legacyPasswords = ["old", "a".repeat(73)];
  for (const legacyPassword of legacyPasswords) {
    await password.fill(legacyPassword);
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect
      .poll(() => passwords.length)
      .toBe(legacyPasswords.indexOf(legacyPassword) + 1);
    await expect(page.getByRole("alert")).toHaveText(
      "ログインできませんでした。入力内容やメールの確認状況をご確認ください。",
    );
    await expect(password).toHaveAttribute("aria-invalid", "false");
    await expect(password).toHaveValue(legacyPassword);
  }
  expect(passwords).toEqual(legacyPasswords);
});

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

for (const path of ["/login", "/signup", "/reset-password"]) {
  test(`password visibility toggle preserves input without submitting on ${path}`, async ({
    page,
  }) => {
    let authRequests = 0;
    await page.route("**/auth/v1/**", (route) => {
      authRequests++;
      return route.fulfill({
        status: 400,
        json: { msg: "Unexpected authentication request" },
      });
    });
    await page.goto(path);
    await waitForAuthHydration(page);
    const password = page.getByLabel("パスワード", { exact: true });
    await expect(password).toHaveAttribute("type", "password");
    if (path !== "/reset-password")
      await page
        .getByLabel("メールアドレス", { exact: true })
        .fill("auth-regression@example.test");
    await password.fill("Regression-Password-123!");
    await page.locator("form").evaluate((form) => {
      form.dataset.submits = "0";
      form.addEventListener("submit", () => {
        form.dataset.submits = String(Number(form.dataset.submits) + 1);
      });
    });
    const show = page.getByRole("button", {
      name: "パスワードを表示",
      exact: true,
    });
    await expect(show).toHaveAttribute("aria-pressed", "false");
    await show.click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(password).toHaveValue("Regression-Password-123!");
    const hide = page.getByRole("button", {
      name: "パスワードを非表示",
      exact: true,
    });
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    await hide.click();
    await expect(password).toHaveAttribute("type", "password");
    await expect(password).toHaveValue("Regression-Password-123!");
    await expect(page.locator("form")).toHaveAttribute("data-submits", "0");
    expect(authRequests).toBe(0);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  });
}

test("successful signup without a session clears credentials and hides the password", async ({
  page,
}) => {
  let signupRequests = 0;
  await page.route("**/auth/v1/signup**", (route) => {
    signupRequests++;
    expect(route.request().postDataJSON()).toMatchObject({
      email: "auth-regression@example.test",
      password: "Regression-Password-123!",
    });
    return route.fulfill({
      json: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        aud: "authenticated",
        role: "authenticated",
        email: "auth-regression@example.test",
        app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: {},
        identities: [],
        created_at: new Date().toISOString(),
      },
    });
  });
  await page.goto("/signup");
  await waitForAuthHydration(page);
  const email = page.getByLabel("メールアドレス", { exact: true });
  const password = page.getByLabel("パスワード", { exact: true });
  await email.fill("auth-regression@example.test");
  await password.fill("Regression-Password-123!");
  await page
    .getByRole("button", { name: "パスワードを表示", exact: true })
    .click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "無料で登録", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "メールが届いた場合は、本文のリンクから登録を完了してください。",
  );
  await expect(email).toHaveValue("");
  await expect(password).toHaveValue("");
  await expect(password).toHaveAttribute("type", "password");
  await expect(
    page.getByRole("button", { name: "パスワードを表示", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(/\/signup$/);
  expect(signupRequests).toBe(1);
});

test("failed signup retains credentials and displays a non-enumerating error", async ({
  page,
}) => {
  let signupRequests = 0;
  await page.route("**/auth/v1/signup**", (route) => {
    signupRequests++;
    return route.fulfill({
      status: 400,
      json: {
        code: "over_email_send_rate_limit",
        msg: "Email rate limit exceeded",
      },
    });
  });
  await page.goto("/signup");
  await waitForAuthHydration(page);
  const email = page.getByLabel("メールアドレス", { exact: true });
  const password = page.getByLabel("パスワード", { exact: true });
  await email.fill("auth-regression@example.test");
  await password.fill("Regression-Password-123!");
  await page.getByRole("button", { name: "無料で登録", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "登録を受け付けられませんでした。時間をおいて再試行するか、Googleで続けてください。",
  );
  await expect(email).toHaveValue("auth-regression@example.test");
  await expect(password).toHaveValue("Regression-Password-123!");
  await expect(password).toHaveAttribute("type", "password");
  await expect(
    page.getByRole("button", { name: "無料で登録", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(signupRequests).toBe(1);
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
