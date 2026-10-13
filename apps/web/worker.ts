import handler from "vinext/server/fetch-handler";
import api, { ApiError, apiErrorResponse, type Env } from "@outfit/api/server";

export * from "vinext/server/fetch-handler";

export default {
  ...handler,
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api" || path.startsWith("/api/") || path === "/health") {
      try {
        return await api.fetch(request, env, ctx);
      } catch {
        // Unexpected failures must not expose credentials or render an HTML page.
        return apiErrorResponse(
          new ApiError(
            "API_UNAVAILABLE",
            503,
            "データを取得できませんでした。少し待って、もう一度お試しください。",
          ),
        );
      }
    }
    return handler.fetch(request, env, ctx);
  },
  scheduled: api.scheduled,
};
