import { spawnSync } from "node:child_process";
import { Pool } from "@neondatabase/serverless";

type Suite = "staff-profile" | "clerk-invite";

function databaseIdentity(value: string): string {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname) {
    throw new Error("The isolated test database setting must be a PostgreSQL connection URL.");
  }
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}${decodeURIComponent(url.pathname).replace(/\/+$/, "").toLowerCase()}`;
}

function failClosed(reason: string): never {
  throw new Error(`Isolated staff test refused to run: ${reason}`);
}

const suite = process.argv[2] as Suite | undefined;
if (suite !== "staff-profile" && suite !== "clerk-invite") {
  failClosed("choose staff-profile or clerk-invite.");
}
if (
  process.env.NODE_ENV !== "development"
  || process.env.REPLIT_DEPLOYMENT === "1"
) {
  failClosed("these checks run only in the development environment.");
}
if (suite === "clerk-invite" && process.env.RUN_CLERK_INVITE_E2E !== "1") {
  failClosed("the browser invitation check requires explicit opt-in.");
}

const currentDatabase = process.env.DATABASE_URL;
const isolatedDatabase = process.env.CLERK_INVITE_TEST_DATABASE_URL;
if (!currentDatabase) failClosed("the current development database is unavailable for comparison.");
if (!isolatedDatabase) failClosed("CLERK_INVITE_TEST_DATABASE_URL is not configured.");

let currentIdentity: string;
let isolatedIdentity: string;
try {
  currentIdentity = databaseIdentity(currentDatabase);
  isolatedIdentity = databaseIdentity(isolatedDatabase);
} catch {
  failClosed("both database settings must be valid PostgreSQL connection URLs.");
}
if (currentIdentity === isolatedIdentity) {
  failClosed("the test database must be a separate database from the app development database.");
}

const testPool = new Pool({
  connectionString: isolatedDatabase,
  max: 1,
  connectionTimeoutMillis: 5_000,
});
// Tables the staff migrations reference but do not create themselves.
const requiredTables = ["auth_users", "clients", "crm_jobs", "crm_contacts", "users"];
try {
  const schema = await testPool.query<{ name: string }>(
    "SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass('public.' || name) IS NULL",
    [requiredTables],
  );
  if (schema.rows.length) {
    failClosed(`the isolated database must have the app schema initialized before tests run (missing: ${schema.rows.map((row) => row.name).join(", ")}).`);
  }
  const users = await testPool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM auth_users",
  );
  if (Number(users.rows[0]?.count ?? "0") !== 0) {
    failClosed("the isolated test database must contain no auth users. Use a blank test database with the app schema.");
  }
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Isolated staff test refused to run:")) throw error;
  failClosed("the isolated test database could not be verified. No migrations or test writes were run.");
} finally {
  await testPool.end();
}

const testEnvironment = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_URL: isolatedDatabase,
  CLERK_ISOLATED_TEST_DB_ACTIVE: "1",
  ...(suite === "staff-profile" ? { RUN_STAFF_PROFILE_ISOLATED_TESTS: "1" } : {}),
};

const [executable, ...command] = suite === "staff-profile"
  ? [process.execPath, "./scripts/run-tests.mjs", "staff-contact-profile.integration.test.ts"]
  : ["pnpm", "exec", "tsx", "./scripts/test-clerk-invite-acceptance.ts"];
const result = spawnSync(executable, command, {
  cwd: process.cwd(),
  env: testEnvironment,
  stdio: "inherit",
});

if (result.error) {
  console.error("Isolated staff test could not start.");
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
