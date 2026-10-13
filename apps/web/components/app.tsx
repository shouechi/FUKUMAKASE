"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Sun,
  CalendarDays,
  Shirt,
  History as HistoryIcon,
  Settings,
  ArrowUpRight,
  ArrowRight,
  Check,
  Leaf,
} from "lucide-react";
import { authClient } from "../lib/client";
import { AuthScreen, AuthCallback } from "./auth";
import { PreferencesScreen } from "./preferences";
import { Closet, NewClothing, ClothingDetail } from "./closet";
import { Today, Week, DayEditor } from "./plans";
import { History } from "./history";
import { DeleteAccount, DeletionProgress, Legal } from "./legal";
import { dateSchema } from "@outfit/schemas";
import { Loading, Notice } from "./ui";
const tabs = [
  ["/today", "今日", Sun],
  ["/week", "1週間", CalendarDays],
  ["/closet", "クローゼット", Shirt],
  ["/history", "記録", HistoryIcon],
  ["/settings", "設定", Settings],
] as const;
export function App() {
  const path = usePathname() || "/";
  const router = useRouter();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const publicRoute = [
    "/",
    "/login",
    "/signup",
    "/forgot-password",
    "/reset-password",
    "/auth/callback",
    "/privacy",
    "/terms",
    "/account/deletion-status",
  ].includes(path);
  useEffect(() => {
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    const client = authClient();
    if (!client) {
      setAuthenticated(false);
      return;
    }
    client.auth
      .getSession()
      .then(({ data }) => setAuthenticated(!!data.session));
    const { data } = client.auth.onAuthStateChange((_event, session) =>
      setAuthenticated(!!session),
    );
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (publicRoute || authenticated === null) return;
    if (!authenticated) {
      router.replace("/login");
      return;
    }
  }, [path, publicRoute, authenticated, router]);
  let content;
  if (path === "/") content = <Landing />;
  else if (
    ["/login", "/signup", "/forgot-password", "/reset-password"].includes(path)
  )
    content = (
      <AuthScreen
        mode={
          path.slice(1) as
            "login" | "signup" | "forgot-password" | "reset-password"
        }
      />
    );
  else if (path === "/auth/callback") content = <AuthCallback />;
  else if (path === "/privacy" || path === "/terms")
    content = <Legal kind={path.slice(1) as "privacy" | "terms"} />;
  else if (path === "/account/deletion-status") content = <DeletionProgress />;
  else if (authenticated !== true)
    content = (
      <div className="narrow">
        {authenticated === null ? (
          <Loading />
        ) : (
          <Notice>
            ログインして、あなたのクローゼットを開いてください。
            <Link href="/login">ログイン</Link>
          </Notice>
        )}
      </div>
    );
  else if (path === "/today") content = <Today />;
  else if (path === "/week") content = <Week />;
  else if (
    /^\/week\/\d{4}-\d{2}-\d{2}$/.test(path) &&
    dateSchema.safeParse(path.split("/")[2]).success
  )
    content = <DayEditor date={path.split("/")[2]} key={path} />;
  else if (path === "/closet") content = <Closet />;
  else if (path === "/closet/new") content = <NewClothing />;
  else if (/^\/closet\/[\w-]+$/.test(path))
    content = <ClothingDetail id={path.split("/")[2]} key={path} />;
  else if (path === "/history") content = <History />;
  else if (path === "/settings" || path === "/onboarding")
    content = (
      <PreferencesScreen onboarding={path === "/onboarding"} key={path} />
    );
  else if (path === "/account/delete") content = <DeleteAccount />;
  else
    content = (
      <div className="empty">
        <h1>ページが見つかりません</h1>
        <Link href="/today">今日の服へ</Link>
      </div>
    );
  return (
    <>
      <a href="#main" className="skip-link">
        本文へスキップ
      </a>
      <header className="header">
        <Link className="brand" href={authenticated ? "/today" : "/"}>
          <span className="brand-icon">
            <Shirt size={23} strokeWidth={1.3} />
          </span>
          フクマカセ<span className="brand-en">FUKUMAKASE</span>
        </Link>
        {!publicRoute && authenticated ? (
          <nav className="desktop-nav" aria-label="メインメニュー">
            {tabs.map(([url, label, Icon]) => (
              <Link
                key={url}
                href={url}
                aria-current={path.startsWith(url) ? "page" : undefined}
              >
                <Icon size={17} />
                {label}
              </Link>
            ))}
          </nav>
        ) : (
          <div className="header-actions">
            <Link href="/login">ログイン</Link>
            <Link href="/signup" className="button primary small">
              無料ではじめる
              <ArrowUpRight size={15} />
            </Link>
          </div>
        )}
      </header>
      <main id="main" className={path === "/" ? "landing-main" : "main"}>
        {content}
      </main>
      {!publicRoute && authenticated && (
        <nav className="bottom-nav" aria-label="メインメニュー">
          {tabs.map(([url, label, Icon]) => (
            <Link
              key={url}
              href={url}
              aria-current={path.startsWith(url) ? "page" : undefined}
            >
              <Icon size={21} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
      )}
      <footer className="footer">
        <span>
          フクマカセ <span className="subtle">あなたの朝に、余白を。</span>
        </span>
        <div>
          <Link href="/privacy">プライバシー</Link>
          <Link href="/terms">利用規約</Link>
        </div>
      </footer>
    </>
  );
}
function Landing() {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="hero-kicker">
            <span />
            朝の服選びを、軽やかに。
          </div>
          <h1>
            明日の服は、
            <br />
            <em>もう決まってる。</em>
          </h1>
          <p>
            天気と、予定と、あなたのクローゼット。
            <br />
            いつもの服から、今日に似合う一組を。
            <br />
            朝の「何を着よう」は、まかせて。
          </p>
          <Link className="button primary hero-cta" href="/signup">
            無料ではじめる
            <ArrowUpRight size={18} />
          </Link>
          <div className="hero-note">
            <Check size={14} />
            トップス1着、ボトムス1着から。
          </div>
        </div>
        <div className="hero-visual" aria-label="服選びのイメージ">
          <div className="visual-label">
            <span className="eyebrow">YOUR MORNING, SIMPLIFIED</span>
            <span>01 / 03</span>
          </div>
          <div className="outfit-illustration">
            <svg
              viewBox="0 0 500 450"
              role="img"
              aria-label="シャツとパンツのイラスト"
            >
              <ellipse cx="250" cy="403" rx="170" ry="14" fill="#e1dfd5" />
              <path
                d="M130 65l-55 25-42 124 56 20 29-77-5 174 168 0-5-174 29 77 56-20-42-124-55-25-33 29h-68z"
                fill="#fdfcf8"
                stroke="#c9c6ba"
                strokeWidth="2"
              />
              <path
                d="M163 65l34 49-30 25-35-57m99-17l-34 49 30 25 36-57M197 114v217"
                fill="none"
                stroke="#c9c6ba"
                strokeWidth="2"
              />
              <path d="M218 113l39 0v41h-39z" fill="none" stroke="#dad7ce" />
              {[154, 193, 232, 271, 310].map((y) => (
                <circle key={y} cx="202" cy={y} r="2.2" fill="#afad9f" />
              ))}
              <path
                d="M299 178h139l-8 211h-58l-12-141-12 141h-58z"
                fill="#475345"
                stroke="#364335"
                strokeWidth="2"
              />
              <path
                d="M298 198h138M360 198v51M315 198l-17 28M416 198l18 26"
                fill="none"
                stroke="#697363"
                strokeWidth="2"
              />
              <circle cx="365" cy="190" r="3" fill="#d2c9ae" />
            </svg>
            <span className="garment-tag shirt-tag">いつもの白シャツ</span>
            <span className="garment-tag pants-tag">お気に入りのパンツ</span>
          </div>
          <div className="recommendation-note">
            <span className="recommendation-icon">
              <Sun size={24} strokeWidth={1.3} />
            </span>
            <div>
              <strong>ちょうどいい、が見つかる。</strong>
              <p>
                新しい服を買わなくても。
                <br />
                持っている服で、心地よい毎日。
              </p>
            </div>
            <Leaf size={21} strokeWidth={1} />
          </div>
        </div>
      </section>
      <section className="benefits">
        <div>
          <span className="step-no">01</span>
          <h2>いつもの服を登録</h2>
          <p>写真を1着ずつ。種類や色はAIがお手伝い。あとから修正もできます。</p>
        </div>
        <div>
          <span className="step-no">02</span>
          <h2>一週間を、ひと足先に</h2>
          <p>出勤日と天気に合わせて準備。決めておきたい日は、自分で固定。</p>
        </div>
        <div>
          <span className="step-no">03</span>
          <h2>朝は「これを着た」だけ</h2>
          <p>着用回数や洗濯もいっしょに管理。次の日の服選びが、もっと楽に。</p>
        </div>
      </section>
      <section className="landing-close">
        <span className="eyebrow">A LITTLE LESS TO THINK ABOUT</span>
        <h2>
          服を選ぶ時間を、
          <br />
          好きなことをする時間に。
        </h2>
        <Link href="/signup" className="button primary">
          クローゼットをはじめる
          <ArrowRight size={18} />
        </Link>
        <p>写真は非公開。あなたのためだけのクローゼットです。</p>
      </section>
    </>
  );
}
