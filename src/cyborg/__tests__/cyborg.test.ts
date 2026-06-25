// Tests for the CyborgDB wrapper (U4). The cyborgdb-service is not running in
// CI, so the `cyborgdb` Client is fully mocked. These tests assert the wrapper
// honors the verified SDK contract: cosine metric + embeddingModel at create,
// `include: ["distance","metadata"]` + `queryContents` (never a bare id/vector)
// at query, similarity = 1 - distance, key reuse on re-provision, the
// IndexLockedError classification, the dimension guard, and AE2 (upsert sends
// contents, never a vector).

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock the SDK ----------------------------------------------------------
// A single shared `index` mock object stands in for the EncryptedIndex the
// Client returns from createIndex/loadIndex. Tests reconfigure its method
// return values per-case.

// `vi.mock` factories are hoisted above the module body, so the mock fns they
// reference must be created via `vi.hoisted` to exist when the factory (and the
// imported-under-test module's top-level `new Client()`) run.
const {
  indexMock,
  createIndexMock,
  loadIndexMock,
  generateKeyMock,
  spaceUpdateMock,
} = vi.hoisted(() => ({
  indexMock: {
    upsert: vi.fn(),
    query: vi.fn(),
    delete: vi.fn(),
    listIds: vi.fn(),
    train: vi.fn(),
    deleteIndex: vi.fn(),
    getIndexConfig: vi.fn(),
  },
  createIndexMock: vi.fn(),
  loadIndexMock: vi.fn(),
  generateKeyMock: vi.fn(),
  spaceUpdateMock: vi.fn(),
}));

vi.mock("cyborgdb", () => {
  class Client {
    createIndex = createIndexMock;
    loadIndex = loadIndexMock;
    generateKey = generateKeyMock;
  }
  return { Client };
});

// Config is required() at import time — provide a stub so client.ts constructs.
vi.mock("../../config.js", () => ({
  config: {
    cyborgdbUrl: "http://localhost:8000",
    cyborgdbApiKey: "test-key",
  },
}));

// Prisma is only touched by provisionIndex when persisting a freshly minted key.
vi.mock("../../db/client.js", () => ({
  prisma: { space: { update: spaceUpdateMock } },
}));

// Import under test AFTER mocks are registered.
import {
  deleteIndex,
  deleteVectors,
  EXPECTED_DIMENSION,
  IndexLockedError,
  listIds,
  openIndex,
  provisionIndex,
  query,
  type SpaceRef,
  train,
  upsertChunks,
} from "../index-service.js";

// A valid 32-byte key in hex (64 chars).
const KEY_HEX = "11".repeat(32);

function space(overrides: Partial<SpaceRef> = {}): SpaceRef {
  return {
    id: "space-1",
    slug: "my-space",
    indexKey: KEY_HEX,
    embeddingModel: "all-MiniLM-L6-v2",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path stubs.
  createIndexMock.mockResolvedValue(indexMock);
  loadIndexMock.mockResolvedValue(indexMock);
  generateKeyMock.mockReturnValue(new Uint8Array(32).fill(0xab));
  indexMock.getIndexConfig.mockResolvedValue({ dimension: EXPECTED_DIMENSION });
  indexMock.upsert.mockResolvedValue({ status: "success" });
  indexMock.query.mockResolvedValue({ results: [] });
  indexMock.delete.mockResolvedValue({ status: "success" });
  indexMock.listIds.mockResolvedValue({ ids: [], count: 0 });
  indexMock.train.mockResolvedValue({ status: "success" });
  indexMock.deleteIndex.mockResolvedValue({ status: "success" });
  spaceUpdateMock.mockResolvedValue({});
});

describe("provisionIndex", () => {
  it("creates the index with cosine metric and the space's embedding model", async () => {
    await provisionIndex(space());

    expect(createIndexMock).toHaveBeenCalledTimes(1);
    const arg = createIndexMock.mock.calls[0][0];
    expect(arg.indexName).toBe("my-space");
    expect(arg.metric).toBe("cosine");
    expect(arg.embeddingModel).toBe("all-MiniLM-L6-v2");
    expect(arg.indexKey).toBeInstanceOf(Uint8Array);
    expect(arg.indexKey).toHaveLength(32);
  });

  it("reuses an existing persisted key and does NOT mint a new one", async () => {
    const hex = await provisionIndex(space({ indexKey: KEY_HEX }));

    expect(generateKeyMock).not.toHaveBeenCalled();
    expect(spaceUpdateMock).not.toHaveBeenCalled();
    expect(hex).toBe(KEY_HEX);
    // The reused key is what gets passed to createIndex.
    const arg = createIndexMock.mock.calls[0][0];
    expect(Buffer.from(arg.indexKey).toString("hex")).toBe(KEY_HEX);
  });

  it("mints and persists a key when the space has none", async () => {
    const hex = await provisionIndex(space({ indexKey: "" }));

    expect(generateKeyMock).toHaveBeenCalledTimes(1);
    expect(spaceUpdateMock).toHaveBeenCalledTimes(1);
    expect(spaceUpdateMock.mock.calls[0][0]).toEqual({
      where: { id: "space-1" },
      data: { indexKey: hex },
    });
    expect(hex).toBe("ab".repeat(32));
  });

  it("treats an already-existing index as success (idempotent)", async () => {
    createIndexMock.mockRejectedValueOnce(
      new Error("400 - index 'my-space' already exists"),
    );
    await expect(provisionIndex(space())).resolves.toBe(KEY_HEX);
  });
});

describe("openIndex", () => {
  it("loads with the hex key decoded to a 32-byte Uint8Array", async () => {
    await openIndex(space());
    const arg = loadIndexMock.mock.calls[0][0];
    expect(arg.indexName).toBe("my-space");
    expect(arg.indexKey).toBeInstanceOf(Uint8Array);
    expect(arg.indexKey).toHaveLength(32);
    expect(indexMock.getIndexConfig).toHaveBeenCalled();
  });

  it("throws IndexLockedError when the key is missing", async () => {
    await expect(openIndex(space({ indexKey: "" }))).rejects.toBeInstanceOf(
      IndexLockedError,
    );
    expect(loadIndexMock).not.toHaveBeenCalled();
  });

  it("throws IndexLockedError when loadIndex fails on a wrong key", async () => {
    loadIndexMock.mockRejectedValueOnce(
      new Error("401 - decryption failed: invalid key"),
    );
    await expect(openIndex(space())).rejects.toBeInstanceOf(IndexLockedError);
  });

  it("throws (not IndexLockedError) when dimension !== 384", async () => {
    indexMock.getIndexConfig.mockResolvedValue({ dimension: 768 });
    await expect(openIndex(space())).rejects.toThrow(/dimension 768/);
    await expect(openIndex(space())).rejects.not.toBeInstanceOf(
      IndexLockedError,
    );
  });

  it("rethrows a non-key load error verbatim", async () => {
    loadIndexMock.mockRejectedValue(new Error("503 - service unavailable"));
    await expect(openIndex(space())).rejects.toThrow(/503/);
    await expect(openIndex(space())).rejects.not.toBeInstanceOf(
      IndexLockedError,
    );
  });
});

describe("upsertChunks (AE2)", () => {
  it("sends contents + metadata, never a vector", async () => {
    await upsertChunks(space(), [
      {
        id: "chunk-1",
        contents: "hello world",
        metadata: { snippet: "hello world", title: "Doc", connector: "github" },
      },
    ]);

    expect(indexMock.upsert).toHaveBeenCalledTimes(1);
    const arg = indexMock.upsert.mock.calls[0][0];
    expect(arg.items).toHaveLength(1);
    const item = arg.items[0];
    expect(item.id).toBe("chunk-1");
    expect(item.contents).toBe("hello world");
    expect(item.metadata.snippet).toBe("hello world");
    // AE2: no precomputed vector is ever sent — the service embeds.
    expect(item).not.toHaveProperty("vector");
  });

  it("no-ops on an empty chunk list", async () => {
    await upsertChunks(space(), []);
    expect(loadIndexMock).not.toHaveBeenCalled();
    expect(indexMock.upsert).not.toHaveBeenCalled();
  });
});

describe("query", () => {
  it("passes queryContents and include: [distance, metadata]", async () => {
    indexMock.query.mockResolvedValueOnce({ results: [] });
    await query(space(), "what is X?", 6);

    const arg = indexMock.query.mock.calls[0][0];
    expect(arg.queryContents).toBe("what is X?");
    expect(arg.topK).toBe(6);
    expect(arg.include).toEqual(["distance", "metadata"]);
    // Never a bare id or vector.
    expect(arg).not.toHaveProperty("queryVectors");
    expect(arg).not.toHaveProperty("id");
  });

  it("computes similarity as 1 - distance and normalizes hits", async () => {
    indexMock.query.mockResolvedValueOnce({
      results: [
        { id: "a", distance: 0.2, metadata: { snippet: "sa" } },
        { id: "b", distance: 0.65, metadata: { snippet: "sb" } },
      ],
    });

    const hits = await query(space(), "q", 6);

    expect(hits).toEqual([
      { id: "a", distance: 0.2, similarity: 0.8, metadata: { snippet: "sa" } },
      {
        id: "b",
        distance: 0.65,
        similarity: expect.closeTo(0.35, 10),
        metadata: { snippet: "sb" },
      },
    ]);
  });

  it("defaults a missing distance to 1 (similarity 0)", async () => {
    indexMock.query.mockResolvedValueOnce({
      results: [{ id: "a", metadata: {} }],
    });
    const hits = await query(space(), "q", 6);
    expect(hits[0].distance).toBe(1);
    expect(hits[0].similarity).toBe(0);
  });
});

describe("deleteVectors / listIds / train / deleteIndex", () => {
  it("deleteVectors forwards ids", async () => {
    await deleteVectors(space(), ["x", "y"]);
    expect(indexMock.delete).toHaveBeenCalledWith({ ids: ["x", "y"] });
  });

  it("deleteVectors no-ops on empty ids", async () => {
    await deleteVectors(space(), []);
    expect(loadIndexMock).not.toHaveBeenCalled();
    expect(indexMock.delete).not.toHaveBeenCalled();
  });

  it("listIds returns the SDK's id array", async () => {
    indexMock.listIds.mockResolvedValueOnce({ ids: ["x", "y"], count: 2 });
    await expect(listIds(space())).resolves.toEqual(["x", "y"]);
  });

  it("train invokes the index train()", async () => {
    await train(space());
    expect(indexMock.train).toHaveBeenCalledTimes(1);
  });

  it("deleteIndex invokes the index deleteIndex()", async () => {
    await deleteIndex(space());
    expect(indexMock.deleteIndex).toHaveBeenCalledTimes(1);
  });
});
