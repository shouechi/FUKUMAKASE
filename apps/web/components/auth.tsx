"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Mail } from "lucide-react";
import { authClient } from "../lib/client";
import { Notice, Loading } from "./ui";
let callbackExchange:
  { code: string; promise: Promise<{ error: unknown }> } | undefined;
export function AuthScreen({
  mode,
}: {
  mode: "login" | "signup" | "forgot-password" | "reset-password";
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const titles = {
    login: "おかえりなさい",
    signup: "朝に、小さな余白を。",
    "forgot-password": "パスワードの再設定",
    "reset-password": "新しいパスワード",
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    const client = authClient();
    if (!client) {
      setError(
        "ただいまサービスの準備中です。しばらくしてからお試しください。",
      );
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "login") {
        const { error } = await client.auth.signInWithPassword({
          email,
          password,
        });
        if (error)
          throw new Error(
            "ログインできませんでした。入力内容やメールの確認状況をご確認ください。",
          );
        router.push("/today");
      }
      if (mode === "signup") {
        const { error, data } = await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: location.origin + "/auth/callback" },
        });
        if (error)
          throw new Error(
            "登録を受け付けられませんでした。時間をおいて再試行するか、Googleで続けてください。",
          );
        if (data.session) router.push("/onboarding");
        else
          setMessage(
            "メールが届いた場合は、本文のリンクから登録を完了してください。",
          );
      }
      if (mode === "forgot-password") {
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin + "/auth/callback?next=/reset-password",
        });
        if (error)
          throw new Error("送信できませんでした。時間をおいてお試しください。");
        setMessage("該当するアカウントがある場合、再設定メールを送信します。");
      }
      if (mode === "reset-password") {
        const { error } = await client.auth.updateUser({ password });
        if (error)
          throw new Error(
            "再設定できませんでした。メールのリンクからもう一度お試しください。",
          );
        setMessage("パスワードを更新しました。");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  async function google() {
    const client = authClient();
    if (!client) {
      setError("ただいまサービスの準備中です。");
      return;
    }
    setBusy(true);
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: location.origin + "/auth/callback",
        scopes: "openid email",
      },
    });
    if (error) {
      setError("Googleログインを開始できませんでした");
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <div className="auth-story">
        <span className="eyebrow">LESS CHOOSING. MORE LIVING.</span>
        <h1>
          明日のわたしに、
          <br />
          ちょうどいい一組。
        </h1>
        <p>
          好きな服を登録するだけ。
          <br />
          朝の「何を着よう」を、フクマカセに。
        </p>
        <div className="thread-art" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
      <section className="auth-card">
        <span className="eyebrow">FUKUMAKASE</span>
        <h2>{titles[mode]}</h2>
        <p>服選びのための、あなた専用のクローゼット。</p>
        {error && <Notice kind="error">{error}</Notice>}
        {message && <Notice kind="success">{message}</Notice>}
        <form onSubmit={submit}>
          {mode !== "reset-password" && (
            <label>
              メールアドレス
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}
          {mode !== "forgot-password" && (
            <label>
              パスワード
              <input
                type="password"
                required
                minLength={mode === "login" ? 1 : 12}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {mode !== "login" && <small>12文字以上で入力してください</small>}
            </label>
          )}
          <button className="button primary" disabled={busy}>
            {busy
              ? "処理しています…"
              : mode === "login"
                ? "ログイン"
                : mode === "signup"
                  ? "無料で登録"
                  : mode === "forgot-password"
                    ? "再設定メールを送る"
                    : "パスワードを更新"}
            <ArrowRight size={17} />
          </button>
        </form>
        {["login", "signup"].includes(mode) && (
          <>
            <div className="divider">または</div>
            <button
              className="button secondary"
              onClick={google}
              disabled={busy}
            >
              <span className="google-mark">G</span>Googleで続ける
            </button>
          </>
        )}
        <div className="auth-links">
          {mode === "login" ? (
            <>
              <Link href="/forgot-password">パスワードを忘れた方</Link>
              <Link href="/signup">アカウントを作成</Link>
            </>
          ) : (
            <Link href="/login">ログインに戻る</Link>
          )}
        </div>
        <small className="legal-note">
          登録により<Link href="/terms">利用規約</Link>と
          <Link href="/privacy">プライバシーポリシー</Link>
          をご確認ください。氏名・住所・電話番号の登録は不要です。
        </small>
      </section>
    </div>
  );
}
export function AuthCallback() {
  const router = useRouter();
  const [error, setError] = useState("");
  useEffect(() => {
    const client = authClient();
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    if (!client || !code) {
      setError(
        "認証リンクを確認できませんでした。ログインからやり直してください。",
      );
      return;
    }
    let live = true;
    if (callbackExchange?.code !== code)
      callbackExchange = {
        code,
        promise: client.auth.exchangeCodeForSession(code),
      };
    callbackExchange.promise
      .then(({ error }) => {
        if (!live) return;
        if (error) {
          setError(
            "認証リンクの有効期限が切れたか、使用済みです。再度お試しください。",
          );
          return;
        }
        const next = params.get("next");
        router.replace(next === "/reset-password" ? next : "/today");
      })
      .catch(() => {
        if (live)
          setError("認証を完了できませんでした。もう一度お試しください。");
      });
    return () => {
      live = false;
    };
  }, [router]);
  return (
    <div className="narrow">
      {error ? (
        <>
          <Notice kind="error">{error}</Notice>
          <Link href="/login">ログインに戻る</Link>
        </>
      ) : (
        <Loading />
      )}
    </div>
  );
}
