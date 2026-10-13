import { z } from "zod";

export const passwordPolicy = {
  minLength: 8,
  maxBytes: 72,
  message:
    "8文字以上で、英小文字・英大文字・数字・記号をそれぞれ1文字以上含めてください。",
  maxMessage:
    "パスワードが長すぎます。72バイト以内（半角英数字・記号なら72文字以内）に短くしてください。",
} as const;

// Supabase Hosted's strongest preset: all 32 ASCII punctuation characters.
// Spaces and non-ASCII symbols do not satisfy the required symbol group.
export const newPasswordSchema = z
  .string()
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= passwordPolicy.maxBytes,
    passwordPolicy.maxMessage,
  )
  .min(passwordPolicy.minLength, passwordPolicy.message)
  .regex(/[a-z]/, passwordPolicy.message)
  .regex(/[A-Z]/, passwordPolicy.message)
  .regex(/[0-9]/, passwordPolicy.message)
  .regex(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/, passwordPolicy.message);

export const categorySchema = z.enum(["top", "bottom", "shoes", "outerwear"]);
export const seasonSchema = z.enum(["spring", "summer", "autumn", "winter"]);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === v;
  }, "日付が正しくありません");
export const regions = [
  ["hokkaido", "北海道", "Sapporo"],
  ["aomori", "青森県", "Aomori"],
  ["iwate", "岩手県", "Morioka"],
  ["miyagi", "宮城県", "Sendai"],
  ["akita", "秋田県", "Akita"],
  ["yamagata", "山形県", "Yamagata"],
  ["fukushima", "福島県", "Fukushima"],
  ["ibaraki", "茨城県", "Mito"],
  ["tochigi", "栃木県", "Utsunomiya"],
  ["gunma", "群馬県", "Maebashi"],
  ["saitama", "埼玉県", "Saitama"],
  ["chiba", "千葉県", "Chiba"],
  ["tokyo", "東京都", "Tokyo"],
  ["kanagawa", "神奈川県", "Yokohama"],
  ["niigata", "新潟県", "Niigata"],
  ["toyama", "富山県", "Toyama"],
  ["ishikawa", "石川県", "Kanazawa"],
  ["fukui", "福井県", "Fukui"],
  ["yamanashi", "山梨県", "Kofu"],
  ["nagano", "長野県", "Nagano"],
  ["gifu", "岐阜県", "Gifu"],
  ["shizuoka", "静岡県", "Shizuoka"],
  ["aichi", "愛知県", "Nagoya"],
  ["mie", "三重県", "Tsu"],
  ["shiga", "滋賀県", "Otsu"],
  ["kyoto", "京都府", "Kyoto"],
  ["osaka", "大阪府", "Osaka"],
  ["hyogo", "兵庫県", "Kobe"],
  ["nara", "奈良県", "Nara"],
  ["wakayama", "和歌山県", "Wakayama"],
  ["tottori", "鳥取県", "Tottori"],
  ["shimane", "島根県", "Matsue"],
  ["okayama", "岡山県", "Okayama"],
  ["hiroshima", "広島県", "Hiroshima"],
  ["yamaguchi", "山口県", "Yamaguchi"],
  ["tokushima", "徳島県", "Tokushima"],
  ["kagawa", "香川県", "Takamatsu"],
  ["ehime", "愛媛県", "Matsuyama"],
  ["kochi", "高知県", "Kochi"],
  ["fukuoka", "福岡県", "Fukuoka"],
  ["saga", "佐賀県", "Saga"],
  ["nagasaki", "長崎県", "Nagasaki"],
  ["kumamoto", "熊本県", "Kumamoto"],
  ["oita", "大分県", "Oita"],
  ["miyazaki", "宮崎県", "Miyazaki"],
  ["kagoshima", "鹿児島県", "Kagoshima"],
  ["okinawa", "沖縄県", "Naha"],
] as const;
export const preferencesSchema = z
  .object({
    style_keywords: z.array(z.string().trim().min(1).max(30)).max(10),
    dress_code: z.enum(["free", "office_casual"]),
    ng_categories: z.array(z.string().trim().min(1).max(40)).max(20),
    base_region_code: z.string().refine((v) => regions.some((r) => r[0] === v)),
    auto_adjust_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:00)?$/),
    holidays_off: z.boolean(),
    weekly_plan_enabled: z.boolean(),
  })
  .strict();
export const defaultPreferences: Preferences = {
  style_keywords: ["シンプル"],
  dress_code: "office_casual",
  ng_categories: [],
  base_region_code: "tokyo",
  auto_adjust_time: "07:00",
  holidays_off: true,
  weekly_plan_enabled: true,
};
export const preferencesPatchSchema = preferencesSchema.partial();
export const weekdaysSchema = z
  .object({
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .max(7)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export const overrideSchema = z
  .object({
    is_workday: z.boolean(),
    occasion: z
      .enum(["normal", "meeting", "external_visit", "other"])
      .default("normal"),
    mood: z.string().trim().max(80).nullable().default(null),
  })
  .strict();
export const clothesPatchSchema = z
  .object({
    category: categorySchema,
    subtype: z.string().trim().max(50),
    color: z.string().trim().min(1).max(30),
    seasons: z.array(seasonSchema).min(1).max(4),
    thickness: z.enum(["thin", "normal", "thick"]).nullable(),
    wear_limit: z.number().int().min(1).max(100),
    state: z.enum(["available", "laundry"]),
    is_available: z.boolean(),
  })
  .partial()
  .strict();
export const clothesCreateSchema = clothesPatchSchema
  .omit({ state: true })
  .extend({ upload_id: z.uuid() })
  .strict();
export const outfitItemSchema = z
  .object({ clothes_id: z.uuid(), slot: categorySchema })
  .strict();
export const manualPlanSchema = z
  .object({
    items: z
      .array(outfitItemSchema)
      .min(1)
      .max(4)
      .refine(
        (v) =>
          new Set(v.map((x) => x.slot)).size === v.length &&
          new Set(v.map((x) => x.clothes_id)).size === v.length,
      ),
  })
  .strict();
export const wearSchema = z
  .object({ target_date: dateSchema, outfit_id: z.uuid() })
  .strict();
export const regenSchema = z
  .object({
    reason: z
      .enum(["dislike_item", "more_casual", "different", "other"])
      .optional(),
  })
  .strict();
export const weeklyRegenSchema = z
  .object({ week: dateSchema.optional() })
  .strict();
export const classificationSchema = z
  .object({
    category: categorySchema,
    subtype: z.string().max(50),
    color: z.string().min(1).max(30),
    seasons: z.array(seasonSchema).min(1).max(4),
    confidence: z.number().min(0).max(1),
    review_required: z.boolean(),
  })
  .strict();
export const aiOutfitSchema = z
  .object({
    items: z.array(outfitItemSchema).min(1).max(4),
    reason_short: z
      .string()
      .min(1)
      .max(100)
      .refine((v) => !/[\r\n]/.test(v)),
  })
  .strict();
export type Category = z.infer<typeof categorySchema>;
export type Season = z.infer<typeof seasonSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
// Responses validate their declared fields while allowing database-added columns.
// Response schemas never fill request defaults or coerce malformed values.
export const dayOverrideSchema = z.object({
  is_workday: overrideSchema.shape.is_workday,
  occasion: overrideSchema.shape.occasion.removeDefault(),
  mood: overrideSchema.shape.mood.removeDefault(),
  target_date: dateSchema,
});
export type DayOverride = z.infer<typeof dayOverrideSchema>;
export type OutfitItem = z.infer<typeof outfitItemSchema>;
export const clothSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid().optional(),
  image_key: z.string().optional(),
  category: categorySchema,
  subtype: classificationSchema.shape.subtype,
  color: classificationSchema.shape.color,
  // Pending/manual classification can have no seasons yet.
  seasons: z.array(seasonSchema).max(4),
  thickness: clothesPatchSchema.shape.thickness.unwrap(),
  wear_limit: clothesPatchSchema.shape.wear_limit.unwrap(),
  wears_since_wash: z.number().int().nonnegative(),
  state: clothesPatchSchema.shape.state.unwrap(),
  is_available: z.boolean().optional(),
  classification_state: z.enum(["pending", "classified", "manual", "review"]),
  deleted_at: z.iso.datetime({ offset: true }).nullable().optional(),
  last_worn_at: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type Cloth = z.infer<typeof clothSchema>;
export const weatherSchema = z.object({
  date: dateSchema,
  min_c: z.number(),
  max_c: z.number(),
  rain_probability: z.number().min(0).max(100),
  source: z.enum(["live", "cache", "seasonal"]),
  fetched_at: z.iso.datetime({ offset: true }).nullable(),
  provisional: z.boolean(),
});
export type Weather = z.infer<typeof weatherSchema>;
export const planSchema = z.object({
  id: z.uuid().optional(),
  target_date: dateSchema,
  outfit_id: z.uuid().nullable().optional(),
  mode: z.enum(["auto", "manual_lock"]),
  plan_status: z.enum(["proposed", "partial", "confirmed", "skipped"]),
  source: z.enum(["ai", "rule", "manual"]),
  reason_short: z.string(),
  items: z.array(outfitItemSchema.extend({ clothes: clothSchema.optional() })),
  warnings: z.array(z.string()),
  weather: weatherSchema.optional(),
});
export type Plan = z.infer<typeof planSchema>;
export const wearLimits: Record<Category, number> = {
  top: 1,
  bottom: 3,
  shoes: 10,
  outerwear: 5,
};
export const preferencesResponseSchema = preferencesSchema.extend({
  onboarding_completed: z.boolean(),
});
export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>;
export const dayOverrideResponseSchema = z.object({
  override: dayOverrideSchema.nullable(),
});
export type DayOverrideResponse = z.infer<typeof dayOverrideResponseSchema>;
export const deletionReceiptSchema = z.object({
  status: z.literal("deleting"),
  job_id: z.uuid(),
});
export type DeletionReceipt = z.infer<typeof deletionReceiptSchema>;
export const deletionStatusSchema = z.object({
  status: z.enum(["deleting", "completed", "retry_required"]),
});
export type DeletionStatus = z.infer<typeof deletionStatusSchema>;
export const usageSchema = z.object({
  daily_regens_remaining: z.number().int().nonnegative(),
  weekly_regens_remaining: z.number().int().nonnegative(),
  daily_reset_at: z.iso.datetime({ offset: true }),
  weekly_reset_at: z.iso.datetime({ offset: true }),
});
export type Usage = z.infer<typeof usageSchema>;
export const wearReceiptSchema = z.object({
  id: z.uuid(),
  target_date: dateSchema,
  outfit_id: z.uuid(),
  confirmed_at: z.iso.datetime({ offset: true }),
});
export type WearReceipt = z.infer<typeof wearReceiptSchema>;
export const wearLogSchema = wearReceiptSchema.extend({
  items: z.array(z.object({ clothes_id: z.uuid(), clothes: clothSchema })),
});
export type WearLog = z.infer<typeof wearLogSchema>;
export const weeklyPlansSchema = z.object({
  week: dateSchema,
  days: z.array(planSchema),
  weekly_regens_remaining: z.number().int().nonnegative().optional(),
});
export type WeeklyPlans = z.infer<typeof weeklyPlansSchema>;
export const clothesPageSchema = z.object({
  items: z.array(clothSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
});
export type ClothesPage = z.infer<typeof clothesPageSchema>;
export const weekdaysResponseSchema = weekdaysSchema;
export type WeekdaysResponse = z.infer<typeof weekdaysResponseSchema>;
export const wearLogsResponseSchema = z.object({
  items: z.array(wearLogSchema),
});
export type WearLogsResponse = z.infer<typeof wearLogsResponseSchema>;
export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;
export const uploadGrantSchema = z.object({
  upload_id: z.uuid(),
  upload_url: z.string().min(1),
  method: z.literal("PUT"),
  expires_at: z.iso.datetime({ offset: true }),
  headers: z.object({ "Content-Type": z.literal("image/webp") }),
});
export type UploadGrant = z.infer<typeof uploadGrantSchema>;
export const uploadReceiptSchema = okResponseSchema.extend({
  upload_id: z.uuid(),
});
export const regeneratedPlanSchema = planSchema.extend({
  daily_regens_remaining: z.number().int().nonnegative(),
});
export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    request_id: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
type Endpoint<Request, Response> = { request: Request; response: Response };
/** Canonical HTTP contract. Dynamic segments are supplied separately by callers. */
export interface ApiContract {
  "GET /api/me/preferences": Endpoint<never, PreferencesResponse>;
  "PATCH /api/me/preferences": Endpoint<
    z.infer<typeof preferencesPatchSchema> & { onboarding_completed?: true },
    PreferencesResponse
  >;
  "GET /api/me/work-weekdays": Endpoint<never, WeekdaysResponse>;
  "PUT /api/me/work-weekdays": Endpoint<WeekdaysResponse, WeekdaysResponse>;
  "GET /api/me/day-overrides/:date": Endpoint<never, DayOverrideResponse>;
  "PUT /api/me/day-overrides/:date": Endpoint<
    z.infer<typeof overrideSchema>,
    DayOverride
  >;
  "DELETE /api/me/day-overrides/:date": Endpoint<never, OkResponse>;
  "POST /api/clothes/upload-url": Endpoint<Record<string, never>, UploadGrant>;
  "PUT /api/uploads/:id": Endpoint<Blob, z.infer<typeof uploadReceiptSchema>>;
  "POST /api/clothes": Endpoint<ClothesCreate, Cloth>;
  "GET /api/clothes": Endpoint<never, ClothesPage>;
  "GET /api/clothes/:id": Endpoint<never, Cloth>;
  "PATCH /api/clothes/:id": Endpoint<ClothesPatch, Cloth>;
  "DELETE /api/clothes/:id": Endpoint<never, OkResponse>;
  "POST /api/clothes/:id/washed": Endpoint<Record<string, never>, Cloth>;
  "GET /api/outfits/today": Endpoint<never, Plan | null>;
  "POST /api/outfits/today/regenerate": Endpoint<
    z.infer<typeof regenSchema>,
    z.infer<typeof regeneratedPlanSchema>
  >;
  "GET /api/plans/weekly": Endpoint<never, WeeklyPlans>;
  "POST /api/plans/weekly/regenerate": Endpoint<
    z.infer<typeof weeklyRegenSchema>,
    WeeklyPlans
  >;
  "PUT /api/plans/:date": Endpoint<z.infer<typeof manualPlanSchema>, Plan>;
  "POST /api/wear-logs": Endpoint<z.infer<typeof wearSchema>, WearReceipt>;
  "GET /api/wear-logs": Endpoint<never, WearLogsResponse>;
  "GET /api/wear-logs/:date": Endpoint<never, WearLog>;
  "PATCH /api/wear-logs/:date": Endpoint<
    { outfit_id: string } | z.infer<typeof manualPlanSchema>,
    WearReceipt
  >;
  "GET /api/me/usage": Endpoint<never, Usage>;
  "POST /api/account/delete": Endpoint<
    { confirmation: "退会する" },
    DeletionReceipt
  >;
  "GET /api/account/deletion-status/:id": Endpoint<never, DeletionStatus>;
}
export type ApiEndpoint = keyof ApiContract;
export type ApiRequest<K extends ApiEndpoint> = ApiContract[K]["request"];
export type ApiResponse<K extends ApiEndpoint> = ApiContract[K]["response"];
/** Every JSON endpoint has a shared runtime response validator. */
export const apiResponseSchemas = {
  "GET /api/me/preferences": preferencesResponseSchema,
  "PATCH /api/me/preferences": preferencesResponseSchema,
  "GET /api/me/work-weekdays": weekdaysResponseSchema,
  "PUT /api/me/work-weekdays": weekdaysResponseSchema,
  "GET /api/me/day-overrides/:date": dayOverrideResponseSchema,
  "PUT /api/me/day-overrides/:date": dayOverrideSchema,
  "DELETE /api/me/day-overrides/:date": okResponseSchema,
  "POST /api/clothes/upload-url": uploadGrantSchema,
  "PUT /api/uploads/:id": uploadReceiptSchema,
  "POST /api/clothes": clothSchema,
  "GET /api/clothes": clothesPageSchema,
  "GET /api/clothes/:id": clothSchema,
  "PATCH /api/clothes/:id": clothSchema,
  "DELETE /api/clothes/:id": okResponseSchema,
  "POST /api/clothes/:id/washed": clothSchema,
  "GET /api/outfits/today": planSchema.nullable(),
  "POST /api/outfits/today/regenerate": regeneratedPlanSchema,
  "GET /api/plans/weekly": weeklyPlansSchema,
  "POST /api/plans/weekly/regenerate": weeklyPlansSchema,
  "PUT /api/plans/:date": planSchema,
  "POST /api/wear-logs": wearReceiptSchema,
  "GET /api/wear-logs": wearLogsResponseSchema,
  "GET /api/wear-logs/:date": wearLogSchema,
  "PATCH /api/wear-logs/:date": wearReceiptSchema,
  "GET /api/me/usage": usageSchema,
  "POST /api/account/delete": deletionReceiptSchema,
  "GET /api/account/deletion-status/:id": deletionStatusSchema,
} satisfies { [K in ApiEndpoint]: z.ZodType<ApiResponse<K>> };
export type ClothesPatch = z.infer<typeof clothesPatchSchema>;
export type ClothesCreate = z.infer<typeof clothesCreateSchema>;
export const limits = {
  clothes: 100,
  uploadBytes: 5 * 1024 * 1024,
  dailyRegenerations: 3,
  weeklyRegenerations: 2,
  timezone: "Asia/Tokyo",
} as const;
