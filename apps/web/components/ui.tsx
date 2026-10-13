"use client";
import { useEffect, useState, type ReactNode } from "react";
import {
  Shirt,
  Footprints,
  Layers,
  AlertCircle,
  Check,
  LoaderCircle,
} from "lucide-react";
import type { Category, Cloth } from "@outfit/schemas";
import { privateImage } from "../lib/client";
export const categoryLabels: Record<Category, string> = {
  top: "トップス",
  bottom: "ボトムス",
  shoes: "靴",
  outerwear: "アウター",
};
export const seasonLabels = {
  spring: "春",
  summer: "夏",
  autumn: "秋",
  winter: "冬",
};
export function Notice({
  children,
  kind = "info",
}: {
  children: ReactNode;
  kind?: "info" | "error" | "success";
}) {
  return (
    <div
      className={`notice ${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {kind === "success" ? <Check size={18} /> : <AlertCircle size={18} />}
      <span>{children}</span>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" />
      読み込み中です
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <Shirt size={32} strokeWidth={1} />
      <h2>{title}</h2>
      <div>{children}</div>
    </div>
  );
}
export function Heading({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}
export function ClothingImage({ cloth }: { cloth: Cloth }) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let url = "";
    setSrc("");
    setFailed(false);
    privateImage(cloth.id)
      .then((value) => {
        url = value;
        if (live) setSrc(value);
        else URL.revokeObjectURL(value);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [cloth.id]);
  const Icon =
    cloth.category === "shoes"
      ? Footprints
      : cloth.category === "outerwear"
        ? Layers
        : Shirt;
  return (
    <div className={`clothing-image category-${cloth.category}`}>
      {src ? (
        <img
          src={src}
          alt={`${cloth.color}の${categoryLabels[cloth.category]}`}
          loading="lazy"
          onError={() => {
            setSrc("");
            setFailed(true);
          }}
        />
      ) : (
        <div className="image-placeholder">
          <Icon size={54} strokeWidth={0.8} />
          {failed && <small>写真を読み込めません</small>}
        </div>
      )}
    </div>
  );
}
export function ClothCard({
  cloth,
  footer,
}: {
  cloth: Cloth;
  footer?: ReactNode;
}) {
  return (
    <article className="cloth-card">
      <ClothingImage cloth={cloth} />
      <div className="cloth-caption">
        <span className="eyebrow">{categoryLabels[cloth.category]}</span>
        <h3>
          {cloth.color} {cloth.subtype || categoryLabels[cloth.category]}
        </h3>
        {cloth.classification_state === "pending" && (
          <span className="tag">AIで分類中</span>
        )}
        {(cloth.classification_state === "review" ||
          (cloth.classification_state === "manual" &&
            (!cloth.seasons.length || cloth.color === "unknown"))) && (
          <span className="tag">分類を確認してください</span>
        )}
        {footer}
      </div>
    </article>
  );
}
