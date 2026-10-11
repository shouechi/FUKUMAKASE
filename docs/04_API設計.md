# Outfit App — Hono API設計 v1.1
HonoをCloudflare Workers上のAPIとして独立配置。Next.jsとは`https://app.example.jp`→`/api/*`（Workers Routes経由でHonoへ）で同一オリジンにする構成を第一候補とする。開発時はローカル2サーバー。Zod/Hono RPCでリクエスト・レスポンスを型付け。

## 認証と共通仕様
- Supabase AuthのJWTを受け、プロジェクトで採用する署名方式に沿って署名・iss/aud/expを検証する（非対称鍵構成ならJWKSを利用）。ユーザーIDは検証済み`sub`から導出し、リクエストに含まれる`user_id`を信用しない。削除申請済み/アカウント不在のアクセスも拒否する。
- 認証APIは共通ミドルウェア、管理/cron APIは別のサービス認証。`SUPABASE_SERVICE_ROLE_KEY`とOpenAI/R2の資格情報をクライアントへ公開しない。ユーザー向けDB処理は可能なら利用者スコープのRLSを適用し、管理者権限は隔離する。
- 変更系はZod入力チェック、RLS、レート制限、`Idempotency-Key`適用。エラー形式は`{error:{code,message,request_id,details?}}`。HTTP 400/401/403/404/409/422/429/503を統一。
- 時刻はDBではUTC、フロント表示はAsia/Tokyo。日次上限は日本時間の暦日、週次上限は日本時間の月曜0:00開始で固定。

## MVPの主なAPI
| Method | Path | 主目的 | 備考 |
|---|---|---|---|
| GET/PATCH | `/api/me/preferences` | 好み、勤務地域、会社ルール、通知前時刻 | 本人のみ |
| GET/PUT | `/api/me/work-weekdays` | 基本出勤曜日 | 曜日1〜7 |
| GET/PUT/DELETE | `/api/me/day-overrides/:date` | 特別予定・休暇・気分・祝日例外 | YYYY-MM-DD |
| POST | `/api/clothes/upload-url` | R2へアップロードする短期署名URL作成 | 認証、容量・枚数上限 |
| POST | `/api/clothes` | アップロード完了を検証しDB登録・AI分類を開始 | 非同期状態を返す |
| GET | `/api/clothes` | 服一覧 | ページング、状態絞り込み |
| GET/PATCH/DELETE | `/api/clothes/:id` | 確認・分類修正・削除 | 削除で計画再評価 |
| POST | `/api/clothes/:id/washed` | 洗濯完了、回数リセット | 冪等処理 |
| GET | `/api/outfits/today` | 今日の服 | 状態・理由・警告 |
| POST | `/api/outfits/today/regenerate` | 今日の再生成 | 1日3回まで、理由任意 |
| GET | `/api/plans/weekly?week=...` | 週間計画 | 暫定/固定フラグ |
| POST | `/api/plans/weekly/regenerate` | 全体再生成 | 週2回まで |
| PUT | `/api/plans/:date` | その日の服・手動ロック | ユーザー操作優先 |
| POST | `/api/wear-logs` | 『今日これを着た』確定 | 日付一意・冪等 |
| GET/PATCH | `/api/wear-logs/:date` | 履歴確認/訂正 | 洗濯回数も補正 |
| POST | `/api/account/delete` | 退会開始 | 再認証/二重確認、ジョブ進捗 |
| GET | `/api/me/usage` | AI回数と上限 | リセット日時 |

## 管理・定期処理（外部公開しない）
- `scheduled` handler：日本時間で処理対象ユーザーを抽出し、期限内の日次調整・日曜夜の週間作成を進める。認証用HTTP管理エンドポイントは必要最小限。
- Cronはすべてのユーザーに同時処理をかけない。`generation_jobs`をリースで排他取得し、1回に少数件処理。失敗時は指数バックオフ。

## 入出力例
`POST /api/outfits/today/regenerate`
```json
{"reason":"more_casual","idempotency_key":"b3c7e7f4-..."}
```
応答：
```json
{"date":"2026-10-12","outfit_id":"...","mode":"ai","reason_short":"今日は気温が低めなので上着を選びました","items":[{"clothes_id":"...","slot":"top"}],"warnings":[],"daily_regens_remaining":2}
```

## 非同期画像分類
1. ユーザー認証→`upload-url`→ブラウザで最大5MBの元画像をWebPへ圧縮（幅1280px目安、構図維持）→R2へPUT。
2. `POST /clothes`で実物のキー・所有者・MIME・サイズを確認しDBへ`pending`作成。
3. 非同期ジョブでAI分類、AI予算枯渇時は`manual`→手動入力フォーム。分類結果は自動保存し、修正可能。
4. 失敗再試行で服が重複しないようにアップロードIDと作成操作の冪等性を持たせる。


## アカウントデータを増やさないAPI原則（追加）
- `/api/me/preferences`のレスポンスにメール・Googleプロフィール・Authの内部情報を載せない。メールを表示する必要があるときだけSupabase Authの認証済みユーザー情報から取得する。
- サインアップ、Google OAuth、メール確認、パスワード再設定はSupabase Authに委任。独自APIで生パスワードやGoogleのアクセストークンを受けて保管しない。
- クラウドへの画像アップロードは本人の認証後に発行した短時間・対象オブジェクト限定の署名付きURLを使う。署名URLの漏えいを防ぐためURLをログに記録しない。
- `/api/account/delete`は再認証/再確認を伴い、削除対象のジョブはサーバーだけが操作する。途中失敗に備え再試行可能な状態遷移を持つ。アクセス停止は削除完了を待たない。
- `request_id`と短いエラーコードで障害調査できるようにし、APIレスポンスやログにメールアドレス・JWT・画像データを出さない。
