import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

// Never connects to or resets an existing database: the entire cluster is ephemeral.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = mkdtempSync(join(tmpdir(), "outfit-acceptance-"));
let started = false,
  exitCode = 1;
const postgresBin =
  process.env.POSTGRES_BIN ??
  execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
const binary = (name) => join(postgresBin, name);
const execute = (name, args) =>
  execFileSync(binary(name), args, { cwd: root, stdio: "pipe" });
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = address.port;
    server.close(() => resolvePort(selected));
  });
});
const data = join(temporary, "data"),
  log = join(temporary, "postgres.log");
try {
  execute("initdb", [
    "-D",
    data,
    "-A",
    "trust",
    "--no-locale",
    "--encoding=UTF8",
    "-U",
    "outfit_test",
  ]);
  execute("pg_ctl", [
    "-D",
    data,
    "-l",
    log,
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${temporary}`,
    "-w",
    "start",
  ]);
  started = true;
  execute("createdb", [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "outfit_test",
    "outfit_acceptance",
  ]);
  execute("psql", [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "outfit_test",
    "-d",
    "outfit_acceptance",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    "tests/database/bootstrap.sql",
    ...readdirSync(join(root, "supabase/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .flatMap((name) => ["-f", join(root, "supabase/migrations", name)]),
  ]);
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "tests/database"],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        TEST_DATABASE_URL: `postgres://outfit_test@127.0.0.1:${port}/outfit_acceptance`,
      },
    },
  );
  exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  if (error.stderr) console.error(String(error.stderr));
  try {
    console.error(readFileSync(log, "utf8"));
  } catch {}
} finally {
  if (started)
    try {
      execute("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    } catch (error) {
      console.error(error.message);
    }
  // Exact path returned by mkdtemp, containing test-owned data only.
  rmSync(temporary, { recursive: true, force: true });
}
process.exitCode = exitCode;
