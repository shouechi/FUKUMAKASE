import { describe, expect, test } from "vitest";
import {
  defaultPreferences,
  type Cloth,
  type Plan,
} from "../packages/schemas/src/index";
import {
  eligible,
  generateWeek,
  isWorkday,
  japaneseHolidays,
  jstDate,
  jstWeekStart,
  nextDailyReset,
  nextWeeklyReset,
  recommend,
  seasonalWeather,
  validateOutfit,
} from "../packages/domain/src/index";

const top: Cloth = {
  id: "11111111-1111-4111-8111-111111111111",
  category: "top",
  subtype: "shirt",
  color: "white",
  seasons: ["spring", "summer", "autumn", "winter"],
  thickness: "normal",
  wear_limit: 10,
  wears_since_wash: 0,
  state: "available",
  classification_state: "manual",
};
const bottom: Cloth = {
  ...top,
  id: "22222222-2222-4222-8222-222222222222",
  category: "bottom",
  subtype: "slacks",
};
const context = {
  date: "2026-10-13",
  clothes: [top, bottom],
  preferences: defaultPreferences,
};

describe("Japanese civil-day, week and holiday semantics", () => {
  test("day changes at UTC 15:00, never UTC midnight", () => {
    expect(jstDate(new Date("2026-10-31T14:59:59.999Z"))).toBe("2026-10-31");
    expect(jstDate(new Date("2026-10-31T15:00:00.000Z"))).toBe("2026-11-01");
    expect(nextDailyReset(new Date("2026-10-31T14:59:59.999Z"))).toBe(
      "2026-10-31T15:00:00.000Z",
    );
  });
  test("month/year boundary does not reset the Monday-based weekly quota", () => {
    expect(jstWeekStart(new Date("2026-11-01T14:59:59Z"))).toBe("2026-10-26");
    expect(jstWeekStart(new Date("2026-11-01T15:00:00Z"))).toBe("2026-11-02");
    expect(nextWeeklyReset(new Date("2026-10-31T20:00:00Z"))).toBe(
      "2026-11-01T15:00:00.000Z",
    );
    expect(jstWeekStart(new Date("2026-12-31T16:00:00Z"))).toBe("2026-12-28");
  });
  // Independent oracle: Cabinet Office 2026/2027 published holiday table.
  // https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
  test.each([
    [
      2026,
      [
        "01-01",
        "01-12",
        "02-11",
        "02-23",
        "03-20",
        "04-29",
        "05-03",
        "05-04",
        "05-05",
        "05-06",
        "07-20",
        "08-11",
        "09-21",
        "09-22",
        "09-23",
        "10-12",
        "11-03",
        "11-23",
      ],
    ],
    [
      2027,
      [
        "01-01",
        "01-11",
        "02-11",
        "02-23",
        "03-21",
        "03-22",
        "04-29",
        "05-03",
        "05-04",
        "05-05",
        "07-19",
        "08-11",
        "09-20",
        "09-23",
        "10-11",
        "11-03",
        "11-23",
      ],
    ],
  ] as const)(
    "%i holidays exactly match the official published dates",
    (year, dates) => {
      expect([...japaneseHolidays(year).keys()].sort()).toEqual(
        dates.map((d) => `${year}-${d}`),
      );
    },
  );
  test("holiday-specific work override wins; leave override wins over weekday", () => {
    expect(isWorkday("2026-10-12", [1, 2, 3, 4, 5], true)).toBe(false);
    expect(isWorkday("2026-10-12", [1, 2, 3, 4, 5], false)).toBe(true);
    expect(
      isWorkday("2026-10-12", [1, 2, 3, 4, 5], true, [
        {
          target_date: "2026-10-12",
          is_workday: true,
          occasion: "normal",
          mood: null,
        },
      ]),
    ).toBe(true);
    expect(
      isWorkday("2026-10-13", [1, 2, 3, 4, 5], false, [
        {
          target_date: "2026-10-13",
          is_workday: false,
          occasion: "normal",
          mood: null,
        },
      ]),
    ).toBe(false);
  });
});

describe("recommendation safety invariants", () => {
  test("one top plus one bottom starts; missing shoes/outerwear are explicit, never invented", () => {
    const result = recommend(context);
    expect(result.items.map((item) => item.clothes_id).sort()).toEqual([
      top.id,
      bottom.id,
    ]);
    expect(result.warnings.join(" ")).toMatch(/靴/);
    expect(result.warnings.join(" ")).toMatch(/アウター/);
    expect(result.source).toBe("rule");
    expect(result.reason_short).not.toMatch(/[\r\n]/);
  });
  test.each([
    { state: "laundry" },
    { wears_since_wash: 10 },
    { deleted_at: "2026-10-12T00:00:00Z" },
    { classification_state: "pending" },
    { subtype: "shorts" },
    { seasons: ["summer"] },
  ] as Partial<Cloth>[])(
    "hard exclusions cannot be overridden by preference score: %j",
    (change) => {
      const invalid = { ...top, ...change };
      expect(eligible(invalid, defaultPreferences, context.date)).toBe(false);
      const result = recommend({ ...context, clothes: [invalid, bottom] });
      expect(result.items.some((item) => item.clothes_id === top.id)).toBe(
        false,
      );
      expect(result.plan_status).toBe("partial");
    },
  );
  test("NG category and subtype override preferred style", () => {
    for (const ng of ["top", "shirt", "SHIRT"]) {
      expect(
        eligible(
          top,
          {
            ...defaultPreferences,
            style_keywords: ["shirt"],
            ng_categories: [ng],
          },
          context.date,
        ),
      ).toBe(false);
    }
  });
  test("untrusted AI IDs, slot mismatches, duplicates and laundry garments are rejected", () => {
    for (const items of [
      [
        {
          clothes_id: "99999999-9999-4999-8999-999999999999",
          slot: "top" as const,
        },
      ],
      [{ clothes_id: top.id, slot: "bottom" as const }],
      [
        { clothes_id: top.id, slot: "top" as const },
        { clothes_id: top.id, slot: "bottom" as const },
      ],
      [
        { clothes_id: top.id, slot: "top" as const },
        { clothes_id: bottom.id, slot: "top" as const },
      ],
    ])
      expect(validateOutfit(items, context)).toBe(false);
    expect(
      validateOutfit([{ clothes_id: top.id, slot: "top" }], {
        ...context,
        clothes: [{ ...top, state: "laundry" }],
      }),
    ).toBe(false);
  });
  test("seasonal fallback is visibly provisional and cannot pretend to be fresh weather", () => {
    const weather = seasonalWeather("2026-12-01");
    expect(weather.source).toBe("seasonal");
    expect(weather.provisional).toBe(true);
    expect(weather.fetched_at).toBeNull();
    expect(
      recommend({ ...context, date: weather.date, weather }).warnings.join(" "),
    ).toMatch(/暫定/);
  });
  test("weekly planning never marks proposed clothes as actually worn", () => {
    const clothes = structuredClone([top, bottom]);
    const before = structuredClone(clothes);
    generateWeek({
      ...context,
      clothes,
      week: "2026-10-12",
      weekdays: [1, 2, 3, 4, 5],
    });
    expect(clothes).toEqual(before);
  });
  test("projected laundry limits are respected across the week", () => {
    const clothes = [
      { ...top, wear_limit: 2 },
      { ...bottom, wear_limit: 2 },
    ];
    const plans = generateWeek({
      ...context,
      clothes,
      week: "2026-10-12",
      weekdays: [1, 2, 3, 4, 5],
    });
    expect(
      plans.flatMap((p) => p.items).filter((i) => i.clothes_id === top.id),
    ).toHaveLength(2);
    expect(plans.filter((p) => p.plan_status === "partial")).toHaveLength(2);
  });
  test("manual lock survives weather change, deleted clothing, laundry and holiday changes with warnings", () => {
    const locked: Plan = {
      ...recommend(context),
      mode: "manual_lock",
      source: "manual",
    };
    const plans = generateWeek({
      ...context,
      week: "2026-10-12",
      weekdays: [],
      existing: [locked],
      clothes: [
        { ...top, state: "laundry", deleted_at: "2026-10-13T00:00:00Z" },
        bottom,
      ],
      forecasts: [{ ...seasonalWeather(context.date), min_c: 0, max_c: 4 }],
    });
    const actual = plans.find((p) => p.target_date === context.date)!;
    expect(actual.items).toEqual(locked.items);
    expect(actual.mode).toBe("manual_lock");
    expect(actual.warnings.join(" ")).toMatch(/固定|洗濯|削除/);
  });
  test("confirmed historical outfit also survives automatic regeneration", () => {
    const confirmed: Plan = { ...recommend(context), plan_status: "confirmed" };
    const plans = generateWeek({
      ...context,
      week: "2026-10-12",
      weekdays: [],
      existing: [confirmed],
      clothes: [],
    });
    expect(plans.find((p) => p.target_date === context.date)?.items).toEqual(
      confirmed.items,
    );
  });
});
