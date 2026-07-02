// Loads and validates app configuration from the environment (.env in dev,
// real env vars in production / docker-compose). See .env.example.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// In local dev, hydrate process.env from a .env file if one is present.
// In Docker/production the env is already populated, so a missing file is fine.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file — rely on the ambient environment
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

// The at-rest encryption master key (KEK). Encrypts sensitive columns via
// prisma-field-encryption; a stolen app.db is useless without it. Unlike the
// session secret, we NEVER auto-generate or persist it next to the DB — that
// would defeat the untrusted-host threat model — so a missing/malformed key is
// a hard boot failure. Format is cloak's: `k1.aesgcm256.<base64 of 32 bytes>`.
// Generate with `npx cloak generate`. Validated here so boot fails loudly
// before the extension would lazily error on the first write.
function validateEncryptionKey(name: string): string {
  const raw = required(name);
  const match = raw.match(/^k1\.aesgcm256\.(.+)$/);
  if (!match) {
    throw new Error(
      `${name} must be a cloak key of the form "k1.aesgcm256.<base64>". ` +
        `Generate one with: npx cloak generate`,
    );
  }
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length !== 32) {
    throw new Error(
      `${name} must encode a 32-byte AES-256 key, got ${bytes.length} bytes.`,
    );
  }
  return raw;
}

// Zero-config session secret: when SESSION_SECRET is not provided, generate a
// random one once and persist it alongside the database so it survives restarts
// (a fresh secret every boot would invalidate all sessions). Setting an explicit
// SESSION_SECRET env always takes precedence. Lets a from-scratch user run
// `docker compose up` with no .env and configure everything from the UI.
function persistedSecretPath(databaseUrl: string): string {
  // DATABASE_URL looks like file:/data/app.db or file:./prisma/dev.db; the
  // secret lives next to it (e.g. /data/session.secret) on the same volume.
  const match = databaseUrl.match(/^file:(.*)$/);
  const dbPath = (match ? match[1] : "./prisma/dev.db").split("?")[0];
  return join(dirname(dbPath), "session.secret");
}

function loadOrCreatePersistedSecret(databaseUrl: string): string {
  const secretPath = persistedSecretPath(databaseUrl);
  try {
    const existing = readFileSync(secretPath, "utf8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // not created yet — fall through and generate
  }
  const secret = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, secret, { mode: 0o600 });
  } catch (err) {
    // Couldn't persist (e.g. read-only fs) — still boot, but warn that sessions
    // will reset on the next restart.
    console.warn(
      `Could not persist a generated session secret to ${secretPath}; sessions ` +
        `will reset on restart. Set SESSION_SECRET to silence this. (${err})`,
    );
  }
  return secret;
}

export interface Config {
  port: number;
  sessionSecret: string;
  cookieSecure: boolean;
  databaseUrl: string;
  cyborgdbUrl: string;
  ollamaDefaultUrl: string;
  encryptionKey: string;
}

// Note: open self-registration was removed with app-layer RBAC — accounts are
// admin-provisioned and `/register` is bootstrap-only. No ALLOW_REGISTRATION.
export function loadConfig(): Config {
  const databaseUrl = optional("DATABASE_URL", "file:./prisma/dev.db");
  return {
    port: Number(optional("PORT", "3000")),
    sessionSecret:
      optional("SESSION_SECRET", "") || loadOrCreatePersistedSecret(databaseUrl),
    // Secure by default: the session cookie is not sent over plaintext HTTP
    // unless the operator explicitly opts out (COOKIE_SECURE=false, e.g. local
    // dev or an HTTP-only deploy behind a trusted network).
    cookieSecure: optional("COOKIE_SECURE", "true") !== "false",
    databaseUrl,
    cyborgdbUrl: required("CYBORGDB_URL"),
    ollamaDefaultUrl: optional("OLLAMA_DEFAULT_URL", ""),
    encryptionKey: validateEncryptionKey("PRISMA_FIELD_ENCRYPTION_KEY"),
  };
}

export const config = loadConfig();
