// U4: the critical fix. Space.indexKey is the CyborgDB per-space encryption key;
// it must be ciphertext at rest so a stolen app.db can't decrypt the embeddings
// (R2). Read through prisma it decrypts to hex, and hexToKey() converts it for
// the SDK exactly as before.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import { hexToKey } from "../client.js";

const CIPHERTEXT = /^v1\.aesgcm256\./;
const HEX_KEY = "ab".repeat(32); // 64 hex chars → 32 bytes

async function rawIndexKey(id: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ v: string }>>(
    `SELECT "indexKey" AS v FROM "Space" WHERE id = '${id}'`,
  );
  return rows[0]?.v ?? "";
}

beforeEach(async () => {
  await prisma.space.deleteMany();
});
afterAll(async () => {
  await prisma.space.deleteMany();
  await prisma.$disconnect();
});

describe("Space.indexKey encryption (U4)", () => {
  it("stores the index key as ciphertext, not the raw 64-hex string", async () => {
    const space = await prisma.space.create({
      data: { slug: "s1", name: "s1", indexKey: HEX_KEY },
    });
    const raw = await rawIndexKey(space.id);
    expect(raw).toMatch(CIPHERTEXT);
    expect(raw).not.toContain(HEX_KEY);
  });

  it("decrypts to the original hex and converts to a 32-byte SDK key", async () => {
    const space = await prisma.space.create({
      data: { slug: "s2", name: "s2", indexKey: HEX_KEY },
    });
    const read = await prisma.space.findUniqueOrThrow({ where: { id: space.id } });
    expect(read.indexKey).toBe(HEX_KEY);
    const key = hexToKey(read.indexKey);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("loads a legacy plaintext-hex key (pass-through) and still converts it", async () => {
    const space = await prisma.space.create({
      data: { slug: "s3", name: "s3", indexKey: HEX_KEY },
    });
    // Simulate a pre-encryption row: overwrite with plaintext hex, bypassing the
    // extension. Reading it back must pass through and still convert.
    await prisma.$executeRawUnsafe(
      `UPDATE "Space" SET "indexKey" = '${HEX_KEY}' WHERE id = '${space.id}'`,
    );
    const read = await prisma.space.findUniqueOrThrow({ where: { id: space.id } });
    expect(read.indexKey).toBe(HEX_KEY);
    expect(hexToKey(read.indexKey).length).toBe(32);
  });
});
