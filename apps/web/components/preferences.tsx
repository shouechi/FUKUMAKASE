"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import {
  defaultPreferences,
  preferencesSchema,
  regions,
  type Preferences,
  type PreferencesResponse,
} from "@outfit/schemas";
import { api, authClient } from "../lib/client";
import { Heading, Loading, Notice } from "./ui";
const dayNames = ["月", "火", "水", "木", "金", "土", "日"];
export function PreferencesScreen({
  onboarding = false,
}: {
  onboarding?: boolean;
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Preferences>(defaultPreferences);
  const [days, setDays] = useState([1, 2, 3, 4, 5]);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [style, setStyle] = useState("シンプル");
  const [ng, setNg] = useState("");
  useEffect(() => {
    Promise.all([
      api("GET /api/me/preferences"),
      api("GET /api/me/work-weekdays"),
    ])
      .then(([p, d]) => {
        const { onboarding_completed, ...values } = p;
        setPrefs(preferencesSchema.parse(values));
        setStyle((p.style_keywords ?? []).join("、"));
        setNg((p.ng_categories ?? []).join("、"));
        setDays(d.weekdays);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPrefs((p) => ({ ...p, [key]: value }));
    setSaved(false);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (onboarding && step < 2) {
      setStep(step + 1);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const list = (s: string) =>
        s
          .split(/[,、]/)
          .map((v) => v.trim())
          .filter(Boolean);
      await api("PATCH /api/me/preferences", {
        body: {
          ...prefs,
          style_keywords: list(style),
          ng_categories: list(ng),
        },
      });
      await api("PUT /api/me/work-weekdays", {
        body: { weekdays: days },
      });
      setSaved(true);
      if (onboarding) router.push("/closet/new");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <Loading />;
  return (
    <div className="narrow">
      <Heading
        eyebrow={onboarding ? "LET’S GET READY" : "YOUR PREFERENCES"}
        title={onboarding ? "あなたのいつもの一週間" : "設定"}
      >
        {onboarding
          ? "毎朝入力しなくていいように、最初に少しだけ。"
          : "生活に合わせて、いつでも変えられます。"}
      </Heading>
      {onboarding && (
        <ol className="steps">
          {["勤務・休日", "地域・時刻", "好み・職場"].map((s, i) => (
            <li key={s} className={step === i ? "active" : ""}>
              {i < step ? <Check size={14} /> : i + 1} {s}
            </li>
          ))}
        </ol>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {saved && <Notice kind="success">設定を保存しました</Notice>}
      <form onSubmit={save} className="settings-form">
        {(!onboarding || step === 0) && (
          <section className="panel">
            <h2>出勤する日</h2>
            <p>休暇・在宅・休日出勤は、週間画面で日ごとに変更できます。</p>
            <div className="weekday-picker">
              {dayNames.map((name, i) => (
                <button
                  type="button"
                  key={name}
                  className={days.includes(i + 1) ? "selected" : ""}
                  aria-pressed={days.includes(i + 1)}
                  onClick={() =>
                    setDays((d) =>
                      d.includes(i + 1)
                        ? d.filter((v) => v !== i + 1)
                        : [...d, i + 1].sort(),
                    )
                  }
                >
                  {name}
                </button>
              ))}
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={prefs.holidays_off}
                onChange={(e) => update("holidays_off", e.target.checked)}
              />
              日本の祝日はお休み
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={prefs.weekly_plan_enabled}
                onChange={(e) =>
                  update("weekly_plan_enabled", e.target.checked)
                }
              />
              週間計画を自動で作る
            </label>
          </section>
        )}
        {(!onboarding || step === 1) && (
          <section className="panel">
            <h2>天気と、朝の支度</h2>
            <label>
              天気を調べる地域
              <select
                value={prefs.base_region_code}
                onChange={(e) => update("base_region_code", e.target.value)}
              >
                {regions.map((r) => (
                  <option key={r[0]} value={r[0]}>
                    {r[1]}
                  </option>
                ))}
              </select>
              <small>詳しい住所や現在地は保存しません。</small>
            </label>
            <label>
              朝の服装調整を終える時刻
              <input
                type="time"
                value={prefs.auto_adjust_time.slice(0, 5)}
                required
                onChange={(e) => update("auto_adjust_time", e.target.value)}
              />
              <small>日本時間。最新の気温や雨に合わせて見直します。</small>
            </label>
          </section>
        )}
        {(!onboarding || step === 2) && (
          <section className="panel">
            <h2>好きな雰囲気と、職場のルール</h2>
            <label>
              服装ルール
              <select
                value={prefs.dress_code}
                onChange={(e) =>
                  update(
                    "dress_code",
                    e.target.value as Preferences["dress_code"],
                  )
                }
              >
                <option value="office_casual">オフィスカジュアル</option>
                <option value="free">自由</option>
              </select>
            </label>
            <label>
              好きなスタイル（任意）
              <input
                value={style}
                maxLength={200}
                onChange={(e) => setStyle(e.target.value)}
                placeholder="シンプル、きれいめ、カジュアル"
              />
              <small>「、」で区切って入力。後から変更できます。</small>
            </label>
            <label>
              職場で避けたい服（任意）
              <input
                value={ng}
                maxLength={200}
                onChange={(e) => setNg(e.target.value)}
                placeholder="denim、sandal、shorts"
              />
              <small>服の種類名（例：denim）を「、」で区切ってください。</small>
            </label>
          </section>
        )}
        <div className="actions">
          {onboarding && step > 0 && (
            <button
              type="button"
              className="button secondary"
              onClick={() => setStep(step - 1)}
            >
              戻る
            </button>
          )}
          <button className="button primary" disabled={busy}>
            {busy
              ? "保存しています…"
              : onboarding
                ? step < 2
                  ? "次へ"
                  : "服を登録する"
                : "設定を保存"}
            <ArrowRight size={17} />
          </button>
        </div>
      </form>
      {!onboarding && (
        <section className="panel account-panel">
          <h2>アカウント</h2>
          <p>ログイン情報は認証サービスで管理されています。</p>
          <Link href="/forgot-password">パスワードを再設定</Link>
          <button
            className="text-button"
            onClick={async () => {
              await authClient()?.auth.signOut();
              router.push("/login");
            }}
          >
            ログアウト
          </button>
          <Link className="danger-link" href="/account/delete">
            退会・データの削除
          </Link>
        </section>
      )}
    </div>
  );
}
