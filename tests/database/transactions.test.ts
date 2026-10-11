import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jstDate, jstWeekStart } from "../../packages/domain/src/index";
import {
  categorySchema,
  clothesPatchSchema,
  defaultPreferences,
  seasonSchema,
  limits,
} from "../../packages/schemas/src/index";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "actual PostgreSQL: independent transactional acceptance and attacks",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 16 });
    const users: string[] = [];
    const key = () => randomUUID();
    async function user() {
      const id = key();
      users.push(id);
      await pool.query("insert into auth.users(id) values($1)", [id]);
      await rpc("ensure_profile", [id]);
      return id;
    }
    async function scoped<T>(
      role: string,
      id: string | undefined,
      run: (client: PoolClient) => Promise<T>,
    ) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(`set local role ${role}`);
        if (id)
          await client.query(
            "select set_config('request.jwt.claim.sub',$1,true)",
            [id],
          );
        const result = await run(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    async function rpc(name: string, args: unknown[]) {
      return scoped("service_role", undefined, async (client) => {
        const { rows } = await client.query(
          `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`,
          args,
        );
        return rows[0].value;
      });
    }
    async function cloth(id: string, category = "top", wearLimit = 10) {
      const request = key();
      const upload = await rpc("reserve_upload", [id, request]);
      return rpc("create_clothes", [
        id,
        request,
        JSON.stringify({
          image_key: upload.image_key,
          category,
          subtype: category === "top" ? "shirt" : "slacks",
          color: "white",
          seasons: ["autumn"],
          wear_limit: wearLimit,
          classification_state: "manual",
        }),
      ]);
    }
    async function outfit(
      id: string,
      garments: { id: string; category: string }[],
    ) {
      const { rows } = await pool.query(
        "insert into outfits(user_id,source,reason_short) values($1,'rule','テスト用') returning id",
        [id],
      );
      for (const c of garments)
        await pool.query(
          "insert into outfit_items(user_id,outfit_id,clothes_id,slot) values($1,$2,$3,$4)",
          [id, rows[0].id, c.id, c.category],
        );
      return rows[0].id as string;
    }
    beforeAll(async () => {
      await pool.query("select 1");
    });
    afterAll(async () => {
      // Only synthetic accounts created by this suite are removed.
      for (const id of users) {
        await pool.query("delete from generation_jobs where user_id=$1", [id]);
        await pool.query("delete from auth.users where id=$1", [id]);
      }
      await pool.end();
    });

    test("A cannot read B clothes/preferences/history nor execute owner-forging service RPCs", async () => {
      const a = await user(),
        b = await user();
      const upper = await cloth(b),
        lower = await cloth(b, "bottom");
      const o = await outfit(b, [upper, lower]);
      await rpc("confirm_wear", [b, "2026-01-01", o, key()]);
      await scoped("authenticated", a, async (client) => {
        for (const table of [
          "profiles",
          "user_preferences",
          "clothes",
          "outfits",
          "outfit_items",
          "wear_logs",
          "wear_log_items",
          "laundry_events",
        ]) {
          const { rows } = await client.query(
            `select * from public.${table} where user_id=$1`,
            [b],
          );
          expect(rows, table).toEqual([]);
        }
      });
      await expect(
        scoped("authenticated", a, (client) =>
          client.query("select reserve_upload($1,$2)", [b, key()]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        scoped("authenticated", a, (client) =>
          client.query("update clothes set user_id=$1 where id=$2", [
            a,
            upper.id,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    test("cross-owner outfit references fail even on the backend service role", async () => {
      const a = await user(),
        b = await user();
      const upper = await cloth(b);
      await expect(
        rpc("save_plan", [
          a,
          "2026-10-13",
          JSON.stringify({ items: [{ clothes_id: upper.id, slot: "top" }] }),
          false,
        ]),
      ).rejects.toThrow(/INVALID_CLOTHES/);
      const o = await outfit(a, []);
      await expect(
        pool.query(
          "insert into outfit_items(user_id,outfit_id,clothes_id,slot) values($1,$2,$3,'top')",
          [a, o, upper.id],
        ),
      ).rejects.toThrow(/foreign key/);
    });

    test("100-garment cap survives 16 competing uploads at 99 garments", async () => {
      const id = await user();
      await pool.query(
        `insert into clothes(user_id,request_key,image_key,category,wear_limit,classification_state)
      select $1::uuid,gen_random_uuid()::text,'private/'||$1::text||'/'||gen_random_uuid()||'.webp','top',1,'manual'
      from generate_series(1,99)`,
        [id],
      );
      const results = await Promise.allSettled(
        Array.from({ length: 16 }, () => rpc("reserve_upload", [id, key()])),
      );
      const successes = results.filter((r) => r.status === "fulfilled");
      expect(successes).toHaveLength(1);
      for (const result of results)
        if (result.status === "rejected")
          expect(String(result.reason)).toContain("CLOTHES_LIMIT");
      const grant = (successes[0] as PromiseFulfilledResult<any>).value;
      await rpc("create_clothes", [
        id,
        key(),
        JSON.stringify({
          image_key: grant.image_key,
          category: "top",
          classification_state: "manual",
        }),
      ]);
      expect(
        Number(
          (
            await pool.query(
              "select count(*) from clothes where user_id=$1 and deleted_at is null",
              [id],
            )
          ).rows[0].count,
        ),
      ).toBe(100);
      await expect(rpc("reserve_upload", [id, key()])).rejects.toThrow(
        /CLOTHES_LIMIT/,
      );
    });

    test("parallel create retries share one upload and one clothing record", async () => {
      const id = await user(),
        request = key();
      const grants = await Promise.all(
        Array.from({ length: 8 }, () => rpc("reserve_upload", [id, request])),
      );
      expect(new Set(grants.map((g) => g.id)).size).toBe(1);
      const data = JSON.stringify({
        image_key: grants[0].image_key,
        category: "top",
        classification_state: "manual",
      });
      const garments = await Promise.all(
        Array.from({ length: 8 }, () =>
          rpc("create_clothes", [id, request, data]),
        ),
      );
      expect(new Set(garments.map((c) => c.id)).size).toBe(1);
      expect(
        Number(
          (
            await pool.query("select count(*) from clothes where user_id=$1", [
              id,
            ])
          ).rows[0].count,
        ),
      ).toBe(1);
    });

    test("simultaneous double-click confirmations increase wear once, freeze snapshot and enter laundry", async () => {
      const id = await user();
      const upper = await cloth(id, "top", 1),
        lower = await cloth(id, "bottom", 3);
      const o = await outfit(id, [upper, lower]);
      const logs = await Promise.all(
        Array.from({ length: 8 }, () =>
          rpc("confirm_wear", [id, "2026-01-01", o, key()]),
        ),
      );
      expect(new Set(logs.map((l) => l.id)).size).toBe(1);
      const rows = (
        await pool.query(
          "select id,wears_since_wash,state from clothes where user_id=$1",
          [id],
        )
      ).rows;
      expect(rows.find((c) => c.id === upper.id)).toMatchObject({
        wears_since_wash: 1,
        state: "laundry",
      });
      expect(rows.find((c) => c.id === lower.id)).toMatchObject({
        wears_since_wash: 1,
        state: "available",
      });
      expect(
        Number(
          (
            await pool.query(
              "select count(*) from wear_log_items where wear_log_id=$1",
              [logs[0].id],
            )
          ).rows[0].count,
        ),
      ).toBe(2);
      await expect(
        rpc("confirm_wear", [id, "2026-01-02", o, key()]),
      ).rejects.toThrow(/UNAVAILABLE_CLOTHES/);
    });

    test("correction applies only changed garments and is retry-safe", async () => {
      const id = await user(),
        a = await cloth(id, "top", 1),
        b = await cloth(id, "top", 1),
        lower = await cloth(id, "bottom", 3);
      const original = await outfit(id, [a, lower]),
        replacement = await outfit(id, [b, lower]);
      await rpc("confirm_wear", [id, "2026-01-01", original, key()]);
      const request = key();
      await Promise.all(
        Array.from({ length: 5 }, () =>
          rpc("correct_wear", [id, "2026-01-01", replacement, request]),
        ),
      );
      const rows = (
        await pool.query(
          "select id,wears_since_wash,state from clothes where user_id=$1",
          [id],
        )
      ).rows;
      expect(rows.find((c) => c.id === a.id)).toMatchObject({
        wears_since_wash: 0,
        state: "available",
      });
      expect(rows.find((c) => c.id === b.id)).toMatchObject({
        wears_since_wash: 1,
        state: "laundry",
      });
      expect(rows.find((c) => c.id === lower.id)?.wears_since_wash).toBe(1);
      expect(
        Number(
          (
            await pool.query(
              "select count(*) from laundry_events where user_id=$1 and event_type='corrected'",
              [id],
            )
          ).rows[0].count,
        ),
      ).toBe(2);
    });

    test("washing retries do not erase a later wear", async () => {
      const id = await user(),
        upper = await cloth(id, "top", 3),
        lower = await cloth(id, "bottom", 3),
        o = await outfit(id, [upper, lower]);
      await rpc("confirm_wear", [id, "2026-01-01", o, key()]);
      const request = key();
      await rpc("wash_clothes", [id, upper.id, request]);
      await rpc("confirm_wear", [id, "2026-01-02", o, key()]);
      await rpc("wash_clothes", [id, upper.id, request]);
      expect(
        (
          await pool.query("select wears_since_wash from clothes where id=$1", [
            upper.id,
          ])
        ).rows[0].wears_since_wash,
      ).toBe(1);
    });

    test("historical correction after a wash never subtracts a new laundry-cycle wear", async () => {
      const id = await user(),
        a = await cloth(id),
        b = await cloth(id),
        lower = await cloth(id, "bottom");
      const original = await outfit(id, [a, lower]),
        replacement = await outfit(id, [b, lower]);
      await rpc("confirm_wear", [id, "2026-01-01", original, key()]);
      await rpc("wash_clothes", [id, a.id, key()]);
      await rpc("confirm_wear", [id, "2026-01-02", original, key()]);
      await rpc("correct_wear", [id, "2026-01-01", replacement, key()]);
      expect(
        (
          await pool.query("select wears_since_wash from clothes where id=$1", [
            a.id,
          ])
        ).rows[0].wears_since_wash,
      ).toBe(1);
    });

    test("correction preserves explicitly marked laundry even below its wear limit", async () => {
      const id = await user(),
        a = await cloth(id, "top", 3),
        b = await cloth(id, "top", 3),
        lower = await cloth(id, "bottom");
      const original = await outfit(id, [a, lower]),
        replacement = await outfit(id, [b, lower]);
      await rpc("confirm_wear", [id, "2026-01-01", original, key()]);
      await pool.query("update clothes set state='laundry' where id=$1", [
        a.id,
      ]);
      await rpc("correct_wear", [id, "2026-01-01", replacement, key()]);
      expect(
        (
          await pool.query(
            "select wears_since_wash,state from clothes where id=$1",
            [a.id],
          )
        ).rows[0],
      ).toEqual({ wears_since_wash: 0, state: "laundry" });
      expect(
        Number(
          (
            await pool.query(
              "select count(*) from laundry_events where clothes_id=$1 and event_type='marked_laundry'",
              [a.id],
            )
          ).rows[0].count,
        ),
      ).toBe(1);
    });

    test("SQL defaults and accepted enums stay consistent with shared schemas", async () => {
      const id = await user(),
        c = await cloth(id);
      const preferences = (
        await pool.query("select * from user_preferences where user_id=$1", [
          id,
        ])
      ).rows[0];
      const normalized = Object.fromEntries(
        Object.keys(defaultPreferences).map((k) => [
          k,
          k === "auto_adjust_time"
            ? preferences[k].slice(0, 5)
            : preferences[k],
        ]),
      );
      expect(normalized).toEqual(defaultPreferences);
      for (const category of categorySchema.options)
        await expect(
          pool.query("update clothes set category=$1 where id=$2", [
            category,
            c.id,
          ]),
        ).resolves.toBeDefined();
      for (const season of seasonSchema.options)
        await expect(
          pool.query("update clothes set seasons=$1 where id=$2", [
            [season],
            c.id,
          ]),
        ).resolves.toBeDefined();
      await expect(
        pool.query("update clothes set category='accessory' where id=$1", [
          c.id,
        ]),
      ).rejects.toThrow(/check constraint/);
      await expect(
        pool.query("update clothes set seasons=array['monsoon'] where id=$1", [
          c.id,
        ]),
      ).rejects.toThrow(/check constraint/);
      for (const value of [0, 1, 100, 101]) {
        const accepted = clothesPatchSchema.safeParse({
          wear_limit: value,
        }).success;
        const operation = pool.query(
          "update clothes set wear_limit=$1 where id=$2",
          [value, c.id],
        );
        if (accepted) await expect(operation).resolves.toBeDefined();
        else await expect(operation).rejects.toThrow(/check constraint/);
      }
      expect(limits.clothes).toBe(100);
      expect(limits.dailyRegenerations).toBe(3);
      expect(limits.weeklyRegenerations).toBe(2);
    });

    test("SQL blocks case-insensitive NG and all shared office-disallowed garment variants", async () => {
      const id = await user(),
        upper = await cloth(id),
        lower = await cloth(id, "bottom");
      const o = await outfit(id, [upper, lower]);
      for (const subtype of [
        "shorts",
        "flip_flops",
        "beach_sandals",
        "tank_top",
        "短パン",
        "ビーチサンダル",
        "タンクトップ",
      ]) {
        await pool.query("update clothes set subtype=$1 where id=$2", [
          subtype,
          upper.id,
        ]);
        await expect(
          rpc("confirm_wear", [id, "2026-01-01", o, key()]),
        ).rejects.toThrow(/UNAVAILABLE_CLOTHES/);
      }
      await pool.query("update clothes set subtype='ShIrT' where id=$1", [
        upper.id,
      ]);
      await pool.query(
        "update user_preferences set ng_categories=array['SHIRT'] where user_id=$1",
        [id],
      );
      await expect(
        rpc("confirm_wear", [id, "2026-01-01", o, key()]),
      ).rejects.toThrow(/UNAVAILABLE_CLOTHES/);
    });

    test("incomplete outfit, pending classification and changed category cannot be confirmed", async () => {
      const id = await user(),
        upper = await cloth(id),
        lower = await cloth(id, "bottom");
      await expect(
        rpc("confirm_wear", [
          id,
          "2026-01-01",
          await outfit(id, [upper]),
          key(),
        ]),
      ).rejects.toThrow(/MISSING_REQUIRED_ITEMS/);
      const o = await outfit(id, [upper, lower]);
      await pool.query(
        "update clothes set classification_state='pending' where id=$1",
        [upper.id],
      );
      await expect(
        rpc("confirm_wear", [id, "2026-01-01", o, key()]),
      ).rejects.toThrow(/UNAVAILABLE_CLOTHES/);
      await pool.query(
        "update clothes set classification_state='manual',category='shoes' where id=$1",
        [upper.id],
      );
      await expect(
        rpc("confirm_wear", [id, "2026-01-01", o, key()]),
      ).rejects.toThrow(/UNAVAILABLE_CLOTHES/);
    });

    test("manual lock and confirmed day cannot be overwritten by automatic plan writes", async () => {
      const id = await user(),
        upper = await cloth(id),
        lower = await cloth(id, "bottom");
      const data = JSON.stringify({
        items: [
          { clothes_id: upper.id, slot: "top" },
          { clothes_id: lower.id, slot: "bottom" },
        ],
        reason_short: "固定テスト",
      });
      const saved = await rpc("save_plan", [id, "2026-01-01", data, true]);
      await pool.query("update clothes set state='laundry' where id=$1", [
        upper.id,
      ]);
      const after = await rpc("save_plan", [
        id,
        "2026-01-01",
        JSON.stringify({ items: [], warnings: ["洗濯待ち"] }),
        false,
      ]);
      expect(after.outfit_id).toBe(saved.outfit_id);
      expect(after.mode).toBe("manual_lock");
      expect(after.warnings).toContain("洗濯待ち");
    });

    test("concurrent daily and weekly manual regeneration quotas cannot overspend", async () => {
      const id = await user();
      for (const [action, limit] of [
        ["daily_regen", 3],
        ["weekly_regen", 2],
      ] as const) {
        const results = await Promise.all(
          Array.from({ length: 12 }, () =>
            rpc("consume_quota", [id, action, key()]),
          ),
        );
        expect(results.filter((r) => r.allowed)).toHaveLength(limit);
        const now = new Date(
          (await pool.query("select now() now")).rows[0].now,
        );
        expect(results[0].period_start).toBe(
          action === "daily_regen" ? jstDate(now) : jstWeekStart(now),
        );
      }
    });

    test("quota retries preserve the original receipt and do not use another allowance", async () => {
      const id = await user(),
        request = key();
      const first = await rpc("consume_quota", [id, "daily_regen", request]);
      const again = await rpc("consume_quota", [id, "daily_regen", request]);
      expect(first.remaining).toBe(2);
      expect(again.remaining).toBe(2);
      expect(again.replayed).toBe(true);
    });

    test("budget reservations stop new AI calls and settlement is idempotent", async () => {
      const id = await user();
      const month = (
        await pool.query(
          "select date_trunc('month',now() at time zone 'Asia/Tokyo')::date::text as billing_period",
        )
      ).rows[0].billing_period;
      await pool.query(
        "insert into service_budget(billing_month,max_ai_usd,ai_enabled) values($1,0.03,true) on conflict(billing_month) do update set max_ai_usd=0.03,reserved_ai_usd=0,spent_ai_usd=0,ai_enabled=true",
        [month],
      );
      const reservations = await Promise.all(
        Array.from({ length: 8 }, () =>
          rpc("reserve_ai", [id, "scheduled", 0.01, key()]),
        ),
      );
      expect(reservations.filter(Boolean)).toHaveLength(3);
      const usage = reservations.find(Boolean);
      await rpc("settle_ai", [usage, 0.01, true]);
      await rpc("settle_ai", [usage, 0.01, true]);
      const budget = (
        await pool.query(
          "select * from service_budget where billing_month=$1",
          [month],
        )
      ).rows[0];
      expect(Number(budget.spent_ai_usd)).toBe(0.01);
      expect(Number(budget.reserved_ai_usd)).toBe(0.02);
      expect(
        await rpc("reserve_ai", [id, "scheduled", 0.01, key()]),
      ).toBeNull();
    });

    test("job lease tokens fence stale workers and failed jobs retry", async () => {
      const id = await user();
      const inserted = await pool.query(
        "insert into generation_jobs(user_id,job_type,dedupe_key) values($1,'scheduled',$2) returning id",
        [id, key()],
      );
      const leased = (
        await pool.query("select * from lease_jobs(25)")
      ).rows.find((j) => j.id === inserted.rows[0].id);
      expect(leased.status).toBe("running");
      expect(await rpc("finish_job", [leased.id, key(), true, null])).toBe(
        false,
      );
      expect(
        await rpc("finish_job", [
          leased.id,
          leased.lease_token,
          false,
          "PROVIDER_UNAVAILABLE",
        ]),
      ).toBe(true);
      const next = (
        await pool.query("select * from generation_jobs where id=$1", [
          leased.id,
        ])
      ).rows[0];
      expect(next.status).toBe("pending");
      expect(next.attempt_count).toBe(1);
      expect(new Date(next.next_attempt_at).getTime()).toBeGreaterThan(
        Date.now(),
      );
    });

    test("expired job leases cannot mutate a plan or overwrite classification", async () => {
      const id = await user(),
        upper = await cloth(id),
        lower = await cloth(id, "bottom");
      await pool.query(
        "update clothes set classification_state='pending' where id=$1",
        [upper.id],
      );
      const jobId = key(),
        token = key();
      await pool.query(
        "insert into generation_jobs(id,user_id,job_type,dedupe_key,status,lease_token,lease_until) values($1,$2,'classify',$3,'running',$4,now()-interval '1 second')",
        [jobId, id, key(), token],
      );
      await expect(
        rpc("complete_classification", [
          id,
          upper.id,
          JSON.stringify({
            category: "top",
            classification_state: "classified",
          }),
          jobId,
          token,
        ]),
      ).rejects.toThrow(/LEASE_LOST/);
      await expect(
        rpc("save_plan", [
          id,
          "2026-10-13",
          JSON.stringify({ items: [{ clothes_id: lower.id, slot: "bottom" }] }),
          false,
          jobId,
          token,
        ]),
      ).rejects.toThrow(/LEASE_LOST/);
      expect(
        (
          await pool.query(
            "select classification_state from clothes where id=$1",
            [upper.id],
          )
        ).rows[0].classification_state,
      ).toBe("pending");
      await pool.query(
        "update generation_jobs set lease_until=now()+interval '5 minutes' where id=$1",
        [jobId],
      );
      await pool.query(
        "update clothes set classification_state='manual',color='red' where id=$1",
        [upper.id],
      );
      await rpc("complete_classification", [
        id,
        upper.id,
        JSON.stringify({ color: "blue", classification_state: "classified" }),
        jobId,
        token,
      ]);
      expect(
        (
          await pool.query(
            "select color,classification_state from clothes where id=$1",
            [upper.id],
          )
        ).rows[0],
      ).toEqual({ color: "red", classification_state: "manual" });
    });

    test("HTTP idempotency claims reject changed payloads and replay completed responses", async () => {
      const id = await user(),
        request = key(),
        operation = "POST:/api/clothes";
      const claims = await Promise.all(
        Array.from({ length: 8 }, () =>
          rpc("claim_operation", [id, operation, request, "payload-hash"]),
        ),
      );
      expect(claims.filter((c) => c.state === "new")).toHaveLength(1);
      expect(claims.filter((c) => c.state === "pending")).toHaveLength(7);
      await expect(
        rpc("claim_operation", [id, operation, request, "changed-payload"]),
      ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
      await rpc("finish_operation", [
        id,
        operation,
        request,
        "payload-hash",
        201,
        JSON.stringify({ id: "created" }),
      ]);
      expect(
        await rpc("claim_operation", [id, operation, request, "payload-hash"]),
      ).toMatchObject({
        state: "complete",
        status: 201,
        response: { id: "created" },
      });
    });

    test("targeted deletion leasing has one winner and completion atomically erases receipt ownership", async () => {
      const id = await user(),
        job = await rpc("begin_deletion", [id]);
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => rpc("lease_job", [job.id])),
      );
      const winners = claims.filter(Boolean);
      expect(winners).toHaveLength(1);
      expect(await rpc("finish_deletion", [job.id, key()])).toBe(false);
      const leased = winners[0];
      await pool.query("delete from auth.users where id=$1", [id]);
      expect(await rpc("finish_deletion", [job.id, leased.lease_token])).toBe(
        true,
      );
      const receipt = (
        await pool.query(
          "select status,user_id,payload,dedupe_key from generation_jobs where id=$1",
          [job.id],
        )
      ).rows[0];
      expect(receipt).toEqual({
        status: "completed",
        user_id: null,
        payload: {},
        dedupe_key: `deleted:${job.id}`,
      });
      // The job is no longer linked to its synthetic account, so cleanup targets its exact ID.
      await pool.query("delete from generation_jobs where id=$1", [job.id]);
    });

    test("deletion and daily adjustment jobs take priority over older reevaluations", async () => {
      const id = await user();
      const other = await user();
      const jobs = await pool.query(
        `insert into generation_jobs(user_id,job_type,dedupe_key,next_attempt_at)
      values($1,'reevaluate',$2,now()-interval '2 days'),($1,'daily',$3,now()-interval '1 day') returning id,job_type`,
        [id, key(), key()],
      );
      const deletion = await rpc("begin_deletion", [other]);
      const first = (await pool.query("select * from lease_jobs(1)")).rows[0];
      expect(first.id).toBe(deletion.id);
      const second = (await pool.query("select * from lease_jobs(1)")).rows[0];
      expect(second.id).toBe(jobs.rows.find((j) => j.job_type === "daily").id);
    });

    test("inflight enqueue cannot resurrect private owner data after deletion begins", async () => {
      const id = await user(),
        other = await user();
      const queued = await pool.query(
        "insert into generation_jobs(user_id,job_type,dedupe_key) values($1,'reevaluate',$2) returning id",
        [id, key()],
      );
      await expect(
        pool.query("update generation_jobs set user_id=$1 where id=$2", [
          other,
          queued.rows[0].id,
        ]),
      ).rejects.toThrow(/OWNER|IMMUTABLE/);
      await rpc("begin_deletion", [id]);
      await expect(
        pool.query(
          "insert into generation_jobs(user_id,job_type,dedupe_key) values($1,'reevaluate',$2)",
          [id, key()],
        ),
      ).rejects.toThrow(/ACCOUNT_UNAVAILABLE/);
      await pool.query("delete from auth.users where id=$1", [id]);
      await expect(
        pool.query(
          "insert into generation_jobs(user_id,job_type,dedupe_key) values($1,'classify',$2)",
          [id, key()],
        ),
      ).rejects.toThrow(/ACCOUNT_UNAVAILABLE/);
    });

    test("deletion immediately blocks stale authenticated tokens, writes and duplicate jobs", async () => {
      const id = await user();
      await cloth(id);
      const first = await rpc("begin_deletion", [id]),
        retry = await rpc("begin_deletion", [id]);
      expect(retry.id).toBe(first.id);
      await scoped("authenticated", id, async (client) => {
        expect((await client.query("select * from clothes")).rows).toEqual([]);
        expect(
          (await client.query("select * from user_preferences")).rows,
        ).toEqual([]);
      });
      await expect(rpc("reserve_upload", [id, key()])).rejects.toThrow(
        /ACCOUNT_UNAVAILABLE/,
      );
      await expect(rpc("ensure_profile", [id])).rejects.toThrow(
        /ACCOUNT_UNAVAILABLE/,
      );
      await pool.query("delete from profiles where user_id=$1", [id]);
      await pool.query("delete from auth.users where id=$1", [id]);
      await expect(rpc("ensure_profile", [id])).rejects.toThrow(/foreign key/);
    });
  },
);
