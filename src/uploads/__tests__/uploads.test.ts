// File-upload ingestion tests. The CyborgDB index-service is mocked with a
// stateful in-memory store per space slug (same approach as sync.test.ts) so
// upsert/delete/listIds behave like the real thing without a running service.
// Prisma runs against the throwaway SQLite DB from the suite-wide setupFile.
//
// Coverage:
// - ingesting a file creates the upload connector + a Document with
//   DocumentVector rows, and upsertChunks receives text contents (no vector);
// - re-uploading the same filename does not grow the vector count (stable IDs /
//   per-file replace) and purges removed trailing chunks;
// - the upload connector's chunkCount reflects the total DocumentVector count.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock the cyborg index-service with a stateful in-memory store ----------
const cyborg = vi.hoisted(() => {
  const store = new Map<string, Map<string, unknown>>();
  const indexFor = (slug: string): Map<string, unknown> => {
    let idx = store.get(slug);
    if (!idx) {
      idx = new Map();
      store.set(slug, idx);
    }
    return idx;
  };
  return {
    store,
    indexFor,
    upsertChunks: vi.fn(
      async (
        space: { slug: string },
        chunks: { id: string; contents: string; metadata: unknown }[],
      ) => {
        const idx = indexFor(space.slug);
        for (const c of chunks) idx.set(c.id, { contents: c.contents, metadata: c.metadata });
      },
    ),
    deleteVectors: vi.fn(async (space: { slug: string }, ids: string[]) => {
      const idx = indexFor(space.slug);
      for (const id of ids) idx.delete(id);
    }),
    listIds: vi.fn(async (space: { slug: string }) => [...indexFor(space.slug).keys()]),
    train: vi.fn(async () => undefined),
  };
});

vi.mock("../../cyborg/index-service.js", () => ({
  upsertChunks: cyborg.upsertChunks,
  deleteVectors: cyborg.deleteVectors,
  listIds: cyborg.listIds,
  train: cyborg.train,
}));

const { prisma } = await import("../../db/client.js");
const { ingestFiles, ensureUploadConnector, UPLOAD_KIND } = await import("../service.js");
const { chunkId } = await import("../../connectors/chunk.js");

async function makeSpace(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return prisma.space.create({ data: { name, slug, indexKey: "a".repeat(64) } });
}

beforeEach(async () => {
  await prisma.space.deleteMany();
  cyborg.store.clear();
  cyborg.upsertChunks.mockClear();
  cyborg.deleteVectors.mockClear();
  cyborg.listIds.mockClear();
  cyborg.train.mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("ingestFiles", () => {
  it("creates the upload connector + a Document with DocumentVector rows and upserts text contents", async () => {
    const space = await makeSpace("Upload Alpha");

    const result = await ingestFiles(space.id, [
      { filename: "notes.md", text: "# Title\nline one\nline two" },
    ]);

    expect(result.files).toEqual([{ name: "notes.md", chunks: 1, documents: 1 }]);
    expect(result.totalChunks).toBe(1);

    // Upload connector row created with kind "upload".
    const conn = await prisma.connector.findFirstOrThrow({
      where: { spaceId: space.id, kind: UPLOAD_KIND },
    });
    expect(conn.id).toBe(result.connectorId);
    expect(conn.status).toBe("connected");
    expect(conn.chunkCount).toBe(1);
    expect(conn.lastSyncAt).not.toBeNull();

    // Document + DocumentVector rows written.
    const docs = await prisma.document.findMany({
      where: { connectorId: conn.id },
      include: { vectors: true },
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].externalRef).toBe("notes.md");
    expect(docs[0].vectors).toHaveLength(1);
    expect(docs[0].vectors[0].vectorId).toBe(chunkId(UPLOAD_KIND, "notes.md", "notes.md", 0));

    // upsertChunks received text contents (no precomputed vector) + snippet meta.
    expect(cyborg.upsertChunks).toHaveBeenCalledTimes(1);
    const [, chunks] = cyborg.upsertChunks.mock.calls[0];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].contents).toContain("line one");
    expect(chunks[0]).not.toHaveProperty("vector");
    expect((chunks[0].metadata as { connector: string }).connector).toBe(UPLOAD_KIND);
    expect((chunks[0].metadata as { snippet: string }).snippet.length).toBeGreaterThan(0);

    // Landed in the (mock) index.
    expect((await cyborg.listIds({ slug: space.slug })).length).toBe(1);
  });

  it("reuses one upload connector across uploads (ensureUploadConnector idempotent)", async () => {
    const space = await makeSpace("Upload Reuse");
    const a = await ensureUploadConnector(space.id);
    const b = await ensureUploadConnector(space.id);
    expect(a.id).toBe(b.id);

    await ingestFiles(space.id, [{ filename: "a.txt", text: "hello" }]);
    await ingestFiles(space.id, [{ filename: "b.txt", text: "world" }]);

    const conns = await prisma.connector.findMany({
      where: { spaceId: space.id, kind: UPLOAD_KIND },
    });
    expect(conns).toHaveLength(1);
  });

  it("re-uploading the same filename keeps a stable vector count and purges removed trailing chunks", async () => {
    const space = await makeSpace("Upload Beta");

    // A file that chunks into several windows (each window <= maxChars/maxLines).
    const bigText = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
    const first = await ingestFiles(space.id, [{ filename: "big.txt", text: bigText }]);
    const firstChunks = first.totalChunks;
    expect(firstChunks).toBeGreaterThan(1);
    const firstCount = (await cyborg.listIds({ slug: space.slug })).length;
    expect(firstCount).toBe(firstChunks);

    // Re-upload the SAME content: stable IDs → no growth, no purge.
    cyborg.deleteVectors.mockClear();
    const same = await ingestFiles(space.id, [{ filename: "big.txt", text: bigText }]);
    expect(same.totalChunks).toBe(firstChunks);
    expect((await cyborg.listIds({ slug: space.slug })).length).toBe(firstCount);
    expect(cyborg.deleteVectors).not.toHaveBeenCalled();

    // Re-upload a SHORTER version: trailing chunks must be purged.
    const shortText = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    cyborg.deleteVectors.mockClear();
    const shorter = await ingestFiles(space.id, [{ filename: "big.txt", text: shortText }]);
    expect(shorter.totalChunks).toBeLessThan(firstChunks);
    expect(cyborg.deleteVectors).toHaveBeenCalled();

    // Index now holds exactly the shorter file's chunks (no orphans).
    const ids = await cyborg.listIds({ slug: space.slug });
    expect(ids.length).toBe(shorter.totalChunks);

    // Only one Document for the filename (per-file replace).
    const conn = await prisma.connector.findFirstOrThrow({
      where: { spaceId: space.id, kind: UPLOAD_KIND },
    });
    const docs = await prisma.document.findMany({ where: { connectorId: conn.id } });
    expect(docs).toHaveLength(1);
  });

  it("connector chunkCount reflects the total DocumentVector count across files", async () => {
    const space = await makeSpace("Upload Gamma");

    await ingestFiles(space.id, [
      { filename: "one.txt", text: "alpha" },
      { filename: "two.txt", text: "beta\ngamma" },
    ]);

    const conn = await prisma.connector.findFirstOrThrow({
      where: { spaceId: space.id, kind: UPLOAD_KIND },
    });
    const dvCount = await prisma.documentVector.count({
      where: { document: { connectorId: conn.id } },
    });
    expect(conn.chunkCount).toBe(dvCount);
    expect(conn.chunkCount).toBe((await cyborg.listIds({ slug: space.slug })).length);
  });
});
