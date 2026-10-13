import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  clothesCreateSchema,
  clothesPatchSchema,
  dateSchema,
  defaultPreferences,
  limits,
  manualPlanSchema,
  overrideSchema,
  preferencesPatchSchema,
  preferencesSchema,
  regenSchema,
  wearLimits,
  wearSchema,
  weekdaysSchema,
  weeklyRegenSchema,
  type Cloth,
  type Plan,
  type DayOverrideResponse,
  type ApiEndpoint,
  type ApiResponse,
} from "@outfit/schemas";
import {
  addDays,
  jstDate,
  jstWeekStart,
  nextDailyReset,
  nextWeeklyReset,
  planWarnings,
  validateOutfit,
  weekStart,
} from "@outfit/domain";
import {
  ApiError,
  apiErrorResponse,
  result,
  type AppEnv,
  type Dependencies,
  type Env,
} from "./types";
import {
  enqueueReevaluation,
  flattenPlan,
  generatePlans,
  loadContext,
  planSelect,
  savePlan,
} from "./service";
import { runSpecificJob } from "./scheduler";

export const defaultClients = (env: Env, token: string) => ({
  user: createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  }),
  admin: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }),
});
const uuid = z.uuid();
const key = (c: any): string => {
  const k = c.req.header("Idempotency-Key");
  if (!k || !/^[-\w:]{8,128}$/.test(k))
    throw new ApiError(
      "IDEMPOTENCY_KEY_REQUIRED",
      400,
      "操作キーが必要です。再読み込みしてください",
    );
  return k;
};
async function body<T>(c: any, schema: z.ZodType<T>): Promise<T> {
  let value;
  try {
    const raw = await c.req.text();
    if (raw.length > 32768)
      throw new ApiError("PAYLOAD_TOO_LARGE", 413, "入力が大きすぎます");
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("INVALID_JSON", 400, "JSON形式が正しくありません");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError("VALIDATION_ERROR", 422, "入力内容を確認してください");
  return parsed.data;
}
function dateParam(value: string): string {
  const parsed = dateSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError("INVALID_DATE", 422, "日付が正しくありません");
  return parsed.data;
}
function idParam(value: string): string {
  if (!uuid.safeParse(value).success)
    throw new ApiError("INVALID_ID", 422, "識別子が正しくありません");
  return value;
}
const ownCloth = async (c: any, id: string): Promise<Cloth> => {
  const cloth = await result<Cloth | null>(
    c
      .get("userDb")
      .from("clothes")
      .select("*")
      .eq("user_id", c.get("userId"))
      .eq("id", idParam(id))
      .is("deleted_at", null)
      .maybeSingle(),
  );
  if (!cloth) throw new ApiError("NOT_FOUND", 404, "服が見つかりません");
  return cloth;
};
const cleanPrefs = (row: any) =>
  preferencesSchema.parse({
    ...Object.fromEntries(
      Object.keys(defaultPreferences).map((k) => [
        k,
        row?.[k] ?? defaultPreferences[k as keyof typeof defaultPreferences],
      ]),
    ),
  });
const reply = <K extends ApiEndpoint>(
  c: any,
  _endpoint: K,
  data: ApiResponse<K>,
  status = 200,
): Response => c.json(data, status);

/** Factory accepts isolated clients, clock and fetch for independent security tests. */
export function createApp(deps: Dependencies = {}) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.set("now", deps.now?.() ?? new Date());
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    c.header("X-Request-Id", c.get("requestId"));
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: limits.uploadBytes,
      onError: () => {
        throw new ApiError(
          "PAYLOAD_TOO_LARGE",
          413,
          "画像は5MB以下にしてください",
        );
      },
    }),
  );
  app.onError((error, c) => {
    const e =
      error instanceof ApiError
        ? error
        : new ApiError(
            "INTERNAL_ERROR",
            503,
            "処理に失敗しました。少し待ってお試しください",
          );
    return apiErrorResponse(e, c.get("requestId"));
  });
  app.get("/health", (c) => c.json({ ok: true, service: "outfit-api" }));
  // The random deletion receipt permits progress after the account/JWT is removed.
  // It reveals only coarse job state; no owner, image keys, payloads or failure details.
  app.get("/api/account/deletion-status/:id", async (c) => {
    if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_ROLE_KEY)
      throw new ApiError("NOT_CONFIGURED", 503, "接続設定が必要です");
    const { admin } = (deps.clients ?? defaultClients)(c.env, "");
    const job = await result<any>(
      admin
        .from("generation_jobs")
        .select("status")
        .eq("id", idParam(c.req.param("id")))
        .eq("job_type", "account_delete")
        .maybeSingle(),
    );
    if (!job) throw new ApiError("NOT_FOUND", 404, "削除受付が見つかりません");
    return reply(c, "GET /api/account/deletion-status/:id", {
      status:
        job.status === "completed"
          ? "completed"
          : job.status === "failed"
            ? "retry_required"
            : "deleting",
    });
  });
  app.use("/api/*", async (c, next) => {
    if (
      !c.env.SUPABASE_URL ||
      !c.env.SUPABASE_ANON_KEY ||
      !c.env.SUPABASE_SERVICE_ROLE_KEY
    )
      throw new ApiError("NOT_CONFIGURED", 503, "接続設定が必要です");
    const origin = c.req.header("Origin");
    if (origin && c.env.APP_ORIGIN && origin !== c.env.APP_ORIGIN)
      throw new ApiError(
        "ORIGIN_FORBIDDEN",
        403,
        "許可されていないアクセスです",
      );
    const authorization = c.req.header("Authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 10000)
      throw new ApiError("UNAUTHORIZED", 401, "ログインしてください");
    const token = authorization.slice(7),
      clients = (deps.clients ?? defaultClients)(c.env, token);
    // getUser contacts the issuer, validating signature, expiry and account existence.
    const { data, error } = await clients.user.auth.getUser(token);
    if (error || !data.user)
      throw new ApiError("UNAUTHORIZED", 401, "ログインし直してください");
    const userId = data.user.id;
    c.set("userId", userId);
    c.set("token", token);
    c.set("userDb", clients.user);
    c.set("admin", clients.admin);
    const profile = await result<any>(
      clients.admin
        .from("profiles")
        .select("user_id,deleting_at")
        .eq("user_id", userId)
        .maybeSingle(),
    );
    if (profile?.deleting_at)
      throw new ApiError("ACCOUNT_DELETING", 403, "アカウントの削除処理中です");
    if (!profile && c.env.SIGNUPS_ENABLED === "false")
      throw new ApiError(
        "SIGNUPS_PAUSED",
        503,
        "新規利用の受付を一時停止しています",
      );
    if (!profile)
      await result(clients.admin.rpc("ensure_profile", { p_user_id: userId }));
    const allowed = await result<boolean>(
      clients.admin.rpc("check_rate_limit", {
        p_user_id: userId,
        p_bucket: c.req.method === "GET" ? "read" : "write",
        p_limit: c.req.method === "GET" ? 180 : 60,
        p_window_seconds: 60,
      }),
    );
    if (!allowed)
      throw new ApiError(
        "RATE_LIMITED",
        429,
        "操作が多いため、少し待ってください",
      );
    if (!["GET", "HEAD"].includes(c.req.method)) {
      key(c);
      const size = Number(c.req.header("Content-Length") ?? 0);
      if (size > limits.uploadBytes)
        throw new ApiError(
          "PAYLOAD_TOO_LARGE",
          413,
          "画像は5MB以下にしてください",
        );
    }
    await next();
  });
  app.use("/api/*", async (c, next) => {
    if (["GET", "HEAD"].includes(c.req.method)) return next();
    const requestKey = key(c),
      operation = `${c.req.method}:${c.req.path}`;
    const bytes = await c.req.raw.clone().arrayBuffer();
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const args = {
      p_user_id: c.get("userId"),
      p_operation: operation,
      p_request_key: requestKey,
      p_hash: hash,
    };
    const receipt = await result<any>(
      c.get("admin").rpc("claim_operation", args),
    );
    if (receipt?.state === "pending")
      throw new ApiError(
        "OPERATION_IN_PROGRESS",
        409,
        "同じ操作を処理中です。少し待って再試行してください",
      );
    if (receipt?.state === "complete")
      return c.newResponse(JSON.stringify(receipt.response), receipt.status, {
        "Content-Type": "application/json",
        "Idempotency-Replayed": "true",
      });
    if (receipt?.state !== "new")
      throw new ApiError(
        "DATABASE_UNAVAILABLE",
        503,
        "操作を受け付けられませんでした",
      );
    try {
      await next();
      if (c.res.status >= 400) {
        await result(c.get("admin").rpc("abort_operation", args));
        return;
      }
      const response = await c.res.clone().json();
      await result(
        c.get("admin").rpc("finish_operation", {
          ...args,
          p_status: c.res.status,
          p_response: response,
        }),
      );
    } catch (error) {
      await result(c.get("admin").rpc("abort_operation", args));
      throw error;
    }
  });
  app.get("/api/me/preferences", async (c) => {
    const [prefs, profile] = await Promise.all([
      result<any>(
        c
          .get("userDb")
          .from("user_preferences")
          .select("*")
          .eq("user_id", c.get("userId"))
          .single(),
      ),
      result<any>(
        c
          .get("userDb")
          .from("profiles")
          .select("onboarding_completed_at")
          .eq("user_id", c.get("userId"))
          .single(),
      ),
    ]);
    return reply(c, "GET /api/me/preferences", {
      ...cleanPrefs(prefs),
      onboarding_completed: !!profile.onboarding_completed_at,
    });
  });
  app.patch("/api/me/preferences", async (c) => {
    const { onboarding_completed, ...data } = await body(
      c,
      preferencesPatchSchema.extend({
        onboarding_completed: z.literal(true).optional(),
      }),
    );
    const prefs = Object.keys(data).length
      ? await result<any>(
          c
            .get("admin")
            .from("user_preferences")
            .update(data)
            .eq("user_id", c.get("userId"))
            .select()
            .single(),
        )
      : await result<any>(
          c
            .get("userDb")
            .from("user_preferences")
            .select("*")
            .eq("user_id", c.get("userId"))
            .single(),
        );
    if (onboarding_completed)
      await result(
        c
          .get("admin")
          .from("profiles")
          .update({ onboarding_completed_at: c.get("now").toISOString() })
          .eq("user_id", c.get("userId")),
      );
    await enqueueReevaluation(
      c.get("admin"),
      c.get("userId"),
      jstDate(c.get("now")),
    );
    const profile = await result<any>(
      c
        .get("userDb")
        .from("profiles")
        .select("onboarding_completed_at")
        .eq("user_id", c.get("userId"))
        .single(),
    );
    return reply(c, "PATCH /api/me/preferences", {
      ...cleanPrefs(prefs),
      onboarding_completed:
        !!onboarding_completed || !!profile?.onboarding_completed_at,
    });
  });
  app.get("/api/me/work-weekdays", async (c) => {
    const rows = await result<any[]>(
      c
        .get("userDb")
        .from("work_weekdays")
        .select("weekday,is_workday")
        .eq("user_id", c.get("userId")),
    );
    return reply(c, "GET /api/me/work-weekdays", {
      weekdays: rows.filter((r) => r.is_workday).map((r) => r.weekday),
    });
  });
  app.put("/api/me/work-weekdays", async (c) => {
    const data = await body(c, weekdaysSchema);
    await result(
      c
        .get("admin")
        .from("work_weekdays")
        .upsert(
          Array.from({ length: 7 }, (_, i) => ({
            user_id: c.get("userId"),
            weekday: i + 1,
            is_workday: data.weekdays.includes(i + 1),
          })),
          { onConflict: "user_id,weekday" },
        ),
    );
    await enqueueReevaluation(
      c.get("admin"),
      c.get("userId"),
      jstDate(c.get("now")),
    );
    return reply(c, "PUT /api/me/work-weekdays", data);
  });
  app.get("/api/me/day-overrides/:date", async (c) => {
    const date = dateParam(c.req.param("date"));
    const data = await result<DayOverrideResponse["override"]>(
      c
        .get("userDb")
        .from("day_overrides")
        .select("target_date,is_workday,occasion,mood")
        .eq("user_id", c.get("userId"))
        .eq("target_date", date)
        .maybeSingle(),
    );
    return reply(c, "GET /api/me/day-overrides/:date", {
      override: data,
    } satisfies DayOverrideResponse);
  });
  app.put("/api/me/day-overrides/:date", async (c) => {
    const date = dateParam(c.req.param("date")),
      data = await body(c, overrideSchema);
    await result(
      c
        .get("admin")
        .from("day_overrides")
        .upsert(
          { ...data, user_id: c.get("userId"), target_date: date },
          { onConflict: "user_id,target_date" },
        ),
    );
    await enqueueReevaluation(c.get("admin"), c.get("userId"), date);
    return reply(c, "PUT /api/me/day-overrides/:date", {
      ...data,
      target_date: date,
    });
  });
  app.delete("/api/me/day-overrides/:date", async (c) => {
    const date = dateParam(c.req.param("date"));
    await result(
      c
        .get("admin")
        .from("day_overrides")
        .delete()
        .eq("user_id", c.get("userId"))
        .eq("target_date", date),
    );
    await enqueueReevaluation(c.get("admin"), c.get("userId"), date);
    return reply(c, "DELETE /api/me/day-overrides/:date", { ok: true });
  });
  app.post("/api/clothes/upload-url", async (c) => {
    await body(c, z.object({}).strict());
    if (c.env.UPLOADS_ENABLED === "false")
      throw new ApiError(
        "UPLOADS_PAUSED",
        503,
        "現在、画像の追加を一時停止しています",
      );
    const grant = await result<any>(
      c.get("admin").rpc("reserve_upload", {
        p_user_id: c.get("userId"),
        p_request_key: key(c),
      }),
    );
    if (grant.used_at || Date.parse(grant.expires_at) <= +c.get("now"))
      throw new ApiError(
        "UPLOAD_EXPIRED",
        409,
        "アップロードをやり直してください",
      );
    return reply(c, "POST /api/clothes/upload-url", {
      upload_id: grant.id,
      upload_url: `/api/uploads/${grant.id}`,
      method: "PUT",
      expires_at: grant.expires_at,
      headers: { "Content-Type": "image/webp" },
    });
  });
  app.put("/api/uploads/:id", async (c) => {
    const grant = await result<any>(
      c
        .get("userDb")
        .from("upload_grants")
        .select("*")
        .eq("user_id", c.get("userId"))
        .eq("id", idParam(c.req.param("id")))
        .maybeSingle(),
    );
    if (
      !grant ||
      grant.used_at ||
      Date.parse(grant.expires_at) <= +c.get("now")
    )
      throw new ApiError(
        "UPLOAD_EXPIRED",
        403,
        "アップロードの有効期限が切れています",
      );
    if (c.req.header("Content-Type") !== "image/webp")
      throw new ApiError("INVALID_IMAGE", 422, "WebP画像を選んでください");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    validateWebP(bytes);
    const existing = await c.env.CLOTHES_BUCKET.head(grant.image_key);
    if (existing)
      return reply(c, "PUT /api/uploads/:id", {
        ok: true,
        upload_id: grant.id,
      });
    const written=await c.env.CLOTHES_BUCKET.put(grant.image_key, bytes, {
      onlyIf:new Headers({"If-None-Match":"*"}),
      httpMetadata: {
        contentType: "image/webp",
        cacheControl: "private, no-store",
      },
      customMetadata: { owner: c.get("userId"), upload_id: grant.id },
    });
    let active: any;
    try {
      active = await result<any>(
        c
          .get("admin")
          .from("profiles")
          .select("deleting_at")
          .eq("user_id", c.get("userId"))
          .maybeSingle(),
      );
    } catch (error) {
      if(written!==null)await c.env.CLOTHES_BUCKET.delete(grant.image_key);
      throw error;
    }
    if (!active || active.deleting_at) {
      await c.env.CLOTHES_BUCKET.delete(grant.image_key);
      throw new ApiError("ACCOUNT_DELETING", 403, "アカウントの削除処理中です");
    }
    return reply(c, "PUT /api/uploads/:id", { ok: true, upload_id: grant.id });
  });
  app.post("/api/clothes", async (c) => {
    const { upload_id, ...metadata } = await body(c, clothesCreateSchema);
    const existing = await result<any>(
      c
        .get("userDb")
        .from("clothes")
        .select("*")
        .eq("user_id", c.get("userId"))
        .eq("request_key", key(c))
        .maybeSingle(),
    );
    if (existing) return reply(c, "POST /api/clothes", existing);
    const grant = await result<any>(
      c
        .get("userDb")
        .from("upload_grants")
        .select("*")
        .eq("user_id", c.get("userId"))
        .eq("id", upload_id)
        .maybeSingle(),
    );
    if (
      !grant ||
      grant.used_at ||
      Date.parse(grant.expires_at) <= +c.get("now")
    )
      throw new ApiError(
        "INVALID_UPLOAD",
        422,
        "画像をアップロードし直してください",
      );
    const object = await c.env.CLOTHES_BUCKET.get(grant.image_key);
    if (
      !object ||
      object.size > limits.uploadBytes ||
      object.httpMetadata?.contentType !== "image/webp" ||
      object.customMetadata?.owner !== c.get("userId")
    )
      throw new ApiError("INVALID_IMAGE", 422, "画像を確認できません");
    validateWebP(new Uint8Array(await object.arrayBuffer()));
    const manual =
      !!metadata.category && !!metadata.color && !!metadata.seasons?.length;
    const cloth = await result<any>(
      c.get("admin").rpc("create_clothes", {
        p_user_id: c.get("userId"),
        p_request_key: key(c),
        p_data: {
          ...metadata,
          image_key: grant.image_key,
          classification_state: manual ? "manual" : "pending",
          wear_limit:
            metadata.wear_limit ?? wearLimits[metadata.category ?? "top"],
        },
      }),
    );
    if (!manual) {
      await result(
        c
          .get("admin")
          .from("generation_jobs")
          .upsert(
            {
              user_id: c.get("userId"),
              job_type: "classify",
              target_date: jstDate(c.get("now")),
              dedupe_key: `classify:${cloth.id}`,
              payload: { clothes_id: cloth.id },
              status: "pending",
            },
            { onConflict: "dedupe_key", ignoreDuplicates: true },
          ),
      );
      const job = await result<any>(
        c
          .get("admin")
          .from("generation_jobs")
          .select("id")
          .eq("dedupe_key", `classify:${cloth.id}`)
          .single(),
      );
      // Workers continues this bounded leased classification after the response;
      // local request-only test environments rely on the same Cron retry path.
      try {
        c.executionCtx.waitUntil(runSpecificJob(c.env, job.id, c.get("now")));
      } catch {
        /* no execution context */
      }
    }
    await enqueueReevaluation(
      c.get("admin"),
      c.get("userId"),
      jstDate(c.get("now")),
    );
    return reply(c, "POST /api/clothes", cloth, 201);
  });
  app.get("/api/clothes", async (c) => {
    const page = Math.max(
        1,
        Math.min(limits.clothes, Number(c.req.query("page")) || 1),
      ),
      limit = Math.max(
        1,
        Math.min(
          limits.clothes,
          Number(c.req.query("limit")) || limits.clothes,
        ),
      );
    let query = c
      .get("userDb")
      .from("clothes")
      .select("*", { count: "exact" })
      .eq("user_id", c.get("userId"))
      .is("deleted_at", null);
    const state = c.req.query("state");
    if (state) {
      if (!["available", "laundry"].includes(state))
        throw new ApiError("VALIDATION_ERROR", 422, "状態が正しくありません");
      query = query.eq("state", state);
    }
    const { data, error, count } = await query
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (error)
      throw new ApiError("DATABASE_UNAVAILABLE", 503, "服を取得できません");
    return reply(c, "GET /api/clothes", {
      items: data ?? [],
      total: count ?? 0,
      page,
      limit,
    });
  });
  app.get("/api/clothes/:id/image", async (c) => {
    const cloth = await ownCloth(c, c.req.param("id"));
    const object = await c.env.CLOTHES_BUCKET.get(cloth.image_key!);
    if (!object) throw new ApiError("NOT_FOUND", 404, "画像が見つかりません");
    return new Response(object.body, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  });
  app.get("/api/clothes/:id", async (c) =>
    reply(c, "GET /api/clothes/:id", await ownCloth(c, c.req.param("id"))),
  );
  app.patch("/api/clothes/:id", async (c) => {
    const cloth = await ownCloth(c, c.req.param("id")),
      data = await body(c, clothesPatchSchema);
    const update = {
      ...data,
      ...(data.category || data.color || data.seasons
        ? { classification_state: "manual" }
        : {}),
    };
    const row = await result<any>(
      c
        .get("admin")
        .from("clothes")
        .update(update)
        .eq("id", cloth.id)
        .eq("user_id", c.get("userId"))
        .select()
        .single(),
    );
    await enqueueReevaluation(
      c.get("admin"),
      c.get("userId"),
      jstDate(c.get("now")),
    );
    return reply(c, "PATCH /api/clothes/:id", row);
  });
  app.delete("/api/clothes/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    const cloth = await result<any>(
      c
        .get("userDb")
        .from("clothes")
        .select("*")
        .eq("id", id)
        .eq("user_id", c.get("userId"))
        .maybeSingle(),
    );
    if (!cloth) throw new ApiError("NOT_FOUND", 404, "服が見つかりません");
    await result(
      c
        .get("admin")
        .from("clothes")
        .update({ deleted_at: c.get("now").toISOString() })
        .eq("id", id)
        .eq("user_id", c.get("userId")),
    );
    await result(
      c
        .get("admin")
        .from("generation_jobs")
        .upsert(
          {
            user_id: c.get("userId"),
            job_type: "image_delete",
            payload: { image_key: cloth.image_key },
            dedupe_key: `image_delete:${id}`,
            status: "pending",
          },
          { onConflict: "dedupe_key", ignoreDuplicates: true },
        ),
    );
    await enqueueReevaluation(
      c.get("admin"),
      c.get("userId"),
      jstDate(c.get("now")),
    );
    return reply(c, "DELETE /api/clothes/:id", { ok: true });
  });
  app.post("/api/clothes/:id/washed", async (c) => {
    await ownCloth(c, c.req.param("id"));
    await body(c, z.object({}).strict());
    const row = await result<any>(
      c.get("admin").rpc("wash_clothes", {
        p_user_id: c.get("userId"),
        p_clothes_id: c.req.param("id"),
        p_request_key: key(c),
      }),
    );
    await enqueueReevaluation(
      c.get("admin"),
      c.get("userId"),
      jstDate(c.get("now")),
    );
    return reply(c, "POST /api/clothes/:id/washed", row);
  });
  app.get("/api/outfits/today", async (c) => {
    const today = jstDate(c.get("now")),
      days = await generatePlans(
        c.env,
        c.get("admin"),
        c.get("userId"),
        weekStart(today),
        c.get("now"),
        { onlyDate: today, fetcher: deps.fetch },
      );
    return reply(
      c,
      "GET /api/outfits/today",
      days.find((d) => d.target_date === today) ?? null,
    );
  });
  app.get("/api/plans/weekly", async (c) => {
    const week = weekStart(
      dateParam(c.req.query("week") ?? jstDate(c.get("now"))),
    );
    const days = await generatePlans(
      c.env,
      c.get("admin"),
      c.get("userId"),
      week,
      c.get("now"),
      { fetcher: deps.fetch },
    );
    return reply(c, "GET /api/plans/weekly", { week, days });
  });
  app.post("/api/outfits/today/regenerate", async (c) => {
    const data = await body(c, regenSchema),
      today = jstDate(c.get("now"));
    const quota = await result<any>(
      c.get("admin").rpc("consume_quota", {
        p_user_id: c.get("userId"),
        p_action: "daily_regen",
        p_request_key: key(c),
      }),
    );
    if (!quota.allowed)
      throw new ApiError(
        "DAILY_LIMIT_REACHED",
        429,
        "今日の再提案は3回までです",
      );
    if (data.reason && !quota.replayed)
      await result(
        c
          .get("admin")
          .from("outfit_feedback")
          .insert({
            user_id: c.get("userId"),
            target_date: today,
            reason: data.reason,
          }),
      );
    const days = await generatePlans(
      c.env,
      c.get("admin"),
      c.get("userId"),
      weekStart(today),
      c.get("now"),
      {
        force: !quota.replayed,
        onlyDate: today,
        rotation: limits.dailyRegenerations - quota.remaining,
        reason: data.reason,
        action: "daily_regen",
        requestKey: key(c),
        fetcher: deps.fetch,
      },
    );
    const plan = days.find((d) => d.target_date === today);
    if (!plan)
      throw new ApiError("PLAN_UNAVAILABLE", 503, "計画を取得できませんでした");
    return reply(c, "POST /api/outfits/today/regenerate", {
      ...plan,
      daily_regens_remaining: quota.remaining,
    });
  });
  app.post("/api/plans/weekly/regenerate", async (c) => {
    const data = await body(c, weeklyRegenSchema),
      week = weekStart(data.week ?? jstDate(c.get("now")));
    const quota = await result<any>(
      c.get("admin").rpc("consume_quota", {
        p_user_id: c.get("userId"),
        p_action: "weekly_regen",
        p_request_key: key(c),
      }),
    );
    if (!quota.allowed)
      throw new ApiError(
        "WEEKLY_LIMIT_REACHED",
        429,
        "週間の再提案は週2回までです",
      );
    const days = await generatePlans(
      c.env,
      c.get("admin"),
      c.get("userId"),
      week,
      c.get("now"),
      {
        force: !quota.replayed,
        rotation: limits.weeklyRegenerations - quota.remaining,
        action: "weekly_regen",
        requestKey: key(c),
        fetcher: deps.fetch,
      },
    );
    return reply(c, "POST /api/plans/weekly/regenerate", {
      week,
      days,
      weekly_regens_remaining: quota.remaining,
    });
  });
  app.put("/api/plans/:date", async (c) => {
    const date = dateParam(c.req.param("date")),
      data = await body(c, manualPlanSchema);
    const context = await loadContext(
      c.get("admin"),
      c.get("userId"),
      weekStart(date),
    );
    if (!validateOutfit(data.items, { ...context, date }, true))
      throw new ApiError(
        "INVALID_OUTFIT",
        422,
        "着用できない服が含まれています",
      );
    const plan: Plan = {
      target_date: date,
      mode: "manual_lock",
      source: "manual",
      plan_status:
        data.items.some((i) => i.slot === "top") &&
        data.items.some((i) => i.slot === "bottom")
          ? "proposed"
          : "partial",
      reason_short: "自分で選んだコーデです",
      items: data.items,
      warnings: [],
    };
    plan.warnings = planWarnings(plan, { ...context, date });
    await savePlan(c.get("admin"), c.get("userId"), plan, true);
    const row = await result<any>(
      c
        .get("userDb")
        .from("daily_plans")
        .select(planSelect)
        .eq("user_id", c.get("userId"))
        .eq("target_date", date)
        .single(),
    );
    return reply(c, "PUT /api/plans/:date", flattenPlan(row));
  });
  app.post("/api/wear-logs", async (c) => {
    const data = await body(c, wearSchema);
    if (data.target_date > jstDate(c.get("now")))
      throw new ApiError("FUTURE_WEAR", 422, "未来の着用は確定できません");
    const row = await result<any>(
      c.get("admin").rpc("confirm_wear", {
        p_user_id: c.get("userId"),
        p_target_date: data.target_date,
        p_outfit_id: data.outfit_id,
        p_request_key: key(c),
      }),
    );
    await enqueueReevaluation(
      c.get("admin"),
      c.get("userId"),
      jstDate(c.get("now")),
    );
    return reply(c, "POST /api/wear-logs", row);
  });
  app.get("/api/wear-logs", async (c) => {
    const month = c.req.query("month") ?? jstDate(c.get("now")).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      throw new ApiError("INVALID_DATE", 422, "月が正しくありません");
    const rows = await result<any[]>(
      c
        .get("userDb")
        .from("wear_logs")
        .select("*,wear_log_items(clothes_id,clothes(*))")
        .eq("user_id", c.get("userId"))
        .gte("target_date", month + "-01")
        .lte(
          "target_date",
          addDays(
            new Date(
              Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1),
            )
              .toISOString()
              .slice(0, 10),
            -1,
          ),
        )
        .order("target_date", { ascending: false }),
    );
    return reply(c, "GET /api/wear-logs", {
      items: rows.map((r) => ({ ...r, items: r.wear_log_items })),
    });
  });
  app.get("/api/wear-logs/:date", async (c) => {
    const date = dateParam(c.req.param("date"));
    const row = await result<any>(
      c
        .get("userDb")
        .from("wear_logs")
        .select("*,wear_log_items(clothes_id,clothes(*))")
        .eq("user_id", c.get("userId"))
        .eq("target_date", date)
        .maybeSingle(),
    );
    if (!row) throw new ApiError("NOT_FOUND", 404, "着用履歴がありません");
    return reply(c, "GET /api/wear-logs/:date", {
      ...row,
      items: row.wear_log_items,
    });
  });
  app.patch("/api/wear-logs/:date", async (c) => {
    const date = dateParam(c.req.param("date")),
      data = await body(
        c,
        z.union([z.object({ outfit_id: uuid }).strict(), manualPlanSchema]),
      );
    let outfitId: string;
    if ("outfit_id" in data) outfitId = data.outfit_id;
    else {
      // Corrections create an immutable outfit without changing the confirmed plan first.
      const clothes = await result<Cloth[]>(
        c
          .get("userDb")
          .from("clothes")
          .select("*")
          .eq("user_id", c.get("userId"))
          .in(
            "id",
            data.items.map((i) => i.clothes_id),
          ),
      );
      if (
        data.items.some(
          (i) =>
            !clothes.some(
              (c) =>
                c.id === i.clothes_id && c.category === i.slot && !c.deleted_at,
            ),
        )
      )
        throw new ApiError("INVALID_OUTFIT", 422, "服が見つかりません");
      const outfit = await result<any>(
        c
          .get("admin")
          .from("outfits")
          .insert({
            user_id: c.get("userId"),
            source: "manual",
            reason_short: "着用履歴を修正しました",
          })
          .select("id")
          .single(),
      );
      outfitId = outfit.id;
      await result(
        c
          .get("admin")
          .from("outfit_items")
          .insert(
            data.items.map((i) => ({
              ...i,
              user_id: c.get("userId"),
              outfit_id: outfitId,
            })),
          ),
      );
    }
    const row = await result<any>(
      c.get("admin").rpc("correct_wear", {
        p_user_id: c.get("userId"),
        p_target_date: date,
        p_outfit_id: outfitId,
        p_request_key: key(c),
      }),
    );
    await enqueueReevaluation(
      c.get("admin"),
      c.get("userId"),
      jstDate(c.get("now")),
    );
    return reply(c, "PATCH /api/wear-logs/:date", row);
  });
  app.get("/api/me/usage", async (c) => {
    const now = c.get("now"),
      rows = await result<any[]>(
        c
          .get("admin")
          .from("quota_counters")
          .select("action,period_start,used")
          .eq("user_id", c.get("userId"))
          .in("period_start", [jstDate(now), jstWeekStart(now)]),
      );
    return reply(c, "GET /api/me/usage", {
      daily_regens_remaining: Math.max(
        0,
        limits.dailyRegenerations -
          (rows.find(
            (r) =>
              r.action === "daily_regen" && r.period_start === jstDate(now),
          )?.used ?? 0),
      ),
      weekly_regens_remaining: Math.max(
        0,
        limits.weeklyRegenerations -
          (rows.find(
            (r) =>
              r.action === "weekly_regen" &&
              r.period_start === jstWeekStart(now),
          )?.used ?? 0),
      ),
      daily_reset_at: nextDailyReset(now),
      weekly_reset_at: nextWeeklyReset(now),
    });
  });
  app.post("/api/account/delete", async (c) => {
    await body(c, z.object({ confirmation: z.literal("退会する") }).strict());
    const { data, error } = await c.get("userDb").auth.getUser(c.get("token"));
    if (
      error ||
      !data.user?.last_sign_in_at ||
      +c.get("now") - Date.parse(data.user.last_sign_in_at) > 10 * 60000
    )
      throw new ApiError(
        "REAUTH_REQUIRED",
        401,
        "退会の前にログインし直してください",
      );
    const job = await result<any>(
      c.get("admin").rpc("begin_deletion", { p_user_id: c.get("userId") }),
    );
    return reply(
      c,
      "POST /api/account/delete",
      { status: "deleting", job_id: job.id },
      202,
    );
  });
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "見つかりません",
          request_id: c.get("requestId"),
        },
      },
      404,
    ),
  );
  return app;
}

export function validateWebP(bytes: Uint8Array): void {
  if (bytes.length < 20 || bytes.length > limits.uploadBytes)
    throw new ApiError("INVALID_IMAGE", 422, "画像のサイズが正しくありません");
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP")
    throw new ApiError("INVALID_IMAGE", 422, "WebP画像ではありません");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length)
    throw new ApiError("INVALID_IMAGE", 422, "画像が壊れています");
  let offset = 12,
    hasImage = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(offset, offset + 4),
      size = view.getUint32(offset + 4, true),
      data = offset + 8;
    if (data + size > bytes.length)
      throw new ApiError("INVALID_IMAGE", 422, "画像が壊れています");
    if (["EXIF", "XMP ", "ANIM", "ANMF"].includes(type))
      throw new ApiError(
        "INVALID_IMAGE",
        422,
        "メタデータやアニメーションを除去してください",
      );
    if (type === "VP8X" && (size !== 10 || (bytes[data]! & 0x0e) !== 0))
      throw new ApiError("INVALID_IMAGE", 422, "静止画に変換してください");
    if (type === "VP8 ") {
      if (
        size < 10 ||
        (bytes[data]! & 1) !== 0 ||
        ascii(data + 3, data + 6) !== "\x9d\x01\x2a" ||
        (view.getUint16(data + 6, true) & 0x3fff) === 0 ||
        (view.getUint16(data + 8, true) & 0x3fff) === 0
      )
        throw new ApiError(
          "INVALID_IMAGE",
          422,
          "画像データが正しくありません",
        );
      hasImage = true;
    }
    if (type === "VP8L") {
      if (size < 6 || bytes[data] !== 0x2f || (bytes[data + 4]! & 0xe0) !== 0)
        throw new ApiError(
          "INVALID_IMAGE",
          422,
          "画像データが正しくありません",
        );
      hasImage = true;
    }
    offset += 8 + size + (size % 2);
  }
  if (!hasImage || offset !== bytes.length)
    throw new ApiError("INVALID_IMAGE", 422, "画像の内容が正しくありません");
}
export const app = createApp();
// ApiContract in @outfit/schemas is the cross-package HTTP contract. This
// incrementally registered Hono instance intentionally does not advertise an
// inferred `hc<AppType>` schema, which would otherwise be empty/misleading.
