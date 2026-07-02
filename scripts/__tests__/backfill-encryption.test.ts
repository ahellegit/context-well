// U5: backfill of legacy plaintext rows.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { backfillEncryption } from "../backfill-encryption.js";

const CIPHERTEXT = /^v1\.aesgcm256\./;

async function rawColumn(table: string, column: string, id: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ v: string }>>(
    `SELECT "${column}" AS v FROM "${table}" WHERE id = '${id}'`,
  );
  return rows[0]?.v ?? "";
}

async function reset() {
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.connector.deleteMany();
  await prisma.space.deleteMany();
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("encryption backfill (U5)", () => {
  it("encrypts a legacy plaintext row and preserves its value", async () => {
    const space = await prisma.space.create({
      data: { slug: "leg", name: "leg", indexKey: "ab".repeat(32) },
    });
    // Overwrite with plaintext, bypassing the extension → a pre-encryption row.
    await prisma.$executeRawUnsafe(
      `UPDATE "Space" SET "customPrompt" = 'legacy prompt' WHERE id = '${space.id}'`,
    );
    expect(await rawColumn("Space", "customPrompt", space.id)).toBe("legacy prompt");

    const counts = await backfillEncryption();
    expect(counts.space).toBe(1);

    expect(await rawColumn("Space", "customPrompt", space.id)).toMatch(CIPHERTEXT);
    const read = await prisma.space.findUniqueOrThrow({ where: { id: space.id } });
    expect(read.customPrompt).toBe("legacy prompt");
  });

  it("is idempotent — a second run leaves values readable and correct", async () => {
    const space = await prisma.space.create({
      data: { slug: "idem", name: "idem", indexKey: "cd".repeat(32), customPrompt: "hi" },
    });
    await backfillEncryption();
    await backfillEncryption();

    expect(await rawColumn("Space", "customPrompt", space.id)).toMatch(CIPHERTEXT);
    const read = await prisma.space.findUniqueOrThrow({ where: { id: space.id } });
    expect(read.customPrompt).toBe("hi");
    expect(read.indexKey).toBe("cd".repeat(32));
  });

  it("handles a mixed table (some legacy, some already encrypted)", async () => {
    const encrypted = await prisma.space.create({
      data: { slug: "enc", name: "enc", indexKey: "11".repeat(32), customPrompt: "already" },
    });
    const legacy = await prisma.space.create({
      data: { slug: "old", name: "old", indexKey: "22".repeat(32) },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "Space" SET "customPrompt" = 'plain' WHERE id = '${legacy.id}'`,
    );

    const counts = await backfillEncryption();
    expect(counts.space).toBe(2);

    expect(await rawColumn("Space", "customPrompt", encrypted.id)).toMatch(CIPHERTEXT);
    expect(await rawColumn("Space", "customPrompt", legacy.id)).toMatch(CIPHERTEXT);
    const readEnc = await prisma.space.findUniqueOrThrow({ where: { id: encrypted.id } });
    const readLegacy = await prisma.space.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(readEnc.customPrompt).toBe("already");
    expect(readLegacy.customPrompt).toBe("plain");
  });
});
