import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  aiOutfitSchema,
  classificationSchema,
  regions,
  type Weather,
} from "@outfit/schemas";
import { addDays, jstDate, seasonalWeather } from "@outfit/domain";
import { result, type Env } from "./types";

export async function getForecasts(
  env: Env,
  db: SupabaseClient,
  region: string,
  dates: string[],
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<Weather[]> {
  const rows = await result<any[]>(
    db
      .from("weather_cache")
      .select("*")
      .eq("region_code", region)
      .in("forecast_date", dates),
  );
  const cached = new Map(rows.map((r) => [r.forecast_date, r]));
  const horizon = env.WEATHER_FORECAST_DAYS === "7" ? 7 : 3;
  const today = jstDate(now);
  // Dates outside the purchased forecast horizon are deliberately seasonal;
  // their absence must not trigger another paid provider fetch on every read.
  const providerDates = dates.filter(
    (d) => d >= today && d < addDays(today, horizon),
  );
  const fresh = providerDates.every((d) => {
    const c = cached.get(d);
    return c && now.getTime() - Date.parse(c.fetched_at) < 3 * 3600000;
  });
  if (!fresh && env.WEATHER_API_KEY) {
    try {
      const city = regions.find((r) => r[0] === region)?.[2] ?? "Tokyo";
      const url = new URL("https://api.weatherapi.com/v1/forecast.json");
      url.searchParams.set("key", env.WEATHER_API_KEY);
      url.searchParams.set("q", city + ",Japan");
      url.searchParams.set(
        "days",
        env.WEATHER_FORECAST_DAYS === "7" ? "7" : "3",
      );
      url.searchParams.set("aqi", "no");
      url.searchParams.set("alerts", "no");
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) throw new Error("weather");
      const payload = (await response.json()) as any;
      const forecasts = z
        .array(
          z.object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            day: z.object({
              mintemp_c: z.number().min(-60).max(60),
              maxtemp_c: z.number().min(-60).max(60),
              daily_chance_of_rain: z.coerce.number().min(0).max(100),
            }),
          }),
        )
        .parse(payload.forecast?.forecastday);
      for (const f of forecasts) {
        const weather: Weather = {
          date: f.date,
          min_c: f.day.mintemp_c,
          max_c: f.day.maxtemp_c,
          rain_probability: f.day.daily_chance_of_rain,
          source: "live",
          fetched_at: now.toISOString(),
          provisional: f.date > addDays(jstDate(now), 2),
        };
        const row = {
          region_code: region,
          forecast_date: f.date,
          payload: weather,
          fetched_at: now.toISOString(),
        };
        await result(
          db
            .from("weather_cache")
            .upsert(row, { onConflict: "region_code,forecast_date" }),
        );
        cached.set(f.date, row);
      }
    } catch {
      /* Never expose provider URLs, keys, or response bodies. */
    }
  }
  return dates.map((date) => {
    const c = cached.get(date);
    if (!c || now.getTime() - Date.parse(c.fetched_at) > 48 * 3600000)
      return seasonalWeather(date);
    return {
      ...c.payload,
      date,
      source: c.fetched_at === now.toISOString() ? "live" : "cache",
      fetched_at: c.fetched_at,
      provisional: date > addDays(jstDate(now), 2),
    };
  });
}

/** Reservation is atomic in Postgres; unconfigured models/costs fail closed to free rules. */
export async function askAI<T>(
  env: Env,
  db: SupabaseClient,
  userId: string,
  action: string,
  key: string,
  schema: z.ZodType<T>,
  input: unknown[],
  fetcher: typeof fetch = fetch,
): Promise<T | null> {
  const model =
    action === "classify" ? env.AI_MODEL_CLASSIFY : env.AI_MODEL_OUTFIT;
  const reserve = Number(env.AI_REQUEST_RESERVE_USD),
    inputRate = Number(env.AI_INPUT_USD_PER_MILLION),
    outputRate = Number(env.AI_OUTPUT_USD_PER_MILLION);
  if (
    !env.OPENAI_API_KEY ||
    !model ||
    !Number.isFinite(reserve) ||
    reserve <= 0 ||
    !Number.isFinite(inputRate) ||
    inputRate <= 0 ||
    !Number.isFinite(outputRate) ||
    outputRate <= 0
  )
    return null;
  const usageId = await result<string | null>(
    db.rpc("reserve_ai", {
      p_user_id: userId,
      p_action: action,
      p_estimate: reserve,
      p_request_key: key,
    }),
  );
  if (!usageId) return null;
  let cost = reserve,
    success = false;
  try {
    const response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 700,
        input,
        text: {
          format: {
            type: "json_schema",
            name: action === "classify" ? "clothing_classification" : "outfit",
            strict: true,
            schema: z.toJSONSchema(schema),
          },
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as any;
    if (body.usage) {
      const inTokens = Number(body.usage.input_tokens),
        outTokens = Number(body.usage.output_tokens);
      if (
        Number.isSafeInteger(inTokens) &&
        Number.isSafeInteger(outTokens) &&
        inTokens >= 0 &&
        outTokens >= 0
      ) {
        cost = (inTokens * inputRate + outTokens * outputRate) / 1e6;
        await result(
          db
            .from("ai_usage")
            .update({
              input_tokens: inTokens,
              output_tokens: outTokens,
              provider_request_id:
                typeof body.id === "string" ? body.id.slice(0, 200) : null,
            })
            .eq("id", usageId)
            .eq("user_id", userId),
        );
      }
    }
    if (body.status !== "completed") return null;
    const text = body.output
      ?.flatMap((v: any) => v.content ?? [])
      .filter((v: any) => v.type === "output_text")
      .map((v: any) => v.text)
      .join("");
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    success = true;
    return parsed.data;
  } catch {
    return null;
  } finally {
    await result(
      db.rpc("settle_ai", {
        p_usage_id: usageId,
        p_actual: cost,
        p_success: success,
      }),
    );
  }
}
export { aiOutfitSchema, classificationSchema };
