import { describe, expect, test, vi } from "vitest";
import { generatePlans } from "../apps/api/src/service";
import { addDays, seasonalWeather } from "../packages/domain/src/index";
import { defaultPreferences, type Cloth } from "../packages/schemas/src/index";
import { fakeDatabase } from "./helpers/fake-supabase";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const topA: Cloth = {
  id: "11111111-1111-4111-8111-111111111111",
  category: "top",
  subtype: "shirt",
  color: "white",
  seasons: ["autumn"],
  thickness: "normal",
  wear_limit: 1,
  wears_since_wash: 0,
  state: "available",
  classification_state: "manual",
};
const topB: Cloth = { ...topA, id: "22222222-2222-4222-8222-222222222222" };
const bottom: Cloth = {
  ...topA,
  id: "33333333-3333-4333-8333-333333333333",
  category: "bottom",
  subtype: "slacks",
  wear_limit: 10,
};
const week = "2026-10-19",
  now = new Date("2026-10-19T00:00:00Z");
const env = {
  OPENAI_API_KEY: "test-key",
  AI_MODEL_OUTFIT: "test-model",
  AI_REQUEST_RESERVE_USD: "0.01",
  AI_INPUT_USD_PER_MILLION: "0.1",
  AI_OUTPUT_USD_PER_MILLION: "0.4",
} as any;
function setup(clothes: Cloth[], rows: any[] = []) {
  const saved: any[] = [];
  const db = fakeDatabase(
    (q) => {
      if (q.table === "user_preferences")
        return { ...defaultPreferences, user_id: userId };
      if (q.table === "clothes") return clothes;
      if (q.table === "work_weekdays")
        return [1, 2].map((weekday) => ({ weekday, is_workday: true }));
      if (q.table === "daily_plans") return rows;
      if (q.table === "weather_cache")
        return Array.from({ length: 7 }, (_, n) => ({
          forecast_date: addDays(week, n),
          fetched_at: now.toISOString(),
          payload: seasonalWeather(addDays(week, n)),
        }));
      return [];
    },
    (name, args) => {
      if (name === "reserve_ai") return crypto.randomUUID();
      if (name === "save_plan") {
        saved.push(structuredClone(args));
        const row = {
          id: crypto.randomUUID(),
          target_date: args.p_target_date,
          outfit_id: crypto.randomUUID(),
          mode: "auto",
          plan_status: args.p_data.plan_status,
          warnings: args.p_data.warnings,
          outfits: {
            source: args.p_data.source,
            reason_short: args.p_data.reason_short,
            context_snapshot: args.p_data.context_snapshot,
            outfit_items: args.p_data.items.map((item: any) => ({
              ...item,
              clothes: clothes.find((c) => c.id === item.clothes_id),
            })),
          },
        };
        const index = rows.findIndex((r) => r.target_date === row.target_date);
        if (index >= 0) rows[index] = row;
        else rows.push(row);
      }
      return true;
    },
  );
  return { db, saved, rows };
}
const aiResponse = (ids: string[]) =>
  Response.json({
    status: "completed",
    output: [
      {
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              items: ids.map((id, i) => ({
                clothes_id: id,
                slot: i ? "bottom" : "top",
              })),
              reason_short: "色を合わせました",
            }),
          },
        ],
      },
    ],
  });

describe("service-level adversarial recommendation verification", () => {
  test("an earlier AI change is reflected in downstream fallback laundry projections", async () => {
    const s = setup([topA, topB, bottom]);
    let calls = 0;
    const fetcher = vi.fn(async () =>
      ++calls === 1
        ? aiResponse([topB.id, bottom.id])
        : aiResponse(["99999999-9999-4999-8999-999999999999", bottom.id]),
    );
    const plans = await generatePlans(env, s.db as any, userId, week, now, {
      fetcher,
    });
    expect(
      plans
        .find((p) => p.target_date === week)
        ?.items.find((i) => i.slot === "top")?.clothes_id,
    ).toBe(topB.id);
    expect(
      plans
        .find((p) => p.target_date === "2026-10-20")
        ?.items.find((i) => i.slot === "top")?.clothes_id,
    ).toBe(topA.id);
    expect(plans.find((p) => p.target_date === "2026-10-20")?.source).toBe(
      "rule",
    );
  });
  test.each(["invented", "laundry", "ng", "missing-bottom"])(
    "AI %s cannot become an accepted plan",
    async (kind) => {
      const blocked = {
        ...topB,
        state:
          kind === "laundry" ? ("laundry" as const) : ("available" as const),
        subtype: kind === "ng" ? "shorts" : "shirt",
      };
      const s = setup([topA, blocked, bottom]);
      const chosen =
        kind === "invented"
          ? "99999999-9999-4999-8999-999999999999"
          : blocked.id;
      const fetcher = vi.fn(async () =>
        aiResponse(kind === "missing-bottom" ? [topA.id] : [chosen, bottom.id]),
      );
      const plans = await generatePlans(env, s.db as any, userId, week, now, {
        fetcher,
      });
      const first = plans.find((p) => p.target_date === week)!;
      expect(first.source).toBe("rule");
      expect(
        first.items.some((i) => i.clothes_id === chosen && i.slot === "top"),
      ).toBe(false);
      expect(first.items.some((i) => i.slot === "bottom")).toBe(true);
    },
  );
  test("AI input contains minimal clothes metadata without account identifier, images or credentials", async () => {
    const s = setup([topA, bottom]);
    const fetcher = vi.fn(
      async () => new Response("unavailable", { status: 503 }),
    );
    await generatePlans(env, s.db as any, userId, week, now, { fetcher });
    const request = fetcher.mock.calls[0] as unknown as [unknown, RequestInit];
    const body = String(request[1].body);
    expect(body).not.toContain(userId);
    expect(body).not.toContain("image_key");
    expect(body).not.toContain("email");
    expect(body).not.toContain("test-key");
    expect(body).toContain(topA.id);
  });
  test("reevaluation leaves valid unaffected automatic days intact and protects manually fixed day", async () => {
    const clothes = [{ ...topA, wear_limit: 10 }, bottom],
      s = setup(clothes);
    await generatePlans({}, s.db as any, userId, week, now);
    const original = s.rows.find((r) => r.target_date === week);
    original.mode = "manual_lock";
    const originalOutfit = original.outfit_id;
    s.saved.splice(0);
    await generatePlans({}, s.db as any, userId, week, now, {
      force: true,
      affectedOnly: true,
    });
    expect(s.saved).toHaveLength(0);
    expect(s.rows.find((r) => r.target_date === week).outfit_id).toBe(
      originalOutfit,
    );
  });
});
