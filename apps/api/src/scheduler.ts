import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { wearLimits, type Cloth } from "@outfit/schemas";
import { addDays, jstDate, weekday, weekStart } from "@outfit/domain";
import { askAI, classificationSchema } from "./providers";
import { enqueueReevaluation, generatePlans } from "./service";
import { ApiError, result, type Env } from "./types";

/** Ten-minute sweep, bounded lease batches. Every user/date job has a unique dedupe key. */
export async function runScheduled(env: Env, now = new Date()): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await enqueueDueJobs(db, now);
  await drainJobBatches(db, (job) => processLeasedJob(env, db, job, now));
  // Expired, unused upload grants are the authoritative orphan candidates.
  const expired = await result<any[]>(
    db
      .from("upload_grants")
      .select("id,image_key,user_id")
      .is("used_at", null)
      .lt("expires_at", new Date(+now - 3600000).toISOString())
      .limit(100),
  );
  for (const grant of expired) {
    await env.CLOTHES_BUCKET.delete(grant.image_key);
    await result(
      db.from("upload_grants").delete().eq("id", grant.id).is("used_at", null),
    );
  }
  // A terminated provider request cannot reserve the monthly pool forever. Charge
  // the estimate conservatively because provider billing may have happened.
  const stale = await result<any[]>(
    db
      .from("ai_usage")
      .select("id,estimated_cost_usd")
      .eq("status", "reserved")
      .lt("created_at", new Date(+now - 15 * 60000).toISOString())
      .limit(100),
  );
  for (const usage of stale)
    await result(
      db.rpc("settle_ai", {
        p_usage_id: usage.id,
        p_actual: usage.estimated_cost_usd,
        p_success: false,
      }),
    );
  await sweepOrphanImages(env, db, now);
}

/** Durable bounded scan catches late writes even if the uploading Worker died. */
export async function sweepOrphanImages(
  env: Env,
  db: SupabaseClient,
  now = new Date(),
): Promise<{ scanned: number; deleted: number }> {
  const state = await result<any>(
    db
      .from("maintenance_state")
      .select("cursor")
      .eq("key", "r2_orphans")
      .maybeSingle(),
  );
  const page = await env.CLOTHES_BUCKET.list({
    prefix: "private/",
    limit: 100,
    ...(state?.cursor ? { cursor: state.cursor } : {}),
  });
  const owners = [
    ...new Set(
      page.objects
        .map((o) => o.key.split("/")[1])
        .filter((v): v is string => !!v && /^[a-f0-9-]{36}$/.test(v)),
    ),
  ];
  const profiles = owners.length
    ? await result<any[]>(
        db.from("profiles").select("user_id,deleting_at").in("user_id", owners),
      )
    : [];
  const remove: string[] = [];
  for (const owner of owners) {
    const objects = page.objects.filter((o) =>
      o.key.startsWith(`private/${owner}/`),
    );
    const profile = profiles.find((p) => p.user_id === owner);
    if (!profile || profile.deleting_at) {
      remove.push(...objects.map((o) => o.key));
      continue;
    }
    const old = objects.filter((o) => +now - +o.uploaded > 3600000);
    if (!old.length) continue;
    const keys = old.map((o) => o.key);
    const clothes = await result<any[]>(
      db
        .from("clothes")
        .select("image_key")
        .eq("user_id", owner)
        .or("deleted_at.is.null,image_purge_started_at.is.null")
        .in("image_key", keys),
    );
    const grants = await result<any[]>(
      db
        .from("upload_grants")
        .select("image_key")
        .eq("user_id", owner)
        .gt("expires_at", now.toISOString())
        .in("image_key", keys),
    );
    const referenced = new Set([...clothes, ...grants].map((r) => r.image_key));
    remove.push(...keys.filter((key) => !referenced.has(key)));
  }
  if (remove.length) await env.CLOTHES_BUCKET.delete(remove);
  // Cursor advances only after a successful batch; a crash safely repeats it.
  await result(
    db
      .from("maintenance_state")
      .upsert(
        {
          key: "r2_orphans",
          cursor: page.truncated ? page.cursor : null,
          updated_at: now.toISOString(),
        },
        { onConflict: "key" },
      ),
  );
  return { scanned: page.objects.length, deleted: remove.length };
}

/** Bulk enqueue with a 30-minute lead, including next-day midnight deadlines. */
export async function enqueueDueJobs(
  db: SupabaseClient,
  now: Date,
): Promise<void> {
  const today = jstDate(now),
    time = new Date(+now + 9 * 3600000).toISOString().slice(11, 16);
  for (let page = 0; page < 100; page++) {
    const prefs = await result<any[]>(
      db
        .from("user_preferences")
        .select(
          "user_id,auto_adjust_time,weekly_plan_enabled,profiles!inner(deleting_at)",
        )
        .is("profiles.deleting_at", null)
        .order("user_id")
        .range(page * 100, page * 100 + 99),
    );
    const jobs: any[] = [];
    for (const p of prefs) {
      for (const date of [today, addDays(today, 1)]) {
        const due = new Date(
          `${date}T${p.auto_adjust_time.slice(0, 5)}:00+09:00`,
        );
        if (+now >= +due - 30 * 60000)
          jobs.push({
            user_id: p.user_id,
            job_type: "daily",
            target_date: date,
            dedupe_key: `daily:${p.user_id}:${date}`,
            payload: { deadline: due.toISOString() },
          });
      }
      if (p.weekly_plan_enabled && weekday(today) === 7 && time >= "20:00")
        jobs.push({
          user_id: p.user_id,
          job_type: "weekly",
          target_date: addDays(today, 1),
          dedupe_key: `weekly:${p.user_id}:${addDays(today, 1)}`,
          payload: {},
        });
    }
    if (jobs.length) {
      try {
        await result(
          db
            .from("generation_jobs")
            .upsert(jobs, { onConflict: "dedupe_key", ignoreDuplicates: true }),
        );
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.code !== "ACCOUNT_UNAVAILABLE"
        )
          throw error;
        // One user starting deletion between the sweep and insert must not starve
        // unrelated users. The DB trigger remains the authoritative active check.
        for (const userId of new Set(jobs.map((j) => j.user_id))) {
          try {
            await result(
              db.from("generation_jobs").upsert(
                jobs.filter((j) => j.user_id === userId),
                { onConflict: "dedupe_key", ignoreDuplicates: true },
              ),
            );
          } catch (singleError) {
            if (
              !(singleError instanceof ApiError) ||
              singleError.code !== "ACCOUNT_UNAVAILABLE"
            )
              throw singleError;
          }
        }
      }
    }
    if (prefs.length < 100) break;
  }
}

/** Bounded batches continue within the Cron runtime instead of only 5 users/tick. */
export async function drainJobBatches(
  db: SupabaseClient,
  process: (job: any) => Promise<void>,
  clock: () => number = Date.now,
): Promise<number> {
  const started = clock();
  let processed = 0;
  while (processed < 200 && clock() - started < 8 * 60000) {
    const jobs = await result<any[]>(db.rpc("lease_jobs", { p_limit: 5 }));
    if (!jobs.length) break;
    await Promise.all(jobs.map(process));
    processed += jobs.length;
  }
  return processed;
}

export async function runSpecificJob(
  env: Env,
  id: string,
  now = new Date(),
): Promise<void> {
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const job = await result<any>(db.rpc("lease_job", { p_id: id }));
  if (job) await processLeasedJob(env, db, job, now);
}

async function processLeasedJob(
  env: Env,
  db: SupabaseClient,
  job: any,
  now: Date,
) {
  const today = jstDate(now);
  try {
    if (job.job_type === "account_delete") {
      await deleteAccount(env, db, job);
      return;
    }
    const profile = await result<any>(
      db
        .from("profiles")
        .select("deleting_at")
        .eq("user_id", job.user_id)
        .maybeSingle(),
    );
    if (!profile || profile.deleting_at) throw new Error("ACCOUNT_DELETING");
    if (job.job_type === "classify") {
      const cloth = await result<Cloth | null>(
        db
          .from("clothes")
          .select("*")
          .eq("id", job.payload.clothes_id)
          .eq("user_id", job.user_id)
          .is("deleted_at", null)
          .maybeSingle(),
      );
      if (cloth && cloth.classification_state === "pending") {
        const object = await env.CLOTHES_BUCKET.get(cloth.image_key!);
        if (!object) throw new Error("IMAGE_MISSING");
        const bytes = new Uint8Array(await object.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const classified = await askAI(
          env,
          db,
          job.user_id,
          "classify",
          job.dedupe_key,
          classificationSchema,
          [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "写真の1着を分類してください。category は top/bottom/shoes/outerwear、seasons は spring/summer/autumn/winter。subtype と color は簡潔な英語。不明なら review_required=true。厚さは推定しない。",
                },
                {
                  type: "input_image",
                  image_url: `data:image/webp;base64,${btoa(binary)}`,
                  detail: "low",
                },
              ],
            },
          ],
        );
        const update = classified
          ? {
              category: classified.category,
              subtype: classified.subtype,
              color: classified.color,
              seasons: classified.seasons,
              classification_state:
                classified.review_required || classified.confidence < 0.7
                  ? "review"
                  : "classified",
              wear_limit: wearLimits[classified.category],
            }
          : { classification_state: "manual" };
        // A user's correction made while the AI ran wins over late provider output.
        await result(
          db.rpc("complete_classification", {
            p_user_id: job.user_id,
            p_clothes_id: cloth.id,
            p_data: update,
            p_job_id: job.id,
            p_lease_token: job.lease_token,
          }),
        );
        await enqueueReevaluation(db, job.user_id, today);
      }
    } else if (job.job_type === "image_delete") {
      const claim = await result<{ image_key: string } | null>(
        db.rpc("claim_clothes_image_purge", {
          p_job_id: job.id,
          p_lease_token: job.lease_token,
        }),
      );
      if (claim) {
        if (!claim.image_key.startsWith(`private/${job.user_id}/`))
          throw new Error("INVALID_IMAGE_OWNER");
        await env.CLOTHES_BUCKET.delete(claim.image_key);
        if (await env.CLOTHES_BUCKET.head(claim.image_key))
          throw new Error("IMAGE_DELETE_FAILED");
      }
    } else if (["daily", "weekly", "reevaluate"].includes(job.job_type)) {
      await generatePlans(
        env,
        db,
        job.user_id,
        weekStart(job.target_date ?? today),
        now,
        {
          force: true,
          affectedOnly: job.job_type !== "weekly",
          onlyDate: job.job_type === "daily" ? job.target_date : undefined,
          requestKey: job.dedupe_key,
          jobId: job.id,
          leaseToken: job.lease_token,
        },
      );
      if (
        job.job_type === "reevaluate" &&
        weekStart(job.target_date ?? today) === weekStart(today)
      )
        await generatePlans(
          env,
          db,
          job.user_id,
          addDays(weekStart(today), 7),
          now,
          {
            force: true,
            affectedOnly: true,
            requestKey: job.dedupe_key + ":next",
            jobId: job.id,
            leaseToken: job.lease_token,
          },
        );
    }
    await result(
      db.rpc("finish_job", {
        p_id: job.id,
        p_lease_token: job.lease_token,
        p_success: true,
      }),
    );
  } catch {
    await result(
      db.rpc("finish_job", {
        p_id: job.id,
        p_lease_token: job.lease_token,
        p_success: false,
        p_error_code: "JOB_FAILED",
      }),
    );
  }
}

export async function deleteAccount(
  env: Env,
  db: any,
  job: any,
): Promise<void> {
  const userId = job.user_id;
  if (!userId) return;
  // Wait for every previously issued grant (including consumed grants) to
  // expire, plus a short in-flight grace period, before declaring completion.
  const grants = await result<any[]>(
    db.from("upload_grants").select("expires_at").eq("user_id", userId),
  );
  if (grants.some((g) => Date.parse(g.expires_at) + 2 * 60000 > Date.now()))
    throw new Error("UPLOADS_SETTLING");
  // Profile tombstone is preserved until Auth deletion cascades it, preventing resurrection.
  let cursor: string | undefined;
  do {
    const list = await env.CLOTHES_BUCKET.list({
      prefix: `private/${userId}/`,
      cursor,
      limit: 500,
    });
    if (list.objects.length)
      await env.CLOTHES_BUCKET.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  const verification = await env.CLOTHES_BUCKET.list({
    prefix: `private/${userId}/`,
    limit: 1,
  });
  if (verification.objects.length) throw new Error("IMAGE_DELETE_FAILED");
  const reserved = await result<any[]>(
    db
      .from("ai_usage")
      .select("id,estimated_cost_usd")
      .eq("user_id", userId)
      .eq("status", "reserved"),
  );
  for (const usage of reserved)
    await result(
      db.rpc("settle_ai", {
        p_usage_id: usage.id,
        p_actual: usage.estimated_cost_usd,
        p_success: false,
      }),
    );
  // Delete dependent business records first, retaining only the access-blocking tombstone.
  for (const table of [
    "outfit_feedback",
    "wear_log_items",
    "wear_logs",
    "daily_plans",
    "outfit_items",
    "outfits",
    "laundry_events",
    "clothes",
    "upload_grants",
    "day_overrides",
    "work_weekdays",
    "user_preferences",
    "ai_usage",
    "operation_receipts",
    "quota_counters",
    "rate_limits",
  ])
    await result(db.from(table).delete().eq("user_id", userId));
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error && error.status !== 404) throw new Error("AUTH_DELETE_FAILED");
  await result(
    db.from("generation_jobs").delete().eq("user_id", userId).neq("id", job.id),
  );
  const finished = await result<boolean>(
    db.rpc("finish_deletion", { p_id: job.id, p_lease_token: job.lease_token }),
  );
  if (!finished) throw new Error("LEASE_LOST");
}
