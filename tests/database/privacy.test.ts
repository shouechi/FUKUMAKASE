import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownedTables = [
  "profiles",
  "user_preferences",
  "work_weekdays",
  "day_overrides",
  "clothes",
  "outfits",
  "outfit_items",
  "daily_plans",
  "wear_logs",
  "wear_log_items",
  "laundry_events",
  "outfit_feedback",
  "ai_usage",
  "generation_jobs",
];

describe.skipIf(!databaseUrl)(
  "actual PostgreSQL: privacy and access-control schema",
  () => {
    const db = new Client({ connectionString: databaseUrl });
    beforeAll(() => db.connect());
    afterAll(() => db.end());

    test("every specified service table exists and has row-level security enabled", async () => {
      const { rows } = await db.query<{
        relname: string;
        relrowsecurity: boolean;
      }>(`
      select c.relname, c.relrowsecurity from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    `);
      for (const table of ownedTables) {
        const found = rows.find((row) => row.relname === table);
        expect(found, `Missing required table: ${table}`).toBeDefined();
        expect(found?.relrowsecurity, `RLS missing: ${table}`).toBe(true);
      }
    });

    test("service data does not duplicate credentials or unrelated personal attributes", async () => {
      const { rows } = await db.query<{
        table_name: string;
        column_name: string;
      }>(`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
    `);
      expect(rows.length).toBeGreaterThan(0);
      const forbidden =
        /^(email|email_address|password|password_hash|display_name|full_name|first_name|last_name|phone|phone_number|address|birth_date|date_of_birth|gender|google_access_token|oauth_token)$/i;
      expect(rows.filter((row) => forbidden.test(row.column_name))).toEqual([]);
      const profileColumns = rows
        .filter((row) => row.table_name === "profiles")
        .map((row) => row.column_name);
      expect(profileColumns).toContain("user_id");
    });

    test("authenticated users cannot mutate administrator-only tables directly", async () => {
      const { rows } = await db.query<{
        table_name: string;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(`
      select c.relname as table_name,
        has_table_privilege('authenticated', c.oid, 'INSERT') as can_insert,
        has_table_privilege('authenticated', c.oid, 'UPDATE') as can_update,
        has_table_privilege('authenticated', c.oid, 'DELETE') as can_delete
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('service_budget', 'ai_usage', 'generation_jobs', 'maintenance_state')
    `);
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.can_insert, `${row.table_name}: INSERT`).toBe(false);
        expect(row.can_update, `${row.table_name}: UPDATE`).toBe(false);
        expect(row.can_delete, `${row.table_name}: DELETE`).toBe(false);
      }
    });

    test("security-definer functions pin search_path against object shadowing", async () => {
      const { rows } = await db.query<{
        proname: string;
        proconfig: string[] | null;
      }>(`
      select p.proname, p.proconfig from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
    `);
      for (const row of rows) {
        expect(
          row.proconfig?.some((config) =>
            /^search_path=public,\s*pg_temp$/.test(config),
          ),
          row.proname,
        ).toBe(true);
      }
    });

    test("anonymous callers have no execute privilege on sensitive service functions", async () => {
      const { rows } = await db.query<{
        proname: string;
        anonymous_execute: boolean;
      }>(`
      select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') anonymous_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and p.proname not in ('handle_new_user')
    `);
      for (const row of rows)
        expect(row.anonymous_execute, row.proname).toBe(false);
    });
  },
);
