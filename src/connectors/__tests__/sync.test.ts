// Sync orchestration tests (U7). The CyborgDB index-service is fully mocked with
// a stateful in-memory index per space slug, so upsert/delete/listIds behave
// like the real thing for reconciliation assertions without a running service.
// A fake connector streams a controllable chunk set. Prisma runs against the
// throwaway SQLite DB from the suite-wide setupFile.
//
// Coverage (per U7 test scenarios):
// - sync ingests chunks, writes Document/DocumentVector rows, status connected
//   with counts;
// - resync after a source deletion purges the stale vectors (reconciled vs
//   listIds ground truth);
// - idempotent no-op resync;
// - one-of-N targets fails → status partial with per-target detail;
// - concurrent sync on the same space → SyncInProgressError;
// - two different spaces sync in parallel without contention;
// - credential masking in the list route.

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock the cyborg index-service with a stateful in-memory store ----------
// Keyed by space slug → Map<vectorId, {contents, metadata}>. upsert/delete/
// listIds mutate it so the orchestrator's reconcile + purge are observable.
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
    upsertChunks: vi.fn(async (space: { slug: string }, chunks: { id: string; contents: string; metadata: unknown }[]) => {
      const idx = indexFor(space.slug);
      for (const c of chunks) idx.set(c.id, { contents: c.contents, metadata: c.metadata });
    }),
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
const { syncConnector, SyncInProgressError, MAX_CHUNKS_PER_SYNC } = await import("../sync.js");
const { registerConnector, clearConnectors } = await import("../registry.js");
const { chunkId } = await import("../chunk.js");
const connectorsRoutes = (await import("../routes.js")).default;
import type { Chunk } from "../types.js";

// --- A fake connector whose sync output the test controls -------------------
// `program` maps targetId → list of {ref, chunks:string[]}. A target id present
// in `failures` throws a per-target error from the iterator.
interface SourceUnit {
  ref: string;
  title: string;
  chunks: string[];
}
let program = new Map<string, SourceUnit[]>();
let failures = new Set<string>();

function makeChunk(target: string, ref: string, title: string, idx: number, body: string): Chunk {
  return {
    id: chunkId("fake", target, ref, idx),
    contents: body,
    metadata: { snippet: body, title, connector: "fake", target, ref },
  };
}

const fakeConnector = {
  kind: "fake",
  async validate() {
    return { ok: true };
  },
  async listTargets() {
    return [...program.keys()].map((id) => ({ id, label: id }));
  },
  async *sync(_creds: unknown, targetIds: string[]): AsyncIterable<Chunk> {
    for (const target of targetIds) {
      if (failures.has(target)) {
        const err = new Error(`target ${target} blew up`) as Error & { targetId: string };
        err.targetId = target;
        throw err;
      }
      for (const unit of program.get(target) ?? []) {
        for (let i = 0; i < unit.chunks.length; i++) {
          yield makeChunk(target, unit.ref, unit.title, i, unit.chunks[i]);
        }
      }
    }
  },
};

// --- Helpers ----------------------------------------------------------------
async function makeSpace(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return prisma.space.create({ data: { name, slug, indexKey: "a".repeat(64) } });
}

async function makeConnector(spaceId: string, targets: string[]) {
  return prisma.connector.create({
    data: { spaceId, kind: "fake", credentials: "secret-token-1234", targets: JSON.stringify(targets) },
  });
}

beforeEach(async () => {
  await prisma.space.deleteMany();
  cyborg.store.clear();
  cyborg.upsertChunks.mockClear();
  cyborg.deleteVectors.mockClear();
  cyborg.listIds.mockClear();
  cyborg.train.mockClear();
  clearConnectors();
  registerConnector(fakeConnector);
  program = new Map();
  failures = new Set();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("syncConnector", () => {
  it("ingests chunks, writes doc/vector rows, status connected with counts", async () => {
    const space = await makeSpace("Alpha");
    const conn = await makeConnector(space.id, ["repoA"]);
    program.set("repoA", [
      { ref: "README.md", title: "README", chunks: ["line one", "line two"] },
      { ref: "main.ts", title: "main.ts", chunks: ["code a"] },
    ]);

    const result = await syncConnector(conn.id);

    expect(result.status).toBe("connected");
    expect(result.chunkCount).toBe(3);
    expect(result.documentCount).toBe(2);
    expect(result.purged).toBe(0);

    // Vectors landed in the (mock) index.
    expect((await cyborg.listIds({ slug: space.slug })).length).toBe(3);

    // Document + DocumentVector rows written.
    const docs = await prisma.document.findMany({ where: { connectorId: conn.id }, include: { vectors: true } });
    expect(docs).toHaveLength(2);
    const totalVectors = docs.reduce((n, d) => n + d.vectors.length, 0);
    expect(totalVectors).toBe(3);

    // Connector row reflects status + counts + lastSyncAt.
    const reread = await prisma.connector.findUniqueOrThrow({ where: { id: conn.id } });
    expect(reread.status).toBe("connected");
    expect(reread.chunkCount).toBe(3);
    expect(reread.lastSyncAt).not.toBeNull();
  });

  it("resync after a source deletion purges the stale vectors (reconciled vs listIds)", async () => {
    const space = await makeSpace("Beta");
    const conn = await makeConnector(space.id, ["repoA"]);
    program.set("repoA", [
      { ref: "a.md", title: "a", chunks: ["aaa"] },
      { ref: "b.md", title: "b", chunks: ["bbb"] },
    ]);
    await syncConnector(conn.id);
    expect((await cyborg.listIds({ slug: space.slug })).length).toBe(2);

    // Source loses b.md on the next sync.
    program.set("repoA", [{ ref: "a.md", title: "a", chunks: ["aaa"] }]);
    const result = await syncConnector(conn.id);

    expect(result.purged).toBe(1);
    const ids = await cyborg.listIds({ slug: space.slug });
    expect(ids).toEqual([chunkId("fake", "repoA", "a.md", 0)]);

    // DB rows reconciled to the single surviving document.
    const docs = await prisma.document.findMany({ where: { connectorId: conn.id } });
    expect(docs).toHaveLength(1);
    expect(docs[0].externalRef).toBe("a.md");
  });

  it("does NOT purge stale vectors when the sync truncated (cap hit)", async () => {
    const space = await makeSpace("Truncated");
    const conn = await makeConnector(space.id, ["repoA"]);

    // First sync: two source units land cleanly (2 vectors).
    program.set("repoA", [
      { ref: "a.md", title: "a", chunks: ["aaa"] },
      { ref: "b.md", title: "b", chunks: ["bbb"] },
    ]);
    await syncConnector(conn.id);
    expect((await cyborg.listIds({ slug: space.slug })).length).toBe(2);

    // Second sync: the source now drops b.md but emits MORE than the cap so the
    // pull truncates before it can confirm the full fresh set. A truncated pull
    // must NOT purge — b.md's vector is still valid and freshIds is incomplete.
    const overCap: SourceUnit[] = [];
    overCap.push({ ref: "a.md", title: "a", chunks: ["aaa"] });
    // One big unit whose chunk count exceeds the cap.
    overCap.push({
      ref: "big.md",
      title: "big",
      chunks: Array.from({ length: MAX_CHUNKS_PER_SYNC + 5 }, (_, i) => `c${i}`),
    });
    program.set("repoA", overCap);

    cyborg.deleteVectors.mockClear();
    const result = await syncConnector(conn.id);

    expect(result.truncated).toBe(true);
    expect(result.status).toBe("partial");
    expect(result.purged).toBe(0);
    // The purge was skipped entirely — no deleteVectors call, and b.md survives.
    expect(cyborg.deleteVectors).not.toHaveBeenCalled();
    const ids = await cyborg.listIds({ slug: space.slug });
    expect(ids).toContain(chunkId("fake", "repoA", "b.md", 0));
  }, 20_000);

  it("is an idempotent no-op when the source is unchanged", async () => {
    const space = await makeSpace("Gamma");
    const conn = await makeConnector(space.id, ["repoA"]);
    program.set("repoA", [{ ref: "a.md", title: "a", chunks: ["aaa", "more"] }]);

    await syncConnector(conn.id);
    cyborg.deleteVectors.mockClear();

    const result = await syncConnector(conn.id);
    expect(result.purged).toBe(0);
    expect(cyborg.deleteVectors).not.toHaveBeenCalled();
    // Same 2 vectors, no duplicates (stable IDs).
    expect((await cyborg.listIds({ slug: space.slug })).length).toBe(2);
  });

  it("marks status partial with per-target detail when one of N targets fails", async () => {
    const space = await makeSpace("Delta");
    const conn = await makeConnector(space.id, ["good", "bad"]);
    program.set("good", [{ ref: "g.md", title: "g", chunks: ["ok"] }]);
    failures.add("bad");

    const result = await syncConnector(conn.id);

    expect(result.status).toBe("partial");
    const bad = result.targets.find((t) => t.targetId === "bad");
    expect(bad?.ok).toBe(false);
    expect(bad?.message).toContain("blew up");

    const reread = await prisma.connector.findUniqueOrThrow({ where: { id: conn.id } });
    expect(reread.status).toBe("partial");
    const detail = JSON.parse(reread.detail);
    expect(detail.targets.find((t: { targetId: string }) => t.targetId === "bad").ok).toBe(false);
  });

  it("rejects a concurrent sync on the same space with SyncInProgressError", async () => {
    const space = await makeSpace("Epsilon");
    const conn = await makeConnector(space.id, ["repoA"]);
    program.set("repoA", [{ ref: "a.md", title: "a", chunks: ["aaa"] }]);

    // Hold the lock by making the first sync's upsert block until released.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    cyborg.upsertChunks.mockImplementationOnce(async (sp: { slug: string }, chunks: { id: string; contents: string; metadata: unknown }[]) => {
      await gate;
      const idx = cyborg.indexFor(sp.slug);
      for (const c of chunks) idx.set(c.id, { contents: c.contents, metadata: c.metadata });
    });

    const first = syncConnector(conn.id);
    // Give the first sync a tick to acquire the lock and enter upsert.
    await new Promise((r) => setTimeout(r, 10));

    await expect(syncConnector(conn.id)).rejects.toBeInstanceOf(SyncInProgressError);

    release();
    await first;
  });

  it("syncs two different spaces in parallel without contention", async () => {
    const s1 = await makeSpace("Space One");
    const s2 = await makeSpace("Space Two");
    const c1 = await makeConnector(s1.id, ["r1"]);
    const c2 = await makeConnector(s2.id, ["r2"]);
    program.set("r1", [{ ref: "x", title: "x", chunks: ["x1"] }]);
    program.set("r2", [{ ref: "y", title: "y", chunks: ["y1"] }]);

    const [r1, r2] = await Promise.all([syncConnector(c1.id), syncConnector(c2.id)]);
    expect(r1.status).toBe("connected");
    expect(r2.status).toBe("connected");
    expect((await cyborg.listIds({ slug: s1.slug })).length).toBe(1);
    expect((await cyborg.listIds({ slug: s2.slug })).length).toBe(1);
  });
});

describe("connectorsRoutes credential masking", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(connectorsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("masks credentials to {set,last4} in the list route (R29)", async () => {
    const space = await makeSpace("Masked");
    await makeConnector(space.id, ["repoA"]);

    const res = await app.inject({ method: "GET", url: `/api/spaces/${space.id}/connectors` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].credentials).toEqual({ set: true, last4: "1234" });
    // The raw token never appears anywhere in the serialized response.
    expect(res.payload).not.toContain("secret-token-1234");
  });
});
