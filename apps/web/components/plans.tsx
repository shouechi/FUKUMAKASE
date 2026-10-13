"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  RefreshCw,
  CloudSun,
  LockKeyhole,
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
} from "lucide-react";
import type {
  Cloth,
  Plan,
  Category,
  Usage,
  DayOverrideResponse,
  WeeklyPlans,
  ClothesPage,
  ApiRequest,
} from "@outfit/schemas";
import { api, dateLabel, monday, shiftDate, todayJst } from "../lib/client";
import {
  categoryLabels,
  ClothCard,
  Empty,
  Heading,
  Loading,
  Notice,
} from "./ui";
async function refreshUsageAfterMutation(
  onUsage: (usage: Usage) => void,
  onReadError: (message: string) => void,
) {
  try {
    onUsage(await api("GET /api/me/usage"));
  } catch (e) {
    // Generation is already saved; recover by reading rather than repeating it.
    onReadError((e as Error).message);
  }
}
function ReloadButton({
  disabled,
  onReload,
}: {
  disabled: boolean;
  onReload: () => Promise<void>;
}) {
  return (
    <button className="button secondary" disabled={disabled} onClick={onReload}>
      <RefreshCw size={16} />
      もう一度読み込む
    </button>
  );
}
export function Today() {
  const router = useRouter();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reason, setReason] =
    useState<ApiRequest<"POST /api/outfits/today/regenerate">["reason"]>(
      "different",
    );
  const [regenOpen, setRegenOpen] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const preferences = await api("GET /api/me/preferences");
      if (!preferences.onboarding_completed) {
        router.replace("/onboarding");
        return;
      }
      const [p, u] = await Promise.all([
        api("GET /api/outfits/today"),
        api("GET /api/me/usage"),
      ]);
      setPlan(p);
      setUsage(u);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [router]);
  useEffect(() => {
    void load();
  }, [load]);
  async function confirm() {
    if (!plan?.outfit_id) return;
    setBusy(true);
    setError("");
    try {
      await api("POST /api/wear-logs", {
        body: {
          target_date: plan.target_date,
          outfit_id: plan.outfit_id,
        },
      });
      setPlan({ ...plan, plan_status: "confirmed" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function regenerate() {
    setBusy(true);
    setError("");
    try {
      const p = await api("POST /api/outfits/today/regenerate", {
        body: { reason },
      });
      setPlan(p);
      setRegenOpen(false);
      setUsage((current) =>
        current
          ? { ...current, daily_regens_remaining: p.daily_regens_remaining }
          : current,
      );
      await refreshUsageAfterMutation(setUsage, setLoadError);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading eyebrow={dateLabel(todayJst())} title="今日の服は、これ。">
        朝のひとつを、おまかせに。
      </Heading>
      {(loadError || error) && (
        <Notice kind="error">{loadError || error}</Notice>
      )}
      {loadError && <ReloadButton disabled={loading || busy} onReload={load} />}
      {loading ? (
        <Loading />
      ) : !plan ? (
        !loadError && (
          <Empty title="今日の服がまだありません。">
            <p>今日の予定や登録した服を確認してください。</p>
            <Link className="button secondary" href={`/week/${todayJst()}`}>
              今日の予定を確認
            </Link>
          </Empty>
        )
      ) : (
        <>
          <div className="today-meta">
            <div className="weather">
              <CloudSun size={22} />
              {plan.weather ? (
                <>
                  <strong>{Math.round(plan.weather.max_c)}°</strong>
                  <span>
                    / {Math.round(plan.weather.min_c)}°
                    <small>降水確率 {plan.weather.rain_probability}%</small>
                  </span>
                  <span className="tag">
                    {plan.weather.source === "seasonal"
                      ? "季節の目安"
                      : plan.weather.source === "cache"
                        ? "保存済み予報"
                        : plan.weather.provisional
                          ? "暫定予報"
                          : "最新予報"}
                  </span>
                </>
              ) : (
                <span>天気を確認できません</span>
              )}
            </div>
            <span className="tag">
              {plan.mode === "manual_lock" ? (
                <>
                  <LockKeyhole size={12} />
                  手動固定
                </>
              ) : plan.plan_status === "confirmed" ? (
                "着用済み"
              ) : plan.source === "rule" ? (
                "簡易提案"
              ) : (
                "あなたへの提案"
              )}
            </span>
          </div>
          {plan.weather?.source === "cache" && plan.weather.fetched_at && (
            <p className="subtle">
              予報の取得：
              {new Date(plan.weather.fetched_at).toLocaleString("ja-JP", {
                timeZone: "Asia/Tokyo",
              })}
            </p>
          )}
          {plan.warnings.map((w, i) => (
            <Notice key={i}>{w}</Notice>
          ))}
          {plan.plan_status === "skipped" ? (
            <Empty title="今日はお休みの日。">
              <p>出勤する場合は、今日の予定を変更できます。</p>
              <Link className="button secondary" href={`/week/${todayJst()}`}>
                今日の予定を変更
              </Link>
            </Empty>
          ) : plan.items.length === 0 ? (
            <Empty title="今日の一組を、準備しましょう。">
              <p>
                着られるトップスとボトムスを登録してください。
                <br />
                洗濯待ちの服は、洗濯済みに戻せます。
              </p>
              <Link className="button primary" href="/closet/new">
                服を登録する
              </Link>
            </Empty>
          ) : (
            <>
              <div className="outfit-grid">
                {plan.items.map((item) =>
                  item.clothes ? (
                    <ClothCard key={item.clothes_id} cloth={item.clothes} />
                  ) : (
                    <div className="panel" key={item.clothes_id}>
                      {categoryLabels[item.slot]}
                      <p>この服は利用できません</p>
                    </div>
                  ),
                )}
              </div>
              <div className="outfit-bottom">
                <p className="outfit-reason">{plan.reason_short}</p>
                <div className="actions">
                  <button
                    className="button primary wear-button"
                    disabled={
                      busy ||
                      plan.plan_status === "confirmed" ||
                      plan.plan_status === "partial"
                    }
                    onClick={confirm}
                  >
                    <Check size={19} />
                    {plan.plan_status === "confirmed"
                      ? "今日の着用を記録しました"
                      : busy
                        ? "処理しています…"
                        : "これを着た"}
                  </button>
                  <Link
                    className="text-button"
                    href={`/week/${plan.target_date}`}
                  >
                    服を入れ替える
                    <ArrowUpRight size={16} />
                  </Link>
                </div>
              </div>
              <div className="regen-section">
                {regenOpen ? (
                  <>
                    <label>
                      変えたい理由（任意）
                      <select
                        value={reason}
                        onChange={(e) =>
                          setReason(e.target.value as typeof reason)
                        }
                      >
                        <option value="different">別の組み合わせ</option>
                        <option value="dislike_item">今日は着たくない</option>
                        <option value="more_casual">もっとカジュアル</option>
                        <option value="other">その他</option>
                      </select>
                    </label>
                    <button
                      className="button secondary"
                      disabled={busy || !!loadError}
                      onClick={regenerate}
                    >
                      もう一度提案する
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setRegenOpen(false)}
                    >
                      キャンセル
                    </button>
                  </>
                ) : (
                  <button
                    className="text-button"
                    disabled={
                      busy ||
                      !!loadError ||
                      usage?.daily_regens_remaining === 0 ||
                      plan.mode === "manual_lock" ||
                      plan.plan_status === "confirmed"
                    }
                    onClick={() => setRegenOpen(true)}
                  >
                    <RefreshCw size={15} />
                    別の服にする{" "}
                    <span className="subtle">
                      あと{usage?.daily_regens_remaining ?? "—"}回 / 日
                    </span>
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
      <aside className="today-footer">
        <span className="eyebrow">A LITTLE LESS TO THINK ABOUT</span>
        <p>着た記録が、明日の服選びにつながります。</p>
        <Link href="/week">
          今週の服を見てみる <ArrowUpRight size={15} />
        </Link>
      </aside>
    </>
  );
}
export function Week() {
  const [week, setWeek] = useState(monday());
  const [plans, setPlans] = useState<Plan[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [p, u] = await Promise.all([
        api("GET /api/plans/weekly", { query: { week } }),
        api("GET /api/me/usage"),
      ]);
      setPlans(p.days);
      setUsage(u);
      setError("");
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [week]);
  useEffect(() => {
    setPlans([]);
    void load();
  }, [load]);
  async function regenerate() {
    setBusy(true);
    setError("");
    try {
      const p = await api("POST /api/plans/weekly/regenerate", {
        body: { week },
      });
      setPlans(p.days);
      if (p.weekly_regens_remaining !== undefined) {
        const remaining = p.weekly_regens_remaining;
        setUsage((current) =>
          current
            ? { ...current, weekly_regens_remaining: remaining }
            : current,
        );
      }
      await refreshUsageAfterMutation(setUsage, setLoadError);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading eyebrow="A WEEK, ALREADY SORTED" title="一週間の支度">
        手動で決めた日は、そのまま大切に。
      </Heading>
      <div className="week-toolbar">
        <button
          className="icon-button"
          aria-label="前の週"
          disabled={loading || busy}
          onClick={() => setWeek(shiftDate(week, -7))}
        >
          <ChevronLeft />
        </button>
        <h2>
          {dateLabel(week)} − {dateLabel(shiftDate(week, 6))}
        </h2>
        <button
          className="icon-button"
          aria-label="次の週"
          disabled={loading || busy}
          onClick={() => setWeek(shiftDate(week, 7))}
        >
          <ChevronRight />
        </button>
      </div>
      {(loadError || error) && (
        <Notice kind="error">{loadError || error}</Notice>
      )}
      {loadError && <ReloadButton disabled={loading || busy} onReload={load} />}
      {loading ? (
        <Loading />
      ) : loadError && !plans.length ? null : (
        <div className="week-list">
          {Array.from({ length: 7 }, (_, i) => shiftDate(week, i)).map(
            (date) => {
              const p = plans.find((p) => p.target_date === date);
              return (
                <Link
                  href={`/week/${date}`}
                  key={date}
                  className={`week-row ${date === todayJst() ? "is-today" : ""}`}
                >
                  <div className="week-date">
                    <strong>{dateLabel(date)}</strong>
                    {date === todayJst() && <span className="tag">今日</span>}
                  </div>
                  <div className="week-outfit">
                    {!p || p.plan_status === "skipped" ? (
                      <span className="subtle">お休み</span>
                    ) : (
                      <>
                        <div className="week-items">
                          {p.items.map((item) => (
                            <span key={item.clothes_id}>
                              {item.clothes
                                ? `${item.clothes.color}の${categoryLabels[item.slot]}`
                                : categoryLabels[item.slot]}
                            </span>
                          ))}
                        </div>
                        <small>{p.reason_short}</small>
                        {p.warnings.length > 0 && (
                          <small className="warning-text">
                            {p.warnings[0]}
                          </small>
                        )}
                      </>
                    )}
                  </div>
                  <div className="week-badges">
                    {p?.mode === "manual_lock" && (
                      <span className="tag">
                        <LockKeyhole size={12} />
                        固定
                      </span>
                    )}
                    {p?.plan_status === "confirmed" && (
                      <span className="tag">着用済み</span>
                    )}
                    {p?.weather?.provisional && (
                      <span className="tag">暫定</span>
                    )}
                    <ArrowUpRight size={17} />
                  </div>
                </Link>
              );
            },
          )}
        </div>
      )}
      <div className="regen-section">
        <button
          className="button secondary"
          disabled={
            busy ||
            loading ||
            !!loadError ||
            usage?.weekly_regens_remaining === 0
          }
          onClick={regenerate}
        >
          <RefreshCw size={16} />
          {busy ? "計画しています…" : "一週間を作り直す"}
        </button>
        <small>
          今週あと{usage?.weekly_regens_remaining ?? "—"}
          回。固定・着用済みの日は変わりません。
        </small>
      </div>
    </>
  );
}
export function DayEditor({ date }: { date: string }) {
  const router = useRouter();
  const [clothes, setClothes] = useState<Cloth[]>([]);
  const [selected, setSelected] = useState<Partial<Record<Category, string>>>(
    {},
  );
  const [isWorkday, setWorkday] = useState(true);
  const [occasion, setOccasion] =
    useState<ApiRequest<"PUT /api/me/day-overrides/:date">["occasion"]>(
      "normal",
    );
  const [mood, setMood] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    Promise.all([
      api("GET /api/clothes"),
      api("GET /api/plans/weekly", { query: { week: monday(date) } }),
      api("GET /api/me/day-overrides/:date", { params: { date } }),
    ])
      .then(([c, p, o]) => {
        setClothes(c.items);
        const plan = p.days.find((p) => p.target_date === date);
        setSelected(
          Object.fromEntries(
            (plan?.items ?? []).map((i) => [i.slot, i.clothes_id]),
          ),
        );
        setWorkday(o.override?.is_workday ?? plan?.plan_status !== "skipped");
        setOccasion(o.override?.occasion ?? "normal");
        setMood(o.override?.mood ?? "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setReady(true));
  }, [date]);
  async function save(lock: boolean) {
    setBusy(true);
    setError("");
    try {
      await api("PUT /api/me/day-overrides/:date", {
        params: { date },
        body: {
          is_workday: isWorkday,
          occasion,
          mood: mood || null,
        },
      });
      if (lock && isWorkday) {
        const items = Object.entries(selected)
          .filter(([, id]) => id)
          .map(([slot, clothes_id]) => ({
            slot: slot as Category,
            clothes_id: clothes_id!,
          }));
        await api("PUT /api/plans/:date", {
          params: { date },
          body: { items },
        });
      }
      router.push("/week");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="narrow">
      <Heading eyebrow="MAKE IT YOURS" title={dateLabel(date)}>
        予定と気分に合わせて、この日だけ調整。
      </Heading>
      {error && <Notice kind="error">{error}</Notice>}
      {!ready ? (
        <Loading />
      ) : (
        <>
          <section className="panel">
            <h2>この日の予定</h2>
            <label>
              出勤予定
              <select
                value={isWorkday ? "work" : "off"}
                onChange={(e) => setWorkday(e.target.value === "work")}
              >
                <option value="work">出勤</option>
                <option value="off">休暇・在宅・お休み</option>
              </select>
            </label>
            {isWorkday && (
              <>
                <label>
                  特別な予定
                  <select
                    value={occasion}
                    onChange={(e) =>
                      setOccasion(e.target.value as typeof occasion)
                    }
                  >
                    <option value="normal">いつもどおり</option>
                    <option value="meeting">会議</option>
                    <option value="external_visit">社外訪問</option>
                    <option value="other">その他</option>
                  </select>
                </label>
                <label>
                  気分（任意）
                  <input
                    maxLength={80}
                    value={mood}
                    onChange={(e) => setMood(e.target.value)}
                    placeholder="今日はきれいめに"
                  />
                </label>
              </>
            )}
            <div className="actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => save(false)}
              >
                予定だけ保存
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("DELETE /api/me/day-overrides/:date", {
                      params: { date },
                    });
                    router.push("/week");
                  } catch (e) {
                    setError((e as Error).message);
                    setBusy(false);
                  }
                }}
              >
                基本の勤務予定に戻す
              </button>
            </div>
          </section>
          {isWorkday && (
            <section className="panel">
              <h2>自分で服を選ぶ</h2>
              <p>
                保存したコーデは手動固定になります。天気や洗濯状態が変わっても自動では入れ替えません。
              </p>
              {Object.entries(categoryLabels).map(([slot, label]) => (
                <label key={slot}>
                  {label}
                  <select
                    value={selected[slot as Category] ?? ""}
                    onChange={(e) =>
                      setSelected({ ...selected, [slot]: e.target.value })
                    }
                  >
                    <option value="">選択なし</option>
                    {clothes
                      .filter((c) => c.category === slot)
                      .map((c) => (
                        <option
                          key={c.id}
                          value={c.id}
                          disabled={
                            c.state === "laundry" ||
                            c.wears_since_wash >= c.wear_limit
                          }
                        >
                          {c.color} {c.subtype || label}
                          {c.state === "laundry" ? "（洗濯待ち）" : ""}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              <button
                className="button primary"
                disabled={busy || !selected.top || !selected.bottom}
                onClick={() => save(true)}
              >
                <LockKeyhole size={17} />
                このコーデで固定
              </button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
