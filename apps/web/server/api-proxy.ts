export interface ApiProxyEnv {
  API?: { fetch(request: Request): Promise<Response> | Response };
}

/** Keep same-origin API traffic out of the page renderer, including private images. */
export async function proxyApiRequest(
  request: Request,
  env: ApiProxyEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api" && !path.startsWith("/api/")) return null;
  try {
    if (env.API) return await env.API.fetch(request);
  } catch {
    // The binding exception may contain credentials; never return or log it.
  }
  const requestId = crypto.randomUUID();
  return Response.json(
    {
      error: {
        code: "API_UNAVAILABLE",
        message:
          "データを取得できませんでした。少し待って、もう一度お試しください。",
        request_id: requestId,
      },
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      },
    },
  );
}
