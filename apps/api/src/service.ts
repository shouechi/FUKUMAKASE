import type { SupabaseClient } from "@supabase/supabase-js";
import {
  defaultPreferences,
  type Cloth,
  type DayOverride,
  type Plan,
  type Preferences,
  type Weather,
} from "@outfit/schemas";
import {
  addDays,
  generateWeek,
  jstDate,
  planWarnings,
  recommend,
  validateOutfit,
  weekStart,
  type RecommendationContext,
} from "@outfit/domain";
import { ApiError, result, type Env } from "./types";
import { aiOutfitSchema, askAI, getForecasts } from "./providers";

export const planSelect = "*,outfits(*,outfit_items(*,clothes(*)))";
export function flattenPlan(row: any): Plan {
  const outfit = row.outfits ?? {};
  return {
    id: row.id,
    target_date: row.target_date,
    outfit_id: row.outfit_id,
    mode: row.mode,
    plan_status: row.plan_status,
    source: outfit.source ?? "rule",
    reason_short: outfit.reason_short ?? "今日はお休みです",
    items: (outfit.outfit_items ?? []).map((i: any) => ({
      clothes_id: i.clothes_id,
      slot: i.slot,
      clothes: i.clothes,
    })),
    warnings: [
      ...new Set<string>([
        ...(row.warnings ?? []),
        ...(outfit.context_snapshot?.warnings ?? []),
      ]),
    ],
    weather: outfit.context_snapshot?.weather,
  };
}
export async function loadContext(
  db: SupabaseClient,
  userId: string,
  week: string,
) {
  const [preferences, clothes, weekdays, overrides, existing, logs] =
    await Promise.all([
      result<any>(
        db
          .from("user_preferences")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle(),
      ),
      result<Cloth[]>(
        db
          .from("clothes")
          .select("*")
          .eq("user_id", userId)
          .is("deleted_at", null),
      ),
      result<any[]>(db.from("work_weekdays").select("*").eq("user_id", userId)),
      result<DayOverride[]>(
        db
          .from("day_overrides")
          .select("*")
          .eq("user_id", userId)
          .gte("target_date", week)
          .lte("target_date", addDays(week, 6)),
      ),
      result<any[]>(
        db
          .from("daily_plans")
          .select(planSelect)
          .eq("user_id", userId)
          .gte("target_date", week)
          .lte("target_date", addDays(week, 6)),
      ),
      result<any[]>(
        db
          .from("wear_logs")
          .select("target_date,wear_log_items(clothes_id)")
          .eq("user_id", userId)
          .gte("target_date", addDays(week, -14)),
      ),
    ]);
  const recentIds: string[] = logs.flatMap((l) =>
    (l.wear_log_items ?? []).map((i: any) => i.clothes_id),
  );
  const learnedStyles: Record<string, number> = {};
  for (const id of recentIds) {
    const subtype = clothes.find((c) => c.id === id)?.subtype;
    if (subtype) learnedStyles[subtype] = (learnedStyles[subtype] ?? 0) + 1;
  }
  return {
    preferences: { ...defaultPreferences, ...preferences } as Preferences,
    clothes,
    weekdays: weekdays.filter((w) => w.is_workday).map((w) => w.weekday),
    overrides,
    existing: existing.map(flattenPlan),
    recentIds,
    learnedStyles,
  };
}
export async function savePlan(
  db: SupabaseClient,
  userId: string,
  plan: Plan,
  manual = false,
  jobId?: string,
  leaseToken?: string,
): Promise<void> {
  await result(
    db.rpc("save_plan", {
      p_user_id: userId,
      p_target_date: plan.target_date,
      p_manual: manual,
      ...(jobId ? { p_job_id: jobId, p_lease_token: leaseToken } : {}),
      p_data: {
        source: plan.source,
        reason_short: plan.reason_short,
        warnings: plan.warnings,
        context_snapshot: { warnings: plan.warnings, weather: plan.weather },
        validation_state: plan.warnings.length ? "warning" : "valid",
        items: plan.items.map(({ clothes_id, slot }) => ({ clothes_id, slot })),
        plan_status: plan.plan_status,
      },
    }),
  );
}
export async function generatePlans(
  env: Env,
  db: SupabaseClient,
  userId: string,
  week: string,
  now: Date,
  options: {
    force?: boolean;
    affectedOnly?: boolean;
    onlyDate?: string;
    action?: string;
    rotation?: number;
    reason?: string;
    requestKey?: string;
    fetcher?: typeof fetch;
    jobId?: string;
    leaseToken?: string;
  } = {},
): Promise<Plan[]> {
  if (week > addDays(weekStart(jstDate(now)), 7))
    throw new ApiError("PLANNING_HORIZON", 422, "計画できるのは翌週までです");
  const context = await loadContext(db, userId, week);
  const forecasts = await getForecasts(
    env,
    db,
    context.preferences.base_region_code,
    Array.from({ length: 7 }, (_, n) => addDays(week, n)),
    now,
    options.fetcher,
  );
  const today = jstDate(now),
    plans = generateWeek({
      ...context,
      week,
      forecasts,
      rotation: options.rotation,
      today,
    });
  for (const plan of plans) {
    if (plan.target_date < jstDate(now)) continue;
    if (options.onlyDate && options.onlyDate !== plan.target_date) continue;
    if (plan.mode === "manual_lock" || plan.plan_status === "confirmed")
      continue;
    const old = context.existing.find(
      (p) => p.target_date === plan.target_date,
    );
    const earlier = plans.filter(
      (p) =>
        p.target_date < plan.target_date &&
        p.target_date >= today &&
        p.plan_status !== "confirmed",
    );
    const projected = new Map<string, number>();
    for (const p of earlier)
      for (const i of p.items)
        projected.set(i.clothes_id, (projected.get(i.clothes_id) ?? 0) + 1);
    const ctx: RecommendationContext = {
      ...context,
      date: plan.target_date,
      weather: plan.weather,
      projected,
      rotation: options.rotation,
      previousItems: earlier.at(-1)?.items,
      mood:
        options.reason === "more_casual"
          ? "casual"
          : context.overrides.find((o) => o.target_date === plan.target_date)
              ?.mood,
      occasion: context.overrides.find(
        (o) => o.target_date === plan.target_date,
      )?.occasion,
    };
    if (plan.plan_status !== "skipped") Object.assign(plan, recommend(ctx));
    if ((options.affectedOnly || !options.force) && old) {
      const oldWeather = old.weather,
        newWeather = plan.weather;
      const changedWeather =
        !oldWeather ||
        !newWeather ||
        Math.abs(oldWeather.max_c - newWeather.max_c) >= 3 ||
        Math.abs(oldWeather.min_c - newWeather.min_c) >= 3 ||
        oldWeather.rain_probability >= 50 !==
          newWeather.rain_probability >= 50 ||
        (oldWeather.source === "seasonal") !== (newWeather.source === "seasonal");
      const needsItems = plan.items.some(
        (i) => !old.items.some((o) => o.slot === i.slot),
      );
      if (
        old.plan_status === plan.plan_status &&
        !changedWeather &&
        !needsItems &&
        (old.plan_status === "skipped" || validateOutfit(old.items, ctx))
      ) {
        Object.assign(plan, old);
        continue;
      }
    }
    if (plan.plan_status === "proposed") {
      // Ranking receives only currently permitted candidates; every returned ID is revalidated.
      const candidates = context.clothes.filter((c) =>
        validateOutfit([{ clothes_id: c.id, slot: c.category }], ctx),
      );
      const candidateIds = new Set(candidates.map((c) => c.id));
      const candidateStyles = new Set(candidates.map((c) => c.subtype));
      const ai = await askAI(
        env,
        db,
        userId,
        options.action ?? "scheduled",
        `${options.requestKey ?? crypto.randomUUID()}:${plan.target_date}`,
        aiOutfitSchema,
        [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  instruction:
                    "選択可能な服だけから仕事用の1コーデを選ぶ。topとbottom必須、必要な場合outerwearとshoes。最近着た服と直前の予定の繰り返しをできる範囲で避け、週内の予定着用回数と実績から学習した好みも考慮する。服が少なければ重複を許容する。予定を着用実績とみなさない。日本語の短い理由を1行。",
                  candidates: candidates.map(
                    ({ id, category, subtype, color, seasons, thickness }) => ({
                      id,
                      category,
                      subtype,
                      color,
                      seasons,
                      thickness,
                    }),
                  ),
                  preferences: {
                    style_keywords: context.preferences.style_keywords,
                    learned_styles: Object.fromEntries(
                      Object.entries(ctx.learnedStyles ?? {}).filter(
                        ([style]) => candidateStyles.has(style),
                      ),
                    ),
                  },
                  wear_history: {
                    recent_clothes_ids: [
                      ...new Set(
                        (ctx.recentIds ?? []).filter((id) =>
                          candidateIds.has(id),
                        ),
                      ),
                    ],
                  },
                  planned_usage: {
                    projected_wears: Object.fromEntries(
                      [...projected].filter(([id]) => candidateIds.has(id)),
                    ),
                    previous_items: (ctx.previousItems ?? [])
                      .filter(({ clothes_id }) => candidateIds.has(clothes_id))
                      .map(({ clothes_id, slot }) => ({ clothes_id, slot })),
                  },
                  forecast: plan.weather,
                  occasion: ctx.occasion,
                  mood: ctx.mood,
                }),
              },
            ],
          },
        ],
        options.fetcher,
      );
      if (
        ai &&
        validateOutfit(ai.items, ctx) &&
        ai.items.some((i) => i.slot === "top") &&
        ai.items.some((i) => i.slot === "bottom") &&
        plan.items.every((i) => ai.items.some((a) => a.slot === i.slot))
      ) {
        plan.items = ai.items;
        plan.source = "ai";
        plan.reason_short = ai.reason_short;
      }
    }
    // Recompute downstream projections on the next operation; save_plan provides lock race protection.
    await savePlan(db, userId, plan, false, options.jobId, options.leaseToken);
  }
  const rows = await result<any[]>(
    db
      .from("daily_plans")
      .select(planSelect)
      .eq("user_id", userId)
      .gte("target_date", week)
      .lte("target_date", addDays(week, 6)),
  );
  const projected = new Map<string, number>();
  return rows
    .map(flattenPlan)
    .sort((a, b) => a.target_date.localeCompare(b.target_date))
    .map((p) => {
      const weather =
        forecasts.find((w) => w.date === p.target_date) ?? p.weather;
      const warnings =
        p.mode === "manual_lock"
          ? planWarnings(p, {
              ...context,
              date: p.target_date,
              weather,
              projected,
            })
          : p.warnings;
      if (p.target_date >= today && p.plan_status !== "confirmed")
        for (const item of p.items)
          projected.set(
            item.clothes_id,
            (projected.get(item.clothes_id) ?? 0) + 1,
          );
      return { ...p, weather, warnings };
    });
}
export async function enqueueReevaluation(
  db: SupabaseClient,
  userId: string,
  date: string,
) {
  await result(
    db.from("generation_jobs").upsert(
      {
        user_id: userId,
        job_type: "reevaluate",
        target_date: date,
        dedupe_key: `reevaluate:${userId}:${crypto.randomUUID()}`,
        payload: {},
        status: "pending",
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    ),
  );
}
