// Vitest setupFile for the auth tests. Runs before any test module is imported,
// so it can (a) satisfy the env vars src/config.ts validates at import time and
// (b) create a throwaway SQLite DB and push the Prisma schema into it before the
// shared PrismaClient connects. This keeps the suite hermetic: it never touches
// the developer's dev.db.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "knowledgellm-auth-"));
const dbFile = join(dir, "test.db");

process.env.DATABASE_URL = `file:${dbFile}`;
process.env.SESSION_SECRET ??= "test-session-secret-test-session-secret-0123456789";
process.env.CYBORGDB_URL ??= "http://localhost:8000";
process.env.COOKIE_SECURE = "false";
process.env.ALLOW_REGISTRATION = "false";

// Project root is two levels up from src/auth/__tests__.
const projectRoot = resolve(import.meta.dirname, "..", "..", "..");

// Provision the schema into the throwaway DB. `db push` is sufficient and fast
// for a fresh SQLite file (no migration history needed for tests).
execFileSync(
  "npx",
  ["prisma", "db", "push", "--schema=prisma/schema.prisma", "--skip-generate"],
  {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: "ignore",
  },
);
