---
date: 2026-06-26
topic: team-access-control
---

# Team Management & Per-Space Access Control (v1 requirements)

## Summary

Add per-space access control to Context Well. Two tiers: workspace **owners/admins** who hold the CyborgDB root key and manage everything, and per-space **editor/viewer** members. Access is enforced both by app-layer route checks and cryptographically by per-user CyborgDB tokens — the root key and every user's tokens are wrapped under their own passwords and unwrapped only at login, so the running app holds usable keys only for whoever is currently logged in. This is the gating feature before more than one person uses the app.

## Problem Frame

The app today has real accounts and sessions but **no authorization** beyond "is there a valid session?" The single guard in `src/auth/guard.ts` attaches `request.user` and every downstream route then trusts any logged-in user equally — space documents, connectors, chat, and uploads are all reachable by anyone with an account ([src/spaces/routes.ts:79-94](src/spaces/routes.ts#L79-L94), [src/chat/routes.ts:41-71](src/chat/routes.ts#L41-L71), [src/uploads/routes.ts:41-94](src/uploads/routes.ts#L41-L94)). Spaces have no owner or membership field ([prisma/schema.prisma:34-47](prisma/schema.prisma#L34-L47)), so "everyone sees everything" is structural, not a bug.

CyborgDB's whole pitch is encrypted, access-gated search, and it ships native RBAC: a root key can mint per-index user API keys (`cdbk_…`) scoped to one index with read or write permission, list them, and revoke them, with access enforced cryptographically via per-user key re-wrapping. The app already maps one space to one CyborgDB index but currently uses a **single shared index key per space**, stored as plaintext hex, against a service running with **auth disabled** ([src/cyborg/index-service.ts:105-138](src/cyborg/index-service.ts#L105-L138), [src/cyborg/client.ts:1-15](src/cyborg/client.ts#L1-L15)). The opportunity is to let CyborgDB enforce isolation rather than reinventing it in app code.

## Key Decisions

- **Defense-in-depth, crypto-primary enforcement.** App-layer role checks guard every space-scoped route *and* CyborgDB per-user tokens enforce read/write below the app. App-layer checks deliver the isolation; per-user tokens add enforcement the app's own code cannot bypass (a viewer's read token physically cannot upsert) plus a revocation kill-switch at the database.

- **Admin-held, password-wrapped root key (least standing privilege).** The deployment's CyborgDB root key is never stored app-decryptable. It is wrapped under each admin's password (one envelope per admin) and unwrapped into memory only while an admin is logged in. All root-only operations — create/delete space, train, mint/revoke tokens — happen only while an admin is present. A stolen database, or a running app with only non-admins logged in, cannot mint tokens or perform lifecycle.

- **Per-user, password-wrapped `cdbk_` tokens.** Each (user, space) membership maps to a CyborgDB token — read for viewer, write for editor — wrapped under that user's password and unwrapped into their session at login. The app reads a member's space using *their* token, so everyday chat/ingest runs with no root key in memory.

- **Two-tier role model.** `owner`/`admin` are workspace-level because the root key is one per deployment; anyone who manages membership is minting/revoking tokens, a root operation. `editor`/`viewer` are per-space. The prototype's per-space owner/admin matrix is collapsed away.

- **Admins reach every space by design.** Holding root, an admin can always mint themselves a token for any index. Isolation is therefore *among editors/viewers*, never *from admins*. This is intended, not a gap.

- **Single admin allowed; password loss is accepted total loss.** If the last admin forgets their password, the root key is unrecoverable and every space's index becomes permanently undecryptable. v1 accepts this and surfaces a soft UI nudge to name a second admin (which adds a second root-key envelope and removes the single point of loss). No escrow.

- **Admin-provisioned accounts.** Admins create accounts with a temp password the user must change on first login. This is the only onboarding path that keeps the per-user token password-wrapped end-to-end (the admin knows the temp password at grant time, so it can wrap the token then; the user re-wraps on first login). Today's `ALLOW_REGISTRATION` open self-registration is removed.

## Actors

- A1. **Owner** — the bootstrap account (first user created). Workspace-level. Holds a root-key envelope, cannot be removed, and is the only role that promotes/demotes admins. Otherwise identical to admin.
- A2. **Admin** — workspace-level. Holds a root-key envelope. Creates/deletes spaces, creates user accounts, grants/revokes per-space memberships (mints/revokes tokens), and can reach every space.
- A3. **Editor** — per-space member. Holds a write token for that space. Ingests/uploads, manages that space's connectors, edits its prompt, and chats.
- A4. **Viewer** — per-space member. Holds a read token for that space. Chats only.
- A5. **Backend app** — enforces role checks per route, wraps/unwraps keys per session, and proxies CyborgDB calls using the caller's unwrapped token.
- A6. **CyborgDB service** — mints/revokes per-index tokens under the root key and enforces read/write access cryptographically.

## Role & Permission Model

| Action | owner | admin | editor | viewer | non-member |
|---|---|---|---|---|---|
| See space in list | all | all | member spaces | member spaces | — |
| Chat / query space | ✓ | ✓ | ✓ | ✓ | ✗ |
| Upload / trigger sync (ingest) | ✓ | ✓ | ✓ | ✗ | ✗ |
| Add/remove connectors, edit space prompt | ✓ | ✓ | ✓ | ✗ | ✗ |
| Create / delete space | ✓ | ✓ | ✗ | ✗ | ✗ |
| Grant/revoke per-space membership | ✓ | ✓ | ✗ | ✗ | ✗ |
| Create user accounts | ✓ | ✓ | ✗ | ✗ | ✗ |
| Promote/demote admins | ✓ | ✗ | ✗ | ✗ | ✗ |
| CyborgDB token scope | root (mints own) | root (mints own) | write | read | none |

## Requirements

### Roles & membership

- R1. The first account created becomes the `owner`; the creation screen is labeled to signal this ("Create root/admin user"). The owner cannot be removed or demoted.
- R2. Roles are two-tier: `owner`/`admin` are workspace-level; `editor`/`viewer` are assigned per space. A user with no membership for a space has no access to it.
- R3. Only the owner may promote a user to admin or demote an admin. Promoting an admin wraps a copy of the root key under that admin's (current or temp) password; demoting removes their root-key envelope.
- R4. Admins and the owner may grant, change, or revoke any user's per-space `editor`/`viewer` membership.

### Authorization enforcement

- R5. Every space-scoped route (space read/update/delete, connector CRUD, sync, upload, chat/query, conversation access) checks the caller's role for the target space and rejects unauthorized callers, in addition to the existing session check.
- R6. The space list returns only spaces the caller may access: all spaces for owner/admin, member spaces for editor/viewer.
- R7. Per-user CyborgDB tokens enforce read vs write at the database: a viewer holds a read token, an editor a write token, so ingest/upsert is impossible for a viewer even if an app-layer check is missing.
- R8. Removing a member, or lowering their permission, revokes their CyborgDB token at the service so a cached or leaked token stops working.

### CyborgDB key & token strategy

- R9. The deployment uses a single CyborgDB root key. It is stored only as password-wrapped envelopes (one per admin), never in app-decryptable form, and is unwrapped into memory only while an admin is logged in.
- R10. Each (user, space) membership maps to a CyborgDB `cdbk_` token scoped to that index with the role's permission. The token is stored wrapped under the user's password and unwrapped into the user's session at login.
- R11. Root-only operations — create/delete index, train, mint/revoke tokens — are performed only by an admin session that has the root key unwrapped.
- R12. Existing spaces' shared plaintext `Space.indexKey` must be migrated into the new model (the migration path is deferred to planning; see Outstanding Questions).

### Onboarding & accounts

- R13. Admins create user accounts with a temporary password; open self-registration (`ALLOW_REGISTRATION`) is removed.
- R14. A user must change their temporary password on first login; on that change, any tokens provisioned at grant time are re-wrapped under the user's new password.
- R15. When an admin grants a not-yet-logged-in user membership, the token is minted and wrapped under the temp-password-derived key, so no app-decryptable copy of a member token is ever stored.
- R16. Resetting a user's password (admin action) invalidates their existing password-wrapped tokens; the admin re-mints and re-wraps that user's tokens so they regain access.

### Members UI

- R17. An admin-only Members surface lists users, their workspace role (owner/admin/member), and their per-space roles, and supports create-account, grant/change/revoke per-space role, promote/demote admin (owner only), and password reset.
- R18. The UI surfaces a non-blocking recommendation to name a second admin while only one exists, explaining that a sole admin's lost password means unrecoverable data.

## Key Flows

- F1. First-run bootstrap
  - **Trigger:** No accounts exist; first person registers.
  - **Steps:** Create the `owner` account → generate the CyborgDB root key → wrap it under the owner's password → land in the app.
  - **Outcome:** Owner holds the only root-key envelope; the service is ready for RBAC operations.
  - **Covers:** R1, R9

- F2. Onboard a user and grant space access
  - **Trigger:** Admin adds a person and gives them a space.
  - **Steps:** Admin creates the account with a temp password (shared out-of-band) → admin (root unwrapped) mints a read/write token scoped to the space → token wrapped under the temp-password key → membership recorded.
  - **Outcome:** User can log in and reach exactly the granted space at the granted permission.
  - **Covers:** R4, R10, R13, R15

- F3. Member login and credential unwrap
  - **Trigger:** A member logs in.
  - **Steps:** Password verified → derive the wrapping key → unwrap that user's space tokens (and, for an admin, the root key) into the session → first-login temp-password change forces a re-wrap.
  - **Outcome:** Session holds the user's usable tokens; the app can act as that user against CyborgDB.
  - **Covers:** R10, R14

- F4. Grounded chat as a member
  - **Trigger:** A member sends a message in a space they belong to.
  - **Steps:** Route checks membership/role → app queries the index using the member's *own* unwrapped read token → retrieval → prompt + context → Ollama → cited answer.
  - **Outcome:** Answer grounded in a space the member is authorized for, with no root key in memory.
  - **Covers:** R5, R7

- F5. Role change or removal
  - **Trigger:** Admin demotes editor→viewer, or removes a member.
  - **Steps:** App (admin session, root unwrapped) revokes the old token at CyborgDB → for a demotion, mints the lower-permission token and stores it wrapped → membership row updated or deleted.
  - **Outcome:** The member's access reflects the new role immediately, enforced at the database, not just in app state.
  - **Covers:** R4, R8, R11

## Acceptance Examples

- AE1. **Covers R5, R6.** Given a user who is an editor of Space A and not a member of Space B, when they list spaces, then Space B is absent; and when they call Space B's document/connector/chat routes directly, then the request is rejected.
- AE2. **Covers R7.** Given a viewer of a space, when an upsert/ingest is attempted on their behalf (including via a route that forgot its check), then CyborgDB rejects the write because their token is read-only.
- AE3. **Covers R8.** Given a member is removed from a space, when a previously issued token for that space is replayed, then CyborgDB rejects it because it was revoked.
- AE4. **Covers R4, R8, R11.** Given an editor is demoted to viewer, when they next ingest, then it fails (write token revoked) but chat still works (read token present).
- AE5. **Covers R9, R18.** Given two admins exist and one forgets their password, when the owner resets it, then no data is lost because the second admin's envelope still unwraps the root key; given only one admin exists and they lose their password, then all spaces are unrecoverable — the documented, accepted outcome the nudge warns about.
- AE6. **Covers R13, R16.** Given a user forgets their password, when an admin resets it and re-mints their tokens, then the user regains access to exactly their prior spaces and roles, and their old wrapped tokens no longer unwrap.

## Scope Boundaries

### Deferred for later
- Email-based invites and any email sending (onboarding is admin-created accounts + out-of-band temp passwords).
- Two-factor authentication (the prototype's 2FA column).
- Agent service accounts / non-human tokens.
- Self-service password reset (admin-driven reset only in v1).

### Outside this product's identity
- Single sign-on (SSO) and external identity providers.
- Multi-workspace / org tenancy — this stays one workspace with many spaces; per-customer isolation is not the product.
- Per-space admins or a delegated management tier that does not hold root — management that mints/revokes tokens must be a root holder.

## Dependencies / Assumptions

- **cyborgdb-service must run with RBAC/auth enabled and a configured root key.** It currently runs auth-disabled with no API key on the client ([src/cyborg/client.ts:1-15](src/cyborg/client.ts#L1-L15)). This is a hard prerequisite — none of the token machinery works until it is flipped on.
- **The CyborgDB SDK exposes per-index user-token mint/list/revoke with read/write scopes.** Asserted from CyborgDB's RBAC design; the exact `cyborgdb-js` surface (method names, scope flags, revocation semantics) must be confirmed against the SDK at planning.
- The existing Prisma + SQLite persistence and signed-cookie session machinery are reused; new membership, role, and wrapped-secret storage are additive ([prisma/schema.prisma](prisma/schema.prisma), [src/auth/service.ts](src/auth/service.ts)). `SystemSetting` is a candidate home for workspace-level state such as root-key envelopes.
- Connector credentials and uploads remain per-space, inheriting the space's membership for who may add/use them.

## Outstanding Questions

### Resolve before planning
- **Does editor-triggered CyborgDB `train` require a client-side root key?** Training is root-only and fires once a corpus crosses a threshold. If the service trains internally (it holds the keys), editors ingest with only a write token and nothing stalls. If a client-side root call is required, then ingestion by an editor while no admin is logged in cannot complete — which would force either keeping root standing-available (collapsing the least-privilege design) or gating/deferring ingestion to admin presence. This is load-bearing for the whole architecture.

### Deferred to planning
- KDF/KEK derivation and envelope format for password-wrapping (root key and per-user tokens).
- Where wrapped envelopes and wrapped tokens live (new tables vs `SystemSetting`), and the schema for memberships/roles.
- Migration of existing spaces' plaintext `Space.indexKey` into the new model (re-key vs wrap-in-place).
- Whether owner/admin per-space query tokens are minted on demand at access time or persisted like member tokens.
- Behavior of an in-flight session when its user is removed mid-session (token revoked at DB; whether the live session is also torn down).
- Exact mechanism for wrapping a token at grant time when the user is offline (temp-password-derived key handoff).

## Sources / Research

- Prior brainstorm that deferred this: [docs/brainstorms/2026-06-25-knowledgellm-rag-cyborgdb-requirements.md](docs/brainstorms/2026-06-25-knowledgellm-rag-cyborgdb-requirements.md) (R2 "no role enforcement," R8 index-key lifecycle, deferred RBAC).
- Current-state grounding (all verified against source): auth guard [src/auth/guard.ts:16-37](src/auth/guard.ts#L16-L37); unprotected resource routes [src/spaces/routes.ts:79-94](src/spaces/routes.ts#L79-L94), [src/chat/routes.ts:41-71](src/chat/routes.ts#L41-L71), [src/uploads/routes.ts:41-94](src/uploads/routes.ts#L41-L94); sessions + bootstrap + gated registration [src/auth/service.ts:29-32](src/auth/service.ts#L29-L32), [src/auth/routes.ts:75-86](src/auth/routes.ts#L75-L86), [src/config.ts:35-47](src/config.ts#L35-L47); shared per-space index key and no per-user tokens [src/cyborg/index-service.ts:105-138](src/cyborg/index-service.ts#L105-L138), [src/cyborg/client.ts:1-15](src/cyborg/client.ts#L1-L15); data model [prisma/schema.prisma:34-47](prisma/schema.prisma#L34-L47).
</content>
</invoke>
