"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  limits,
  type ApiEndpoint,
  type ApiRequest,
  type ApiResponse,
} from "@outfit/schemas";
import { jstDate, weekStart } from "@outfit/domain";
export { jstDate as todayJst, addDays as shiftDate } from "@outfit/domain";
let client: SupabaseClient | undefined;
// A failed network response leaves the mutation uncertain, so retries reuse its key.
const pendingMutations = new Map<string, string>();
export function authClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || url.includes("YOUR_PROJECT")) return null;
  client ??= createClient(url, key, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return client;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const auth = authClient();
  const session = auth ? (await auth.auth.getSession()).data.session : null;
  const publicReceipt = path.startsWith("/api/account/deletion-status/");
  if (!session && !publicReceipt)
    throw new ApiError("UNAUTHENTICATED", "ログインしてください", 401);
  const headers = new Headers(options.headers);
  if (session && !publicReceipt)
    headers.set("Authorization", `Bearer ${session.access_token}`);
  if (options.body && !(options.body instanceof Blob))
    headers.set("Content-Type", "application/json");
  const mutation =
    !!options.method && !["GET", "HEAD"].includes(options.method);
  const fingerprint =
    mutation && typeof options.body !== "object"
      ? `${session?.user.id}:${options.method}:${path}:${options.body ?? ""}`
      : null;
  if (mutation && !headers.has("Idempotency-Key")) {
    const key =
      (fingerprint && pendingMutations.get(fingerprint)) || crypto.randomUUID();
    if (fingerprint) pendingMutations.set(fingerprint, key);
    headers.set("Idempotency-Key", key);
  }
  const response = await fetch(path, {
    ...options,
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (
      fingerprint &&
      response.status < 500 &&
      body?.error?.code !== "OPERATION_IN_PROGRESS"
    )
      pendingMutations.delete(fingerprint);
    throw new ApiError(
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.message ?? "処理に失敗しました。もう一度お試しください。",
      response.status,
    );
  }
  const data = response.status === 204 ? undefined : await response.json();
  if (fingerprint) pendingMutations.delete(fingerprint);
  return data as T;
}
type SegmentNames<S extends string> =
  S extends `${string}/:${infer P}/${infer Rest}`
    ? P | SegmentNames<`/${Rest}`>
    : S extends `${string}/:${infer P}`
      ? P
      : never;
type Params<K extends ApiEndpoint> = [SegmentNames<K>] extends [never]
  ? { params?: never }
  : { params: Record<SegmentNames<K>, string> };
type CallOptions<K extends ApiEndpoint> = Params<K> & {
  query?: Record<string, string | number>;
  headers?: HeadersInit;
} & ([ApiRequest<K>] extends [never]
    ? { body?: never }
    : { body: ApiRequest<K> });
type CallArgs<K extends ApiEndpoint> = [
  ApiRequest<K> | SegmentNames<K>,
] extends [never]
  ? [options?: CallOptions<K>]
  : [options: CallOptions<K>];
/** Callers choose the shared endpoint; request/response types cannot be invented in UI. */
export function api<K extends ApiEndpoint>(
  endpoint: K,
  ...args: CallArgs<K>
): Promise<ApiResponse<K>> {
  const options = args[0];
  const [method, template] = endpoint.split(" ");
  const path = template.replace(/:([a-z_]+)/g, (_, name) =>
    encodeURIComponent(
      (options?.params as Record<string, string> | undefined)?.[name] ?? "",
    ),
  );
  const query = options?.query
    ? `?${new URLSearchParams(Object.entries(options.query).map(([k, v]) => [k, String(v)]))}`
    : "";
  return request<ApiResponse<K>>(path + query, {
    method,
    headers: options?.headers,
    ...(options?.body !== undefined
      ? {
          body:
            options.body instanceof Blob
              ? options.body
              : JSON.stringify(options.body),
        }
      : {}),
  });
}
export async function privateImage(id: string): Promise<string> {
  const session = (await authClient()?.auth.getSession())?.data.session;
  if (!session) throw new Error("ログインしてください");
  const res = await fetch(`/api/clothes/${encodeURIComponent(id)}/image`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error("写真を取得できません");
  return URL.createObjectURL(await res.blob());
}
export async function compressImage(file: File): Promise<Blob> {
  if (file.size > limits.uploadBytes)
    throw new Error("写真は5MB以下で選んでください");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("JPEG・PNG・WebPの写真を選んでください");
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("このブラウザでは写真を変換できません");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const convert = (quality: number) =>
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) =>
            b ? resolve(b) : reject(new Error("写真の変換に失敗しました")),
          "image/webp",
          quality,
        ),
      );
    let blob = await convert(0.82);
    if (blob.size > 250 * 1024) blob = await convert(0.65);
    if (blob.type !== "image/webp")
      throw new Error("WebPに対応したブラウザをご利用ください");
    return blob;
  } finally {
    bitmap.close();
  }
}
export function monday(date = jstDate()) {
  return weekStart(date);
}
export function dateLabel(date: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: limits.timezone,
  }).format(new Date(date + "T00:00:00+09:00"));
}
