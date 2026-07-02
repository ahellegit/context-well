// Connector registry. Maps a connector `kind` to its implementation so the
// orchestrator and the routes can resolve a connector by kind and so the UI can
// list the installed connectors.
//
// The registry is populated by the connector modules (github, slack) via
// `registerConnector` — either through an explicit call those modules make or by
// import side-effect. This module ships empty; it does not import the concrete
// connectors itself (that would create a dependency the layering does not want).
// Callers that need a populated registry import the connector modules.

import type { Connector } from "./types.js";

const registry = new Map<string, Connector>();

/**
 * Register (or replace) a connector implementation under its `kind`. Idempotent
 * on re-registration, which keeps import-side-effect registration safe under a
 * module that loads more than once (e.g. in tests).
 */
export function registerConnector(connector: Connector): void {
  registry.set(connector.kind, connector);
}

/** Look up a connector by kind, or undefined if none is registered. */
export function getConnector(kind: string): Connector | undefined {
  return registry.get(kind);
}

/** All registered connectors, in registration order. */
export function listConnectors(): Connector[] {
  return [...registry.values()];
}

/** Remove all registrations — test isolation helper. */
export function clearConnectors(): void {
  registry.clear();
}
