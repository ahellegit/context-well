import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock config so importing the service does not require real env vars.
vi.mock("../../config.js", () => ({
  config: { ollamaDefaultUrl: "http://env-default:11434" },
}));

// In-memory stand-in for the SystemSetting KV table.
const kv = new Map<string, string>();

vi.mock("../../db/client.js", () => ({
  prisma: {
    systemSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        const value = kv.get(where.key);
        return value === undefined ? null : { key: where.key, value };
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { key: string };
          create: { key: string; value: string };
          update: { value: string };
        }) => {
          if (kv.has(where.key)) {
            kv.set(where.key, update.value);
            return { key: where.key, value: update.value };
          }
          kv.set(create.key, create.value);
          return { key: create.key, value: create.value };
        },
      ),
    },
  },
}));

// Imported after the mocks are registered.
const { getSettings, updateSettings, isConfigured } = await import(
  "../service.js"
);

beforeEach(() => {
  kv.clear();
});

describe("settings service", () => {
  it("falls back to the .env default URL and empty model when nothing persisted", async () => {
    const s = await getSettings();
    expect(s.ollamaUrl).toBe("http://env-default:11434");
    expect(s.chatModel).toBe("");
  });

  it("reports not configured until both URL and model are persisted", async () => {
    expect(await isConfigured()).toBe(false);
    await updateSettings({ ollamaUrl: "http://localhost:11434" });
    expect(await isConfigured()).toBe(false); // model still missing
    await updateSettings({ chatModel: "llama3:8b" });
    expect(await isConfigured()).toBe(true);
  });

  it("round-trips updateSettings -> getSettings (simulating persistence across restart)", async () => {
    await updateSettings({
      ollamaUrl: "http://my-ollama:11434",
      chatModel: "llama3:8b",
    });

    // A fresh read reflects the persisted KV (the Map survives like the DB would).
    const s = await getSettings();
    expect(s.ollamaUrl).toBe("http://my-ollama:11434");
    expect(s.chatModel).toBe("llama3:8b");
    expect(await isConfigured()).toBe(true);
  });

  it("updates a single field without clobbering the other", async () => {
    await updateSettings({
      ollamaUrl: "http://a:11434",
      chatModel: "model-a",
    });
    await updateSettings({ chatModel: "model-b" });

    const s = await getSettings();
    expect(s.ollamaUrl).toBe("http://a:11434");
    expect(s.chatModel).toBe("model-b");
  });
});
