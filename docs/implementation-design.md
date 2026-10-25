# 実装設計・要件対応 v0.1

設計担当は `docs/01`〜`08` を独立して読み、DB契約をAPI担当へ渡す。実装担当とテスト担当を分離し、最後に敵対的検証を行う。要件変更は利用者の明示指示に従って正本 `docs/01`〜`08` から更新する。この文書は実装判断・未検証ゲートを記録するもので、要件を暗黙に上書きしたりチェックなしで公開可能とみなしたりしない。

## SSoT（各情報の唯一の正本）

| 情報 | 正本 | 他の層の扱い |
|---|---|---|
| プロダクト要件・v0.1/v0.2範囲・受入条件 | 元の `docs/01`〜`08` | この文書は実装への対応表。元の要件を上書きしない |
| API入力・enum・共有型・初期値 | `packages/schemas/src/index.ts` | Web/APIはここからimportし、別の型や初期値を複製しない |
| 日時/JST・祝日・服の適否・推薦ルール | `packages/domain/src/index.ts` | Web/API/ジョブから同じ純粋関数を呼ぶ |
| 同時実行・上限・着用/洗濯計数・所有権・RLS | `supabase/migrations/` | ブラウザやAPIの事前チェックは補助。最終判断はDBトランザクション |
| 認証情報と本人ID | Supabase Auth | アプリの認証情報コピーを作らない |
| 服・好み・履歴・週間計画 | Supabase PostgreSQL | ブラウザの状態は表示用。別の永続データ源にしない |
| 服画像の本体 | 非公開R2 | DBは所有者付きオブジェクトキーのみ |

SQLのCHECKや確定時検証は、APIを迂回した書込みに備えて共有enum・会社NG・上限の一部を再検証する。これは別の業務仕様ではなく、多層防御に必要な制約の複製である。SQL/共有スキーマ/ドメインの許可値・初期値・会社NGの差分は独立テストで検出する。境界を変更するときは正本を先に直し、対応するSQL制約と整合性テストを同時に更新する。

## 境界と正本

ブラウザは Next.js の日本語モバイルUI、Hono APIは認証・入力検証・R2所有者確認・AI/天気/ジョブを担当する。Supabase Auth が認証情報の唯一の正本。DBには UUID とサービスデータのみを持つ。R2は非公開で、API経由の所有者確認を省略しない。

2026-10-13の利用者指定に基づき、正本04/06を1Worker構成へ変更した。本番は `fukumakase` の入口で `/api`・`/api/*`・`/health` を既存Honoへ直接渡し、他のパスをvinextへ渡す。Service BindingもAPI専用の本番Workerも使わない。`apps/api` の既存実装を共有し、元のRequestとExecutionContextを保持する。統合Workerの `scheduled` は既存スケジューラへ委譲し、Cron・R2・サーバーSecretsを同じWorkerに設定する。開発時のみ従来の2サーバーとViteプロキシを使い、APIの単独Wrangler設定はローカル専用とする。

旧 `fukumakase-api` の停止・削除やSecretsの移行はコードでは自動実行しない。旧Cron停止・伝播待ち・統合先Secrets設定をmainへのマージより前に行い、統合Worker公開後は1つのCronだけを稼働させる。具体的な切替・戻し手順は `operations.md` が正本。

2026-10-15の利用者指定に基づき、正本05を固定モデル方針へ変更した。写真分類とコーデ提案は共通の `apps/api/src/ai-config.ts` により `gpt-6-luna`、Standard（`service_tier: "default"`）、推論なし、出力700トークン、`store: false`、厳格なJSON Schemaを使用する。旧モデル・単価の環境変数は参照せず、高額モデルへの自動切替は行わない。単価は同日確認した入力$0.10・出力$0.50 / 100万トークンに固定し、変更時は共通設定と検証を更新する。費用精算は入力・出力トークンによる概算で、キャッシュ読込割引・書込料金・長文料金などを個別補正しないため、請求との突合が必要である。`OPENAI_API_KEY` と正の `AI_REQUEST_RESERVE_USD` に加え、DBの当月予算明示有効化を必要とし、キー・予約額に既定値を設けない。

APIレスポンスの実行時検証も `packages/schemas` に置き、Webは共有契約に沿ってJSONを検証する。HTML・壊れたJSON・空本文・契約に違反する応答は固定の日本語エラーに変換し、生の本文や解析例外を表示しない。通信断や結果の不明な応答では更新の冪等キーを保持し、利用者の再試行時も同じ操作として扱う。更新の自動再送は行わない。Todayのデータ取得には再試行を用意し、正常な `null` 応答と読み込み中を区別する。

DBは利用者への直接の変更権限を付与しない。ユーザー所有テーブルのSELECTには `auth.uid() = user_id AND is_active_user(user_id)` のRLSを適用する。Honoは有効なセッションとアカウント存在・削除状態を確かめた上で、認証済みUUIDを使い、所有者を指定したサービス権限の操作を行う。サービス権限はRLSを迂回できるため、APIの検証とDBの複合所有者外部キーの両方が必要。これは設計書の「可能ならユーザースコープのRLS」という条件に対し、トランザクションの不変条件を優先した選択である。

## DBの不変条件

- `outfit_items` と `wear_log_items` には所有者列を追加し、親行と服の両方に `(user_id,id)` 複合外部キーを持たせる。他人の服を自分のコーデや履歴へ混入できない。服の所有者・ID・画像キーは更新トリガーでも固定する。
- 服とアップロード予約を合わせて100枠まで。利用者の `profiles` 行をロックして並行処理を直列化する。アップロード予約は10分で失効し、登録後は消費済みになる。服の挿入・削除取消にも100着トリガーが働く。同じリクエストキーのリトライは既存の結果を返す。
- 削除UndoはDB時刻から30秒間。`deletion_token`で世代を区別し、`undo_until`未満かつ`image_purge_started_at`未設定の場合だけ復元する。削除と復元の業務receipt・計画再評価・分類再開も同じDBトランザクションで確定する。共有期間定数は`packages/schemas`に置き、SQLの期限設定との一致を独立テストで確認する。
- 削除後は登録枠を空け、復元時に有効な服＋有効な未使用アップロード予約が100未満であることをDBで検証する。上限なら429を返し、画面は期限内の再試行を残す。業務receiptも復元の入力世代を照合し、同じキーに別の世代を指定した再送を拒否する。
- 計画は服の着用回数を変更しない。着用確定のみが固定スナップショットと回数を同一トランザクションで記録する。日付一意制約が二重クリックを防ぐ。訂正は差分の追加・削除と監査イベントを原子的に記録する。洗濯後に過去の履歴を訂正しても、洗濯前の回数を復活させない。
- AI・自動保存は `manual_lock` または確定済み計画の構成を変えない。警告の更新のみ許す。DBでも存在・所有者・利用可否・NGカテゴリ・最低限の会社ルールを検証し、より詳細な季節・会社ルール・予測洗濯回数はドメイン層で判断する。
- 手動再生成枠はAIが使えなくても消費する。日付はJSTの暦日、週はJST月曜を基準とし、対象計画の日付を変えて枠を回避できない。リトライキーの再使用では消費を増やさない。
- 全体AI予算は月次行をロックし、見積予約額＋既使用額で可否を決める。未設定月・停止時・全体同時4件到達時はAIを実行せずルール提案へ移る。予約の再使用は追加の外部実行を許可しない。実費精算では予約した月へ計上する。実際の料金が見積りを超える可能性は設計書通り残るため、運用で料金表・トークン上限・請求との突合を行う。
- ジョブは `FOR UPDATE SKIP LOCKED` で取得し、5分のリースとランダムな `lease_token` を発行する。計画保存・分類結果反映・完了・失敗は同じリーストークンを必要とする。DB保存時にもリース行をロックして検証するため、期限切れワーカーが新しい実行結果を上書きできない。指数バックオフ、最大8試行で停止。
- 退会開始は即時に `deleting_at` を設定し、RLSとAPIの両方を遮断する。削除ジョブはR2全キーの削除と検証→サービス行削除→Auth削除の順に進む。Auth削除の失敗に備えて削除ジョブにAuth FKを置かない。その代わり、通常ジョブの挿入時・本文更新時にactiveなprofile行をロックするトリガーを置き、処理中のAPIが退会完了後に個人データ付きジョブを再作成する競合を防ぐ。最終成功はジョブのUUID・キー・payload消去と同一トランザクションで記録する。

## APIから呼ぶ契約

すべて `public` スキーマ。`p_user_id` は検証済みセッションからAPIが設定する。RPC実行権限は `service_role` のみ（RLS補助の `is_active_user` を除く）。JSON列名はsnake_case。

| RPC | 引数・結果 | 責務 |
|---|---|---|
| `ensure_profile` | `p_user_id` → profile | Authの存在をFKで確認、初期設定・平日勤務を作成 |
| `reserve_upload` | `p_user_id,p_request_key` → grant | `id,image_key,expires_at`、100枠の予約 |
| `create_clothes` | `p_user_id,p_request_key,p_data` → clothes | 有効な所有者の画像予約を消費し冪等登録 |
| `delete_clothes` | `p_user_id,p_clothes_id,p_request_key` → `{ok,clothes_id,category,color,deletion_token,undo_until,server_now}` | 論理削除、30秒の期限、世代と業務receipt、期限後の画像削除と再評価の登録 |
| `restore_clothes` | `p_user_id,p_clothes_id,p_request_key,p_deletion_token` → clothes | 所有権・世代・期限・100枠検証、服の復元と分類/再評価再開 |
| `list_clothes_deletions` | `p_user_id` → `{items,server_now}` | 本人の現在Undo可能な削除受付を取得 |
| `claim_clothes_image_purge` | `p_job_id,p_lease_token` → `{image_key}`またはnull | 有効な画像削除ジョブの所有者・世代・期限を検証し、復元不能な削除開始を確定 |
| `save_plan` | `p_user_id,p_target_date,p_data,p_manual=false,p_job_id=null,p_lease_token=null` → plan＋outfit＋items | 自動上書き保護、服検証、スナップショット作成、ジョブ保存のリース検証 |
| `complete_classification` | `p_user_id,p_clothes_id,p_data,p_job_id,p_lease_token` → clothes | pending服だけ分類し、途中の利用者編集を保護 |
| `claim_operation` | `p_user_id,p_operation,p_request_key,p_hash` → `{state,response?,status?}` | HTTP変更操作の本文ハッシュ一致・並行リトライ排他 |
| `finish_operation` | 上記＋`p_status,p_response` → void | 成功応答の保存・同キー再送への再利用 |
| `abort_operation` | claimと同じ → void | 失敗した処理中受付を解除 |
| `confirm_wear` | `p_user_id,p_target_date,p_outfit_id,p_request_key` → wear_log | 日付一意、着用数更新 |
| `correct_wear` | 上記と同じ → wear_log | 差分補正・監査・再試行保護 |
| `wash_clothes` | `p_user_id,p_clothes_id,p_request_key` → clothes | 回数初期化・監査・再試行保護 |
| `consume_quota` | `p_user_id,p_action,p_request_key` → `{allowed,remaining,period_start,replayed?}` | JST日次3回・週次2回 |
| `check_rate_limit` | `p_user_id,p_bucket,p_limit,p_window_seconds` → boolean | DBに永続する短時間上限 |
| `reserve_ai` | `p_user_id,p_action,p_estimate,p_request_key` → UUIDまたはnull | 月予算・同時実行枠の予約 |
| `settle_ai` | `p_usage_id,p_actual,p_success` → void | 費用精算、二重精算防止 |
| `lease_jobs` | `p_limit=10` → jobs[] | 最大25件、期限切れ再取得 |
| `lease_job` | `p_id` → jobまたはnull | 画像登録直後の対象ジョブ取得、Cronと同じ排他条件 |
| `finish_job` | `p_id,p_lease_token,p_success,p_error_code=null` → boolean | リースを検証し完了／再試行 |
| `finish_deletion` | `p_id,p_lease_token` → boolean | 退会完了とジョブのUUID/本文/キー匿名化を原子的に実行 |
| `begin_deletion` | `p_user_id` → job | 即時アクセス遮断・削除要求の重複排除 |

`save_plan.p_data` は `{source,reason_short,context_snapshot,validation_state,items:[{clothes_id,slot}],plan_status,warnings}`。履歴訂正用に新規コーデを作る場合、確定済み日の `save_plan` は保護されるため、APIで所有者付きの新しいoutfit/itemスナップショットを作成して `correct_wear` に渡す。履歴のoutfit/item自体を書き換えない。

朝のジョブは30分先行して投入し、退会・日次期限を優先して取得する。1回のCronは同時5件のバッチを最大200件・8分まで続ける。これは少数利用者でも5件/10分に制限される初期実装の欠陥を解消するための有限の処理枠であり、任意の人数で指定時刻を保証するものではない。待ち行列の遅延を監視し、規模に応じた増強と負荷試験を公開後も継続する。

R2とDBに分散トランザクションはない。PUT直後の利用者確認が失敗した場合は画像を補償削除し、プロセス停止で補償処理自体が動かない場合に備えてCronが画像を100件ずつ走査する。service-only・RLS有効の `maintenance_state(key,cursor,updated_at)` に進捗を持ち、利用者不在/退会中の画像と、1時間以上経過し服・有効予約に参照されない画像を回収する。DBが不明なときは削除しない。退会の完了receiptと遅延したPUTの間に原子的なバリアがあるわけではなく、孤児は後続の走査周期で最終的に除去する。実R2で停止・遅延を注入した検証は公開前ゲートに含む。

服の画像削除では、先に`claim_clothes_image_purge`がprofile・服・ジョブをロックして削除開始を確定する。R2削除はその後に実行し、不在確認まで再試行する。復元が先なら旧世代ジョブは何も削除せず、削除開始が先なら復元を拒否する。孤児清掃は`image_purge_started_at`未設定の削除服も参照中とみなし、期限切れとR2削除の間に復元との競合を作らない。削除世代・期限のない導入前の削除行は復元対象外とし、旧形式ジョブもDBで現在の所有権・削除状態を確認してから回収する。旧Workerとの混在を防ぐ切替条件は正本06に記載する。

## 元設計との対応・必要な証拠

| 元要件 | 実装箇所／検証すべき証拠 |
|---|---|
| メール・Google・確認・再設定 | Web Authフロー＋Supabase Auth実メール/OAuth検証。DBに認証情報列なし |
| 3段階初期設定・上1下1から開始 | Onboarding画面とドメイン最低構成テスト |
| 勤務曜日・祝日・例外・気分・特別予定 | 設定／週編集、祝日計算と例外優先テスト |
| 写真1着・圧縮・構図保持・EXIF削除 | ブラウザ変換、WebP実体検査、非公開R2統合検証 |
| AI分類・自動保存・手修正 | classifyジョブ、構造化出力検証、AI停止時の手動導線 |
| 100着・並行・リトライ | SQL予約/登録RPC＋別接続の競合テスト |
| 誤削除のUndo | DB期限・削除世代・冪等receipt、復元/画像削除/登録/退会の競合と権限テスト、孤児清掃保護、画面の更新後復元・残秒・失敗時再試行。実R2の保持と削除は公開前に別途検証 |
| 私服勤務NG・利用不可・未知ID拒否 | ドメイン単体、API入力、DB confirm検証 |
| 今日1コーデ・理由1行・不足表示 | Today画面、2着・未登録靴・アウターの統合テスト |
| 初週・日曜翌週・朝指定時刻 | scheduler日時境界・リース・dedupeテスト、Workers実Cron検証 |
| 日次3回・週次2回・月またぎ | quota RPCとJST日付/週開始テスト |
| 手動固定・確定保護・影響日だけ更新 | save_plan保護＋API再評価対象テスト |
| 週間予測着用・重複抑制 | ドメイン生成テスト、少数服で制限優先を確認。AIにも候補IDに限定した予定着用回数・直前の予定構成を渡し、実績とは区別して順位づけへ反映 |
| 確定・洗濯・訂正・好み学習 | wear/laundry RPC、履歴スナップショット、最近の実績を推薦スコアへ反映。AIには候補IDの重複なしの最近着用一覧と候補subtype別の実績学習回数を渡す |
| AI停止・予算・構造化出力 | 予約・精算並行テスト、AI無効→ルール選択の統合テスト |
| 天気障害・キャッシュ鮮度・季節暫定 | 天気アダプタと表示・障害テスト |
| RLS・他人画像/API拒否・偽造ID | 実authenticatedロールのSQL、API IDOR、R2所有者検証 |
| 退会再確認・即時拒否・順次削除・再試行 | UI確認、DBフラグ、削除ジョブ段階故障テスト＋実Auth/R2削除 |
| アクセシビリティ・PWA・モバイル | キーボード・ラベル・44px・Safari/Chrome、manifestと画面検証 |
| 公開文書・監視・無料枠制限 | 利用規約/プライバシー、連絡先/保持期間の確定、予算/画像追加停止設定 |
| v0.2通知・欲しい服・SNS画像共有 | v0.1には含めない。初回画像は常に非公開 |

## 公開前の外部ゲート

資格情報なしで可能な実サービス境界の検証として、`node tests/integration/run.mjs` が隔離したローカルGoTrue/PostgREST/PostgreSQLへ実マイグレーションを適用する。2026-10-11の5件成功はJWT検証・RLS・実HTTP RPC/関連取得・Auth削除後拒否の証拠であり、実SMTP・Google OAuth・Cloudflare/R2配備の代替ではない。

ローカルテストは実アカウントでのCloudflare/Supabase/R2/SMTP検証を代替しない。次の証拠が揃うまで公開準備完了とはしない。

1. stagingの1つのCloudflare WorkerへWeb/API/scheduledを配置し、SSR・同一オリジン・OAuth callback・R2アップロード/閲覧を通す。Service Bindingが不要であることとCronが1つだけ稼働することを確認する。vinextを第一候補とする設計に対し、使用アダプタと互換性結果を記録する。
2. Supabase AuthのGoogle OAuthと独自SMTPを構成して第三者メールで確認・再設定を検証する。認証のURL許可・パスワード・登録上限を確認する。
3. 非公開R2を外部から取得できないこと、他人キーへのAPIアクセス拒否、削除後JWT拒否、DB/R2/Auth削除再試行をstagingで確認する。
4. 朝の指定時刻と日曜生成を実Cronで確認する。API応答より長い処理は後続ジョブへ分割し、リース時間を超える外部リクエストにはタイムアウトを設定する。
5. AIモデルの画像分類を20〜50サンプルで測定し、モデル単価と見積りを照合する。月予算行を運用者が明示的に有効化する。古い予約の回収は外部請求状態を確認してから行い、盲目的な返金で過剰実行を許さない。
6. 連絡先・第三者保持条件・バックアップ残存期間・復旧手順・実コストを運用者が確定し、利用規約とプライバシー告知を公開する。Safari/Chromeで実機確認する。

費用目標3,000円は保証ではない。秘密情報が未提供ならクラウドへの公開は行わず、ローカルで検証可能な実装と外部ゲートを区別して報告する。
