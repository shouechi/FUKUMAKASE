import { describe, expect, test, vi } from "vitest";
import {
  askAI,
  getForecasts,
  aiOutfitSchema,
  classificationSchema,
} from "../apps/api/src/providers";
import { deleteAccount, sweepOrphanImages } from "../apps/api/src/scheduler";
import { fakeDatabase } from "./helpers/fake-supabase";

const now = new Date("2026-10-13T01:00:00Z");
const userId = "11111111-1111-4111-8111-111111111111";
const env = {
  OPENAI_API_KEY: "test-secret",
  AI_REQUEST_RESERVE_USD: "0.01",
  WEATHER_API_KEY: "weather-secret",
} as any;

describe("fixed GPT-6 Luna request and billing contract (OpenAI simulated)", () => {
  const classified = {
    category: "top",
    subtype: "shirt",
    color: "white",
    seasons: ["autumn"],
    confidence: 0.9,
    review_required: false,
  };
  const outfit = {
    items: [{ clothes_id: userId, slot: "top" }],
    reason_short: "色を合わせました",
  };
  const providerResponse = (value: unknown, usage?: unknown) =>
    Response.json({
      id: "response-test",
      status: "completed",
      usage,
      output: [
        { content: [{ type: "output_text", text: JSON.stringify(value) }] },
      ],
    });

  test.each(["classify", "daily", "weekly", "scheduled"])(
    "%s uses the fixed model and explicit inexpensive settings despite legacy overrides",
    async (action) => {
      const db = fakeDatabase(
        () => [],
        (name) => (name === "reserve_ai" ? "usage-id" : null),
      );
      const classification = action === "classify";
      const expected = classification ? classified : outfit;
      const input = [
        {
          role: "user",
          content: [{ type: "input_text", text: "test metadata" }],
        },
      ];
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        // No paid request may start before its atomic database reservation succeeds.
        expect(db.rpc).toHaveBeenCalledExactlyOnceWith("reserve_ai", {
          p_user_id: userId,
          p_action: action,
          p_estimate: 0.01,
          p_request_key: "request",
        });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "gpt-6-luna",
          reasoning: { effort: "none" },
          service_tier: "default",
          max_output_tokens: 700,
          store: false,
          input,
          text: {
            format: {
              type: "json_schema",
              name: classification ? "clothing_classification" : "outfit",
              strict: true,
              schema: expect.any(Object),
            },
          },
        });
        return providerResponse(expected);
      });
      expect(
        await askAI(
          {
            ...env,
            AI_MODEL_CLASSIFY: "expensive-classifier",
            AI_MODEL_OUTFIT: "expensive-outfit-model",
          },
          db as any,
          userId,
          action,
          "request",
          (classification ? classificationSchema : aiOutfitSchema) as any,
          input,
          fetcher,
        ),
      ).toEqual(expected);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        "https://api.openai.com/v1/responses",
        expect.objectContaining({ method: "POST" }),
      );
      expect(db.rpc).toHaveBeenLastCalledWith("settle_ai", {
        p_usage_id: "usage-id",
        p_actual: 0.01,
        p_success: true,
      });
    },
  );

  test.each([false, true])(
    "successful usage is billed at fixed standard rates; legacy override present: %s",
    async (legacy) => {
      const db = fakeDatabase(
        () => [],
        (name) => (name === "reserve_ai" ? "usage-id" : null),
      );
      const fetcher = vi.fn(async () =>
        providerResponse(classified, {
          input_tokens: 1000,
          output_tokens: 200,
        }),
      );
      expect(
        await askAI(
          {
            ...env,
            ...(legacy
              ? {
                  AI_INPUT_USD_PER_MILLION: "100",
                  AI_OUTPUT_USD_PER_MILLION: "500",
                }
              : {}),
          },
          db as any,
          userId,
          "classify",
          "request",
          classificationSchema,
          [],
          fetcher,
        ),
      ).toEqual(classified);
      expect(db.rpc).toHaveBeenLastCalledWith("settle_ai", {
        p_usage_id: "usage-id",
        p_actual: 0.0002,
        p_success: true,
      });
      expect(db.queries).toContainEqual(
        expect.objectContaining({
          table: "ai_usage",
          action: "update",
          payload: {
            input_tokens: 1000,
            output_tokens: 200,
            provider_request_id: "response-test",
          },
          filters: [
            ["eq", "id", "usage-id"],
            ["eq", "user_id", userId],
          ],
        }),
      );
    },
  );

  test.each([
    { input_tokens: -1, output_tokens: 200 },
    { input_tokens: 1.5, output_tokens: 200 },
    { input_tokens: 1000, output_tokens: -1 },
    { input_tokens: "invalid", output_tokens: 200 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 200 },
  ])(
    "unusable usage preserves the conservative reservation: %j",
    async (usage) => {
      const db = fakeDatabase(
        () => [],
        (name) => (name === "reserve_ai" ? "usage-id" : null),
      );
      const fetcher = vi.fn(async () => providerResponse(classified, usage));
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
      ).toEqual(classified);
      expect(db.rpc).toHaveBeenLastCalledWith("settle_ai", {
        p_usage_id: "usage-id",
        p_actual: 0.01,
        p_success: true,
      });
      expect(db.queries).toHaveLength(0);
    },
  );
});

describe("provider failures and budget fallback", () => {
  test.each([
    { OPENAI_API_KEY: undefined },
    { OPENAI_API_KEY: "" },
    ...[undefined, "", "0", "-1", "NaN", "Infinity"].map((reserve) => ({
      AI_REQUEST_RESERVE_USD: reserve,
    })),
  ])(
    "missing credentials or invalid reservation fails closed: %j",
    async (override) => {
      const fetcher = vi.fn();
      const db = fakeDatabase();
      expect(
        await askAI(
          { ...env, ...override },
          db as any,
          userId,
          "classify",
          "request",
          classificationSchema,
          [],
          fetcher,
        ),
      ).toBeNull();
      expect(db.rpc).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  test("exhausted global budget never calls AI or settles an unreserved request", async () => {
    const fetcher = vi.fn();
    const db = fakeDatabase(
      () => [],
      () => null,
    );
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
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("reserve_ai", {
      p_user_id: userId,
      p_action: "classify",
      p_estimate: 0.01,
      p_request_key: "request",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  test.each(["http", "timeout", "malformed", "bad-category", "incomplete"])(
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
          status: failure === "incomplete" ? "incomplete" : "completed",
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text:
                    failure === "malformed"
                      ? "not json"
                      : JSON.stringify({
                          category:
                            failure === "bad-category" ? "arbitrary" : "top",
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
      expect(fetcher).toHaveBeenCalledTimes(1);
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
