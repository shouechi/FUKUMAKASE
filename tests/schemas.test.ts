import { describe, expect, test } from "vitest";
import {
  aiOutfitSchema,
  apiResponseSchemas,
  apiErrorResponseSchema,
  classificationSchema,
  clothesCreateSchema,
  clothesPatchSchema,
  clothesRestoreSchema,
  dateSchema,
  defaultPreferences,
  manualPlanSchema,
  preferencesSchema,
  weekdaysSchema,
  wearSchema,
} from "../packages/schemas/src/index";

const top = "11111111-1111-4111-8111-111111111111";
const bottom = "22222222-2222-4222-8222-222222222222";

describe("untrusted API boundaries derived from requirements", () => {
  test.each([
    "2026-02-29",
    "2026-02-30",
    "2026-13-01",
    "2026-00-01",
    "2026-01-00",
    "2026-1-1",
    "2026-01-01T00:00:00Z",
    "../../etc/passwd",
  ])("rejects invalid date %s", (value) => {
    expect(dateSchema.safeParse(value).success).toBe(false);
  });
  test("allows real leap day and year boundary dates", () => {
    for (const value of ["2028-02-29", "2026-12-31", "2027-01-01"])
      expect(dateSchema.safeParse(value).success).toBe(true);
  });
  test("preferences cannot smuggle ownership or forbidden account data", () => {
    for (const [key, value] of Object.entries({
      user_id: top,
      email: "private@example.test",
      display_name: "Name",
      password_hash: "hash",
      google_access_token: "secret",
    })) {
      expect(
        preferencesSchema.safeParse({ ...defaultPreferences, [key]: value })
          .success,
        key,
      ).toBe(false);
    }
  });
  test("workdays are unique ISO weekdays", () => {
    expect(
      weekdaysSchema.safeParse({ weekdays: [1, 2, 3, 4, 5] }).success,
    ).toBe(true);
    for (const weekdays of [[0], [8], [1, 1], [1.5]])
      expect(weekdaysSchema.safeParse({ weekdays }).success).toBe(false);
  });
  test("manual outfit cannot assign one garment twice or duplicate a slot", () => {
    expect(
      manualPlanSchema.safeParse({
        items: [
          { clothes_id: top, slot: "top" },
          { clothes_id: top, slot: "bottom" },
        ],
      }).success,
    ).toBe(false);
    expect(
      manualPlanSchema.safeParse({
        items: [
          { clothes_id: top, slot: "top" },
          { clothes_id: bottom, slot: "top" },
        ],
      }).success,
    ).toBe(false);
  });
  test("user cannot forge wear counters, owner, object key or deletion state on clothes writes", () => {
    for (const payload of [
      { wears_since_wash: 0 },
      { user_id: top },
      { image_key: `private/${bottom}/secret.webp` },
      { deleted_at: null },
      { wear_limit: 0 },
      { wear_limit: -1 },
    ])
      expect(clothesPatchSchema.safeParse(payload).success).toBe(false);
    expect(
      clothesCreateSchema.safeParse({ upload_id: top, user_id: bottom })
        .success,
    ).toBe(false);
  });
  test("wear requests cannot claim another user", () => {
    expect(
      wearSchema.safeParse({
        target_date: "2026-10-12",
        outfit_id: top,
        user_id: bottom,
      }).success,
    ).toBe(false);
  });
  test("restore requires a deletion generation and cannot smuggle ownership or state", () => {
    expect(
      clothesRestoreSchema.safeParse({ deletion_token: top }).success,
    ).toBe(true);
    for (const payload of [
      {},
      { deletion_token: "old" },
      { deletion_token: top, user_id: bottom },
      { deletion_token: top, deleted_at: null },
    ])
      expect(clothesRestoreSchema.safeParse(payload).success).toBe(false);
  });
  test("AI classification rejects unsupported categories and arbitrary persisted properties", () => {
    const classification = {
      category: "top",
      subtype: "shirt",
      color: "white",
      seasons: ["autumn"],
      confidence: 0.8,
      review_required: false,
    };
    expect(classificationSchema.safeParse(classification).success).toBe(true);
    expect(
      classificationSchema.safeParse({
        ...classification,
        category: "accessory",
      }).success,
    ).toBe(false);
    expect(
      classificationSchema.safeParse({ ...classification, thickness: "thick" })
        .success,
    ).toBe(false);
    expect(
      classificationSchema.safeParse({ ...classification, user_id: top })
        .success,
    ).toBe(false);
  });
  test("AI reason must remain one short line", () => {
    const items = [{ clothes_id: top, slot: "top" }];
    expect(
      aiOutfitSchema.safeParse({
        items,
        reason_short: "涼しい朝に合う組み合わせです",
      }).success,
    ).toBe(true);
    expect(
      aiOutfitSchema.safeParse({ items, reason_short: "理由\n長い説明" })
        .success,
    ).toBe(false);
    expect(
      aiOutfitSchema.safeParse({ items, reason_short: "長".repeat(101) })
        .success,
    ).toBe(false);
  });
});

describe("shared API response contracts", () => {
  const date = "2026-10-13";
  const timestamp = "2026-10-13T00:00:00Z";
  const cloth = {
    id: top,
    category: "top",
    subtype: "shirt",
    color: "白",
    seasons: [],
    thickness: null,
    wear_limit: 1,
    wears_since_wash: 0,
    state: "available",
    classification_state: "pending",
  };
  const plan = {
    target_date: date,
    outfit_id: bottom,
    mode: "auto",
    plan_status: "partial",
    source: "rule",
    reason_short: "服を追加してください",
    items: [{ clothes_id: top, slot: "top", clothes: cloth }],
    warnings: ["ボトムスが未登録です"],
  };
  const override = {
    target_date: date,
    is_workday: false,
    occasion: "normal",
    mood: null,
  };
  const receipt = {
    id: top,
    target_date: date,
    outfit_id: bottom,
    confirmed_at: timestamp,
  };
  const deletion = {
    ok: true,
    category: "top",
    color: "white",
    clothes_id: top,
    deletion_token: bottom,
    server_now: timestamp,
    undo_until: "2026-10-13T00:00:30Z",
  };
  const fixtures = {
    "GET /api/me/preferences": {
      ...defaultPreferences,
      onboarding_completed: true,
    },
    "PATCH /api/me/preferences": {
      ...defaultPreferences,
      onboarding_completed: true,
    },
    "GET /api/me/work-weekdays": { weekdays: [1, 3, 5] },
    "PUT /api/me/work-weekdays": { weekdays: [] },
    "GET /api/me/day-overrides/:date": { override },
    "PUT /api/me/day-overrides/:date": override,
    "DELETE /api/me/day-overrides/:date": { ok: true },
    "POST /api/clothes/upload-url": {
      upload_id: top,
      upload_url: `/api/uploads/${top}`,
      method: "PUT",
      expires_at: timestamp,
      headers: { "Content-Type": "image/webp" },
    },
    "PUT /api/uploads/:id": { ok: true, upload_id: top },
    "POST /api/clothes": cloth,
    "GET /api/clothes": { items: [cloth], total: 1, page: 1, limit: 100 },
    "GET /api/clothes/:id": cloth,
    "PATCH /api/clothes/:id": cloth,
    "DELETE /api/clothes/:id": deletion,
    "POST /api/clothes/:id/restore": cloth,
    "GET /api/clothes/deletions": { items: [deletion], server_now: timestamp },
    "POST /api/clothes/:id/washed": cloth,
    "GET /api/outfits/today": plan,
    "POST /api/outfits/today/regenerate": {
      ...plan,
      daily_regens_remaining: 2,
    },
    "GET /api/plans/weekly": { week: "2026-10-12", days: [plan] },
    "POST /api/plans/weekly/regenerate": {
      week: "2026-10-12",
      days: [plan],
      weekly_regens_remaining: 1,
    },
    "PUT /api/plans/:date": plan,
    "POST /api/wear-logs": receipt,
    "GET /api/wear-logs": {
      items: [{ ...receipt, items: [{ clothes_id: top, clothes: cloth }] }],
    },
    "GET /api/wear-logs/:date": {
      ...receipt,
      items: [{ clothes_id: top, clothes: cloth }],
    },
    "PATCH /api/wear-logs/:date": receipt,
    "GET /api/me/usage": {
      daily_regens_remaining: 0,
      weekly_regens_remaining: 2,
      daily_reset_at: timestamp,
      weekly_reset_at: timestamp,
    },
    "POST /api/account/delete": { status: "deleting", job_id: top },
    "GET /api/account/deletion-status/:id": { status: "completed" },
  };

  test("all canonical endpoint responses have independently supplied valid examples", () => {
    expect(Object.keys(apiResponseSchemas).sort()).toEqual(
      Object.keys(fixtures).sort(),
    );
    for (const endpoint of Object.keys(fixtures) as (keyof typeof fixtures)[]) {
      const result = apiResponseSchemas[endpoint].safeParse(fixtures[endpoint]);
      expect(result.success, endpoint).toBe(true);
      if (result.success) expect(result.data).toEqual(fixtures[endpoint]);
      expect(
        apiResponseSchemas[endpoint].safeParse({}).success,
        `${endpoint}: empty object`,
      ).toBe(false);
    }
  });

  test("response validation must not invent request defaults for omitted fields", () => {
    for (const field of ["occasion", "mood", "is_workday", "target_date"]) {
      const incomplete: Record<string, unknown> = { ...override };
      delete incomplete[field];
      expect(
        apiResponseSchemas["PUT /api/me/day-overrides/:date"].safeParse(
          incomplete,
        ).success,
        field,
      ).toBe(false);
      expect(
        apiResponseSchemas["GET /api/me/day-overrides/:date"].safeParse({
          override: incomplete,
        }).success,
        field,
      ).toBe(false);
    }
  });

  test("only nullable API values accept absence", () => {
    expect(
      apiResponseSchemas["GET /api/outfits/today"].safeParse(null).success,
    ).toBe(true);
    expect(
      apiResponseSchemas["GET /api/me/day-overrides/:date"].safeParse({
        override: null,
      }).success,
    ).toBe(true);
    expect(
      apiResponseSchemas["GET /api/me/usage"].safeParse(null).success,
    ).toBe(false);
  });

  test("nested persisted values cannot cross the response boundary with incompatible types", () => {
    for (const malformed of [
      { ...plan, items: {} },
      { ...plan, warnings: [3] },
      {
        ...plan,
        items: [
          {
            clothes_id: top,
            slot: "top",
            clothes: { ...cloth, wears_since_wash: "0" },
          },
        ],
      },
      {
        ...plan,
        weather: {
          date,
          min_c: 10,
          max_c: 20,
          rain_probability: 101,
          source: "cache",
          fetched_at: null,
          provisional: true,
        },
      },
    ])
      expect(
        apiResponseSchemas["GET /api/outfits/today"].safeParse(malformed)
          .success,
      ).toBe(false);
  });

  test("error envelopes require declared string fields rather than trusting arbitrary JSON", () => {
    const error = {
      code: "SERVICE_UNAVAILABLE",
      message: "一時的に利用できません",
      request_id: "fixture-request",
    };
    expect(apiErrorResponseSchema.safeParse({ error }).success).toBe(true);
    for (const field of ["code", "message", "request_id"]) {
      const incomplete: Record<string, unknown> = { ...error };
      delete incomplete[field];
      expect(
        apiErrorResponseSchema.safeParse({ error: incomplete }).success,
      ).toBe(false);
      expect(
        apiErrorResponseSchema.safeParse({ error: { ...error, [field]: {} } })
          .success,
      ).toBe(false);
    }
  });
});
