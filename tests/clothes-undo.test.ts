import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../apps/api/src/app";
import { runSpecificJob, sweepOrphanImages } from "../apps/api/src/scheduler";
import { fakeDatabase } from "./helpers/fake-supabase";

const external = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock(
  "../apps/api/node_modules/@supabase/supabase-js/dist/index.mjs",
  () => ({ createClient: external.client }),
);
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const garment = "33333333-3333-4333-8333-333333333333";
const token = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-10-21T01:00:00Z");
const receipt = {
  ok: true,
  category: "top",
  color: "white",
  clothes_id: garment,
  deletion_token: token,
  server_now: now.toISOString(),
  undo_until: new Date(+now + 30_000).toISOString(),
};
const cloth = {
  id: garment,
  category: "top",
  subtype: "shirt",
  color: "white",
  seasons: ["autumn"],
  thickness: null,
  wear_limit: 3,
  wears_since_wash: 2,
  state: "laundry",
  classification_state: "manual",
  is_available: false,
};
const env = {
  SUPABASE_URL: "https://fixture.supabase.co",
  SUPABASE_ANON_KEY: "public-fixture",
  SUPABASE_SERVICE_ROLE_KEY: "server-fixture",
  APP_ORIGIN: "https://app.example.test",
  CLOTHES_BUCKET: { delete: vi.fn(), head: vi.fn(), get: vi.fn() },
} as any;
beforeEach(() => vi.clearAllMocks());
function fixture(failure?: string) {
  const admin = fakeDatabase(
    (q) =>
      q.table === "profiles" ? { user_id: owner, deleting_at: null } : [],
    (name) => {
      if (name === "claim_operation") return { state: "new" };
      if (name === "delete_clothes") return receipt;
      if (name === "restore_clothes") return cloth;
      if (name === "list_clothes_deletions")
        return { items: [receipt], server_now: receipt.server_now };
      if (
        [
          "ensure_profile",
          "check_rate_limit",
          "finish_operation",
          "abort_operation",
        ].includes(name)
      )
        return true;
      throw new Error(`Unexpected RPC ${name}`);
    },
  );
  if (failure) {
    const original = admin.rpc.getMockImplementation()!;
    admin.rpc.mockImplementation(async (name, args) =>
      name === "restore_clothes"
        ? { data: null, error: { message: failure } }
        : original(name, args),
    );
  }
  const user = {
    ...fakeDatabase(() => {
      throw new Error("Undo must use owner-bound transactional RPCs");
    }),
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: owner } },
        error: null,
      })),
    },
  };
  const app = createApp({
    clients: () => ({ user, admin }) as any,
    now: () => now,
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(
      path,
      {
        ...init,
        headers: {
          Authorization: "Bearer fixture",
          "Idempotency-Key": "independent-operation",
          "Content-Type": "application/json",
          ...init.headers,
        },
      },
      env,
    );
  return { request, admin, user, app };
}

describe("real Hono clothing Undo contract with external DB mocked", () => {
  test("DELETE returns a server receipt without touching image storage", async () => {
    const s = fixture(),
      response = await s.request(`/api/clothes/${garment}`, {
        method: "DELETE",
      });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(receipt);
    expect(s.admin.rpc).toHaveBeenCalledWith("delete_clothes", {
      p_user_id: owner,
      p_clothes_id: garment,
      p_request_key: "independent-operation",
    });
    expect(env.CLOTHES_BUCKET.delete).not.toHaveBeenCalled();
    expect(s.admin.queries.filter((q) => q.table === "clothes")).toEqual([]);
  });
  test("deletions route resolves before :id and ignores forged query ownership", async () => {
    const s = fixture(),
      response = await s.request(`/api/clothes/deletions?user_id=${other}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [receipt],
      server_now: receipt.server_now,
    });
    expect(s.admin.rpc).toHaveBeenCalledWith("list_clothes_deletions", {
      p_user_id: owner,
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  test("restore passes only authenticated ownership, token and operation key and preserves laundry", async () => {
    const s = fixture(),
      response = await s.request(`/api/clothes/${garment}/restore`, {
        method: "POST",
        body: JSON.stringify({ deletion_token: token }),
      });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cloth);
    expect(s.admin.rpc).toHaveBeenCalledWith("restore_clothes", {
      p_user_id: owner,
      p_clothes_id: garment,
      p_request_key: "independent-operation",
      p_deletion_token: token,
    });
    expect(
      s.admin.rpc.mock.calls.some(([name]) => name === "wash_clothes"),
    ).toBe(false);
    expect(env.CLOTHES_BUCKET.delete).not.toHaveBeenCalled();
  });
  test("restore rejects missing/invalid tokens, forged state and missing operation keys before business RPC", async () => {
    const s = fixture();
    for (const body of [
      {},
      { deletion_token: "fake" },
      { deletion_token: token, user_id: other },
      { deletion_token: token, state: "available" },
    ])
      expect(
        (
          await s.request(`/api/clothes/${garment}/restore`, {
            method: "POST",
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(422);
    expect(
      (
        await s.request(`/api/clothes/${garment}/restore`, {
          method: "POST",
          body: JSON.stringify({ deletion_token: token }),
          headers: { "Idempotency-Key": "" },
        })
      ).status,
    ).toBe(400);
    expect(
      s.admin.rpc.mock.calls.some(([name]) => name === "restore_clothes"),
    ).toBe(false);
  });
  test.each([
    ["UNDO_EXPIRED", 409, "UNDO_EXPIRED"],
    ["DELETION_CONFLICT", 409, "CONFLICT"],
    ["CLOTHES_LIMIT", 429, "LIMIT_REACHED"],
    ["NOT_FOUND", 404, "NOT_FOUND"],
  ] as const)(
    "DB %s returns the expected safe Japanese API error",
    async (error, status, code) => {
      const response = await fixture(error).request(
        `/api/clothes/${garment}/restore`,
        { method: "POST", body: JSON.stringify({ deletion_token: token }) },
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.error).toMatchObject({
        code,
        message: expect.stringMatching(/[ぁ-んァ-ヶ一-龠]/),
        request_id: expect.any(String),
      });
      expect(JSON.stringify(body)).not.toMatch(/server-fixture|Bearer/);
    },
  );
});

describe("image purge and orphan sweep with R2/DB mocked", () => {
  test.each([null, { image_key: `private/${owner}/${garment}.webp` }])(
    "image_delete touches R2 only after a successful matching DB claim: %j",
    async (claim) => {
      const job = {
        id: jobId,
        job_type: "image_delete",
        user_id: owner,
        payload: { image_key: `private/${owner}/untrusted-payload.webp` },
        lease_token: token,
      };
      const db = fakeDatabase(
        (q) => (q.table === "profiles" ? { deleting_at: null } : []),
        (name) => {
          if (name === "lease_job") return job;
          if (name === "claim_clothes_image_purge") return claim;
          if (name === "finish_job") return true;
          throw new Error(`Unexpected RPC ${name}`);
        },
      );
      external.client.mockReturnValue(db);
      await runSpecificJob(env, job.id, now);
      expect(db.rpc).toHaveBeenCalledWith("claim_clothes_image_purge", {
        p_job_id: job.id,
        p_lease_token: token,
      });
      if (claim)
        expect(env.CLOTHES_BUCKET.delete).toHaveBeenCalledExactlyOnceWith(
          claim.image_key,
        );
      else expect(env.CLOTHES_BUCKET.delete).not.toHaveBeenCalled();
      expect(db.rpc).toHaveBeenCalledWith("finish_job", {
        p_id: job.id,
        p_lease_token: token,
        p_success: true,
      });
    },
  );
  test("invalid lease or owner claim never deletes an R2 photo", async () => {
    for (const mode of ["lost-lease", "wrong-owner"]) {
      const db = fakeDatabase(
        () => ({ deleting_at: null }),
        (name) =>
          name === "lease_job"
            ? {
                id: jobId,
                job_type: "image_delete",
                user_id: owner,
                payload: {},
                lease_token: token,
              }
            : name === "claim_clothes_image_purge"
              ? { image_key: `private/${other}/other.webp` }
              : true,
      );
      if (mode === "lost-lease") {
        const original = db.rpc.getMockImplementation()!;
        db.rpc.mockImplementation(async (name, args) =>
          name === "claim_clothes_image_purge"
            ? { data: null, error: { message: "LEASE_LOST" } }
            : original(name, args),
        );
      }
      external.client.mockReturnValue(db);
      await runSpecificJob(env, jobId, now);
      expect(db.rpc).toHaveBeenCalledWith("finish_job", {
        p_id: jobId,
        p_lease_token: token,
        p_success: false,
        p_error_code: "JOB_FAILED",
      });
    }
    expect(env.CLOTHES_BUCKET.delete).not.toHaveBeenCalled();
  });
  test("sweep protects tombstoned photos until DB purge begins even when the file is old", async () => {
    const protectedPhoto = `private/${owner}/undo.webp`,
      orphan = `private/${owner}/orphan.webp`;
    const db = fakeDatabase((q) => {
      if (q.table === "profiles")
        return [{ user_id: owner, deleting_at: null }];
      if (q.table === "clothes") {
        expect(q.filters).toContainEqual([
          "or",
          "deleted_at.is.null,image_purge_started_at.is.null",
          undefined,
        ]);
        return [{ image_key: protectedPhoto }];
      }
      return [];
    });
    const bucket = {
      list: vi.fn(async () => ({
        objects: [protectedPhoto, orphan].map((key) => ({
          key,
          uploaded: new Date(+now - 7_200_000),
        })),
        truncated: false,
      })),
      delete: vi.fn(),
    };
    expect(
      await sweepOrphanImages(
        { ...env, CLOTHES_BUCKET: bucket },
        db as any,
        now,
      ),
    ).toEqual({ scanned: 2, deleted: 1 });
    expect(bucket.delete).toHaveBeenCalledExactlyOnceWith([orphan]);
  });
});
