import handler from "vinext/server/fetch-handler";
import { proxyApiRequest, type ApiProxyEnv } from "./server/api-proxy";

export * from "vinext/server/fetch-handler";

export default {
  ...handler,
  async fetch(
    request: Request,
    env: ApiProxyEnv,
    ctx: unknown,
  ): Promise<Response> {
    const response = await proxyApiRequest(request, env);
    return response ?? handler.fetch(request, env, ctx);
  },
};
