import { describe, expect, test, vi } from "vitest";
import {
  askAI,
  getForecasts,
  classificationSchema,
} from "../apps/api/src/providers";
import { deleteAccount, sweepOrphanImages } from "../apps/api/src/scheduler";
import { fakeDatabase } from "./helpers/fake-supabase";

const now = new Date("2026-10-13T01:00:00Z");
const userId = "11111111-1111-4111-8111-111111111111";
const env = {
  OPENAI_API_KEY: "test-secret",
  AI_MODEL_CLASSIFY: "configured-model",
  AI_MODEL_OUTFIT: "configured-model",
  AI_REQUEST_RESERVE_USD: "0.01",
  AI_INPUT_USD_PER_MILLION: "0.1",
  AI_OUTPUT_USD_PER_MILLION: "0.4",
  WEATHER_API_KEY: "weather-secret",
} as any;

describe("provider failures and budget fallback", () => {
  test("missing model/cost configuration and exhausted global budget never call AI", async () => {
    const fetcher = vi.fn();
    const db = fakeDatabase(
      () => [],
      () => null,
    );
    expect(
      await askAI(
        { ...env, AI_MODEL_CLASSIFY: undefined },
        db as any,
        userId,
        "classify",
        "request",
        classificationSchema,
        [],
        fetcher,
      ),
    ).toBeNull();
    expect(
      await askAI(
        env,
        db as any,
        userId,
        "classify",
        "request",
        classificationSchema,
        [],
        fetcher,
      ),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  test.each(["http", "timeout", "malformed", "bad-category"])(
    "AI %s returns fallback and settles its reserved budget",
    async (failure) => {
      const db = fakeDatabase(
        () => [],
        (name) => (name === "reserve_ai" ? "usage-id" : null),
      );
      const fetcher = vi.fn(async () => {
        if (failure === "timeout")
          throw new Error("provider network error includes secret");
        if (failure === "http")
          return new Response("provider error", { status: 503 });
        return Response.json({
          status: "completed",
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text:
                    failure === "malformed"
                      ? "not json"
                      : JSON.stringify({
                          category: "arbitrary",
                          color: "white",
                          subtype: "shirt",
                          seasons: ["autumn"],
                          confidence: 1,
                          review_required: false,
                        }),
                },
              ],
            },
          ],
        });
      });
      expect(
        await askAI(
          env,
          db as any,
          userId,
          "classify",
          "request",
          classificationSchema,
          [],
          fetcher,
        ),
      ).toBeNull();
      expect(db.rpc).toHaveBeenCalledWith("settle_ai", {
        p_usage_id: "usage-id",
        p_actual: 0.01,
        p_success: false,
      });
    },
  );
  test("weather outage keeps recent cache with freshness and falls back seasonally for stale/missing days", async () => {
    const db = fakeDatabase(() => [
      {
        forecast_date: "2026-10-13",
        fetched_at: "2026-10-12T01:00:00Z",
        payload: { min_c: 12, max_c: 22, rain_probability: 70 },
      },
      {
        forecast_date: "2026-10-14",
        fetched_at: "2026-10-09T01:00:00Z",
        payload: { min_c: 15, max_c: 24, rain_probability: 20 },
      },
    ]);
    const fetcher = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const forecast = await getForecasts(
      env,
      db as any,
      "tokyo",
      ["2026-10-13", "2026-10-14", "2026-10-15"],
      now,
      fetcher,
    );
    expect(forecast[0]).toMatchObject({
      source: "cache",
      fetched_at: "2026-10-12T01:00:00Z",
      rain_probability: 70,
    });
    expect(forecast[1]).toMatchObject({
      source: "seasonal",
      fetched_at: null,
      provisional: true,
    });
    expect(forecast[2]).toMatchObject({
      source: "seasonal",
      fetched_at: null,
      provisional: true,
    });
  });
  test("fresh cache avoids provider requests and remote future forecast stays provisional", async () => {
    const db = fakeDatabase(() => [
      {
        forecast_date: "2026-10-17",
        fetched_at: "2026-10-13T00:00:00Z",
        payload: { min_c: 12, max_c: 22, rain_probability: 0 },
      },
    ]);
    const fetcher = vi.fn();
    const forecast = await getForecasts(
      env,
      db as any,
      "tokyo",
      ["2026-10-17"],
      now,
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(forecast[0].provisional).toBe(true);
  });
  test("malformed weather never replaces a valid cached forecast", async () => {
    const db = fakeDatabase(() => [
      {
        forecast_date: "2026-10-13",
        fetched_at: "2026-10-12T01:00:00Z",
        payload: { min_c: 12, max_c: 22, rain_probability: 0 },
      },
    ]);
    const fetcher = vi.fn(async () =>
      Response.json({
        forecast: {
          forecastday: [
            {
              date: "2026-10-13",
              day: {
                mintemp_c: -999,
                maxtemp_c: "hot",
                daily_chance_of_rain: 200,
              },
            },
          ],
        },
      }),
    );
    expect(
      (
        await getForecasts(
          env,
          db as any,
          "tokyo",
          ["2026-10-13"],
          now,
          fetcher,
        )
      )[0].source,
    ).toBe("cache");
    expect(db.queries.some((q) => q.action === "upsert")).toBe(false);
  });
});

describe("deletion worker adversarial retries (external services simulated)", () => {
  function deletionSetup() {
    const objects = new Set([
      `private/${userId}/one.webp`,
      `private/${userId}/two.webp`,
      "private/another-user/keep.webp",
    ]);
    const events: string[] = [];
    const bucket = {
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        objects: [...objects]
          .filter((k) => k.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      })),
      delete: vi.fn(async (keys: string[]) => {
        events.push("images");
        keys.forEach((k) => objects.delete(k));
      }),
    };
    const db = {
      ...fakeDatabase(
        (q) => {
          if (q.action === "delete") events.push(`db:${q.table}`);
          return [];
        },
        (name) => name === "finish_deletion",
      ),
      auth: {
        admin: {
          deleteUser: vi.fn(async () => {
            events.push("auth");
            return { error: null as any };
          }),
        },
      },
    };
    const job = { id: "job", user_id: userId, lease_token: "lease" };
    return { objects, events, bucket, db, job };
  }
  test("image deletion must be verified before any personal DB/Auth erasure", async () => {
    const s = deletionSetup();
    s.bucket.delete.mockImplementationOnce(async () => {});
    await expect(
      deleteAccount({ ...env, CLOTHES_BUCKET: s.bucket }, s.db, s.job),
    ).rejects.toThrow("IMAGE_DELETE_FAILED");
    expect(s.db.queries.filter((q) => q.action !== "select")).toHaveLength(0);
    expect(s.db.auth.admin.deleteUser).not.toHaveBeenCalled();
    await deleteAccount({ ...env, CLOTHES_BUCKET: s.bucket }, s.db, s.job);
    expect(s.objects).toEqual(new Set(["private/another-user/keep.webp"]));
    expect(s.events.indexOf("images")).toBeLessThan(
      s.events.indexOf("db:clothes"),
    );
    expect(s.events.indexOf("db:clothes")).toBeLessThan(
      s.events.indexOf("auth"),
    );
  });
  test("Auth outage retains the tombstone; retry removes the final account and anonymizes job receipt", async () => {
    const s = deletionSetup();
    s.db.auth.admin.deleteUser.mockResolvedValueOnce({
      error: { status: 503 },
    });
    await expect(
      deleteAccount({ ...env, CLOTHES_BUCKET: s.bucket }, s.db, s.job),
    ).rejects.toThrow("AUTH_DELETE_FAILED");
    expect(
      s.db.queries.some((q) => q.table === "profiles" && q.action === "delete"),
    ).toBe(false);
    expect(
      s.db.rpc.mock.calls.some(([name]) => name === "finish_deletion"),
    ).toBe(false);
    await deleteAccount({ ...env, CLOTHES_BUCKET: s.bucket }, s.db, s.job);
    expect(s.db.rpc).toHaveBeenCalledWith("finish_deletion", {
      p_id: s.job.id,
      p_lease_token: s.job.lease_token,
    });
    expect(s.db.auth.admin.deleteUser).toHaveBeenCalledTimes(2);
  });
  test("durable sweep removes late writes for deleted owners without touching live referenced photos", async () => {
    const active = "22222222-2222-4222-8222-222222222222";
    const late = `private/${userId}/late.webp`,
      live = `private/${active}/live.webp`,
      oldOrphan = `private/${active}/orphan.webp`;
    const objects = new Set([late, live, oldOrphan]);
    const db = fakeDatabase((q) => {
      if (q.table === "maintenance_state") return { cursor: "saved-cursor" };
      if (q.table === "profiles")
        return [{ user_id: active, deleting_at: null }];
      if (q.table === "clothes") return [{ image_key: live }];
      return [];
    });
    const bucket = {
      list: vi.fn(async () => ({
        objects: [...objects].map((key) => ({
          key,
          uploaded: new Date(+now - 7200000),
        })),
        truncated: true,
        cursor: "next-cursor",
      })),
      delete: vi.fn(async (keys: string[]) => {
        keys.forEach((k) => objects.delete(k));
      }),
    };
    expect(
      await sweepOrphanImages(
        { ...env, CLOTHES_BUCKET: bucket },
        db as any,
        now,
      ),
    ).toEqual({ scanned: 3, deleted: 2 });
    expect(objects).toEqual(new Set([live]));
    expect(bucket.list).toHaveBeenCalledWith({
      prefix: "private/",
      limit: 100,
      cursor: "saved-cursor",
    });
    expect(db.queries.find((q) => q.action === "upsert")?.payload.cursor).toBe(
      "next-cursor",
    );
  });
  test("sweep deletion outage does not advance durable cursor past the unprocessed objects", async () => {
    const db = fakeDatabase((q) =>
      q.table === "maintenance_state" ? { cursor: "saved-cursor" } : [],
    );
    const bucket = {
      list: vi.fn(async () => ({
        objects: [{ key: `private/${userId}/late.webp`, uploaded: now }],
        truncated: true,
        cursor: "next-cursor",
      })),
      delete: vi.fn(async () => {
        throw new Error("R2 outage");
      }),
    };
    await expect(
      sweepOrphanImages({ ...env, CLOTHES_BUCKET: bucket }, db as any, now),
    ).rejects.toThrow("R2 outage");
    expect(db.queries.some((q) => q.action === "upsert")).toBe(false);
  });
});
