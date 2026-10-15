# 起動・検証・運用手順

この文書は環境の設定手順です。機能仕様の正本は01〜08、API契約は `packages/schemas`、DBの正本はマイグレーションです。実サービスの資格情報がない環境では、ローカル検証と公開前ゲートを区別します。

## ローカル開発

1. Node.js 24とpnpmを用意し、ルートで `pnpm install --frozen-lockfile` を実行します。
2. `apps/web/.env.example` を `.env.local`、`apps/api/.dev.vars.example` を `.dev.vars` にコピーし、Supabaseの検証環境の値を設定します。両方のURL・公開キーは同じプロジェクトを指定します。`service_role` はAPIのみに置きます。
3. Supabase検証DBへマイグレーションを順に適用します。Supabase CLIの `supabase db push` を使用する場合はリンク先が検証環境であることを確認します。`tests/database/bootstrap.sql` はローカルPostgreSQL専用で、本物のSupabaseへ適用しません。
4. Supabase AuthのSite URLとRedirect URLsに `http://127.0.0.1:3000/auth/callback`、パスワード再設定の同URLクエリ付きパスを許可します。APIの `APP_ORIGIN` は `http://127.0.0.1:3000` にします。Googleログインを使う場合はGoogle OAuthプロバイダも設定します。
5. `pnpm dev` で従来どおりWeb/APIの2サーバーを起動します。本番は1Workerですが、ローカル開発ではWebのViteプロキシから同じAPI実装へ接続します。R2はローカルエミュレーションに保存します。Cronを試す際は別途 `pnpm --filter @outfit/api exec wrangler dev --test-scheduled` でAPIを起動し、開発用scheduledエンドポイントを使います。通常のAPIにはCron実行HTTP管理パスを公開しません。`apps/api/wrangler.jsonc` はローカル専用で、本番へ単独デプロイしません。

OpenAI/天気のキーがなくても、ルールベース提案・季節の暫定天気・手動分類を使えます。本人データの保存にはSupabaseの接続が必要です。写真分類は応答後のバックグラウンド処理で試行し、失敗はCronが再試行します。

統合WorkerをWranglerでローカル検証する場合のサーバー設定例は `apps/web/.dev.vars.example` です。通常の `pnpm dev` ではAPI側の `.dev.vars` を使います。ブラウザ用公開値は引き続き `apps/web/.env.local` に置き、サーバー専用の値は `.env.local` の `NEXT_PUBLIC_*` に混ぜません。検証するURLに合わせて `APP_ORIGIN` とSupabaseのリダイレクト許可を設定してください。

## テストの証拠を分ける

- `pnpm test`：ドメイン、共有スキーマ、依存先を注入したAPI・外部サービス障害テスト。DB接続があればDBテストも対象。
- `pnpm test:db`：一時PostgreSQLを作成し、実SQLの所有権、RLS、100枠の競合、着用・洗濯訂正、予算、リース、冪等性を検証して停止・削除。`POSTGRES_BIN` でバイナリディレクトリを指定できます。
- `pnpm test:e2e`：リリース前に手動実行する必須ゲート。ChromiumのPC・スマートフォンサイズで公開画面と認証済みUIを検証。Auth/APIの固定応答はテスト内のみ。実メール・実OAuth・実R2の代替ではありません。
- `pnpm build:worker`：Cloudflare Workers形式のビルド（CI対象）。検証にはこのコマンドを使用します。ビルドは公開ではありません。

### CIとリリース前の手動E2E

`CI / verify` はmainへのpushとmain宛てPRで実行します。作業ブランチのpushでは実行しないため、PRの更新で同じ変更にpushとpull_requestの両方が起動することはありません。同じPRの新しいコミットでは古い実行を停止し、mainのpushや別PRの実行は停止しません。固定インストール、PostgreSQLマイグレーション、`pnpm typecheck`、`pnpm test`、`pnpm build:worker` を実行し、通常ビルドとブラウザE2Eは含めません。

リリース担当者は対象コミットを確認して依存関係をインストールし、必要に応じて `pnpm exec playwright install --with-deps chromium` でブラウザを用意してから `pnpm test:e2e` を手動実行します。対象コミット・実行環境・結果をリリース記録に残し、失敗時は `test-results/` の証跡をローカルで確認して修正・再実行します。CIでブラウザ失敗artifactは保存しません。認証情報を含む証跡は公開・コミットしないでください。docs/07のチェックを完了するまで公開せず、CI成功をE2E成功の代わりにしません。

## 検証環境・本番環境

各環境に別Supabaseプロジェクト、R2非公開バケット、1つのWorkerとSecretsを用意します。誤って本番のサービスキーを開発環境へ置かないでください。実際の公開先が確定するまではデプロイを行いません。

本番の基礎設定は `apps/web/wrangler.jsonc` です。Worker `fukumakase` が画面、Hono API、定期処理を実行します。`/api`・`/api/*`・`/health` は既存Honoへ直接渡し、それ以外はvinextへ渡します。静的ファイルがAPIを覆わないよう、これらのパスは `assets.run_worker_first` にも指定します。元のRequestとExecutionContextを渡すため、認証・Origin・本文・クエリ・冪等キー・応答後の処理を保持します。別のAPI WorkerやService Bindingは不要です。`apps/api` は同じAPI実装の正本とローカル開発用で、単独の本番公開は行いません。

初回公開では非公開R2バケットとSupabaseのマイグレーションを用意し、Worker `fukumakase` の「Settings → Variables and Secrets」にサーバー用設定を登録します。最低限必要な設定は次です。

| 名前 | 設定先・内容 |
|---|---|
| `SUPABASE_URL` | 統合Workerの実行時設定。同じプロジェクトの `NEXT_PUBLIC_SUPABASE_URL` と一致させる |
| `SUPABASE_ANON_KEY` | 統合Workerの実行時設定。同じプロジェクトの `NEXT_PUBLIC_SUPABASE_ANON_KEY` と一致させる |
| `SUPABASE_SERVICE_ROLE_KEY` | 統合WorkerのSecret。サーバー専用キー |
| `APP_ORIGIN` | 統合Workerの実行時設定。本番のオリジン（パスを含めない）：`https://fukumakase.hajimete-1105.workers.dev` |

すべてSecretとして登録しても構いません。CLIを使う場合は対話式の `pnpm --filter @outfit/web exec wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config wrangler.jsonc` 等で設定します。値をコマンド引数やログへ残さないでください。OpenAI/天気のキー、AI予約額、受付スイッチも統合Workerに置きます。AIを使うには当月の予算有効化が別途必要です。

写真分類とコーデ提案は共通の `apps/api/src/ai-config.ts` により `gpt-6-luna` / Standardに固定しています。入力$0.10・出力$0.50 / 100万トークン（2026-10-15公式確認）、推論なし、出力上限700トークン、`store: false`、厳格なJSON Schemaを使用します。旧 `AI_MODEL_CLASSIFY` / `AI_MODEL_OUTFIT` / `AI_INPUT_USD_PER_MILLION` / `AI_OUTPUT_USD_PER_MILLION` が環境に残っていても参照しません。これらの旧設定を削除しても構いません。モデルや単価の変更は共通設定のコード変更として検証します。

有料AI用に設定するのは `OPENAI_API_KEY` と正の `AI_REQUEST_RESERVE_USD` です。後者は1リクエスト分のUSD予約額で、既定値はありません。写真のサイズ・出力などを実測し、余裕を持った額を設定してください。両方の開発用設定例は同じAPI実装を使い、空欄のままなら有料APIを呼び出しません。DB予算も別途必要なので、これらの値だけでAIは有効になりません。

手動公開はリポジトリのルートから次の1コマンドでビルド・公開します。

```sh
pnpm --filter @outfit/web run deploy
```

CloudflareのWorker名は `fukumakase`、本番ブランチは `main` とします。Git連携のRoot directoryはリポジトリのルート、Build commandは `pnpm build:worker`、Deploy commandは `pnpm --filter @outfit/web exec wrangler deploy --config dist/server/wrangler.json` を設定します。MVPでは自動Preview Buildsを無効にし、mainのみ本番へ自動デプロイします。検証環境は本番と分離し、必要時に手動運用します。

Web公開ビルド時の `NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SUPABASE_ANON_KEY` はクライアントへ埋め込まれる公開値です。APIの `SUPABASE_URL`・`SUPABASE_ANON_KEY` は別名の実行時設定なので、公開値だけをビルドに設定してもAPI接続は構成されません。秘密鍵を `NEXT_PUBLIC_*` に置かないでください。APIの `.dev.vars` は本番では使用されず、旧API WorkerのSecretsも自動移行されません。

統合Workerの `CLOTHES_BUCKET` は既存の非公開R2バケット `fukumakase-private-clothes` に接続します。写真のコピーやバケット再作成は不要です。R2のr2.dev公開アクセスとカスタム公開ドメインは無効にします。画像のPUT/GETは期限付きアップロード予約と認証済みAPIで行い、所有権チェックと `no-store` を通します。公開バケットや永続公開URLは使いません。

接続確認は本番の `/health` が稼働確認のJSONを返すこと、`/today` が画面HTMLを返すことを確認します。`/api/me/preferences` に認証なしでGETすると、設定済みなら401のJSON、APIの接続設定不足なら503のJSONが返ります。200の `text/html` が返る場合は振分けが正しくないため、公開を完了扱いにしません。続いて認証済みの画面・画像・更新と、統合WorkerのCron実行を実機で確認してください。コード修正やローカルビルドの成功だけで公開確認済みとは扱いません。

### 既存の2Worker構成からの切替

旧 `fukumakase-api` はコード変更だけでは消えません。旧Cronの停止と統合Workerの設定は、本番を変更する公開担当者の作業です。mainへのマージで自動公開が始まるため、次の準備をマージ・手動公開より前に済ませます。

1. 統合先 `fukumakase` に上記のSupabase設定・サーバーSecretsを登録し、既存のR2バケット名を確認します。旧API Workerに設定がある場合も統合先へ再設定します。Secretsをリポジトリやログへコピーしません。
2. Cloudflareで旧 `fukumakase-api` のCron Triggersを停止します。Wrangler管理では旧Workerを対象とした設定の `triggers.crons` を空配列にして反映します。Cronの変更・削除には最大15分の反映時間があるため、反映を待ち、旧処理の完了も確認します。[CloudflareのCron削除・伝播仕様](https://developers.cloudflare.com/workers/configuration/cron-triggers/#remove-a-cron-trigger)
3. 旧WorkerへデプロイするGit連携や外部ジョブがある場合は停止し、旧Cronが再設定されないようにします。このリポジトリのAPIローカル設定を変更しただけでは、既に配備済みの旧Cronは停止しません。
4. mainへマージして自動公開するか、上記のWeb deployコマンドで統合Workerを公開します。`fukumakase` の `*/10 * * * *` だけが稼働する状態を確認します。移行により定期処理の停止時間があるため、朝の締切などを避けて行います。
5. `/health`・APIのJSON・ログイン後の表示・非公開画像・更新・Cronを確認します。統合後はAPI用Workerの運用は不要です。旧 `fukumakase-api` の削除は確認後の別作業とし、コード作業で自動削除しません。旧Workerへ誤って秘密設定を追加しても統合先には反映されません。

戻す場合も、統合WorkerのCronを先に止めて反映・処理完了を確認し、旧構成を復元してから旧Cronを再開します。2つのCronを同時稼働させません。停止・公開・検証の対象と結果をリリース記録へ残してください。

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
- `service_budget` の日本時間当月行が未設定、または `ai_enabled=false` の場合、AI呼出しは行いません。管理者がSQLで当月の予算を明示設定し、APIキーと正のリクエスト予約額を設定してから有効化します。費用は応答の入力・出力トークンと共通のStandard単価による概算です。キャッシュ読込割引・書込料金・長文料金などの個別補正は行わず、即時請求額の保証ではないため、公式料金・請求と突き合わせます。
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
