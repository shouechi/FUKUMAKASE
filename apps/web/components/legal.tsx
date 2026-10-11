"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { DeletionReceipt, DeletionStatus } from "@outfit/schemas";
import { api, authClient } from "../lib/client";
import { Heading, Notice } from "./ui";
export function Legal({ kind }: { kind: "privacy" | "terms" }) {
  const contact = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
  return (
    <article className="narrow legal">
      <Heading
        eyebrow="FUKUMAKASE"
        title={kind === "privacy" ? "プライバシーポリシー" : "利用規約"}
      />
      {kind === "privacy" ? (
        <>
          <h2>お預かりするデータ</h2>
          <p>
            メールアドレス・パスワード・Googleログイン情報はSupabase
            Authで管理します。アプリ独自のデータベースにこれらを複製せず、UUIDに服の写真、好み、勤務曜日、都道府県単位の地域、提案と着用履歴を関連付けます。氏名・住所・電話番号・生年月日・性別は収集しません。
          </p>
          <h2>外部サービスでの処理</h2>
          <p>
            Supabaseは認証とデータベース、Cloudflareはアプリ配信と非公開の服写真保存に使用します。OpenAIには服の分類に必要な圧縮写真、提案に必要な服の属性のみを送ります。氏名・メール・認証トークンをAIに送りません。写真の位置情報などのメタデータは変換時に除去します。
          </p>
          <p>
            WeatherAPIには都道府県に対応する都市を送り、天気を取得します。認証メールはSupabaseに設定したSMTP事業者を通じて送信します。各サービスの処理地域・保持条件は契約設定により異なります。
          </p>
          <h2>保存と削除</h2>
          <p>
            写真・設定・履歴はサービス提供中に保存します。退会申請の受付後はアプリへのアクセスを停止し、Cloudflare
            R2の写真、アプリDB、Supabase
            Authの順で削除します。失敗した処理は再試行します。
          </p>
          <p>
            バックアップ内のデータは即時削除できない場合があります。本番環境のバックアップ保持日数、SMTP事業者、OpenAIのデータ保持設定は公開前に運営者が確定し、このページへ明記します。未確定の間は一般公開の準備段階です。
          </p>
          <h2>ログと端末内の保存</h2>
          <p>
            操作ログにメール・認証トークン・写真・署名付きURLを記録しません。端末にはログイン維持に必要なセッション情報を保存します。写真や着用履歴の正本はサーバーで保護し、共有端末ではログアウトしてください。
          </p>
          <h2>写真は非公開です</h2>
          <p>
            服の写真は本人認証と所有権確認の後にのみ配信します。初期版には公開共有機能はありません。
          </p>
        </>
      ) : (
        <>
          <h2>サービスについて</h2>
          <p>
            フクマカセは、登録した服から仕事に着ていく一組を提案する、日本国内向けの無料サービスです。アカウントにつき服は100着まで、当日の手動再提案は日本時間で1日3回、週間計画の手動再生成は月曜始まりの週に2回までです。
          </p>
          <h2>提案と利用上の注意</h2>
          <p>
            AI分類や天気予報には誤りが含まれる場合があります。服の分類を確認し、実際の天候・職場ルール・服の状態に合わせてご判断ください。障害や利用上限により、簡易提案への切替や新規登録・画像追加の一時制限を行うことがあります。
          </p>
          <h2>写真とアカウント</h2>
          <p>
            利用する権利のある服の写真のみ登録してください。他人の個人情報や不適切な画像の登録、他の利用者への不正アクセス、サービスを妨害する行為は禁止します。ログイン情報を適切に管理してください。
          </p>
          <h2>退会</h2>
          <p>
            設定の「退会・データの削除」から、ログインの再確認と最終確認を経て申請できます。写真・サービスデータ・認証アカウントを削除します。バックアップの保持条件はプライバシーポリシーに記載します。
          </p>
          <h2>サービスの変更</h2>
          <p>
            運用上の事情により提供内容を変更・停止する場合があります。利用者に影響する変更はサービス内で案内します。
          </p>
        </>
      )}
      <h2>お問い合わせ</h2>
      {contact ? (
        <p>
          <a href={`mailto:${contact}`}>{contact}</a>
        </p>
      ) : (
        <p>
          問い合わせ窓口は公開準備中です。窓口と運営者情報の設定が完了するまで、一般公開は行いません。
        </p>
      )}
      <p>
        <Link href={kind === "privacy" ? "/terms" : "/privacy"}>
          {kind === "privacy" ? "利用規約" : "プライバシーポリシー"}
        </Link>
      </p>
    </article>
  );
}
export function DeleteAccount() {
  const [confirm, setConfirm] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="narrow">
      <Heading eyebrow="ACCOUNT & DATA" title="退会・データの削除" />
      <section className="panel">
        <p>
          登録した服の写真、好み、週間計画、着用履歴とアカウントを削除します。この操作は取り消せません。
        </p>
        <Notice>
          本人確認のため、10分以内にログインしたセッションが必要です。
        </Notice>
        <button
          className="button secondary"
          onClick={async () => {
            await authClient()?.auth.signOut();
            location.assign("/login");
          }}
        >
          ログインし直す
        </button>
        {error && <Notice kind="error">{error}</Notice>}
        <label className="check-row">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          すべてのデータが削除されることを確認しました
        </label>
        <label>
          確認のため「退会する」と入力
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
          />
        </label>
        <button
          className="button danger"
          disabled={busy || !checked || confirm !== "退会する"}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const receipt = await api("POST /api/account/delete", {
                body: { confirmation: "退会する" },
              });
              // The public receipt page remains accessible after logout/Auth deletion.
              location.assign(
                `/account/deletion-status?receipt=${encodeURIComponent(receipt.job_id)}`,
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "削除を受け付けています…" : "退会してデータを削除"}
        </button>
        <p className="subtle">
          バックアップ内の残存期間は
          <Link href="/privacy">プライバシーポリシー</Link>をご確認ください。
        </p>
      </section>
    </div>
  );
}

export function DeletionProgress() {
  const [status, setStatus] = useState<DeletionStatus["status"]>("deleting");
  const [error, setError] = useState("");
  useEffect(() => {
    void authClient()?.auth.signOut({ scope: "local" });
    const receipt = new URLSearchParams(location.search).get("receipt");
    if (!receipt || !/^[0-9a-f-]{36}$/i.test(receipt)) {
      setError(
        "削除受付番号を確認できません。運営窓口にお問い合わせください。",
      );
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api("GET /api/account/deletion-status/:id", {
          params: { id: receipt! },
        });
        if (!live) return;
        setStatus(data.status);
        setError("");
        if (data.status === "deleting") timer = setTimeout(poll, 5000);
      } catch (e) {
        if (live) {
          setError((e as Error).message);
          timer = setTimeout(poll, 15000);
        }
      }
    }
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  return (
    <div className="narrow">
      <Heading
        eyebrow="ACCOUNT & DATA"
        title={
          status === "completed" ? "データを削除しました" : "削除の受付状況"
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      <Notice
        kind={
          status === "completed"
            ? "success"
            : status === "retry_required"
              ? "error"
              : "info"
        }
      >
        {status === "completed"
          ? "写真・サービスデータ・認証情報の削除が完了しました。"
          : status === "retry_required"
            ? "削除処理を完了できませんでした。アクセス停止は維持されています。運営窓口にお問い合わせください。"
            : "削除申請を受け付けました。アクセスを停止し、写真・サービスデータ・認証情報を順に削除しています。"}
      </Notice>
      <p>
        このページで状況を確認できます。バックアップの保持条件は
        <Link href="/privacy">プライバシーポリシー</Link>をご確認ください。
      </p>
      <Link href="/">トップページへ</Link>
    </div>
  );
}
