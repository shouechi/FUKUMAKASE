import { app } from "./app";
import { runScheduled } from "./scheduler";
import type { Env } from "./types";
export { app, createApp } from "./app";
export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },
};
