import type { SupabaseClient } from "@supabase/supabase-js";
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  CLOTHES_BUCKET: R2Bucket;
  APP_ORIGIN?: string;
  OPENAI_API_KEY?: string;
  AI_MODEL_CLASSIFY?: string;
  AI_MODEL_OUTFIT?: string;
  AI_REQUEST_RESERVE_USD?: string;
  AI_INPUT_USD_PER_MILLION?: string;
  AI_OUTPUT_USD_PER_MILLION?: string;
  WEATHER_API_KEY?: string;
  WEATHER_FORECAST_DAYS?: string;
  UPLOADS_ENABLED?: string;
  SIGNUPS_ENABLED?: string;
}
export interface Clients {
  user: SupabaseClient;
  admin: SupabaseClient;
}
export interface Dependencies {
  clients?: (env: Env, token: string) => Clients;
  now?: () => Date;
  fetch?: typeof fetch;
}
export interface Variables {
  userId: string;
  token: string;
  userDb: SupabaseClient;
  admin: SupabaseClient;
  requestId: string;
  now: Date;
}
export type AppEnv = { Bindings: Env; Variables: Variables };
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}
export async function result<T = any>(
  query: PromiseLike<{ data: T | null; error: any }>,
): Promise<T> {
  const { data, error } = await query;
  if (error) {
    const msg = String(error.message ?? "");
    if (/ACCOUNT_UNAVAILABLE/.test(msg))
      throw new ApiError(
        "ACCOUNT_UNAVAILABLE",
        403,
        "アカウントを利用できません",
      );
    if (/LIMIT|QUOTA|CAP|RATE/.test(msg))
      throw new ApiError("LIMIT_REACHED", 429, "利用上限に達しました");
    if (/NOT_FOUND/.test(msg))
      throw new ApiError("NOT_FOUND", 404, "見つかりません");
    if (/DELET|FORBIDDEN|OWNER/.test(msg))
      throw new ApiError("FORBIDDEN", 403, "この操作は許可されていません");
    if (/MISSING_REQUIRED|FUTURE_WEAR/.test(msg))
      throw new ApiError(
        "INVALID_OUTFIT",
        422,
        "トップスとボトムス、着用日を確認してください",
      );
    if (
      /CONFLICT|LOCK|IDEMPOT|INVALID|UNAVAILABLE|LAUNDRY|NG_|EXPIRED/.test(msg)
    )
      throw new ApiError(
        "CONFLICT",
        409,
        "状態が変わりました。内容を確認してください",
      );
    throw new ApiError(
      "DATABASE_UNAVAILABLE",
      503,
      "保存先との通信に失敗しました",
    );
  }
  return data as T;
}
