# フクマカセ — Outfit App MVP

登録済みの服から、仕事に着ていく今日の一組を決める日本語Web/PWA。Next.js App Router（vinext）とHono APIを1つのCloudflare Worker `fukumakase` で動かし、Supabase Auth/PostgreSQL、非公開R2へ接続します。画面・API・定期処理の公開と設定は1つのWorkerにまとめます。

## 起動

Node.js 24、pnpm 11.13以上を使用します。

```sh
pnpm install --frozen-lockfile
cp apps/web/.env.example apps/web/.env.local
cp apps/api/.dev.vars.example apps/api/.dev.vars
```

環境変数に検証用SupabaseのURL・公開キー・サーバー専用サービスキーを設定し、`supabase/migrations/` を適用してください。キー未設定でも公開画面を確認できますが、認証や個人データの操作はできません。サンプルデータで本物の保存を代替するモードはありません。

```sh
pnpm dev
```

ローカル開発ではWebは `http://127.0.0.1:3000`、Hono APIは `http://127.0.0.1:8787` の2サーバーを使います。Webの `/api` は開発プロキシ経由でAPIへ接続します。R2はWranglerのローカルストレージです。本番は同じAPI実装をWorker内で直接呼び出すため、API用WorkerやService Bindingは不要です。詳しい設定・公開手順は [運用手順](docs/operations.md) を参照してください。

写真分類とコーデ提案のAIは `gpt-6-luna` に固定し、モデル・単価・呼び出し設定を `apps/api/src/ai-config.ts` で共有します。有料AIを使うにはサーバー側の `OPENAI_API_KEY`、正の `AI_REQUEST_RESERVE_USD`、DBの当月予算有効化が必要です。未設定時は写真の手動分類・ルールベース提案を利用できます。環境変数によるモデルや単価の指定は不要です。

## 本番への公開

非公開R2とSupabaseを準備し、Worker `fukumakase` にサーバー用のSecretsを設定してから公開します。

```sh
pnpm --filter @outfit/web run deploy
```

`apps/api` は共通のAPI実装とローカル開発用です。APIだけを本番に公開する手順はありません。既存の `fukumakase-api` がある環境は、mainへのマージ・自動公開より前に旧Cronを停止するなど、[統合への切替手順](docs/operations.md#既存の2worker構成からの切替)を実施してください。コードの変更だけでは、旧Workerの停止・削除やSecretsの移行は行われません。

## 検証

```sh
pnpm typecheck
pnpm test
pnpm test:db
pnpm build:worker
```

`test:db` はPostgreSQLの `initdb`・`pg_ctl`・`psql` を使い、一時DBへ実マイグレーションを適用して権限・競合・トランザクションを検証します。既存DBを初期化しません。`pnpm test` のみでは接続設定のないDBテストはスキップされます。

GitHub Actionsの `CI / verify` はmainへのpushとmain宛てPRで、型検査・実PostgreSQLへのマイグレーション・単体/DBテスト・Workersビルドを実行します。作業ブランチのpushでは実行せず、同じPRの新しいコミットは古い実行を停止します。

ブラウザE2EはPR CIに含めず、リリース前に手動で実行し、対象コミットと結果を記録します。

```sh
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

ブラウザの認証済みフローテストは、外部Auth/APIをネットワーク境界で置き換える画面テストです。実際のメール・Google OAuth・Cloudflareへの公開を証明するものではありません。CI成功だけではE2E完了とせず、[リリース前チェックリスト](docs/07_開発計画とテスト.md)を確認してください。

## 構成とSSoT

- `apps/web`：画面、写真圧縮、認証UI、画面/API/Cronをまとめる本番Worker。
- `apps/api`：Web Workerから共有する認証済みAPI、非公開画像、AI/天気の接続、定期処理。単独起動はローカル開発用。
- `packages/schemas`：APIの共通契約・検証・型・列挙値・初期値。
- `packages/domain`：日付、祝日、勤務日、服選定の共通業務ルール。
- `supabase/migrations`：DB構造・RLS・原子的な着用、上限、予算、ジョブ処理。
- `tests`：独立した受け入れテストと敵対的回帰テスト。

[AGENTS.md](AGENTS.md) にエージェントの分担とSSoTの更新ルールを定義しています。[実装設計](docs/implementation-design.md) は元仕様との対応表、[敵対的検証](docs/adversarial-review.md) は指摘と修正状況です。

## 設計書 v1.1

作成日：2026-10-11。質問1〜42の合意仕様を維持し、認証関連データをアプリ独自DBに複製しない設計を追加。

設計書は `docs/` にまとめています。実装・変更時は、まずMVP要件定義を読み、作業対象に関連する設計書を参照してください。

- [01 MVP要件定義](docs/01_MVP要件定義.md)
- [02 画面UX設計](docs/02_画面UX設計.md)
- [03 DB設計](docs/03_DB設計.md)
- [04 API設計](docs/04_API設計.md)
- [05 AI設計](docs/05_AI設計.md)
- [06 インフラ運用設計](docs/06_インフラ運用設計.md)
- [07 開発計画とテスト](docs/07_開発計画とテスト.md)
- [08 認証・個人情報最小化設計](docs/08_認証・個人情報最小化設計.md)

**注意**：Supabase Authに認証を委任しても、運営者としての権限管理・個人データ保護責任は残ります。公開前にCloudflare上のNext.js互換性、RLS、R2非公開アクセス、退会時削除、認証メールの配信を実際に検証してください。
