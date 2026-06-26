// CyborgDB client construction and key-encoding helpers (U4 / KTD4).
//
// The app talks to a `cyborgdb-service` instance over HTTP; the `cyborgdb`
// npm package (cyborgdb-js SDK) exposes `Client` (re-export of `CyborgDB`).
// Per-space 32-byte encryption keys are minted by the SDK, stored as hex in
// the app DB (Space.indexKey), and re-supplied as `Uint8Array` on `loadIndex`.

import { Client } from "cyborgdb";
import { config } from "../config.js";

// Single shared client for the app process. The service runs with auth disabled
// (no CYBORGDB_SERVICE_ROOT_KEY), so the client needs only the base URL.
export const cyborgClient = new Client({
  baseUrl: config.cyborgdbUrl,
});

/**
 * Encode a raw 32-byte index key as a lowercase hex string for DB storage.
 * Throws if the key is not exactly 32 bytes (matches the SDK's own guard).
 */
export function keyToHex(key: Uint8Array): string {
  if (key.length !== 32) {
    throw new Error(`index key must be 32 bytes, got ${key.length}`);
  }
  return Buffer.from(key).toString("hex");
}

/**
 * Decode a hex-encoded index key (as stored on Space.indexKey) back to the
 * raw `Uint8Array` the SDK expects. Throws if the hex does not decode to
 * exactly 32 bytes — a corrupted/truncated key would otherwise surface as a
 * confusing service-side error on load.
 */
export function hexToKey(hex: string): Uint8Array {
  const buf = Buffer.from(hex, "hex");
  // Buffer.from drops invalid hex chars silently, so verify the round-trip
  // length rather than trusting the input string.
  if (buf.length !== 32) {
    throw new Error(
      `index key hex must decode to 32 bytes, got ${buf.length}`,
    );
  }
  return new Uint8Array(buf);
}
