import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultPreferences, type Plan } from "../packages/schemas/src/index";

const auth = vi.hoisted(() => ({
  session: {
    access_token: "test-token",
    user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  } as { access_token: string; user: { id: string } } | null,
}));

const today: Plan = {
  target_date: "2026-10-13",
  mode: "auto",
  source: "rule",
  plan_status: "partial",
  reason_short: "服を登録してください",
  items: [],
  warnings: [],
};
const preferences = { ...defaultPreferences, onboarding_completed: true };
const html = "<!DOCTYPE html><html><body>internal-secret-marker</body></html>";
let client: typeof import("../apps/web/lib/client");
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://client-test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-test-key");
  auth.session = {
    access_token: "test-token",
    user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  };
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  client = await import("../apps/web/lib/client");
  expect(client.authClient()).not.toBeNull();
  vi.spyOn(client.authClient()!.auth, "getSession").mockImplementation(
    async () => ({ data: { session: auth.session as never }, error: null }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function expectSafeFailure(promise: Promise<unknown>, status?: number) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(client.ApiError);
  expect(error.message).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  expect(error.message).not.toMatch(
    /Unexpected token|DOCTYPE|internal-secret-marker|SyntaxError/,
  );
  if (status !== undefined) expect(error.status).toBe(status);
  return error as InstanceType<typeof client.ApiError>;
}

describe("API response boundary", () => {
  test.each([
    [
      "HTML success",
      () => new Response(html, { headers: { "Content-Type": "text/html" } }),
    ],
    [
      "HTML mislabelled JSON",
      () =>
        new Response(html, { headers: { "Content-Type": "application/json" } }),
    ],
    [
      "truncated JSON",
      () =>
        new Response('{"target_date":', {
          headers: { "Content-Type": "application/json" },
        }),
    ],
    [
      "empty success",
      () =>
        new Response("", { headers: { "Content-Type": "application/json" } }),
    ],
    [
      "204 is outside this endpoint contract",
      () => new Response(null, { status: 204 }),
    ],
    ["unrelated JSON object", () => Response.json({ unexpected: true })],
    [
      "incorrect nested collection",
      () => Response.json({ ...today, warnings: {} }),
    ],
    [
      "incorrect enumeration",
      () => Response.json({ ...today, mode: "invented" }),
    ],
    ["null does not satisfy nonnullable endpoint", () => Response.json(null)],
  ] as const)(
    "%s becomes a safe Japanese ApiError",
    async (label, response) => {
      fetchMock.mockResolvedValueOnce(response());
      await expectSafeFailure(
        label === "null does not satisfy nonnullable endpoint"
          ? client.api("GET /api/me/preferences")
          : client.api("GET /api/outfits/today"),
      );
    },
  );

  test("transport failure does not leak browser exception text", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError("internal-secret-marker: Failed to fetch"),
    );
    await expectSafeFailure(client.api("GET /api/outfits/today"));
  });

  test.each([400, 404, 500, 503])(
    "HTML HTTP %i never exposes its body",
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        new Response(html, {
          status,
          headers: { "Content-Type": "text/html" },
        }),
      );
      await expectSafeFailure(client.api("GET /api/outfits/today"), status);
    },
  );

  test("normal object and legitimately absent plan retain their contract", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(today))
      .mockResolvedValueOnce(Response.json(null));
    await expect(client.api("GET /api/outfits/today")).resolves.toEqual(today);
    await expect(client.api("GET /api/outfits/today")).resolves.toBeNull();
    const [, options] = fetchMock.mock.calls[0];
    expect(new Headers(options.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
    expect(options.cache).toBe("no-store");
  });

  test("JSON with charset retains its contract", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(today), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
    );
    await expect(client.api("GET /api/outfits/today")).resolves.toEqual(today);
  });

  test("API's declared error remains readable and actionable", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: "DAILY_LIMIT",
            message: "今日の作り直しは3回までです",
            request_id: "test-request",
          },
        },
        { status: 429 },
      ),
    );
    const error = await expectSafeFailure(
      client.api("GET /api/outfits/today"),
      429,
    );
    expect(error.code).toBe("DAILY_LIMIT");
    expect(error.message).toBe("今日の作り直しは3回までです");
  });

  test.each([null, {}, { error: { code: 123, message: {} } }])(
    "malformed error envelope %j uses a safe fallback",
    async (body) => {
      fetchMock.mockResolvedValueOnce(Response.json(body, { status: 400 }));
      await expectSafeFailure(client.api("GET /api/outfits/today"), 400);
    },
  );

  test("a deletion receipt stays public after session is removed", async () => {
    auth.session = null;
    fetchMock.mockResolvedValueOnce(Response.json({ status: "completed" }));
    await expect(
      client.api("GET /api/account/deletion-status/:id", {
        params: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(
      new Headers(fetchMock.mock.calls[0][1].headers).has("Authorization"),
    ).toBe(false);
  });
});

describe("mutation uncertainty", () => {
  const mutate = () =>
    client.api("PATCH /api/me/preferences", {
      body: { style_keywords: ["カジュアル"] },
    });
  const keyAt = (n: number) =>
    new Headers(fetchMock.mock.calls[n][1].headers).get("Idempotency-Key");

  test.each([
    [
      "HTML 200",
      () =>
        Promise.resolve(
          new Response(html, { headers: { "Content-Type": "text/html" } }),
        ),
    ],
    [
      "HTML 400",
      () =>
        Promise.resolve(
          new Response(html, {
            status: 400,
            headers: { "Content-Type": "text/html" },
          }),
        ),
    ],
    [
      "invalid success JSON",
      () =>
        Promise.resolve(
          new Response("{", {
            headers: { "Content-Type": "application/json" },
          }),
        ),
    ],
    [
      "JSON outside response contract",
      () => Promise.resolve(Response.json({})),
    ],
    ["network", () => Promise.reject(new TypeError("Failed to fetch"))],
    [
      "API unavailable",
      () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "一時的に利用できません",
                request_id: "test-request",
              },
            },
            { status: 503 },
          ),
        ),
    ],
    [
      "operation is in progress",
      () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: "OPERATION_IN_PROGRESS",
                message: "処理中です",
                request_id: "test-request",
              },
            },
            { status: 409 },
          ),
        ),
    ],
  ] as const)(
    "%s preserves key until a valid success is received",
    async (_label, fail) => {
      fetchMock
        .mockImplementationOnce(fail)
        .mockResolvedValueOnce(Response.json(preferences))
        .mockResolvedValueOnce(Response.json(preferences));
      await expectSafeFailure(mutate());
      await expect(mutate()).resolves.toEqual(preferences);
      await mutate();
      expect(keyAt(0)).toBeTruthy();
      expect(keyAt(1)).toBe(keyAt(0));
      expect(keyAt(2)).not.toBe(keyAt(0));
    },
  );

  test("a valid final rejection permits a new operation key", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "入力を確認してください",
              request_id: "test-request",
            },
          },
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(Response.json(preferences));
    await expectSafeFailure(mutate());
    await mutate();
    expect(keyAt(1)).not.toBe(keyAt(0));
  });

  test("server-confirmed deletion clears only the current owner's pending DELETE key", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const anotherId = "22222222-2222-4222-8222-222222222222";
    const firstOwner = auth.session!;
    const remove = (clothId: string) =>
      client.api("DELETE /api/clothes/:id", { params: { id: clothId } });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expectSafeFailure(remove(id)); // A's pending deletion
    await expectSafeFailure(remove(anotherId)); // A's unrelated deletion
    auth.session = {
      ...firstOwner,
      user: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    };
    await expectSafeFailure(remove(id)); // B's pending deletion
    await client.acknowledgeClothesDeletion(id);
    await expectSafeFailure(remove(id));
    expect(keyAt(3)).not.toBe(keyAt(2));
    auth.session = firstOwner;
    await expectSafeFailure(remove(id));
    expect(keyAt(4)).toBe(keyAt(0));
    await client.acknowledgeClothesDeletion(id);
    await expectSafeFailure(remove(id));
    expect(keyAt(5)).not.toBe(keyAt(0));
    await expectSafeFailure(remove(anotherId));
    expect(keyAt(6)).toBe(keyAt(1));
  });
});

describe("private image response boundary", () => {
  test("HTML with success status never creates an image object URL", async () => {
    const objectURL = vi.spyOn(URL, "createObjectURL");
    fetchMock.mockResolvedValueOnce(
      new Response(html, { headers: { "Content-Type": "text/html" } }),
    );
    await expectSafeFailure(
      client.privateImage("11111111-1111-4111-8111-111111111111"),
    );
    expect(objectURL).not.toHaveBeenCalled();
  });

  test("transport and authentication use the same safe error boundary", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("internal-secret-marker"));
    await expectSafeFailure(client.privateImage("id"));
    auth.session = null;
    await expectSafeFailure(client.privateImage("id"), 401);
  });

  test("actual supported image remains a private object URL", async () => {
    const objectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test-image");
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "Content-Type": "image/webp" },
      }),
    );
    await expect(client.privateImage("id")).resolves.toBe("blob:test-image");
    expect(objectURL).toHaveBeenCalledOnce();
    expect(
      new Headers(fetchMock.mock.calls[0][1].headers).get("Authorization"),
    ).toBe("Bearer test-token");
  });
});
