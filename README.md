# フクマカセ — Outfit App MVP

登録済みの服から、仕事に着ていく今日の一組を決める日本語Web/PWA。Next.js App Router（vinext）、Hono Workers、Supabase Auth/PostgreSQL、非公開R2で構成します。

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

Webは `http://127.0.0.1:3000`、Hono APIは `http://127.0.0.1:8787`。Webの `/api` は開発プロキシ経由でAPIへ接続します。R2はWranglerのローカルストレージです。詳しい設定・公開手順は [運用手順](docs/operations.md) を参照してください。

## 検証

```sh
pnpm typecheck
pnpm test
pnpm test:db
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
pnpm build:worker
```

`test:db` はPostgreSQLの `initdb`・`pg_ctl`・`psql` を使い、一時DBへ実マイグレーションを適用して権限・競合・トランザクションを検証します。既存DBを初期化しません。`pnpm test` のみでは接続設定のないDBテストはスキップされます。

ブラウザの認証済みフローテストは、外部Auth/APIをネットワーク境界で置き換える画面テストです。実際のメール・Google OAuth・Cloudflareへの公開を証明するものではありません。GitHub Actionsでも型検査・実PostgreSQL・ブラウザ・ビルドを実行します。

## 構成とSSoT

- `apps/web`：画面、写真圧縮、認証UI。
- `apps/api`：認証済みAPI、非公開画像、AI/天気の接続、定期処理。
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
