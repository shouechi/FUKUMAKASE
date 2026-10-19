import { describe, expect, test, vi } from "vitest";
import { generatePlans } from "../apps/api/src/service";
import { addDays, seasonalWeather } from "../packages/domain/src/index";
import { defaultPreferences, type Cloth } from "../packages/schemas/src/index";
import { fakeDatabase, type Query } from "./helpers/fake-supabase";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const week = "2026-10-19";
const now = new Date("2026-10-19T00:00:00Z");
const env = {
  OPENAI_API_KEY: "history-test-secret",
  AI_REQUEST_RESERVE_USD: "0.01",
};
const topA: Cloth = {
  id: "11111111-1111-4111-8111-111111111111",
  category: "top",
  subtype: "shirt",
  color: "white",
  seasons: ["autumn"],
  thickness: "normal",
  wear_limit: 10,
  wears_since_wash: 0,
  state: "available",
  classification_state: "manual",
};
const topB: Cloth = {
  ...topA,
  id: "22222222-2222-4222-8222-222222222222",
  subtype: "sweater",
};
const bottom: Cloth = {
  ...topA,
  id: "33333333-3333-4333-8333-333333333333",
  category: "bottom",
  subtype: "slacks",
};
const unavailable: Cloth = {
  ...topA,
  id: "44444444-4444-4444-8444-444444444444",
  subtype: "private-hidden-style",
  state: "laundry",
};
const inventedId = "99999999-9999-4999-8999-999999999999";
const pair = (top: Cloth) => [
  { clothes_id: top.id, slot: "top" },
  { clothes_id: bottom.id, slot: "bottom" },
];
const wearLog = (date: string, ids: string[]) => ({
  target_date: date,
  wear_log_items: ids.map((clothes_id) => ({ clothes_id })),
});

type HistoryInput = {
  candidates: { id: string }[];
  wear_history: { recent_clothes_ids: string[] };
  preferences: {
    style_keywords: string[];
    learned_styles: Record<string, number>;
  };
  planned_usage: {
    projected_wears: Record<string, number>;
    previous_items: { clothes_id: string; slot: string }[];
  };
};

function selectedRows(rows: any[], query: Query, column: string) {
  return rows.filter((row) =>
    query.filters.every(([operator, key, value]) => {
      if (key !== column) return true;
      if (operator === "gte") return row[key] >= String(value);
      if (operator === "lte") return row[key] <= String(value);
      if (operator === "lt") return row[key] < String(value);
      if (operator === "eq") return row[key] === value;
      return true;
    }),
  );
}

// Database and OpenAI boundaries are simulated; these tests inspect the real
// service/provider request path without claiming live provider quality or RLS.
function setup(
  clothes: Cloth[] = [topA, topB, bottom, unavailable],
  options: {
    rows?: any[];
    logs?: any[];
    preferences?: object;
    clock?: Date;
    weekdays?: number[];
  } = {},
) {
  const rows = options.rows ?? [];
  const saved: any[] = [];
  const clock = options.clock ?? now;
  const db = fakeDatabase(
    (query) => {
      if (query.table === "user_preferences")
        return {
          ...defaultPreferences,
          user_id: userId,
          ...options.preferences,
        };
      if (query.table === "clothes") return clothes;
      if (query.table === "work_weekdays")
        return (options.weekdays ?? [1, 2]).map((weekday) => ({
          weekday,
          is_workday: true,
        }));
      if (query.table === "wear_logs")
        return selectedRows(options.logs ?? [], query, "target_date");
      if (query.table === "daily_plans")
        return selectedRows(rows, query, "target_date");
      if (query.table === "weather_cache")
        return Array.from({ length: 7 }, (_, n) => ({
          forecast_date: addDays(week, n),
          fetched_at: clock.toISOString(),
          payload: seasonalWeather(addDays(week, n)),
        }));
      return [];
    },
    (name, args) => {
      if (name === "reserve_ai") return crypto.randomUUID();
      if (name === "save_plan") {
        saved.push(structuredClone(args));
        const row = planRow(
          args.p_target_date,
          args.p_data.items,
          "auto",
          args.p_data.plan_status,
        );
        Object.assign(row.outfits, {
          source: args.p_data.source,
          reason_short: args.p_data.reason_short,
          context_snapshot: args.p_data.context_snapshot,
        });
        row.warnings = args.p_data.warnings;
        const index = rows.findIndex(
          (existing) => existing.target_date === row.target_date,
        );
        if (index < 0) rows.push(row);
        else rows[index] = row;
      }
      return true;
    },
  );
  return { db, saved, rows, clock };
}

function planRow(
  date: string,
  items: { clothes_id: string; slot: string }[],
  mode = "manual_lock",
  status = "proposed",
) {
  return {
    id: crypto.randomUUID(),
    target_date: date,
    outfit_id: crypto.randomUUID(),
    mode,
    plan_status: status,
    warnings: [] as string[],
    outfits: {
      source: "manual",
      reason_short: "固定した服です",
      context_snapshot: { weather: seasonalWeather(date) },
      outfit_items: items.map((item) => ({
        ...item,
        clothes: [topA, topB, bottom, unavailable].find(
          (cloth) => cloth.id === item.clothes_id,
        ),
      })),
    },
  };
}

function aiResponse(items: { clothes_id: string; slot: string }[]) {
  return Response.json({
    status: "completed",
    output: [
      {
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              items,
              reason_short: "着用間隔を考えました",
            }),
          },
        ],
      },
    ],
  });
}

function captureAI(
  reply: (call: number) => Response = () => aiResponse(pair(topB)),
) {
  const inputs: HistoryInput[] = [];
  const bodies: string[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(body);
    const request = JSON.parse(body);
    expect(request.input).toHaveLength(1);
    expect(request.input[0].content).toHaveLength(1);
    expect(request.input[0].content[0].type).toBe("input_text");
    inputs.push(JSON.parse(request.input[0].content[0].text));
    return reply(inputs.length);
  });
  return { inputs, bodies, fetcher };
}

describe("AI recommendation history contract (database/OpenAI simulated)", () => {
  test("sends deduplicated eligible actual wear IDs and learned style counts separately from plans", async () => {
    const s = setup(undefined, {
      logs: [
        wearLog("2026-10-16", [topA.id, bottom.id]),
        wearLog("2026-10-18", [topA.id, unavailable.id, inventedId]),
      ],
    });
    const ai = captureAI();
    await generatePlans(env, s.db as any, userId, week, s.clock, {
      fetcher: ai.fetcher,
      onlyDate: week,
    });
    expect(ai.inputs).toHaveLength(1);
    const input = ai.inputs[0];
    expect(new Set(input.wear_history.recent_clothes_ids)).toEqual(
      new Set([topA.id, bottom.id]),
    );
    expect(input.wear_history.recent_clothes_ids).toHaveLength(2);
    expect(input.preferences).toEqual({
      style_keywords: defaultPreferences.style_keywords,
      learned_styles: { shirt: 2, slacks: 1 },
    });
    expect(input.planned_usage).toEqual({
      projected_wears: {},
      previous_items: [],
    });
  });

  test("the next day receives the accepted AI outfit rather than the preliminary rule outfit", async () => {
    const s = setup(undefined, {
      logs: [wearLog("2026-10-18", [topA.id])],
      preferences: { style_keywords: ["shirt"] },
    });
    const baseline = setup(undefined, {
      logs: [wearLog("2026-10-18", [topA.id])],
      preferences: { style_keywords: ["shirt"] },
    });
    const preliminary = await generatePlans(
      {},
      baseline.db as any,
      userId,
      week,
      baseline.clock,
      { onlyDate: week },
    );
    expect(
      preliminary
        .find((plan) => plan.target_date === week)
        ?.items.map(({ clothes_id, slot }) => ({ clothes_id, slot })),
    ).toEqual(pair(topA));
    const ai = captureAI((call) => aiResponse(pair(call === 1 ? topB : topA)));
    const plans = await generatePlans(env, s.db as any, userId, week, s.clock, {
      fetcher: ai.fetcher,
    });
    expect(ai.inputs).toHaveLength(2);
    expect(plans.find((plan) => plan.target_date === week)).toMatchObject({
      source: "ai",
      items: pair(topB),
    });
    expect(ai.inputs[1].planned_usage).toEqual({
      projected_wears: { [topB.id]: 1, [bottom.id]: 1 },
      previous_items: pair(topB),
    });
    expect(ai.inputs[1].wear_history).toEqual({
      recent_clothes_ids: [topA.id],
    });
    expect(ai.inputs[1].preferences.learned_styles).toEqual({ shirt: 1 });
  });

  test("manual fixed outfits inform the next request while remaining protected", async () => {
    const fixed = planRow(week, pair(topB));
    const s = setup(undefined, { rows: [fixed] });
    const ai = captureAI(() => aiResponse(pair(topA)));
    await generatePlans(env, s.db as any, userId, week, s.clock, {
      fetcher: ai.fetcher,
      force: true,
    });
    expect(ai.inputs).toHaveLength(1);
    expect(ai.inputs[0].planned_usage).toEqual({
      projected_wears: { [topB.id]: 1, [bottom.id]: 1 },
      previous_items: pair(topB),
    });
    expect(ai.inputs[0].wear_history.recent_clothes_ids).toEqual([]);
    expect(s.saved.some((args) => args.p_target_date === week)).toBe(false);
    expect(s.rows.find((row) => row.target_date === week)?.outfit_id).toBe(
      fixed.outfit_id,
    );
  });

  test.each(["confirmed", "past"])(
    "%s days are not charged again as projected future wear",
    async (kind) => {
      const s = setup(undefined, {
        rows: [
          planRow(
            week,
            pair(topB),
            kind === "confirmed" ? "auto" : "manual_lock",
            kind === "confirmed" ? "confirmed" : "proposed",
          ),
        ],
        logs: [wearLog(week, [topB.id, bottom.id])],
        clock: kind === "confirmed" ? now : new Date("2026-10-20T00:00:00Z"),
      });
      const ai = captureAI();
      await generatePlans(env, s.db as any, userId, week, s.clock, {
        fetcher: ai.fetcher,
        onlyDate: "2026-10-20",
      });
      expect(ai.inputs).toHaveLength(1);
      expect(ai.inputs[0].planned_usage).toEqual({
        projected_wears: {},
        previous_items: [],
      });
      expect(new Set(ai.inputs[0].wear_history.recent_clothes_ids)).toEqual(
        new Set([topB.id, bottom.id]),
      );
    },
  );

  test("history projection omits unavailable IDs and database/account/image fields", async () => {
    const marker = "private-database-marker";
    const clothes = [topA, topB, bottom, unavailable].map((cloth) => ({
      ...cloth,
      user_id: userId,
      image_key: `private/${userId}/${marker}.webp`,
    }));
    const fixed = planRow(week, [
      ...pair(topB),
      {
        clothes_id: unavailable.id,
        slot: "outerwear",
      },
    ]);
    fixed.outfits.reason_short = marker;
    const s = setup(clothes, {
      rows: [fixed],
      logs: [wearLog("2026-10-18", [topA.id, unavailable.id])],
      preferences: { email: `${marker}@example.com`, jwt: marker },
    });
    const ai = captureAI();
    await generatePlans(env, s.db as any, userId, week, s.clock, {
      fetcher: ai.fetcher,
    });
    expect(ai.inputs).toHaveLength(1);
    expect(ai.inputs[0].planned_usage).toEqual({
      projected_wears: { [topB.id]: 1, [bottom.id]: 1 },
      previous_items: pair(topB),
    });
    expect(ai.inputs[0].wear_history).toEqual({
      recent_clothes_ids: [topA.id],
    });
    const body = ai.bodies[0];
    for (const forbidden of [
      userId,
      marker,
      env.OPENAI_API_KEY,
      unavailable.id,
      unavailable.subtype,
      "image_key",
      "image_url",
      "input_image",
      "email",
      "jwt",
    ])
      expect(body).not.toContain(forbidden);
  });

  test("two available garments may repeat without treating their plans as actual wear", async () => {
    const s = setup([topA, bottom], { weekdays: [1, 2, 3] });
    const ai = captureAI(() => aiResponse(pair(topA)));
    const plans = await generatePlans(env, s.db as any, userId, week, s.clock, {
      fetcher: ai.fetcher,
    });
    expect(ai.inputs).toHaveLength(3);
    for (const date of [week, "2026-10-20", "2026-10-21"])
      expect(plans.find((plan) => plan.target_date === date)).toMatchObject({
        source: "ai",
        plan_status: "proposed",
        items: pair(topA),
      });
    expect(ai.inputs[1].planned_usage.projected_wears).toEqual({
      [topA.id]: 1,
      [bottom.id]: 1,
    });
    expect(ai.inputs[1].wear_history.recent_clothes_ids).toEqual([]);
    expect(ai.inputs[1].preferences.learned_styles).toEqual({});
    expect(ai.inputs[2].planned_usage.projected_wears).toEqual({
      [topA.id]: 2,
      [bottom.id]: 2,
    });
  });

  test.each(["outage", "invented", "laundry", "missing-bottom"])(
    "history-aware requests retain safe rule fallback for %s",
    async (failure) => {
      const s = setup(undefined, {
        logs: [wearLog("2026-10-18", [topA.id])],
      });
      const ai = captureAI(() => {
        if (failure === "outage")
          return new Response("unavailable", { status: 503 });
        if (failure === "missing-bottom") return aiResponse([pair(topA)[0]]);
        return aiResponse([
          {
            clothes_id: failure === "invented" ? inventedId : unavailable.id,
            slot: "top",
          },
          pair(topA)[1],
        ]);
      });
      const plans = await generatePlans(
        env,
        s.db as any,
        userId,
        week,
        s.clock,
        { fetcher: ai.fetcher, onlyDate: week },
      );
      expect(ai.inputs).toHaveLength(1);
      expect(ai.inputs[0].wear_history.recent_clothes_ids).toEqual([topA.id]);
      const plan = plans.find((entry) => entry.target_date === week)!;
      expect(plan.source).toBe("rule");
      expect(plan.plan_status).toBe("proposed");
      expect(plan.items.some((item) => item.slot === "bottom")).toBe(true);
      expect(
        plan.items.some((item) =>
          [inventedId, unavailable.id].includes(item.clothes_id),
        ),
      ).toBe(false);
    },
  );
});
