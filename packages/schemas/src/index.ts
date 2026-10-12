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
export type DayOverride = z.infer<typeof overrideSchema> & {
  target_date: string;
};
export type OutfitItem = z.infer<typeof outfitItemSchema>;
export interface Cloth {
  id: string;
  user_id?: string;
  image_key?: string;
  category: Category;
  subtype: string;
  color: string;
  seasons: Season[];
  thickness: "thin" | "normal" | "thick" | null;
  wear_limit: number;
  wears_since_wash: number;
  state: "available" | "laundry";
  is_available?: boolean;
  classification_state: "pending" | "classified" | "manual" | "review";
  deleted_at?: string | null;
  last_worn_at?: string | null;
}
export interface Weather {
  date: string;
  min_c: number;
  max_c: number;
  rain_probability: number;
  source: "live" | "cache" | "seasonal";
  fetched_at: string | null;
  provisional: boolean;
}
export interface Plan {
  id?: string;
  target_date: string;
  outfit_id?: string | null;
  mode: "auto" | "manual_lock";
  plan_status: "proposed" | "partial" | "confirmed" | "skipped";
  source: "ai" | "rule" | "manual";
  reason_short: string;
  items: (OutfitItem & { clothes?: Cloth })[];
  warnings: string[];
  weather?: Weather;
}
export const wearLimits: Record<Category, number> = {
  top: 1,
  bottom: 3,
  shoes: 10,
  outerwear: 5,
};
export interface PreferencesResponse extends Preferences {
  onboarding_completed: boolean;
}
export interface DayOverrideResponse {
  override: DayOverride | null;
}
export interface DeletionReceipt {
  status: "deleting";
  job_id: string;
}
export interface DeletionStatus {
  status: "deleting" | "completed" | "retry_required";
}
export interface Usage {
  daily_regens_remaining: number;
  weekly_regens_remaining: number;
  daily_reset_at: string;
  weekly_reset_at: string;
}
export interface WearLog {
  id: string;
  target_date: string;
  outfit_id: string;
  confirmed_at: string;
  items: { clothes_id: string; clothes: Cloth }[];
}
export interface WeeklyPlans {
  week: string;
  days: Plan[];
  weekly_regens_remaining?: number;
}
export interface ClothesPage {
  items: Cloth[];
  total: number;
  page: number;
  limit: number;
}
export interface WeekdaysResponse {
  weekdays: number[];
}
export interface WearLogsResponse {
  items: WearLog[];
}
export interface WearReceipt {
  id: string;
  target_date: string;
  outfit_id: string;
  confirmed_at: string;
}
export interface OkResponse {
  ok: true;
}
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
  "PUT /api/uploads/:id": Endpoint<Blob, OkResponse & { upload_id: string }>;
  "POST /api/clothes": Endpoint<ClothesCreate, Cloth>;
  "GET /api/clothes": Endpoint<never, ClothesPage>;
  "GET /api/clothes/:id": Endpoint<never, Cloth>;
  "PATCH /api/clothes/:id": Endpoint<ClothesPatch, Cloth>;
  "DELETE /api/clothes/:id": Endpoint<never, OkResponse>;
  "POST /api/clothes/:id/washed": Endpoint<Record<string, never>, Cloth>;
  "GET /api/outfits/today": Endpoint<never, Plan | null>;
  "POST /api/outfits/today/regenerate": Endpoint<
    z.infer<typeof regenSchema>,
    Plan & { daily_regens_remaining: number }
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
export interface UploadGrant {
  upload_id: string;
  upload_url: string;
  method: "PUT";
  expires_at: string;
  headers: { "Content-Type": "image/webp" };
}
export type ClothesPatch = z.infer<typeof clothesPatchSchema>;
export type ClothesCreate = z.infer<typeof clothesCreateSchema>;
export const limits = {
  clothes: 100,
  uploadBytes: 5 * 1024 * 1024,
  dailyRegenerations: 3,
  weeklyRegenerations: 2,
  timezone: "Asia/Tokyo",
} as const;
