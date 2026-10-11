"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Camera,
  ArrowRight,
  Check,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  wearLimits,
  limits,
  type ClothesPage,
  type UploadGrant,
  type ClothesPatch,
  type Category,
  type Cloth,
  type Season,
} from "@outfit/schemas";
import { api, compressImage } from "../lib/client";
import {
  categoryLabels,
  seasonLabels,
  ClothCard,
  ClothingImage,
  Empty,
  Heading,
  Loading,
  Notice,
} from "./ui";
export function Closet() {
  const [clothes, setClothes] = useState<Cloth[]>([]);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api("GET /api/clothes")
      .then((r) => setClothes(r.items))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  const visible = clothes.filter(
    (c) =>
      filter === "all" ||
      (filter === "laundry" ? c.state === "laundry" : c.category === filter),
  );
  return (
    <>
      <Heading
        eyebrow="YOUR WARDROBE"
        title="クローゼット"
        action={
          <Link className="button primary" href="/closet/new">
            <Plus size={18} />
            服を追加
          </Link>
        }
      >
        好きな服を、気持ちよく着まわそう。{" "}
        <span className="count">
          {clothes.length} / {limits.clothes}着
        </span>
      </Heading>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="filter-row">
        {[
          ["all", "すべて"],
          ...Object.entries(categoryLabels),
          ["laundry", "洗濯待ち"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={filter === key ? "selected" : ""}
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
          >
            {label}
          </button>
        ))}
      </div>
      {loading ? (
        <Loading />
      ) : visible.length === 0 ? (
        <Empty
          title={
            clothes.length
              ? "この種類の服はありません"
              : "まずは、いつもの2着から。"
          }
        >
          <p>
            トップス1着・ボトムス1着から始められます。
            <br />
            5〜10着あると、着まわしがもっと楽に。
          </p>
          <Link href="/closet/new" className="button primary">
            最初の服を登録
            <ArrowRight size={17} />
          </Link>
        </Empty>
      ) : (
        <div className="closet-grid">
          {visible.map((c) => (
            <Link key={c.id} href={`/closet/${c.id}`} className="card-link">
              <ClothCard
                cloth={c}
                footer={
                  <div className="cloth-status">
                    <span className={`status-dot ${c.state}`} />
                    {c.state === "laundry"
                      ? "洗濯待ち"
                      : `着用 ${c.wears_since_wash} / ${c.wear_limit}回`}
                  </div>
                }
              />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
type Fields = Pick<
  Cloth,
  "category" | "subtype" | "color" | "seasons" | "thickness" | "wear_limit"
>;
const initialFields: Fields = {
  category: "top",
  subtype: "",
  color: "",
  seasons: ["spring", "summer", "autumn", "winter"],
  thickness: null,
  wear_limit: wearLimits.top,
};
function ClothingFields({
  fields,
  setFields,
}: {
  fields: Fields;
  setFields: (f: Fields) => void;
}) {
  return (
    <div className="form-grid">
      <label>
        種類
        <select
          value={fields.category}
          onChange={(e) =>
            setFields({
              ...fields,
              category: e.target.value as Category,
              wear_limit: wearLimits[e.target.value as Category],
            })
          }
        >
          {Object.entries(categoryLabels).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label>
        色
        <input
          required
          maxLength={30}
          value={fields.color}
          onChange={(e) => setFields({ ...fields, color: e.target.value })}
          placeholder="白、ネイビーなど"
        />
      </label>
      <label>
        詳しい種類（任意）
        <input
          maxLength={50}
          value={fields.subtype}
          onChange={(e) => setFields({ ...fields, subtype: e.target.value })}
          placeholder="shirt、knit、denimなど"
        />
      </label>
      <label>
        生地の厚さ（任意）
        <select
          value={fields.thickness ?? ""}
          onChange={(e) =>
            setFields({
              ...fields,
              thickness: (e.target.value || null) as Fields["thickness"],
            })
          }
        >
          <option value="">未設定</option>
          <option value="thin">薄手</option>
          <option value="normal">普通</option>
          <option value="thick">厚手</option>
        </select>
      </label>
      <fieldset className="full-width">
        <legend>着る季節</legend>
        <div className="check-options">
          {Object.entries(seasonLabels).map(([v, l]) => (
            <label key={v} className="check-row">
              <input
                type="checkbox"
                checked={fields.seasons.includes(v as Season)}
                onChange={(e) =>
                  setFields({
                    ...fields,
                    seasons: e.target.checked
                      ? [...fields.seasons, v as Season]
                      : fields.seasons.filter((s) => s !== v),
                  })
                }
              />
              {l}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="full-width">
        洗濯までの着用回数
        <input
          type="number"
          min={1}
          max={100}
          required
          value={fields.wear_limit}
          onChange={(e) =>
            setFields({ ...fields, wear_limit: Number(e.target.value) })
          }
        />
        <small>この回数に達すると、洗濯待ちに切り替わります。</small>
      </label>
    </div>
  );
}
export function NewClothing() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [manual, setManual] = useState(false);
  const [fields, setFields] = useState(initialFields);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Cloth | null>(null);
  const [clothes, setClothes] = useState<Cloth[]>([]);
  const uploadAttempt = useRef<
    | {
        file: File;
        blob?: Blob;
        grant?: UploadGrant;
        metadata: Partial<Fields>;
        reserveKey: string;
        putKey: string;
        createKey: string;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    api("GET /api/clothes")
      .then((r) => setClothes(r.items))
      .catch(() => {});
  }, [created]);
  useEffect(() => {
    if (created?.classification_state !== "pending") return;
    const timer = setInterval(() => {
      api("GET /api/clothes/:id", { params: { id: created.id } })
        .then(setCreated)
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [created?.id, created?.classification_state]);
  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      if (uploadAttempt.current?.file !== file)
        uploadAttempt.current = {
          file,
          metadata: manual ? { ...fields } : {},
          reserveKey: crypto.randomUUID(),
          putKey: crypto.randomUUID(),
          createKey: crypto.randomUUID(),
        };
      const attempt = uploadAttempt.current;
      setStatus("写真を圧縮しています");
      const blob = (attempt.blob ??= await compressImage(file));
      setStatus("写真をアップロードしています");
      const grant = (attempt.grant ??= await api(
        "POST /api/clothes/upload-url",
        {
          body: {},
          headers: { "Idempotency-Key": attempt.reserveKey },
        },
      ));
      await api("PUT /api/uploads/:id", {
        params: { id: grant.upload_id },
        body: blob,
        headers: {
          "Content-Type": "image/webp",
          "Idempotency-Key": attempt.putKey,
        },
      });
      setStatus("服を登録しています");
      const cloth = await api("POST /api/clothes", {
        headers: { "Idempotency-Key": attempt.createKey },
        body: {
          upload_id: grant.upload_id,
          ...attempt.metadata,
        },
      });
      setCreated(cloth);
      uploadAttempt.current = undefined;
      setFile(null);
      setStatus("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const canStart =
    clothes.some((c) => c.category === "top") &&
    clothes.some((c) => c.category === "bottom");
  return (
    <div className="narrow">
      <Heading eyebrow="ADD TO YOUR WARDROBE" title="いつもの服を、ひとつ。">
        1着ずつ、全体が写る写真を選んでください。
      </Heading>
      {error && <Notice kind="error">{error}</Notice>}
      {created && (
        <section className="panel">
          <Notice kind="success">
            服を登録しました。
            {created.classification_state === "pending"
              ? "AIで種類・色・季節を確認しています。"
              : "種類・色・季節を確認できます。"}
          </Notice>
          <Link href={`/closet/${created.id}`}>登録した服を確認・修正</Link>
        </section>
      )}
      <form onSubmit={upload}>
        <label className="upload-area">
          {preview ? (
            <img src={preview} alt="登録する服のプレビュー" />
          ) : (
            <>
              <Camera size={38} strokeWidth={1} />
              <strong>写真を撮る・選ぶ</strong>
              <span>JPEG / PNG / WebP・5MBまで</span>
            </>
          )}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-label="服の写真"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError("");
            }}
          />
        </label>
        <p className="subtle">
          構図はそのまま、位置情報などを除いて圧縮します。写真は非公開で保存します。
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={manual}
            onChange={(e) => setManual(e.target.checked)}
          />
          種類・色・季節を自分で入力する
        </label>
        {manual ? (
          <section className="panel">
            <ClothingFields fields={fields} setFields={setFields} />
          </section>
        ) : (
          <p className="subtle">
            AIが写真から分類して自動保存します。AIを使えない場合も、手動で登録・修正できます。
          </p>
        )}
        <button
          className="button primary full-width"
          disabled={busy || !file || (manual && fields.seasons.length === 0)}
        >
          {busy ? status : "この服を登録"}
          <Plus size={18} />
        </button>
      </form>
      <div className="start-panel">
        <p>トップスとボトムスが揃ったら、まず試してみましょう。</p>
        <button
          className="button secondary"
          disabled={!canStart || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("PATCH /api/me/preferences", {
                body: { onboarding_completed: true },
              });
              await api("GET /api/plans/weekly");
              router.push("/today");
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          この服で、まず試す
          <ArrowRight size={17} />
        </button>
      </div>
    </div>
  );
}
export function ClothingDetail({ id }: { id: string }) {
  const router = useRouter();
  const [cloth, setCloth] = useState<Cloth | null>(null);
  const [fields, setFields] = useState(initialFields);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    api("GET /api/clothes/:id", { params: { id } })
      .then((c) => {
        setCloth(c);
        setFields({
          category: c.category,
          subtype: c.subtype ?? "",
          color: c.color,
          seasons: c.seasons,
          thickness: c.thickness,
          wear_limit: c.wear_limit,
        });
      })
      .catch((e) => setError(e.message));
  }, [id]);
  async function action(
    kind: "update" | "wash" | "delete",
    body: ClothesPatch = {},
  ) {
    setBusy(true);
    setError("");
    try {
      if (kind === "delete") {
        await api("DELETE /api/clothes/:id", { params: { id } });
        router.push("/closet");
        return;
      }
      const c =
        kind === "wash"
          ? await api("POST /api/clothes/:id/washed", {
              params: { id },
              body: {},
            })
          : await api("PATCH /api/clothes/:id", { params: { id }, body });
      setCloth(c);
      setMessage("更新しました");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="narrow">
      <Heading eyebrow="GARMENT DETAILS" title="服の詳細" />
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      {!cloth ? (
        !error && <Loading />
      ) : (
        <>
          <div className="detail-image">
            <ClothingImage cloth={cloth} />
          </div>
          <div className="laundry-bar">
            <span>
              {cloth.state === "laundry"
                ? "洗濯待ち"
                : `洗濯後 ${cloth.wears_since_wash}回着用`}
            </span>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => action("wash")}
            >
              <RotateCcw size={16} />
              洗濯済みにする
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              action("update", fields);
            }}
            className="panel"
          >
            <ClothingFields fields={fields} setFields={setFields} />
            <label className="check-row">
              <input
                type="checkbox"
                checked={cloth.is_available !== false}
                disabled={busy}
                onChange={(e) => {
                  action("update", {
                    is_available: e.target.checked,
                  });
                }}
              />
              提案に使える状態
            </label>
            <button
              className="button primary"
              disabled={busy || fields.seasons.length === 0}
            >
              変更を保存
              <Check size={17} />
            </button>
          </form>
          <section className="delete-panel">
            {deleting ? (
              <>
                <p>
                  この服を削除しますか？写真も削除対象になります。手動固定の日はそのまま残り、注意を表示します。
                </p>
                <div className="actions">
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() => action("delete")}
                  >
                    削除する
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => setDeleting(false)}
                  >
                    キャンセル
                  </button>
                </div>
              </>
            ) : (
              <button
                className="text-button danger-link"
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={16} />
                この服を削除
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
