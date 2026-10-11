import type {
  Cloth,
  DayOverride,
  OutfitItem,
  Plan,
  Preferences,
  Season,
  Weather,
} from "@outfit/schemas";

export const jstDate = (now: Date = new Date()): string =>
  new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
export const addDays = (date: string, days: number): string =>
  new Date(new Date(date + "T00:00:00Z").getTime() + days * 86400000)
    .toISOString()
    .slice(0, 10);
export const weekday = (date: string): number =>
  new Date(date + "T00:00:00Z").getUTCDay() || 7;
export const weekStart = (date: string): string =>
  addDays(date, 1 - weekday(date));
export const jstWeekStart = (now: Date = new Date()): string =>
  weekStart(jstDate(now));
export const nextDailyReset = (now: Date = new Date()): string =>
  new Date(addDays(jstDate(now), 1) + "T00:00:00+09:00").toISOString();
export const nextWeeklyReset = (now: Date = new Date()): string =>
  new Date(addDays(jstWeekStart(now), 7) + "T00:00:00+09:00").toISOString();

/** Modern Japanese holiday law; equinox estimates valid 1980–2099. Historical Olympic exceptions included. */
export function japaneseHolidays(year: number): Map<string, string> {
  const days = new Map<string, string>();
  const date = (m: number, d: number) =>
    `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const put = (m: number, d: number, name: string) =>
    days.set(date(m, d), name);
  const monday = (m: number, n: number) =>
    1 + ((8 - weekday(date(m, 1))) % 7) + (n - 1) * 7;
  put(1, 1, "元日");
  put(1, monday(1, 2), "成人の日");
  put(2, 11, "建国記念の日");
  if (year >= 2020) put(2, 23, "天皇誕生日");
  else if (year <= 2018) put(12, 23, "天皇誕生日");
  put(
    3,
    Math.floor(
      20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4),
    ),
    "春分の日",
  );
  put(4, 29, "昭和の日");
  put(5, 3, "憲法記念日");
  put(5, 4, "みどりの日");
  put(5, 5, "こどもの日");
  if (year === 2020) {
    put(7, 23, "海の日");
    put(7, 24, "スポーツの日");
    put(8, 10, "山の日");
  } else if (year === 2021) {
    put(7, 22, "海の日");
    put(7, 23, "スポーツの日");
    put(8, 8, "山の日");
  } else {
    put(7, monday(7, 3), "海の日");
    if (year >= 2016) put(8, 11, "山の日");
    put(10, monday(10, 2), "スポーツの日");
  }
  put(9, monday(9, 3), "敬老の日");
  put(
    9,
    Math.floor(
      23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4),
    ),
    "秋分の日",
  );
  put(11, 3, "文化の日");
  put(11, 23, "勤労感謝の日");
  if (year === 2019) {
    put(5, 1, "即位の日");
    put(10, 22, "即位礼正殿の儀");
  }
  for (let d = date(1, 2); d < date(12, 31); d = addDays(d, 1))
    if (!days.has(d) && days.has(addDays(d, -1)) && days.has(addDays(d, 1)))
      days.set(d, "国民の休日");
  for (const d of [...days.keys()].sort())
    if (weekday(d) === 7) {
      let n = addDays(d, 1);
      while (days.has(n)) n = addDays(n, 1);
      days.set(n, "振替休日");
    }
  return days;
}
export const holidayName = (date: string): string | null =>
  japaneseHolidays(Number(date.slice(0, 4))).get(date) ?? null;
export const isJapaneseHoliday = (date: string): boolean =>
  holidayName(date) !== null;
export function isWorkday(
  date: string,
  weekdays: number[],
  holidaysOff: boolean,
  overrides: DayOverride[] = [],
): boolean {
  const override = overrides.find((v) => v.target_date === date);
  return override
    ? override.is_workday
    : weekdays.includes(weekday(date)) &&
        (!holidaysOff || !isJapaneseHoliday(date));
}
export function seasonForDate(date: string): Season {
  const month = Number(date.slice(5, 7));
  return month >= 3 && month <= 5
    ? "spring"
    : month >= 6 && month <= 8
      ? "summer"
      : month >= 9 && month <= 11
        ? "autumn"
        : "winter";
}
export function seasonalWeather(date: string): Weather {
  const s = seasonForDate(date);
  const [min_c, max_c] =
    s === "summer"
      ? [24, 31]
      : s === "winter"
        ? [3, 10]
        : s === "spring"
          ? [11, 20]
          : [14, 23];
  return {
    date,
    min_c,
    max_c,
    rain_probability: 0,
    source: "seasonal",
    fetched_at: null,
    provisional: true,
  };
}
export function eligible(
  cloth: Cloth,
  preferences: Preferences,
  date: string,
  weather: Weather = seasonalWeather(date),
  projected = 0,
  allowClimateMismatch = false,
): boolean {
  if (
    cloth.deleted_at ||
    cloth.is_available === false ||
    cloth.state !== "available" ||
    cloth.wears_since_wash + projected >= cloth.wear_limit ||
    cloth.classification_state === "pending" ||
    !cloth.seasons.length ||
    cloth.color === "unknown"
  )
    return false;
  if (
    preferences.ng_categories.some(
      (ng) =>
        ng.toLowerCase() === cloth.category ||
        ng.toLowerCase() === cloth.subtype.toLowerCase(),
    )
  )
    return false;
  if (
    preferences.dress_code === "office_casual" &&
    [
      "shorts",
      "flip_flops",
      "beach_sandals",
      "tank_top",
      "短パン",
      "ビーチサンダル",
      "タンクトップ",
    ].includes(cloth.subtype.toLowerCase())
  )
    return false;
  if (allowClimateMismatch) return true;
  if (cloth.seasons.length > 0 && !cloth.seasons.includes(seasonForDate(date)))
    return false;
  if (weather.max_c >= 28 && cloth.thickness === "thick") return false;
  if (
    weather.max_c <= 8 &&
    cloth.thickness === "thin" &&
    ["top", "outerwear"].includes(cloth.category)
  )
    return false;
  return true;
}
export interface RecommendationContext {
  date: string;
  clothes: Cloth[];
  preferences: Preferences;
  weather?: Weather;
  projected?: Map<string, number>;
  recentIds?: string[];
  previousItems?: OutfitItem[];
  mood?: string | null;
  occasion?: string;
  rotation?: number;
  learnedStyles?: Record<string, number>;
}
/** Japanese preferences and classifier English tags share this single matcher. */
export function matchesStyle(cloth: Cloth, keyword: string): boolean {
  const styles: Record<string, string[]> = {
    カジュアル: [
      "t_shirt",
      "t-shirt",
      "sweater",
      "jeans",
      "sneakers",
      "Tシャツ",
      "ニット",
      "デニム",
    ],
    casual: ["t_shirt", "t-shirt", "sweater", "jeans", "sneakers"],
    きれいめ: [
      "shirt",
      "blouse",
      "slacks",
      "jacket",
      "loafers",
      "シャツ",
      "ブラウス",
      "ジャケット",
    ],
    シンプル: ["shirt", "t_shirt", "slacks", "sweater", "シャツ", "ニット"],
    リラックス: ["t_shirt", "sweater", "jeans", "sneakers"],
  };
  return (
    (styles[keyword]?.includes(cloth.subtype) ?? false) ||
    cloth.subtype.toLowerCase().includes(keyword.toLowerCase())
  );
}
export function recommend(context: RecommendationContext): Plan {
  const { date, clothes, preferences } = context,
    weather = context.weather ?? seasonalWeather(date),
    warnings: string[] = [];
  if (weather.source === "seasonal")
    warnings.push("天気を取得できないため季節を目安にした暫定提案です");
  else if (weather.source === "cache")
    warnings.push(
      `保存済みの予報を使用しています（${weather.fetched_at?.slice(0, 16)}）`,
    );
  if (weather.provisional) warnings.push("先の日付の予報・洗濯予定は暫定です");
  if (weather.rain_probability >= 50)
    warnings.push("雨の予報です。傘と濡れてもよい靴を確認してください");
  const items: OutfitItem[] = [];
  for (const slot of ["top", "bottom", "shoes", "outerwear"] as const) {
    if (slot === "outerwear" && weather.min_c >= 18) {
      if (!clothes.some((c) => c.category === slot && !c.deleted_at))
        warnings.push("アウターが未登録です（今日は省略できます）");
      continue;
    }
    const candidates = clothes.filter(
      (c) =>
        c.category === slot &&
        eligible(
          c,
          preferences,
          date,
          weather,
          context.projected?.get(c.id) ?? 0,
        ),
    );
    const score = (c: Cloth) => {
      let n =
        (context.recentIds?.includes(c.id) ? 0 : 2) -
        (context.previousItems?.some((i) => i.clothes_id === c.id) ? 3 : 0) -
        2 * (context.projected?.get(c.id) ?? 0);
      if (preferences.style_keywords.some((k) => matchesStyle(c, k))) n += 3;
      n += Math.min(2, (context.learnedStyles?.[c.subtype] ?? 0) * 0.2);
      if (
        context.mood &&
        (matchesStyle(c, context.mood) || c.color.includes(context.mood))
      )
        n += 3;
      if (
        context.occasion &&
        context.occasion !== "normal" &&
        ["shirt", "jacket", "slacks", "シャツ", "ジャケット"].includes(
          c.subtype,
        )
      )
        n += 3;
      if (
        weather.rain_probability >= 50 &&
        ["raincoat", "rain_boots", "boots", "レインコート", "長靴"].includes(
          c.subtype,
        )
      )
        n += 3;
      if (
        (weather.max_c > 24 && c.thickness === "thin") ||
        (weather.max_c < 14 && c.thickness === "thick")
      )
        n += 3;
      if (
        [
          "white",
          "black",
          "gray",
          "navy",
          "beige",
          "白",
          "黒",
          "グレー",
        ].includes(c.color)
      )
        n++;
      return n;
    };
    candidates.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const selected = candidates.length
      ? candidates[(context.rotation ?? 0) % candidates.length]
      : undefined;
    if (selected) items.push({ clothes_id: selected.id, slot });
    else
      warnings.push(
        `${{ top: "トップス", bottom: "ボトムス", shoes: "靴", outerwear: "アウター" }[slot]}の着用可能な服がありません`,
      );
  }
  return {
    target_date: date,
    mode: "auto",
    plan_status:
      items.some((i) => i.slot === "top") &&
      items.some((i) => i.slot === "bottom")
        ? "proposed"
        : "partial",
    source: "rule",
    reason_short:
      weather.min_c < 18
        ? "気温に合わせて、着用できる服から選びました"
        : "着用間隔と色の合わせやすさから選びました",
    items,
    warnings,
    weather,
  };
}
export function validateOutfit(
  items: OutfitItem[],
  context: RecommendationContext,
  allowClimateMismatch = false,
): boolean {
  if (
    !items.length ||
    new Set(items.map((i) => i.slot)).size !== items.length ||
    new Set(items.map((i) => i.clothes_id)).size !== items.length
  )
    return false;
  return items.every((i) => {
    const c = context.clothes.find((c) => c.id === i.clothes_id);
    return (
      !!c &&
      c.category === i.slot &&
      eligible(
        c,
        context.preferences,
        context.date,
        context.weather,
        context.projected?.get(c.id) ?? 0,
        allowClimateMismatch,
      )
    );
  });
}
export function planWarnings(
  plan: Plan,
  context: RecommendationContext,
): string[] {
  // Warnings describe current conditions; stale laundry/weather warnings must clear.
  const warnings: string[] = [];
  if (!validateOutfit(plan.items, context))
    warnings.push(
      "固定した服に削除済み・洗濯待ち・会社ルールや季節に合わない服があります",
    );
  if (
    (context.weather?.min_c ?? 20) < 15 &&
    !plan.items.some((i) => i.slot === "outerwear")
  )
    warnings.push("気温が低いためアウターの追加をおすすめします");
  return [...new Set(warnings)];
}
export function generateWeek(
  context: Omit<RecommendationContext, "date"> & {
    week: string;
    weekdays: number[];
    overrides?: DayOverride[];
    existing?: Plan[];
    forecasts?: Weather[];
    today?: string;
  },
): Plan[] {
  const projected = new Map<string, number>(),
    plans: Plan[] = [];
  for (let n = 0; n < 7; n++) {
    const date = addDays(weekStart(context.week), n),
      weather =
        context.forecasts?.find((w) => w.date === date) ??
        seasonalWeather(date);
    const override = context.overrides?.find((o) => o.target_date === date);
    const ctx: RecommendationContext = {
      ...context,
      date,
      weather,
      projected,
      previousItems: plans.at(-1)?.items,
      mood: override?.mood,
      occasion: override?.occasion,
    };
    const existing = context.existing?.find((p) => p.target_date === date);
    let plan: Plan;
    if (
      existing &&
      (existing.mode === "manual_lock" || existing.plan_status === "confirmed")
    )
      plan = { ...existing, warnings: planWarnings(existing, ctx), weather };
    else if (
      !isWorkday(
        date,
        context.weekdays,
        context.preferences.holidays_off,
        context.overrides,
      )
    )
      plan = {
        target_date: date,
        mode: "auto",
        source: "rule",
        plan_status: "skipped",
        reason_short: "今日はお休みです",
        items: [],
        warnings: [],
        weather,
      };
    else plan = recommend(ctx);
    plans.push(plan);
    if (
      plan.plan_status !== "confirmed" &&
      (!context.today || date >= context.today)
    )
      for (const item of plan.items)
        projected.set(
          item.clothes_id,
          (projected.get(item.clothes_id) ?? 0) + 1,
        );
  }
  return plans;
}
