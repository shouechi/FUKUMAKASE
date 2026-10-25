import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { limits } from "../../packages/schemas/src/index";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "actual PostgreSQL: clothing deletion Undo acceptance",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 16 });
    const accounts: string[] = [];
    const key = () => randomUUID();
    async function scoped<T>(
      role: string,
      owner: string | null,
      action: (db: PoolClient) => Promise<T>,
    ) {
      const db = await pool.connect();
      try {
        await db.query("begin");
        await db.query(`set local role ${role}`);
        if (owner)
          await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
            owner,
          ]);
        const value = await action(db);
        await db.query("commit");
        return value;
      } catch (error) {
        await db.query("rollback");
        throw error;
      } finally {
        db.release();
      }
    }
    const rpc = (name: string, args: Record<string, unknown>) =>
      scoped("service_role", null, async (db) => {
        const entries = Object.entries(args);
        return (
          await db.query(
            `select public.${name}(${entries.map(([name], i) => `${name} => $${i + 1}`).join(",")}) as result`,
            entries.map(([, value]) => value),
          )
        ).rows[0].result;
      });
    async function user() {
      const id = key();
      accounts.push(id);
      await pool.query("insert into auth.users(id) values($1)", [id]);
      await rpc("ensure_profile", { p_user_id: id });
      return id;
    }
    async function cloth(owner: string, classification = "manual") {
      return (
        await pool.query(
          `insert into clothes(user_id,request_key,image_key,category,color,seasons,wear_limit,classification_state)
      values($1::uuid,$2::text,'private/'||$1::text||'/'||$2::text||'.webp','top','white',array['autumn'],3,$3) returning *`,
          [owner, key(), classification],
        )
      ).rows[0];
    }
    const remove = (owner: string, id: string, request = key()) =>
      rpc("delete_clothes", {
        p_user_id: owner,
        p_clothes_id: id,
        p_request_key: request,
      });
    const restore = (
      owner: string,
      id: string,
      token: string,
      request = key(),
    ) =>
      rpc("restore_clothes", {
        p_user_id: owner,
        p_clothes_id: id,
        p_request_key: request,
        p_deletion_token: token,
      });
    const list = (owner: string) =>
      rpc("list_clothes_deletions", { p_user_id: owner });
    async function purgeJob(owner: string, token: string) {
      const row = (
        await pool.query(
          "select * from generation_jobs where user_id=$1 and job_type='image_delete' and payload->>'deletion_token'=$2",
          [owner, token],
        )
      ).rows[0];
      expect(row).toBeDefined();
      return row;
    }
    const lease = (id: string) => rpc("lease_job", { p_id: id });
    const claim = (job: { id: string; lease_token: string }) =>
      rpc("claim_clothes_image_purge", {
        p_job_id: job.id,
        p_lease_token: job.lease_token,
      });
    beforeAll(() => pool.query("select 1"));
    afterAll(async () => {
      for (const owner of accounts) {
        await pool.query("delete from generation_jobs where user_id=$1", [
          owner,
        ]);
        await pool.query("delete from auth.users where id=$1", [owner]);
      }
      await pool.end();
    });

    test("deletion grants exactly 30 server seconds and reload only recovers the owner's live receipt", async () => {
      const owner = await user(),
        other = await user(),
        garment = await cloth(owner);
      const receipt = await remove(owner, garment.id);
      expect(receipt).toMatchObject({ ok: true, clothes_id: garment.id });
      expect(receipt.deletion_token).toMatch(/^[\da-f-]{36}$/);
      expect(limits.clothesUndoSeconds).toBe(30);
      expect(
        Date.parse(receipt.undo_until) - Date.parse(receipt.server_now),
      ).toBe(30_000);
      expect((await list(owner)).items).toContainEqual(
        expect.objectContaining({
          clothes_id: garment.id,
          deletion_token: receipt.deletion_token,
        }),
      );
      expect((await list(other)).items).toEqual([]);
      await expect(
        claim({
          id: (await purgeJob(owner, receipt.deletion_token)).id,
          lease_token: key(),
        }),
      ).rejects.toThrow(/LEASE_LOST/);
      await pool.query(
        "update clothes set deleted_at=clock_timestamp()-interval '31 seconds',undo_until=clock_timestamp()-interval '1 millisecond' where id=$1",
        [garment.id],
      );
      expect((await list(owner)).items).toEqual([]);
      await expect(
        restore(owner, garment.id, receipt.deletion_token),
      ).rejects.toThrow(/UNDO_EXPIRED/);
    });

    test("restore preserves identity, laundry cycle, counters and historical references", async () => {
      const owner = await user(),
        garment = await cloth(owner);
      const outfit = (
        await pool.query(
          "insert into outfits(user_id,source,reason_short) values($1,'manual','履歴保持確認') returning id",
          [owner],
        )
      ).rows[0];
      await pool.query(
        "insert into outfit_items(user_id,outfit_id,clothes_id,slot) values($1,$2,$3,'top')",
        [owner, outfit.id, garment.id],
      );
      const wear = (
        await pool.query(
          "insert into wear_logs(user_id,target_date,outfit_id) values($1,'2026-10-01',$2) returning id",
          [owner, outfit.id],
        )
      ).rows[0];
      await pool.query(
        "insert into wear_log_items(user_id,wear_log_id,clothes_id) values($1,$2,$3)",
        [owner, wear.id, garment.id],
      );
      await pool.query(
        "update clothes set state='laundry',wears_since_wash=2,last_washed_at='2026-10-01T00:00:00Z',is_available=false where id=$1",
        [garment.id],
      );
      const receipt = await remove(owner, garment.id);
      const restored = await restore(owner, garment.id, receipt.deletion_token);
      expect(restored).toMatchObject({
        id: garment.id,
        image_key: garment.image_key,
        state: "laundry",
        wears_since_wash: 2,
        wear_limit: 3,
        is_available: false,
        deleted_at: null,
      });
      expect(new Date(restored.last_washed_at).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      expect(
        (
          await pool.query(
            "select clothes_id from wear_log_items where wear_log_id=$1",
            [wear.id],
          )
        ).rows,
      ).toEqual([{ clothes_id: garment.id }]);
      expect((await list(owner)).items).toEqual([]);
      const job = await purgeJob(owner, receipt.deletion_token);
      await pool.query(
        "update generation_jobs set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",
        [job.id],
      );
      const leased = await lease(job.id);
      if (leased) expect(await claim(leased)).toBeNull();
    });

    test("cross-owner restore/delete and forged token do not mutate either owner's clothes", async () => {
      const owner = await user(),
        other = await user(),
        garment = await cloth(owner);
      await expect(remove(other, garment.id)).rejects.toThrow(/NOT_FOUND/);
      const receipt = await remove(owner, garment.id);
      await expect(
        restore(other, garment.id, receipt.deletion_token),
      ).rejects.toThrow(/NOT_FOUND/);
      await expect(restore(owner, garment.id, key())).rejects.toThrow(
        /NOT_FOUND|UNDO_|DELETION_CONFLICT/,
      );
      expect(
        (
          await pool.query("select deleted_at from clothes where id=$1", [
            garment.id,
          ])
        ).rows[0].deleted_at,
      ).not.toBeNull();
      for (const role of ["anon", "authenticated"]) {
        for (const [name, args] of [
          ["delete_clothes", [owner, garment.id, key()]],
          [
            "restore_clothes",
            [owner, garment.id, key(), receipt.deletion_token],
          ],
          ["list_clothes_deletions", [owner]],
          ["claim_clothes_image_purge", [key(), key()]],
        ] as const)
          await expect(
            scoped(role, other, (db) =>
              db.query(
                `select ${name}(${args.map((_, i) => `$${i + 1}`).join(",")})`,
                [...args],
              ),
            ),
          ).rejects.toThrow(/permission denied/);
      }
    });

    test("duplicate operations replay their original generation and stale requests never restore a new deletion", async () => {
      const owner = await user(),
        garment = await cloth(owner),
        deleteKey = key(),
        restoreKey = key();
      const receipts = await Promise.all(
        Array.from({ length: 6 }, () => remove(owner, garment.id, deleteKey)),
      );
      expect(new Set(receipts.map((r) => r.deletion_token)).size).toBe(1);
      const first = receipts[0];
      await Promise.all(
        Array.from({ length: 6 }, () =>
          restore(owner, garment.id, first.deletion_token, restoreKey),
        ),
      );
      const second = await remove(owner, garment.id);
      expect(second.deletion_token).not.toBe(first.deletion_token);
      expect((await remove(owner, garment.id, deleteKey)).deletion_token).toBe(
        first.deletion_token,
      );
      await restore(owner, garment.id, first.deletion_token, restoreKey);
      expect(
        (
          await pool.query(
            "select deletion_token,deleted_at from clothes where id=$1",
            [garment.id],
          )
        ).rows[0],
      ).toMatchObject({
        deletion_token: second.deletion_token,
        deleted_at: expect.any(Date),
      });
      await expect(
        restore(owner, garment.id, first.deletion_token),
      ).rejects.toThrow(/NOT_FOUND|UNDO_|DELETION_CONFLICT/);
      await expect(
        restore(owner, garment.id, second.deletion_token, restoreKey),
      ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
      expect((await list(owner)).items).toHaveLength(1);
    });

    test("purge cannot claim during Undo and a claimed purge permanently blocks restore", async () => {
      const owner = await user(),
        garment = await cloth(owner),
        receipt = await remove(owner, garment.id);
      const job = await purgeJob(owner, receipt.deletion_token);
      await pool.query(
        "update generation_jobs set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",
        [job.id],
      );
      const leased = await lease(job.id);
      expect(leased).toBeTruthy();
      await expect(claim(leased)).rejects.toThrow(/UNDO_NOT_EXPIRED/);
      await pool.query(
        "update clothes set deleted_at=clock_timestamp()-interval '31 seconds',undo_until=clock_timestamp()-interval '1 second' where id=$1",
        [garment.id],
      );
      expect(await claim(leased)).toMatchObject({
        image_key: garment.image_key,
      });
      expect(
        (
          await pool.query(
            "select image_purge_started_at from clothes where id=$1",
            [garment.id],
          )
        ).rows[0].image_purge_started_at,
      ).toBeInstanceOf(Date);
      // Clock rollback or administrative deadline extension cannot resurrect a photo whose purge began.
      await pool.query(
        "update clothes set undo_until=clock_timestamp()+interval '30 seconds' where id=$1",
        [garment.id],
      );
      await expect(
        restore(owner, garment.id, receipt.deletion_token),
      ).rejects.toThrow(/UNDO_EXPIRED|PURGE/);
      expect((await list(owner)).items).toEqual([]);
    });

    test("old-generation and expired lease workers cannot purge a newly deleted photo", async () => {
      const owner = await user(),
        garment = await cloth(owner),
        first = await remove(owner, garment.id);
      const oldJob = await purgeJob(owner, first.deletion_token);
      await restore(owner, garment.id, first.deletion_token);
      const second = await remove(owner, garment.id),
        newJob = await purgeJob(owner, second.deletion_token);
      await pool.query(
        "update clothes set deleted_at=clock_timestamp()-interval '31 seconds',undo_until=clock_timestamp()-interval '1 second' where id=$1",
        [garment.id],
      );
      // Simulate a worker with an old lease retained across the restore/redelete cycle.
      const oldToken = key();
      await pool.query(
        "update generation_jobs set status='running',lease_token=$2,lease_until=clock_timestamp()+interval '1 minute' where id=$1",
        [oldJob.id, oldToken],
      );
      expect(await claim({ id: oldJob.id, lease_token: oldToken })).toBeNull();
      const expiredToken = key();
      await pool.query(
        "update generation_jobs set status='running',lease_token=$2,lease_until=clock_timestamp()-interval '1 second' where id=$1",
        [newJob.id, expiredToken],
      );
      await expect(
        claim({ id: newJob.id, lease_token: expiredToken }),
      ).rejects.toThrow(/LEASE_LOST/);
      expect(
        (
          await pool.query(
            "select image_purge_started_at from clothes where id=$1",
            [garment.id],
          )
        ).rows[0].image_purge_started_at,
      ).toBeNull();
    });

    test("deadline is checked after a blocked transaction obtains the profile lock", async () => {
      const owner = await user(),
        garment = await cloth(owner),
        receipt = await remove(owner, garment.id);
      const blocker = await pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query(
          "select * from profiles where user_id=$1 for update",
          [owner],
        );
        await blocker.query(
          "update clothes set undo_until=clock_timestamp()+interval '150 milliseconds' where id=$1",
          [garment.id],
        );
        const attempt = restore(owner, garment.id, receipt.deletion_token);
        const rejected = expect(attempt).rejects.toThrow(/UNDO_EXPIRED/);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await blocker.query("commit");
        await rejected;
      } finally {
        await blocker.query("rollback");
        blocker.release();
      }
    });

    test("a restore racing a premature purge leaves an active photo without a purge claim", async () => {
      const owner = await user(),
        garment = await cloth(owner),
        receipt = await remove(owner, garment.id);
      const job = await purgeJob(owner, receipt.deletion_token);
      await pool.query(
        "update generation_jobs set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",
        [job.id],
      );
      const leased = await lease(job.id);
      const results = await Promise.allSettled([
        restore(owner, garment.id, receipt.deletion_token),
        claim(leased),
      ]);
      expect(results[0].status).toBe("fulfilled");
      if (results[1].status === "fulfilled")
        expect(results[1].value).toBeNull();
      else
        expect(String(results[1].reason)).toMatch(
          /UNDO_NOT_EXPIRED|LEASE_LOST/,
        );
      expect(
        (
          await pool.query(
            "select deleted_at,image_purge_started_at from clothes where id=$1",
            [garment.id],
          )
        ).rows[0],
      ).toEqual({ deleted_at: null, image_purge_started_at: null });
    });

    test.each(["legacy-deleted", "active", "new-generation"] as const)(
      "legacy image jobs only purge pre-Undo tombstones: %s",
      async (state) => {
        const owner = await user(),
          garment = await cloth(owner);
        if (state === "legacy-deleted")
          await pool.query(
            "update clothes set deleted_at=clock_timestamp()-interval '1 day' where id=$1",
            [garment.id],
          );
        if (state === "new-generation") await remove(owner, garment.id);
        const job = (
          await pool.query(
            "insert into generation_jobs(user_id,job_type,payload,dedupe_key) values($1,'image_delete',jsonb_build_object('image_key',$2::text),$3) returning id",
            [owner, garment.image_key, key()],
          )
        ).rows[0];
        const leased = await lease(job.id);
        expect(leased).toBeTruthy();
        const claimed = await claim(leased);
        const stored = (
          await pool.query(
            "select image_purge_started_at from clothes where id=$1",
            [garment.id],
          )
        ).rows[0];
        if (state === "legacy-deleted") {
          expect(claimed).toEqual({ image_key: garment.image_key });
          expect(stored.image_purge_started_at).toBeInstanceOf(Date);
        } else {
          expect(claimed).toBeNull();
          expect(stored.image_purge_started_at).toBeNull();
        }
      },
    );

    test("a purge lease expiring while waiting for the owner lock cannot claim a photo", async () => {
      const owner = await user(),
        garment = await cloth(owner),
        receipt = await remove(owner, garment.id);
      const job = await purgeJob(owner, receipt.deletion_token),
        leaseToken = key();
      await pool.query(
        "update clothes set deleted_at=clock_timestamp()-interval '31 seconds',undo_until=clock_timestamp()-interval '1 second' where id=$1",
        [garment.id],
      );
      const blocker = await pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query(
          "select * from profiles where user_id=$1 for update",
          [owner],
        );
        await pool.query(
          "update generation_jobs set status='running',lease_token=$2,lease_until=clock_timestamp()+interval '150 milliseconds' where id=$1",
          [job.id, leaseToken],
        );
        const rejected = expect(
          claim({ id: job.id, lease_token: leaseToken }),
        ).rejects.toThrow(/LEASE_LOST/);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await blocker.query("commit");
        await rejected;
      } finally {
        await blocker.query("rollback");
        blocker.release();
      }
      expect(
        (
          await pool.query(
            "select image_purge_started_at from clothes where id=$1",
            [garment.id],
          )
        ).rows[0].image_purge_started_at,
      ).toBeNull();
    });

    test("account deletion immediately makes recovery unavailable", async () => {
      const owner = await user(),
        garment = await cloth(owner),
        receipt = await remove(owner, garment.id);
      await rpc("begin_deletion", { p_user_id: owner });
      await expect(
        restore(owner, garment.id, receipt.deletion_token),
      ).rejects.toThrow(/ACCOUNT_UNAVAILABLE/);
      await expect(list(owner)).rejects.toThrow(/ACCOUNT_UNAVAILABLE/);
    });

    test("restore never takes a valid upload reservation and can retry once space is free", async () => {
      const owner = await user(),
        garment = await cloth(owner),
        receipt = await remove(owner, garment.id);
      await pool.query(
        `insert into clothes(user_id,request_key,image_key,category,wear_limit,classification_state)
      select $1::uuid,gen_random_uuid()::text,'private/'||$1::text||'/'||gen_random_uuid()||'.webp','top',1,'manual' from generate_series(1,99)`,
        [owner],
      );
      const grant = await rpc("reserve_upload", {
        p_user_id: owner,
        p_request_key: key(),
      });
      const request = key();
      await expect(
        restore(owner, garment.id, receipt.deletion_token, request),
      ).rejects.toThrow(/CLOTHES_LIMIT/);
      expect((await list(owner)).items).toHaveLength(1);
      await pool.query(
        "update upload_grants set expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [grant.id],
      );
      expect(
        await restore(owner, garment.id, receipt.deletion_token, request),
      ).toMatchObject({ id: garment.id, deleted_at: null });
    });

    test("competing uploads and restores share the last slot without exceeding 100", async () => {
      const owner = await user(),
        garment = await cloth(owner),
        receipt = await remove(owner, garment.id);
      await pool.query(
        `insert into clothes(user_id,request_key,image_key,category,wear_limit,classification_state)
      select $1::uuid,gen_random_uuid()::text,'private/'||$1::text||'/'||gen_random_uuid()||'.webp','top',1,'manual' from generate_series(1,99)`,
        [owner],
      );
      const attempts = await Promise.allSettled([
        restore(owner, garment.id, receipt.deletion_token),
        ...Array.from({ length: 8 }, () =>
          rpc("reserve_upload", { p_user_id: owner, p_request_key: key() }),
        ),
      ]);
      expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const attempt of attempts)
        if (attempt.status === "rejected")
          expect(String(attempt.reason)).toContain("CLOTHES_LIMIT");
      const winner = attempts.find(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<any>;
      if (winner.value.image_key && !winner.value.category)
        await rpc("create_clothes", {
          p_user_id: owner,
          p_request_key: key(),
          p_data: JSON.stringify({
            image_key: winner.value.image_key,
            category: "top",
            classification_state: "manual",
          }),
        });
      expect(
        Number(
          (
            await pool.query(
              "select count(*) from clothes where user_id=$1 and deleted_at is null",
              [owner],
            )
          ).rows[0].count,
        ),
      ).toBe(100);
    });

    test("deleting a pending classification fences the old worker and restoration starts a fresh job", async () => {
      const owner = await user(),
        garment = await cloth(owner, "pending"),
        oldToken = key();
      const oldJob = (
        await pool.query(
          "insert into generation_jobs(user_id,job_type,payload,dedupe_key,status,lease_token,lease_until) values($1,'classify',jsonb_build_object('clothes_id',$2::text),$3,'running',$4,clock_timestamp()+interval '5 minutes') returning id",
          [owner, garment.id, key(), oldToken],
        )
      ).rows[0];
      const receipt = await remove(owner, garment.id);
      await restore(owner, garment.id, receipt.deletion_token);
      await expect(
        rpc("complete_classification", {
          p_user_id: owner,
          p_clothes_id: garment.id,
          p_data: JSON.stringify({
            color: "red",
            classification_state: "classified",
          }),
          p_job_id: oldJob.id,
          p_lease_token: oldToken,
        }),
      ).rejects.toThrow(/LEASE_LOST/);
      const pending = (
        await pool.query(
          "select * from generation_jobs where user_id=$1 and job_type='classify' and status='pending'",
          [owner],
        )
      ).rows;
      expect(pending).toHaveLength(1);
      expect(pending[0].id).not.toBe(oldJob.id);
      expect(pending[0].payload.clothes_id).toBe(garment.id);
      expect(
        (
          await pool.query(
            "select color,classification_state from clothes where id=$1",
            [garment.id],
          )
        ).rows[0],
      ).toEqual({ color: "white", classification_state: "pending" });
    });
  },
);
