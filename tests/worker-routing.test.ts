import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApp, app } from "../apps/api/src/app";
import apiWorker from "../apps/api/src/index";
import worker from "../apps/web/worker";
import { fakeDatabase } from "./helpers/fake-supabase";

const boundary = vi.hoisted(() => ({
  webFetch: vi.fn(),
  runScheduled: vi.fn(),
}));
// vinext is installed in apps/web; its virtual Worker entry is unavailable in Node.
vi.mock("../apps/web/node_modules/vinext/dist/server/fetch-handler.js", () => ({
  default: { fetch: boundary.webFetch },
}));
vi.mock("../apps/api/src/scheduler", async (original) => ({
  ...(await original<typeof import("../apps/api/src/scheduler")>()),
  runScheduled: boundary.runScheduled,
}));
// Keep the actual Hono entry point by default; replace only external boundaries.
vi.mock("../apps/api/src/index", async (original) => {
  const actual = await original<typeof import("../apps/api/src/index")>();
  return {
    ...actual,
    default: { ...actual.default, fetch: vi.fn(actual.default.fetch) },
  };
});

const apiFetch = vi.mocked(apiWorker.fetch);
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const item = "33333333-3333-4333-8333-333333333333";
const origin = "https://app.example.test";
const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() });
const configuredEnv = () => ({
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "fixture-public-key",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-server-secret",
  APP_ORIGIN: origin,
  CLOTHES_BUCKET: { get: vi.fn() },
});
const dispatch = (request: Request, env: unknown = {}, context = ctx()) =>
  worker.fetch(request, env as never, context as never);

beforeEach(() => {
  apiFetch.mockReset().mockImplementation(app.fetch);
  boundary.webFetch.mockReset().mockImplementation(
    async () =>
      new Response("page fixture", {
        headers: { "Content-Type": "text/html" },
      }),
  );
  boundary.runScheduled.mockReset().mockResolvedValue(undefined);
});

async function expectSafeError(
  response: Response,
  status: number,
  code: string,
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  const body = await response.json();
  expect(body.error.code).toBe(code);
  expect(body.error.request_id).toMatch(/^[\da-f-]{36}$/);
  expect(response.headers.get("X-Request-Id")).toBe(body.error.request_id);
  expect(body.error.message).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  expect(JSON.stringify(body)).not.toMatch(
    /fixture-server-secret|fixture-auth-token|private-internal-marker|<!DOCTYPE/,
  );
  expect(boundary.webFetch).not.toHaveBeenCalled();
}

function useAuthenticatedHono(options: { invalidToken?: boolean } = {}) {
  const env = configuredEnv();
  env.CLOTHES_BUCKET.get.mockResolvedValue({ body: new Uint8Array([1, 2, 3]) });
  const admin = fakeDatabase(
    (q) =>
      q.table === "profiles" ? { user_id: owner, deleting_at: null } : [],
    (name) => (name === "claim_operation" ? { state: "new" } : true),
  );
  const user = {
    ...fakeDatabase((q) => {
      if (q.table !== "clothes") return [];
      const requested = q.filters.find((f) => f[1] === "id")?.[2];
      const requestedOwner = q.filters.find((f) => f[1] === "user_id")?.[2];
      return requested === item && requestedOwner === owner
        ? {
            id: item,
            user_id: owner,
            image_key: `private/${owner}/${item}.webp`,
          }
        : null;
    }),
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: options.invalidToken ? null : { id: owner } },
        error: options.invalidToken
          ? { message: "private-internal-marker" }
          : null,
      })),
    },
  };
  const hono = createApp({ clients: () => ({ user, admin }) as never });
  apiFetch.mockImplementation(hono.fetch);
  const request = (path: string, init: RequestInit = {}) =>
    dispatch(
      new Request(`${origin}${path}`, {
        ...init,
        headers: {
          Authorization: "Bearer fixture-auth-token",
          "Content-Type": "application/json",
          "Idempotency-Key": "fixture-operation",
          ...init.headers,
        },
      }),
      env,
    );
  return { env, user, admin, request };
}

describe("single production Worker routing", () => {
  test.each([
    "/api",
    "/api/",
    "/api/outfits/today",
    "/api/clothes/id/image",
    "/api/plans/weekly?week=2026-10-12",
    "/api//unknown",
    "/api/%2e%2e%2fprivate",
    "/api/%2Ftoday",
    "/health?probe=1",
  ])(
    "%s invokes the API entry point with the original request/env/context",
    async (path) => {
      const response = Response.json({ ok: true });
      apiFetch.mockResolvedValue(response);
      const request = new Request(`${origin}${path}`);
      const env = configuredEnv(),
        context = ctx();
      expect(await dispatch(request, env, context)).toBe(response);
      expect(apiFetch).toHaveBeenCalledExactlyOnceWith(request, env, context);
      expect(boundary.webFetch).not.toHaveBeenCalled();
    },
  );

  test.each([
    "/",
    "/today",
    "/apiary",
    "/api-preview/today",
    "/assets/app.js",
    "/healthcare",
  ])(
    "%s invokes the page renderer with the original request/env/context",
    async (path) => {
      const request = new Request(`${origin}${path}`);
      const env = configuredEnv(),
        context = ctx();
      expect(
        (await dispatch(request, env, context)).headers.get("Content-Type"),
      ).toBe("text/html");
      expect(boundary.webFetch).toHaveBeenCalledExactlyOnceWith(
        request,
        env,
        context,
      );
      expect(apiFetch).not.toHaveBeenCalled();
    },
  );

  test("mutation preserves body, authorization, origin, idempotency key and query", async () => {
    const request = new Request(
      `${origin}/api/plans/weekly/regenerate?source=ui`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer fixture-auth-token",
          Origin: origin,
          "Content-Type": "application/json",
          "Idempotency-Key": "fixture-operation",
        },
        body: JSON.stringify({ week: "2026-10-12" }),
      },
    );
    apiFetch.mockImplementation(async (received) => {
      expect(received).toBe(request);
      expect(received.method).toBe("POST");
      expect(received.url).toBe(request.url);
      expect(received.headers.get("Authorization")).toBe(
        "Bearer fixture-auth-token",
      );
      expect(received.headers.get("Origin")).toBe(origin);
      expect(received.headers.get("Idempotency-Key")).toBe("fixture-operation");
      expect(await received.json()).toEqual({ week: "2026-10-12" });
      return Response.json({ ok: true });
    });
    expect((await dispatch(request)).status).toBe(200);
    expect(boundary.webFetch).not.toHaveBeenCalled();
  });

  test("private image bytes, status and response headers remain untouched", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "private, no-store",
      },
    });
    apiFetch.mockResolvedValue(response);
    const result = await dispatch(
      new Request(`${origin}/api/clothes/${item}/image`),
    );
    expect(result).toBe(response);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await result.arrayBuffer()).toEqual(
      new Uint8Array([1, 2, 3]).buffer,
    );
  });

  test.each(["sync", "async"])(
    "%s API entry failure produces safe JSON without page fallback",
    async (mode) => {
      apiFetch.mockImplementation(() => {
        const error = new Error(
          "private-internal-marker fixture-server-secret",
        );
        if (mode === "sync") throw error;
        return Promise.reject(error);
      });
      await expectSafeError(
        await dispatch(new Request(`${origin}/api/outfits/today`)),
        503,
        "API_UNAVAILABLE",
      );
    },
  );
});

describe("combined Worker preserves the existing Hono security boundary", () => {
  test("public health works without database configuration", async () => {
    const response = await dispatch(new Request(`${origin}/health`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "outfit-api" });
    expect(boundary.webFetch).not.toHaveBeenCalled();
  });
  test("missing configuration is a Japanese JSON 503", async () => {
    await expectSafeError(
      await dispatch(new Request(`${origin}/api/outfits/today`)),
      503,
      "NOT_CONFIGURED",
    );
  });
  test.each([
    "/api/outfits/today",
    `/api/clothes/${item}/image`,
    "/api/unknown",
  ])(
    "%s cannot bypass authentication through the combined Worker",
    async (path) => {
      await expectSafeError(
        await dispatch(new Request(`${origin}${path}`), configuredEnv()),
        401,
        "UNAUTHORIZED",
      );
    },
  );
  test("invalid JWT is rejected by the actual Hono auth boundary", async () => {
    const s = useAuthenticatedHono({ invalidToken: true });
    await expectSafeError(
      await s.request(`/api/clothes/${item}/image`),
      401,
      "UNAUTHORIZED",
    );
    expect(s.user.auth.getUser).toHaveBeenCalledWith("fixture-auth-token");
    expect(s.env.CLOTHES_BUCKET.get).not.toHaveBeenCalled();
  });
  test("foreign origin mutation is denied before auth or DB work", async () => {
    const s = useAuthenticatedHono();
    await expectSafeError(
      await s.request("/api/me/preferences", {
        method: "PATCH",
        headers: { Origin: "https://evil.example" },
        body: "{}",
      }),
      403,
      "ORIGIN_FORBIDDEN",
    );
    expect(s.user.auth.getUser).not.toHaveBeenCalled();
    expect(s.admin.rpc).not.toHaveBeenCalled();
  });
  test("unexpected database errors stay safe JSON inside the actual Hono boundary", async () => {
    const s = useAuthenticatedHono();
    s.admin.rpc.mockRejectedValue(
      new Error("private-internal-marker fixture-server-secret"),
    );
    await expectSafeError(
      await s.request("/api/outfits/today"),
      503,
      "INTERNAL_ERROR",
    );
  });
  test.each(["/api", "/api/unknown", "/api/%2Ftoday", "/api//unknown"])(
    "unknown %s remains JSON 404 and never becomes a page",
    async (path) => {
      const s = useAuthenticatedHono();
      await expectSafeError(await s.request(path), 404, "NOT_FOUND");
    },
  );
  test("malformed JSON and missing idempotency cannot turn mutations into pages", async () => {
    const s = useAuthenticatedHono();
    await expectSafeError(
      await s.request("/api/me/preferences", {
        method: "PATCH",
        body: "<!DOCTYPE html>",
      }),
      400,
      "INVALID_JSON",
    );
    await expectSafeError(
      await s.request("/api/me/preferences", {
        method: "PATCH",
        headers: { "Idempotency-Key": "" },
        body: "{}",
      }),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });
  test("foreign image ID is denied and own image remains private", async () => {
    const s = useAuthenticatedHono();
    await expectSafeError(
      await s.request(`/api/clothes/${other}/image?user_id=${other}`),
      404,
      "NOT_FOUND",
    );
    expect(s.env.CLOTHES_BUCKET.get).not.toHaveBeenCalled();
    const response = await s.request(`/api/clothes/${item}/image`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'",
    );
    expect(await response.arrayBuffer()).toEqual(
      new Uint8Array([1, 2, 3]).buffer,
    );
    expect(s.env.CLOTHES_BUCKET.get).toHaveBeenCalledExactlyOnceWith(
      `private/${owner}/${item}.webp`,
    );
    expect(boundary.webFetch).not.toHaveBeenCalled();
  });
});

describe("single production Worker scheduled tasks and bindings", () => {
  test("scheduled runs the existing scheduler and registers its original promise with waitUntil", async () => {
    const work = Promise.resolve();
    boundary.runScheduled.mockReturnValue(work);
    const env = configuredEnv(),
      context = ctx();
    const event = {
      scheduledTime: Date.parse("2026-10-13T01:00:00Z"),
      cron: "*/10 * * * *",
    };
    await worker.scheduled(event as never, env as never, context as never);
    expect(boundary.runScheduled).toHaveBeenCalledExactlyOnceWith(env);
    expect(context.waitUntil).toHaveBeenCalledExactlyOnceWith(work);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(boundary.webFetch).not.toHaveBeenCalled();
  });
  test("one config owns R2, Cron and API vars without a service binding", () => {
    const config = JSON.parse(
      readFileSync(
        new URL("../apps/web/wrangler.jsonc", import.meta.url),
        "utf8",
      )
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,\s*([}\]])/g, "$1"),
    );
    expect(config.name).toBe("fukumakase");
    expect(config.services ?? []).toEqual([]);
    expect(config.assets?.run_worker_first).toEqual(
      expect.arrayContaining(["/api", "/api/*", "/health"]),
    );
    expect(config.triggers?.crons).toEqual(["*/10 * * * *"]);
    expect(config.r2_buckets).toContainEqual(
      expect.objectContaining({
        binding: "CLOTHES_BUCKET",
        bucket_name: "fukumakase-private-clothes",
      }),
    );
    expect(config.vars).toMatchObject({
      UPLOADS_ENABLED: "true",
      WEATHER_FORECAST_DAYS: "3",
    });
    const apiPackage = JSON.parse(
      readFileSync(
        new URL("../apps/api/package.json", import.meta.url),
        "utf8",
      ),
    );
    expect(apiPackage.scripts).not.toHaveProperty("deploy");
    const localConfig = JSON.parse(
      readFileSync(
        new URL("../apps/api/wrangler.jsonc", import.meta.url),
        "utf8",
      )
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,\s*([}\]])/g, "$1"),
    );
    expect(localConfig.name).not.toBe("fukumakase-api");
    expect(localConfig.triggers?.crons ?? []).toEqual([]);
  });
});
