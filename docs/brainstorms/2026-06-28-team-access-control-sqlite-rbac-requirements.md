---
date: 2026-06-28
topic: team-access-control-sqlite-rbac
supersedes-scope-of: docs/brainstorms/2026-06-26-team-access-control-requirements.md
relates-to: docs/plans/2026-06-26-001-feat-team-access-control-plan.md
---

# Team Access Control — SQLite-only (interim) requirements

## Summary

Ship per-space access control for Context Well using **app-layer enforcement only**: workspace `owner`/`admin` plus per-space `editor`/`viewer` roles, stored in SQLite, enforced by route guards and space-list filtering, with an admin-only Members UI and admin-provisioned onboarding. This is a deliberately reduced version of the full [team-access-control plan](../plans/2026-06-26-001-feat-team-access-control-plan.md): the **CyborgDB per-user token layer and all password-based key-wrapping are deferred** and preserved unchanged on a separate branch for a later pass. The goal is to get usable multi-user access control in front of people now, then add cryptographic enforcement as a follow-up.

## Problem Frame

Context Well authenticates users but performs **no authorization** beyond a session-existence check ([src/auth/guard.ts:16-37](../../src/auth/guard.ts#L16-L37)); every space/connector/chat/upload route trusts any logged-in user equally, and `Space` has no owner or membership ([prisma/schema.prisma:34-47](../../prisma/schema.prisma#L34-L47)). This is the gating feature before more than one person uses the app.

The full plan answers this with **two enforcement layers**: app-layer role checks *and* per-user CyborgDB `cdbk_` tokens, with an app master key, the service root key, and per-user tokens all password-wrapped into an in-session keyring. That crypto layer is the bulk of the build (units U1, U2, U4, U5, U6, U7, U10) and gates on flipping `cyborgdb-service` to auth-enabled — a breaking ops change. This interim version keeps **only the app layer** (units U3-minus-secrets, U8, U9, U11) so access control can ship without the crypto/ops lift.

## Key Decisions

- **App-layer enforcement only; accepted interim risk.** Isolation between editors/viewers comes entirely from `requireSpaceRole` guards plus space-list filtering. A forgotten guard on any space-scoped route is a confidentiality bug — the exact failure mode the full design's token layer exists to backstop. This is **accepted for the interim** and closed later by the crypto branch. The route-guard audit (every space-scoped handler must be covered) is therefore load-bearing.

- **CyborgDB service is unchanged.** It stays auth-disabled, with one shared per-space index key stored as plaintext hex ([src/cyborg/index-service.ts:105-138](../../src/cyborg/index-service.ts#L105-L138)) — exactly as today. No service-auth flip, no per-user tokens, no caller-token data path, no index-key wrapping or cutover migration. The data path is untouched by this work.

- **No password-based key-wrapping, no keyring.** No app master key, no root-key envelope, no per-user token wrapping, no in-session keyring. Sessions stay pure DB rows. `node:crypto` wrapping helpers and the keyring are not built here.

- **Keep the owner/admin two-tier model.** First account is `owner`; only the owner promotes/demotes admins; the owner cannot be removed or demoted. Here the distinction means *who manages other admins* (not *who holds the root key*, since there is no root key in this version). Kept because it matches the end-state and costs little.

- **Admin-provisioned onboarding; open registration removed.** Admins create accounts with a temporary password; the user must change it on first login. `ALLOW_REGISTRATION` open self-registration is removed and `/register` becomes bootstrap-only. Without token-wrapping, first-login is just a forced password change — no re-mint, no re-wrap.

- **Admins reach every space.** A workspace admin/owner passes the per-space guard for all spaces and sees all spaces in the list. Isolation is *among editors/viewers*, never *from admins* — intended, same as the full design.

- **Last-admin invariant kept.** The system refuses any demote/remove that would leave zero admins; the owner cannot be demoted or removed. (In the full design this protected the last root-key holder; here it protects the last account that can manage members.)

- **Audit log kept.** Every membership/role/account change — grant, revoke, role change, promote, demote, account creation, password reset, and rejected invariant violations — writes an audit entry (actor, action, target, space, outcome, timestamp; no secret material). A system whose purpose is access control must answer "who granted whom access to what, when." Cheap and app-layer, so it stays.

## Roles & Permission Model

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

(No "CyborgDB token scope" row — there are no per-user tokens in this version.)

## Requirements

### Roles & membership
- R1. The first account created becomes `owner`; the creation screen is labeled to signal this ("Create root/admin user"). The owner cannot be removed or demoted.
- R2. Roles are two-tier: `owner`/`admin` are workspace-level; `editor`/`viewer` are assigned per space. No membership for a space = no access to it.
- R3. Only the owner may promote a user to admin or demote an admin.
- R4. Admins and the owner may grant, change, or revoke any user's per-space `editor`/`viewer` membership.
- R5. The system refuses any role change that would leave zero workspace admins; rejected attempts are audited.

### Authorization enforcement
- R6. Every space-scoped route (space read/update/delete, connector CRUD, sync, upload, chat/query, conversation access) checks the caller's role for the target space and rejects unauthorized callers, in addition to the existing session check. Indirect references (a conversation or connector id belonging to another space) default-deny.
- R7. The space list returns only spaces the caller may access: all spaces for owner/admin, member spaces for editor/viewer.
- R8. No `/api/*` response body exposes secret material; existing `publicSpace`-style masking discipline is preserved (there are no tokens/keys to leak in this version, but the boundary check stays).

### Onboarding & accounts
- R9. Admins create user accounts with a temporary password; open self-registration (`ALLOW_REGISTRATION`) is removed and `/register` is bootstrap-only (returns 403 server-side once any user exists).
- R10. A user must change their temporary password on first login. No token re-wrap is involved — it is a plain forced password change.
- R11. An admin may reset a user's password (sets a new temp password, forces change on next login). The user's prior memberships/roles are unaffected — there are no tokens to re-mint.

### Members UI
- R12. An admin-only Members surface lists users, their workspace role (owner/admin/member), and their per-space roles, and supports create-account, grant/change/revoke per-space role, promote/demote admin (owner only), and password reset. Non-admins never see this view.
- R13. The UI surfaces a non-blocking recommendation to name a second admin while only one exists (operational resilience; in this version it is not about key custody).

### Safety & accountability
- R14. Every membership/role/account change is recorded in an audit log (actor, action, target, space, outcome, timestamp; no secret material), including rejected invariant violations.
- R15. `/login` and admin mutation endpoints are rate-limited to bound online guessing. CSPRNG-generated temp passwords (≥128 bits) with a finite validity window.

## Acceptance Examples

- AE1. **Covers R6, R7.** Given an editor of Space A who is not a member of Space B: when they list spaces, Space B is absent; when they call Space B's document/connector/chat/upload routes directly, the request is 403'd — with no 404-vs-403 oracle confirming B exists.
- AE2. **Covers R6.** Given a viewer of a space: a chat/query succeeds; an upload/connector-mutation route is 403'd at the app layer. *(Note: unlike the full design, nothing below the app enforces this — the guard is the only barrier. See Accepted Risk.)*
- AE3. **Covers R3, R5.** The owner can promote/demote admins; an admin cannot; the system refuses to demote/remove the last admin and refuses to demote the owner, logging the rejection.
- AE4. **Covers R9, R10.** An admin creates an account with a temp password (no auto-login); the user logs in, is forced to change the password, and reaches exactly their granted spaces/roles. `/register` returns 403 once a user exists.
- AE5. **Covers R6.** A viewer of A requests a conversation/connector belonging to B by id → 403 (default-deny), not a leak.

## Scope Boundaries

### Deferred to the crypto branch (preserved, not discarded)
The following are fully designed in the [full plan](../plans/2026-06-26-001-feat-team-access-control-plan.md) and kept on a separate branch for a later pass:
- CyborgDB per-user `cdbk_` tokens and database-level read/write enforcement (plan U1, U6, U7).
- `cyborgdb-service` auth-enabled flip + configured root key (plan U1).
- Password-derived key-wrapping (KDF/AEAD), app master key, root-key & index-key envelopes (plan U2).
- In-session keyring (plan U4).
- Login-time unwrap, temp-password re-wrap, multi-secret transactions (plan U5).
- Index-key envelope cutover migration (plan U10).
- Token-revocation-first deletion ordering and reconcile backstop (plan U12, U6).

### Deferred for later (from origin, unchanged)
- Email invites / email sending; self-service password reset; 2FA; agent service accounts.

### Outside this product's identity (from origin, unchanged)
- SSO / external identity providers; multi-workspace / org tenancy; per-space admins that don't sit in the workspace tier.

## Dependencies / Assumptions

- Reuses existing Prisma + SQLite persistence and signed-cookie sessions; the membership/role/audit model is **additive** ([prisma/schema.prisma](../../prisma/schema.prisma), [src/auth/service.ts](../../src/auth/service.ts)). Drop the `WrappedSecret` table and `Membership.cyborgUserId` from the full design's U3 schema; keep `Membership`, `User.workspaceRole`, and `AuditLog`.
- `cyborgdb-service` continues to run **auth-disabled with shared per-space index keys** — no change to [src/cyborg/](../../src/cyborg/). This is the current production posture.
- Connector credentials and uploads remain per-space, inheriting the space's membership for who may add/use them.
- **Branch strategy (intent; mechanics → planning):** the current `feat/team-access-control` branch already carries the full crypto/token work (commits U1–U6). Preserve that state on a clearly-named branch (e.g. `feat/team-access-control-crypto`) so nothing is lost, and build this SQLite-only version such that it does **not** depend on the wrapped-secret/keyring/token code. How exactly to split (rename + rebuild vs. cherry-pick the app-layer commits) is a planning/execution decision.

## Outstanding Questions

### Deferred to planning
- Exact split mechanics for the existing branch: which committed units (U3 mixes membership+audit, which we keep, with wrapped-secret storage, which we drop) get reworked vs. rebuilt, and how the crypto branch is named and parked.
- Whether `WrappedSecret`, `kdfSalt`, and `keyVerifier` columns are simply omitted from the schema now or stubbed for forward-compatibility with the crypto branch (additive-later vs. clean-now).
- The interim `Space.indexKey` stays plaintext as today; confirm no migration touches it (it is wrapped only on the crypto branch).

## Sources / Research

- Parent v1 requirements: [docs/brainstorms/2026-06-26-team-access-control-requirements.md](2026-06-26-team-access-control-requirements.md).
- Full implementation plan (the superset this carves down): [docs/plans/2026-06-26-001-feat-team-access-control-plan.md](../plans/2026-06-26-001-feat-team-access-control-plan.md) — units U3 (data model), U8 (authorization layer), U9 (membership/account management), U11 (Members UI) are the app-layer subset retained here; U1, U2, U4, U5, U6, U7, U10, U12 are the deferred crypto/token layer.
- Current-state grounding (verified in parent docs): unauthorized routes [src/auth/guard.ts:16-37](../../src/auth/guard.ts#L16-L37), [src/chat/routes.ts:41-71](../../src/chat/routes.ts#L41-L71), [src/uploads/routes.ts:41-94](../../src/uploads/routes.ts#L41-L94); data model [prisma/schema.prisma:34-47](../../prisma/schema.prisma#L34-L47); shared plaintext index key / auth-disabled service [src/cyborg/index-service.ts:105-138](../../src/cyborg/index-service.ts#L105-L138), [src/cyborg/client.ts:1-15](../../src/cyborg/client.ts#L1-L15).
</content>
</invoke>
