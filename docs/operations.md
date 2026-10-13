# 起動・検証・運用手順

この文書は環境の設定手順です。機能仕様の正本は01〜08、API契約は `packages/schemas`、DBの正本はマイグレーションです。実サービスの資格情報がない環境では、ローカル検証と公開前ゲートを区別します。

## ローカル開発

1. Node.js 24とpnpmを用意し、ルートで `pnpm install --frozen-lockfile` を実行します。
2. `apps/web/.env.example` を `.env.local`、`apps/api/.dev.vars.example` を `.dev.vars` にコピーし、Supabaseの検証環境の値を設定します。両方のURL・公開キーは同じプロジェクトを指定します。`service_role` はAPIのみに置きます。
3. Supabase検証DBへマイグレーションを順に適用します。Supabase CLIの `supabase db push` を使用する場合はリンク先が検証環境であることを確認します。`tests/database/bootstrap.sql` はローカルPostgreSQL専用で、本物のSupabaseへ適用しません。
4. Supabase AuthのSite URLとRedirect URLsに `http://127.0.0.1:3000/auth/callback`、パスワード再設定の同URLクエリ付きパスを許可します。Web/APIの `APP_ORIGIN` は同じオリジンにします。Googleログインを使う場合はGoogle OAuthプロバイダも設定します。
5. `pnpm dev` でWeb/APIを起動します。R2はローカルエミュレーションに保存します。Cronを試す際は別途APIを `wrangler dev --test-scheduled` で起動し、開発用scheduledエンドポイントを使います。通常のAPIにはCron実行HTTP管理パスを公開しません。

OpenAI/天気のキーがなくても、ルールベース提案・季節の暫定天気・手動分類を使えます。本人データの保存にはSupabaseの接続が必要です。写真分類は応答後のバックグラウンド処理で試行し、失敗はCronが再試行します。

## テストの証拠を分ける

- `pnpm test`：ドメイン、共有スキーマ、依存先を注入したAPI・外部サービス障害テスト。DB接続があればDBテストも対象。
- `pnpm test:db`：一時PostgreSQLを作成し、実SQLの所有権、RLS、100枠の競合、着用・洗濯訂正、予算、リース、冪等性を検証して停止・削除。`POSTGRES_BIN` でバイナリディレクトリを指定できます。
- `pnpm test:e2e`：リリース前に手動実行する必須ゲート。ChromiumのPC・スマートフォンサイズで公開画面と認証済みUIを検証。Auth/APIの固定応答はテスト内のみ。実メール・実OAuth・実R2の代替ではありません。
- `pnpm build:worker`：Cloudflare Workers形式のビルド（CI対象）。検証にはこのコマンドを使用します。ビルドは公開ではありません。

### CIとリリース前の手動E2E

`CI / verify` はmainへのpushとmain宛てPRで実行します。作業ブランチのpushでは実行しないため、PRの更新で同じ変更にpushとpull_requestの両方が起動することはありません。同じPRの新しいコミットでは古い実行を停止し、mainのpushや別PRの実行は停止しません。固定インストール、PostgreSQLマイグレーション、`pnpm typecheck`、`pnpm test`、`pnpm build:worker` を実行し、通常ビルドとブラウザE2Eは含めません。

リリース担当者は対象コミットを確認して依存関係をインストールし、必要に応じて `pnpm exec playwright install --with-deps chromium` でブラウザを用意してから `pnpm test:e2e` を手動実行します。対象コミット・実行環境・結果をリリース記録に残し、失敗時は `test-results/` の証跡をローカルで確認して修正・再実行します。CIでブラウザ失敗artifactは保存しません。認証情報を含む証跡は公開・コミットしないでください。docs/07のチェックを完了するまで公開せず、CI成功をE2E成功の代わりにしません。

## 検証環境・本番環境

各環境に別Supabaseプロジェクト、R2非公開バケット、WorkersとSecretsを用意します。誤って本番のサービスキーを開発環境へ置かないでください。実際の公開先が確定するまではデプロイを行いません。

Webは `apps/web/wrangler.jsonc`、APIは `apps/api/wrangler.jsonc` が基礎設定です。Web WorkerはService Binding `API` で `fukumakase-api` に接続し、同一オリジンの `/api`・`/api/*` の通信を転送します。`workers.dev` でも同じ経路を使用します。CloudflareダッシュボードでWorker名、環境別バケット名を確認してください。環境別にAPI Worker名を変更する場合はWebのService Bindingの接続先も合わせます。WebのVite開発プロキシは本番接続を代替しません。

初回公開では、非公開R2バケットとSupabaseのマイグレーションを用意し、API Workerの `SUPABASE_URL`・`SUPABASE_ANON_KEY`・`SUPABASE_SERVICE_ROLE_KEY`・`APP_ORIGIN` を設定して、`pnpm --filter @outfit/api deploy` でAPIを先に公開します。`APP_ORIGIN` はWebの本番オリジン（パスを含めない）です。今回のWeb公開先の場合は `https://fukumakase.hajimete-1105.workers.dev` を指定します。Secretsは対話式の `wrangler secret put` 等で設定し、値をコマンド引数やログへ残さないでください。API Workerが存在してからWebをビルド・公開します。これらは公開担当者が実施する手順であり、コード修正やローカルビルドの成功だけで実施済みとは扱いません。

接続確認はWebの本番URLの `/api/me/preferences` に認証なしでGETします。設定済みなら401のJSON、APIの接続設定が不足していれば503のJSONが返ります。200の `text/html` はAPIの通信がWeb画面へ届いている状態です。APIの公開用 `workers.dev` URLが404でも、公開アクセスを無効にしたWorkerはService Bindingで接続できるため、それだけでAPI Workerが存在しないとは判定しません。続いて認証済みの画面・画像・更新の実機確認を行ってください。

CloudflareのWeb Worker名は `fukumakase`、本番ブランチは `main` とします。Build commandは `pnpm build:worker`、Deploy commandは `pnpm --filter @outfit/web exec wrangler deploy --config dist/server/wrangler.json` を設定します。MVPでは自動Preview Buildsを無効にし、mainのみ本番へ自動デプロイします。検証環境は本番と分離し、必要時に手動運用します。

Web公開ビルド時の `NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SUPABASE_ANON_KEY` はクライアントへ埋め込まれる公開値です。秘密鍵を `NEXT_PUBLIC_*` に置かないでください。APIの `.dev.vars` は本番では使用されないため、必要な値をWrangler Secretsで設定します。

APIのCloudflareバインディングは非公開の `CLOTHES_BUCKET`。R2のr2.dev公開アクセスとカスタム公開ドメインは無効にします。画像のPUT/GETは期限付きアップロード予約と認証済みAPIで行い、所有権チェックと `no-store` を通します。公開バケットや永続公開URLは使いません。

Supabaseではメール確認、以下のパスワード要件、Google OAuth、カスタムSMTP、レート制限、許可リダイレクトURLを構成します。メール認証・再設定は実在する検証用アカウントで動作確認し、認証情報は独自DBへ転記しません。

### Supabase Authのパスワード設定

1. 対象の検証／本番プロジェクトを確認し、Supabase DashboardのAuthenticationにあるメール認証・パスワードの設定を開きます。
2. Minimum password lengthを **8** に設定します。
3. Required charactersは **英小文字・英大文字・数字・記号をすべて必須**とする最強プリセット（lowercase / uppercase / digits / symbols）を選び、保存します。大小どちらかの英字だけでよい設定とは異なります。記号の範囲は `08_認証・個人情報最小化設計.md` の32文字と一致させます。[Supabase公式のパスワード設定](https://supabase.com/docs/guides/auth/password-security)
4. 保存後に設定を再表示して確認し、検証環境のテスト専用アカウントで新規登録・再設定を試します。全条件を満たすASCIIの8文字は受理、ASCIIの7文字以下と各文字種を欠く値は拒否されることを、UI経由とAuth APIへの直接リクエストの両方で確認します。Unicodeを含む長さの境界値は、クライアントのコードポイント数による判定とHostedの実動作（UTF-8バイト長で判定される可能性）を別々に検証・記録し、同じ結果を前提にしません。実際のパスワードをログ・検証記録へ残しません。
5. 変更前の弱いパスワードを持つ既存のテスト専用アカウントが引き続きログインできることを確認します。アプリのログイン画面に新しい強度検証は適用しません。漏えいパスワード保護など追加のAuth設定による拒否も別途確認します。
6. Supabase Authの技術上限はUTF-8で72バイトです（半角英数字・記号なら72文字）。Dashboardで別途上限を設定する作業ではありません。他の要件を満たす72バイト／73バイトをASCIIのみ・Unicode混在の両方で試し、UIの共有スキーマとAuth API直接呼び出しで受理／拒否を確認します。Unicodeでは文字数とバイト数を混同しないでください。UIの超過エラーが入力修正で解除され、ログイン画面にはこの上限が追加されていないことも確認します。

この設定は運営者が環境ごとに行う作業です。リポジトリ内の共有スキーマとUIは更新済みでも、**リモートSupabaseへの設定反映・実サービス検証が完了したことを意味しません**。公開前チェックリストで未実施を管理してください。

## 上限・費用・障害

- `UPLOADS_ENABLED=false` は新規画像追加を停止します。既存画像閲覧や洗濯操作は維持します。
- `SIGNUPS_ENABLED=false` は新しいアプリ利用者の受付を停止します。認証メール送信の停止にはSupabase Auth側でも新規登録を無効化します。
- `service_budget` の当月行が未設定、または `ai_enabled=false` の場合、AI呼出しは行いません。管理者がSQLで当月の予算を明示設定し、モデル名と単価をSecretsに設定してから有効化します。費用の見積りは即時請求額の保証ではありません。
- 予算は予約と精算を分離します。障害で不明な予約を返金して再実行すると過剰利用になるため、AIプロバイダの請求状態を確認してから運用者が処置します。
- Cronは10分間隔。ジョブはリース・期限・再試行回数を持ち、失敗はバックオフします。`generation_jobs` の最古のpending、failed、長いleaseと処理件数を監視します。利用者数が増えたら実測からバッチ容量を見直します。
- 天気は取得成功分のキャッシュ、古すぎる場合は季節の暫定値。3日予報契約では4日目以降は暫定表示です。手動固定日は更新せず、必要な警告だけを変えます。
- Supabase DB容量、R2容量、Workers CPU/リクエスト、認証SMTP送信数、OpenAI請求を各管理画面で確認します。一般公開前にアラートと担当者を設定します。月3,000円は設計上の目標で、保証ではありません。

## 退会・復旧

退会受付で即時にアクセスを停止し、画像→サービスDB→Authの順で削除します。公開の削除受付ページはランダムな受付番号に対して粗い処理状態だけを返します。失敗が試行上限に到達した場合は、運用者が原因を解消し、該当する削除ジョブだけを再試行します。Authが消えた状態でも残存データを消せることを検証環境で確認してください。

バックアップの保持日数・復旧手段は契約と設定によって異なります。公開前に利用するSupabaseプランの保持期間、SMTP事業者、OpenAIの保持設定、運営者・問い合わせ窓口を確定し、`/privacy`・`/terms` に反映してください。現時点で未確定の値を架空の数字やメールアドレスで埋めていません。

復旧は検証環境へバックアップを戻して読み取り・RLS・削除済みユーザーの扱いを確認してから実施します。削除申請の記録を突き合わせ、退会済みデータを利用可能な状態で復活させないことを公開前の訓練項目とします。

## 公開判定

元設計07の公開チェックリストを使用します。実CloudflareのSSR/API/画像、実Supabaseメール・OAuth、実Cron、実R2/DB/Auth退会削除、Safari/Chrome、予算・問い合わせ・保持期間が未検証なら、一般公開可能と判定しません。ローカルテスト成功のみでこれらを完了扱いしないでください。
