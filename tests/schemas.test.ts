import { describe, expect, test } from "vitest";
import {
  aiOutfitSchema,
  classificationSchema,
  clothesCreateSchema,
  clothesPatchSchema,
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
