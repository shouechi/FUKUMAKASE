# 実Auth・PostgRESTのローカル結合テスト

```sh
node tests/integration/run.mjs
```

Dockerとインストール済みのワークスペース依存を使用する。`postgres:16`、`supabase/gotrue:v2.196.0`、`postgrest/postgrest:v14.17` が必要（初回は取得する）。`outfit-review-*` コンテナと専用ネットワークを新規作成し、GoTrue自身のAuthマイグレーションに続いてアプリの実マイグレーションを適用する。終了時はこのfixtureだけを削除する。DBはtmpfsのため終了時に消える。ダウンロードしたイメージは残す。既存の同名projectがあれば開始せず、無関係のコンテナを変更しない。

ホスト公開は `127.0.0.1:54338`（Auth）と `127.0.0.1:54339`（REST）だけ。テスト中のローカルgatewayは `127.0.0.1:54337` を使う。資格情報はすべて公開可能な偽のローカル専用値であり、クラウドの `.env` や秘密鍵を読まない。本番への転用は禁止。

## 検証する境界

Honoアプリの入口をNodeのローカルHTTPサーバーへ接続し、テストから実HTTPで呼ぶ。アプリの `defaultClients` からGoTrueとPostgRESTへの通信も実HTTPで、Authのユーザー表・JWT検証・RLS・RPC・関連テーブル取得は実装を置換しない。画像本体、R2、外部AI、実メール配信、Google OAuth、Cloudflare Worker環境はこの試験の対象外。

- 実パスワードログイン、改ざんJWT・期限切れJWTの拒否。
- 実JWT claimsからのRLS所有権判定、他人データとservice-only RPC/保守表への拒否。
- 初回設定完了だけのPATCH、日別予定の日本語入力と応答構造。
- 手動コーデの関連テーブル取得、着用確定の再送、着用数と洗濯処理。
- 退会中の有効JWT拒否、Auth削除後の未失効JWT拒否、削除receiptの匿名化。

通常の `pnpm test` はこの5件をスキップする。上記runnerで別途実行した結果だけを結合試験の成功として数える。

2026-10-11 16:33 JST: API入口もHTTP化した最終実行で5件すべて成功。対象の3コンテナ・専用network・一時DBの削除を確認した。メールは自動確認設定なので、メール確認・SMTP配信の成功とは扱わない。

バージョンと最小構成は [Supabase公式Docker構成](https://github.com/supabase/supabase/blob/master/docker/docker-compose.yml)、Auth環境変数と自動migrationは [GoTrue公式README](https://github.com/supabase/auth/blob/master/README.md) を参照した。
