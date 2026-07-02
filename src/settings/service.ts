// Settings service: persists the Ollama URL + selected chat model in the
// SystemSetting KV table so config survives restarts and is workspace-global.
// `.env` only supplies optional defaults — the persisted
// value wins once setup has run.

import { prisma } from "../db/client.js";
import { config } from "../config.js";

// KV keys used in the SystemSetting table.
const KEY_OLLAMA_URL = "ollama.url";
const KEY_CHAT_MODEL = "ollama.chatModel";

export interface AppSettings {
  ollamaUrl: string;
  chatModel: string;
}

async function readKv(key: string): Promise<string | undefined> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row?.value;
}

async function writeKv(key: string, value: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/**
 * Current persisted settings. The Ollama URL falls back to the optional `.env`
 * default hint when nothing has been persisted yet; the chat model has no
 * default (the user picks it during setup).
 */
export async function getSettings(): Promise<AppSettings> {
  const [ollamaUrl, chatModel] = await Promise.all([
    readKv(KEY_OLLAMA_URL),
    readKv(KEY_CHAT_MODEL),
  ]);
  return {
    ollamaUrl: ollamaUrl ?? config.ollamaDefaultUrl ?? "",
    chatModel: chatModel ?? "",
  };
}

/**
 * Upsert the Ollama URL and/or chat model. Either field may be omitted to leave
 * the existing persisted value untouched.
 */
export async function updateSettings(
  input: Partial<AppSettings>,
): Promise<AppSettings> {
  const writes: Promise<void>[] = [];
  if (typeof input.ollamaUrl === "string") {
    writes.push(writeKv(KEY_OLLAMA_URL, input.ollamaUrl));
  }
  if (typeof input.chatModel === "string") {
    writes.push(writeKv(KEY_CHAT_MODEL, input.chatModel));
  }
  await Promise.all(writes);
  return getSettings();
}

/**
 * True when both an Ollama URL and a chat model have been persisted. The
 * frontend uses this on load to route to the app vs the setup wizard.
 * Only persisted values count — the `.env` default hint alone is not "configured".
 */
export async function isConfigured(): Promise<boolean> {
  const [ollamaUrl, chatModel] = await Promise.all([
    readKv(KEY_OLLAMA_URL),
    readKv(KEY_CHAT_MODEL),
  ]);
  return Boolean(ollamaUrl && chatModel);
}
