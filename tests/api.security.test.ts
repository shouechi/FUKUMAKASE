import { describe, expect, test, vi } from "vitest";
import { createApp, validateWebP } from "../apps/api/src/app";
import { fakeDatabase } from "./helpers/fake-supabase";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const item = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-13T01:00:00Z");
function setup(
  options: {
    deleted?: boolean;
    invalidToken?: boolean;
    rateLimited?: boolean;
    oldSession?: boolean;
  } = {},
) {
  const bucket = {
    get: vi.fn(async () => ({ body: new Uint8Array([1, 2, 3]) })),
    head: vi.fn(),
    put: vi.fn(),
  };
  const admin = fakeDatabase(
    (q) =>
      q.table === "profiles"
        ? {
            user_id: owner,
            deleting_at: options.deleted ? now.toISOString() : null,
          }
        : [],
    (name) =>
      name === "claim_operation" ? { state: "new" } : !options.rateLimited,
  );
  const user = {
    ...fakeDatabase((q) => {
      if (q.table === "clothes") {
        const requested = q.filters.find((f) => f[1] === "id")?.[2];
        const requestedOwner = q.filters.find((f) => f[1] === "user_id")?.[2];
        return requested === item && requestedOwner === owner
          ? {
              id: item,
              user_id: owner,
              image_key: `private/${owner}/${item}.webp`,
              category: "top",
              color: "white",
            }
          : null;
      }
      return [];
    }),
    auth: {
      getUser: vi.fn(async () => ({
        data: {
          user: options.invalidToken
            ? null
            : {
                id: owner,
                last_sign_in_at: options.oldSession
                  ? "2026-10-12T00:00:00Z"
                  : now.toISOString(),
              },
        },
        error: options.invalidToken ? { message: "token invalid" } : null,
      })),
    },
  };
  const app = createApp({
    clients: () => ({ user, admin }) as any,
    now: () => now,
  });
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "public",
    SUPABASE_SERVICE_ROLE_KEY: "server-only",
    APP_ORIGIN: "https://app.example.test",
    CLOTHES_BUCKET: bucket,
  } as any;
  const request = (path: string, init: RequestInit = {}) =>
    app.request(
      path,
      {
        ...init,
        headers: {
          Authorization: "Bearer authenticated-test-token",
          "Idempotency-Key": "independent-test-key",
          "Content-Type": "application/json",
          ...init.headers,
        },
      },
      env,
    );
  return { app, env, request, bucket, user, admin };
}

describe("real Hono routes with independently controlled auth/DB/R2 boundaries", () => {
  test("no token, invalid token, foreign origin and deleting account are blocked before image fetch", async () => {
    const s = setup();
    expect(
      (await s.app.request(`/api/clothes/${item}/image`, {}, s.env)).status,
    ).toBe(401);
    expect(
      (
        await setup({ invalidToken: true }).request(
          `/api/clothes/${item}/image`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await s.request(`/api/clothes/${item}/image`, {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    const deleting = setup({ deleted: true });
    expect((await deleting.request(`/api/clothes/${item}/image`)).status).toBe(
      403,
    );
    expect(deleting.bucket.get).not.toHaveBeenCalled();
    expect(s.bucket.get).not.toHaveBeenCalled();
  });
  test("foreign clothing IDs return 404 without touching private object storage", async () => {
    const s = setup();
    const response = await s.request(
      `/api/clothes/${other}/image?user_id=${other}`,
    );
    expect(response.status).toBe(404);
    expect(s.bucket.get).not.toHaveBeenCalled();
    expect(
      s.user.queries.find((q) => q.table === "clothes")?.filters,
    ).toContainEqual(["eq", "user_id", owner]);
  });
  test("own image is private, never public-cacheable, and has nosniff headers", async () => {
    const s = setup(),
      response = await s.request(`/api/clothes/${item}/image`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(s.bucket.get).toHaveBeenCalledWith(`private/${owner}/${item}.webp`);
  });
  test("forged user_id and arbitrary personal data are rejected before preference mutation", async () => {
    const s = setup();
    for (const body of [
      { user_id: other },
      { email: "private@example.test" },
      { display_name: "Name" },
      { password_hash: "secret" },
    ]) {
      const response = await s.request("/api/me/preferences", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(422);
    }
    expect(s.admin.queries.filter((q) => q.action === "update")).toEqual([]);
  });
  test("mutation requires idempotency key and rate limit cannot be bypassed", async () => {
    const s = setup();
    expect(
      (
        await s.request("/api/clothes/upload-url", {
          method: "POST",
          headers: { "Idempotency-Key": "" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    expect(
      (await setup({ rateLimited: true }).request(`/api/clothes/${item}/image`))
        .status,
    ).toBe(429);
  });
  test("invalid real date and future wear fail before transactional confirmation", async () => {
    const s = setup();
    expect((await s.request("/api/me/day-overrides/2026-02-30")).status).toBe(
      422,
    );
    expect(
      (
        await s.request("/api/wear-logs", {
          method: "POST",
          body: JSON.stringify({ target_date: "2026-10-14", outfit_id: item }),
        })
      ).status,
    ).toBe(422);
    expect(
      s.admin.rpc.mock.calls.some(([name]) => name === "confirm_wear"),
    ).toBe(false);
  });
  test("deletion demands explicit confirmation and a recent session", async () => {
    const s = setup();
    expect(
      (
        await s.request("/api/account/delete", {
          method: "POST",
          body: JSON.stringify({ confirmation: "yes" }),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await setup({ oldSession: true }).request("/api/account/delete", {
          method: "POST",
          body: JSON.stringify({ confirmation: "退会する" }),
        })
      ).status,
    ).toBe(401);
    expect(
      s.admin.rpc.mock.calls.some(([name]) => name === "begin_deletion"),
    ).toBe(false);
  });
  test("errors contain a correlation ID but no credentials, email or internal errors", async () => {
    const s = setup({ invalidToken: true }),
      response = await s.request(`/api/clothes/${item}/image`);
    const body = await response.json();
    expect(body.error.request_id).toMatch(/^[\da-f-]{36}$/);
    expect(JSON.stringify(body)).not.toMatch(
      /authenticated-test-token|server-only|private@example|token invalid/,
    );
  });
});

function riff(chunk: string, payload: Uint8Array) {
  const bytes = new Uint8Array(20 + payload.length + (payload.length % 2));
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WEBP" + chunk), 8);
  new DataView(bytes.buffer).setUint32(16, payload.length, true);
  bytes.set(payload, 20);
  return bytes;
}
describe("adversarial WebP validation", () => {
  test("rejects spoofed containers without a real image bitstream", () => {
    expect(() => validateWebP(riff("VP8 ", new Uint8Array()))).toThrow();
    expect(() =>
      validateWebP(riff("VP8L", new Uint8Array([0, 0, 0, 0, 0]))),
    ).toThrow();
  });
  test("rejects EXIF, animated content, arbitrary bytes and oversized input", () => {
    expect(() => validateWebP(riff("EXIF", new Uint8Array([1, 2])))).toThrow();
    expect(() => validateWebP(riff("ANIM", new Uint8Array([1, 2])))).toThrow();
    expect(() =>
      validateWebP(new TextEncoder().encode("<script>alert(1)</script>")),
    ).toThrow();
    expect(() => validateWebP(new Uint8Array(5 * 1024 * 1024 + 1))).toThrow();
  });
});
