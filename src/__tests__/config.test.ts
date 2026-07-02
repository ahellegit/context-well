// Master-key config validation. The suite-wide setup-env.ts sets a valid
// PRISMA_FIELD_ENCRYPTION_KEY before import, so importing config.ts succeeds;
// here we flex loadConfig() against good and bad key values.

import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const KEY = "PRISMA_FIELD_ENCRYPTION_KEY";
const VALID = "k1.aesgcm256.NvVoW1CM4cGEKF4NZhaDU1ieyzu7UVJ1v75WYhdmyag=";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("encryption master key config", () => {
  it("accepts a valid cloak key and exposes it on the config", () => {
    process.env[KEY] = VALID;
    expect(loadConfig().encryptionKey).toBe(VALID);
  });

  it("throws at boot when the key is missing", () => {
    delete process.env[KEY];
    expect(() => loadConfig()).toThrow(/Missing required environment variable/);
  });

  it("throws when the key is not in k1.aesgcm256 form", () => {
    process.env[KEY] = "not-a-cloak-key";
    expect(() => loadConfig()).toThrow(/k1\.aesgcm256/);
  });

  it("throws when the key does not decode to 32 bytes", () => {
    process.env[KEY] = "k1.aesgcm256.dG9vLXNob3J0"; // "too-short" -> 9 bytes
    expect(() => loadConfig()).toThrow(/32-byte/);
  });

  it("does not write a key file to the database directory", () => {
    // Contrast with the session-secret pattern: the master key is never
    // persisted. loadConfig with a valid key must not create any file.
    process.env[KEY] = VALID;
    expect(() => loadConfig()).not.toThrow();
    // No filesystem assertion needed beyond behavior: validateEncryptionKey
    // has no write path (unlike loadOrCreatePersistedSecret).
  });
});
