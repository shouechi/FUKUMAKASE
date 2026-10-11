import { api } from "../apps/web/lib/client";
import type {
  DayOverrideResponse,
  Plan,
  Usage,
} from "../packages/schemas/src/index";

// Compile-only adversarial contract checks: if a rejected call becomes legal,
// TypeScript reports its @ts-expect-error as unused and fails this suite.
function sharedClientContract() {
  const usage: Promise<Usage> = api("GET /api/me/usage");
  const today: Promise<Plan | null> = api("GET /api/outfits/today");
  const override: Promise<DayOverrideResponse> = api(
    "GET /api/me/day-overrides/:date",
    { params: { date: "2026-10-13" } },
  );
  api("PATCH /api/clothes/:id", {
    params: { id: "id" },
    body: { is_available: false },
  });
  // @ts-expect-error callers cannot invent response types
  api<{ arbitrary: string }>("GET /api/me/usage");
  // @ts-expect-error missing dynamic path parameter
  api("GET /api/clothes/:id");
  // @ts-expect-error incorrect dynamic path parameter name
  api("GET /api/clothes/:id", { params: { user_id: "another-account" } });
  // @ts-expect-error HTTP method is part of the canonical endpoint
  api("POST /api/me/usage", { body: {} });
  // @ts-expect-error GET has no mutation body
  api("GET /api/me/usage", { body: {} });
  api("POST /api/wear-logs", {
    // @ts-expect-error owner is never provided by callers
    body: { target_date: "2026-10-13", outfit_id: "id", user_id: "other" },
  });
  api("PATCH /api/clothes/:id", {
    params: { id: "id" },
    // @ts-expect-error invalid garment category
    body: { category: "accessory" },
  });
  // @ts-expect-error deletion requires explicit canonical confirmation
  api("POST /api/account/delete", { body: { confirmation: "yes" } });
  // @ts-expect-error raw or external URL cannot bypass canonical contracts
  api("https://evil.example/api");
  return { usage, today, override };
}
void sharedClientContract;
