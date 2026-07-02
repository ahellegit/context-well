import { PrismaClient } from "@prisma/client";
import { fieldEncryptionExtension } from "prisma-field-encryption";
import { config } from "../config.js";

// Single shared Prisma client for the app process, extended with transparent
// field-level encryption. Columns annotated `/// @encrypted` in the schema
// are AES-256-GCM encrypted on write and decrypted on read using the master key
// (config.encryptionKey, validated at boot in config.ts). Passing the key
// explicitly keeps config.ts the single source of truth rather than letting the
// extension read the env directly. Legacy plaintext rows decrypt as pass-through,
// so the extension is safe to deploy before the backfill runs.
//
// Rotation: set a new key in PRISMA_FIELD_ENCRYPTION_KEY and list retired keys in
// PRISMA_FIELD_DECRYPTION_KEYS (comma-separated); old data still decrypts.
const decryptionKeys = (process.env.PRISMA_FIELD_DECRYPTION_KEYS ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter((k) => k.length > 0);

export const prisma = new PrismaClient().$extends(
  fieldEncryptionExtension({
    encryptionKey: config.encryptionKey,
    ...(decryptionKeys.length > 0 ? { decryptionKeys } : {}),
  }),
);
