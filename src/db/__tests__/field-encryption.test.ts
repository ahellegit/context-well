// Transparent field encryption. Writes go through the extended client, so
// annotated columns are AES-256-GCM encrypted at rest; reads decrypt. We assert
// ciphertext-at-rest with $queryRawUnsafe, which bypasses the extension and
// returns the literal stored bytes.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../client.js";

// A cloak ciphertext string looks like `v1.aesgcm256.<fingerprint>.<iv>.<data>`.
const CIPHERTEXT = /^v1\.aesgcm256\./;

async function rawColumn(table: string, column: string, id: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(
    `SELECT "${column}" AS v FROM "${table}" WHERE id = '${id}'`,
  );
  return rows[0]?.v ?? "";
}

async function reset() {
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.document.deleteMany();
  await prisma.connector.deleteMany();
  await prisma.space.deleteMany();
}

function makeSpace(slug: string, customPrompt = "") {
  return prisma.space.create({
    data: { slug, name: slug, indexKey: "00".repeat(32), customPrompt },
  });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("field encryption at rest", () => {
  it("stores connector credentials as ciphertext, reads them back in clear", async () => {
    const space = await makeSpace("alpha");
    const token = "ghp_supersecrettoken1234567890";
    const c = await prisma.connector.create({
      data: { spaceId: space.id, kind: "github", credentials: token },
    });

    expect(await rawColumn("Connector", "credentials", c.id)).toMatch(CIPHERTEXT);
    const read = await prisma.connector.findUniqueOrThrow({ where: { id: c.id } });
    expect(read.credentials).toBe(token);
  });

  it("encrypts message text and sources, round-trips both", async () => {
    const space = await makeSpace("beta");
    const conv = await prisma.conversation.create({ data: { spaceId: space.id } });
    const text = "what is our refund policy?";
    const sources = JSON.stringify([{ id: "1", title: "Refunds", snippet: "…", score: 0.9 }]);
    const m = await prisma.message.create({
      data: { conversationId: conv.id, role: "user", text, sources },
    });

    expect(await rawColumn("Message", "text", m.id)).toMatch(CIPHERTEXT);
    expect(await rawColumn("Message", "sources", m.id)).toMatch(CIPHERTEXT);
    const read = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(read.text).toBe(text);
    expect(JSON.parse(read.sources)).toHaveLength(1);
  });

  it("encrypts conversation title, space custom prompt, and document metadata", async () => {
    const space = await makeSpace("gamma", "You are a helpful legal assistant.");
    const conv = await prisma.conversation.create({
      data: { spaceId: space.id, title: "Q3 board deck questions" },
    });
    const connector = await prisma.connector.create({
      data: { spaceId: space.id, kind: "github", credentials: "ghp_x" },
    });
    const doc = await prisma.document.create({
      data: {
        spaceId: space.id,
        connectorId: connector.id,
        externalRef: "repo/path.md",
        title: "Confidential design doc",
        metadata: JSON.stringify({ author: "alice" }),
      },
    });

    expect(await rawColumn("Space", "customPrompt", space.id)).toMatch(CIPHERTEXT);
    expect(await rawColumn("Conversation", "title", conv.id)).toMatch(CIPHERTEXT);
    expect(await rawColumn("Document", "title", doc.id)).toMatch(CIPHERTEXT);
    expect(await rawColumn("Document", "metadata", doc.id)).toMatch(CIPHERTEXT);

    const readSpace = await prisma.space.findUniqueOrThrow({ where: { id: space.id } });
    const readDoc = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(readSpace.customPrompt).toBe("You are a helpful legal assistant.");
    expect(readDoc.title).toBe("Confidential design doc");
  });

  it("leaves a non-annotated column (name) in clear text", async () => {
    const space = await makeSpace("delta");
    expect(await rawColumn("Space", "name", space.id)).toBe("delta");
  });

  it("persists rows that use empty-string defaults without error", async () => {
    const space = await makeSpace("epsilon"); // customPrompt defaults to ""
    const conv = await prisma.conversation.create({ data: { spaceId: space.id } }); // title default
    const read = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(read.title).toBe("New chat");
    const readSpace = await prisma.space.findUniqueOrThrow({ where: { id: space.id } });
    expect(readSpace.customPrompt).toBe("");
  });

  it("reads a legacy plaintext row unchanged (pass-through)", async () => {
    // Simulate a pre-encryption row by writing plaintext straight to the column,
    // bypassing the extension, then reading it back through the extended client.
    const space = await makeSpace("zeta");
    const conv = await prisma.conversation.create({ data: { spaceId: space.id } });
    await prisma.$executeRawUnsafe(
      `UPDATE "Conversation" SET title = 'legacy plaintext title' WHERE id = '${conv.id}'`,
    );
    const read = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(read.title).toBe("legacy plaintext title");
  });
});
