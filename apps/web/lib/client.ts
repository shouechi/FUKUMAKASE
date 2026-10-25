"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  limits,
  apiResponseSchemas,
  apiErrorResponseSchema,
  type ApiEndpoint,
  type ApiRequest,
  type ApiResponse,
} from "@outfit/schemas";
import { jstDate, weekStart } from "@outfit/domain";
export { jstDate as todayJst, addDays as shiftDate } from "@outfit/domain";
let client: SupabaseClient | undefined;
// A failed network response leaves the mutation uncertain, so retries reuse its key.
const pendingMutations = new Map<string, string>();
function mutationFingerprint(
  userId: string | undefined,
  method: string,
  path: string,
  body: string = "",
) {
  return `${userId}:${method}:${path}:${body}`;
}
/** Call only after the authenticated deletions list confirms this deletion. */
export async function acknowledgeClothesDeletion(id: string): Promise<void> {
  const auth = authClient();
  const session = auth ? (await auth.auth.getSession()).data.session : null;
  if (!session) return;
  pendingMutations.delete(
    mutationFingerprint(
      session.user.id,
      "DELETE",
      `/api/clothes/${encodeURIComponent(id)}`,
    ),
  );
}
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
const invalidResponseMessage =
  "データを読み取れませんでした。少し待って、もう一度お試しください。";
const networkErrorMessage =
  "通信に失敗しました。接続を確認して、もう一度お試しください。";
const supportedImageMediaTypes = ["image/jpeg", "image/png", "image/webp"];
function invalidResponse(status: number): ApiError {
  return new ApiError("INVALID_RESPONSE", invalidResponseMessage, status);
}
async function authorizedHeaders(path: string, options: RequestInit) {
  const auth = authClient();
  const session = auth ? (await auth.auth.getSession()).data.session : null;
  const publicReceipt = path.startsWith("/api/account/deletion-status/");
  if (!session && !publicReceipt)
    throw new ApiError("UNAUTHENTICATED", "ログインしてください", 401);
  const headers = new Headers(options.headers);
  if (session && !publicReceipt)
    headers.set("Authorization", `Bearer ${session.access_token}`);
  return { headers, userId: session?.user.id };
}
async function fetchResponse(
  path: string,
  options: RequestInit,
): Promise<Response> {
  try {
    return await fetch(path, { ...options, cache: "no-store" });
  } catch {
    throw new ApiError("NETWORK_ERROR", networkErrorMessage, 0);
  }
}
async function readBody<T>(
  response: Response,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch {
    throw new ApiError("NETWORK_ERROR", networkErrorMessage, response.status);
  }
}
function mediaType(response: Response): string {
  return (response.headers.get("Content-Type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}
async function readJson(response: Response): Promise<unknown> {
  if (
    !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(
      mediaType(response),
    )
  )
    throw invalidResponse(response.status);
  const text = await readBody(response, () => response.text());
  try {
    return JSON.parse(text);
  } catch {
    throw invalidResponse(response.status);
  }
}
function responseError(body: unknown, status: number): ApiError {
  const parsed = apiErrorResponseSchema.safeParse(body);
  if (!parsed.success) throw invalidResponse(status);
  return new ApiError(
    parsed.data.error.code,
    parsed.data.error.message,
    status,
  );
}
async function request<K extends ApiEndpoint>(
  endpoint: K,
  path: string,
  options: RequestInit = {},
): Promise<ApiResponse<K>> {
  const { headers, userId } = await authorizedHeaders(path, options);
  if (options.body && !(options.body instanceof Blob))
    headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const method = (options.method ?? "GET").toUpperCase();
  const mutation = !["GET", "HEAD"].includes(method);
  const fingerprint =
    mutation && typeof options.body !== "object"
      ? mutationFingerprint(userId, method, path, options.body ?? "")
      : null;
  if (mutation && !headers.has("Idempotency-Key")) {
    const key =
      (fingerprint && pendingMutations.get(fingerprint)) || crypto.randomUUID();
    if (fingerprint) pendingMutations.set(fingerprint, key);
    headers.set("Idempotency-Key", key);
  }
  const response = await fetchResponse(path, { ...options, headers });
  const body = await readJson(response);
  if (!response.ok) {
    const error = responseError(body, response.status);
    if (
      fingerprint &&
      response.status >= 400 &&
      response.status < 500 &&
      error.code !== "OPERATION_IN_PROGRESS"
    )
      pendingMutations.delete(fingerprint);
    throw error;
  }
  const parsed = apiResponseSchemas[endpoint].safeParse(body);
  if (!parsed.success) throw invalidResponse(response.status);
  if (fingerprint) pendingMutations.delete(fingerprint);
  return parsed.data as ApiResponse<K>;
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
  return request(endpoint, path + query, {
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
  const path = `/api/clothes/${encodeURIComponent(id)}/image`;
  const { headers } = await authorizedHeaders(path, {});
  const response = await fetchResponse(path, { headers });
  if (!response.ok)
    throw responseError(await readJson(response), response.status);
  if (!supportedImageMediaTypes.includes(mediaType(response)))
    throw invalidResponse(response.status);
  const blob = await readBody(response, () => response.blob());
  if (!blob.size) throw invalidResponse(response.status);
  return URL.createObjectURL(blob);
}
export async function compressImage(file: File): Promise<Blob> {
  if (file.size > limits.uploadBytes)
    throw new Error("写真は5MB以下で選んでください");
  if (!supportedImageMediaTypes.includes(file.type))
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
