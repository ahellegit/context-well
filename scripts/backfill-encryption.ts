// U5: one-time backfill that encrypts rows written before field encryption was
// enabled. Strategy: read each row through the extended client (legacy plaintext
// passes through; already-encrypted values decrypt), then write the same values
// back — the extension encrypts on write. Idempotent: re-running simply
// re-encrypts already-encrypted rows (read → decrypt → write → encrypt), so a row
// always ends encrypted and readable. Safe to run before or after deploying the
// extension, in any order, because reads pass legacy plaintext through (R6).
//
// Run with:  npx tsx scripts/backfill-encryption.ts

import { fileURLToPath } from "node:url";
import { prisma } from "../src/db/client.js";

export interface BackfillCounts {
  space: number;
  connector: number;
  message: number;
  conversation: number;
  document: number;
}

// Re-write only the annotated columns so the extension re-encrypts them. Reads
// come back decrypted, so passing them straight to update() encrypts on write.
export async function backfillEncryption(): Promise<BackfillCounts> {
  const counts: BackfillCounts = {
    space: 0,
    connector: 0,
    message: 0,
    conversation: 0,
    document: 0,
  };

  for (const row of await prisma.space.findMany()) {
    await prisma.space.update({
      where: { id: row.id },
      data: { indexKey: row.indexKey, customPrompt: row.customPrompt },
    });
    counts.space++;
  }

  for (const row of await prisma.connector.findMany()) {
    await prisma.connector.update({
      where: { id: row.id },
      data: { credentials: row.credentials },
    });
    counts.connector++;
  }

  for (const row of await prisma.message.findMany()) {
    await prisma.message.update({
      where: { id: row.id },
      data: { text: row.text, sources: row.sources },
    });
    counts.message++;
  }

  for (const row of await prisma.conversation.findMany()) {
    await prisma.conversation.update({
      where: { id: row.id },
      data: { title: row.title },
    });
    counts.conversation++;
  }

  for (const row of await prisma.document.findMany()) {
    await prisma.document.update({
      where: { id: row.id },
      data: { title: row.title, metadata: row.metadata },
    });
    counts.document++;
  }

  return counts;
}

async function main() {
  const counts = await backfillEncryption();
  console.log("Encryption backfill complete:", counts);
  await prisma.$disconnect();
}

// Only run when executed directly (not when imported by a test).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  });
}
