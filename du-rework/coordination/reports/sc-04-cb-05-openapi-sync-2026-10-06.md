# SC-04 / CB-05 / PM-M07 — OpenAPI regeneration and docs sync

- Date: 2026-10-06 (Asia/Bangkok).
- Owner: codex_arch, direct user packet; cwd `D:\Git\dugate\du-rework`.
- Status: **generator/docs IMPLEMENTED + offline checks PASS**. Independent API/security review and SC/CB live acceptance OPEN. No commit, push, deployment, database or provider calls.
- `docs/21-openapi.json` was written only by `python tools/openapi/gen_openapi.py`, never hand-edited.

## Outcome and changed paths

| File | Change |
|---|---|
| `tools/openapi/gen_openapi.py` | Adds existing Secrets BFF operations, Portal session scheme and configurable Portal origin 3001; loads canonical SC/CB model projection; documents unavailable surfaces; extends NO-DROP from paths to operations; repairs existing missing path parameters/query schemas; script-relative cwd |
| `tools/openapi/catalog_callback_schemas.cjs` | New source-derived OpenAPI projection of canonical Zod SC/CB modules, plus legacy webhook envelope. Transpiles current TypeScript in a scoped one-shot Node process; does not use stale dist. Unsupported Zod types/checks fail closed. Strict read models contain no value; literal fields writeOnly; runtime refinements explicitly annotated |
| `tools/openapi/validate_openapi.py` | Canonical projection parity, local refs resolution, unique declared operation IDs, BFF auth/model/availability checks; script-relative cwd; existing 23 example probes retained |
| `docs/21-openapi.json` | Generated v1.4.0 artifact: **58 paths / 62 operations / 51 schemas**, including 37 projected SC/CB/notification models |
| `docs/08-connector-api.md` | Secrets BFF origin/auth/tenant/CAS/no-readback, callback receiver modes/limits/HMAC/dedup/auth refs, current-vs-target gaps |
| `docs/40-du-platform-architecture.md` | Portal→BFF→Internal API boundary, source-derived model generation, missing upstream/admission/resolver wiring and acceptance scope |
| `coordination/reports/raw/sc-04-cb-05-openapi-sync-2026-10-06/*` | Commands/exits/logs, reproducible offline verification runner, summary and changed-file hashes |

The existing Public/Internal/Runtime/Connector paths remain. Secrets BFF uses `DU_OPENAPI_PORTAL_ORIGIN` (default `http://localhost:3001`), tag/family `admin` and `PortalSession` cookie `du_session`, with platform-admin and CSRF required for mutations. BFF is not misassigned to the Internal 3002 or Connector 8080 listener. No fake `/api/v1/admin/secrets*` or callback endpoint is generated.

## Source reconciliation / MISMATCH register

| ID | Expected / actual at source inspection | Owner / verification needed |
|---|---|---|
| SC-04-M01 | Secret catalog upstream exists → only BFF calls reference `/api/v1/admin/secrets*`; no active upstream handlers found. SC-01 receipt is contracts-only, SC-03 receipt also records upstream absent | SC catalog/backend owner: repository/router/storage/tenant/purpose/CAS/no-readback + independent VFY-SC. Spec marks BFF-only upstream 404/503; models are not deployment proof |
| SC-04-M02 | POST `/admin/api/secrets` reaches create → `bff/secrets.ts:58` matches list, `:80-82` requires GET for list, so POST is 405 before create branch `:172-175`. No get-by-id/delete/plaintext resolve routes exist | BFF owner fix method dispatch + focused create-vs-list tests. Spec exposes current POST as unavailable 405 with planned DTO annotation, not successful create |
| CB-05-M01 | Editor `policy.callbackPolicy` persists/pins → only Portal sends it; canonical `profile-policy.ts` and profile/admission implementation have no callbackPolicy field at inspection | Profile/admission integrator: wire draft/publish/read/snapshot and operation pin writer; current spec publishes contract models separately rather than falsely claiming field acceptance |
| CB-05-M02 | Authenticated callback ready → CB-02 dispatcher requires resolver; owner receipt says production resolver/admission writer missing, so credential policies fail closed | CB/SC integrator: production resolver + live PG/HTTPS token/receiver VFY. Model/auth descriptions do not claim live delivery |
| CB-05-M03 | Catalog and callback secret refs interchangeable → catalog ValueSource uses UUID `secret_ref`, frozen callback uses opaque `managed-secret` ref | Contract/consumer owners reconcile mapping explicitly; no guessed alias or plaintext expansion in docs/spec |

Anchors reflect the read snapshot; other lanes may move lines. No product-source fixes made in this packet. `notification_with_result` receiver model describes explicit omission reasons, bounds, expiring relative authenticated artifact paths and retry dedup, not an invented REST callback route. Schema projection cannot encode every Zod refinement (reserved headers, approved-origin/SSRF checks, conditional create values); `x-runtime-validation`, model descriptions and docs keep canonical validation authoritative.

## Verification (offline)

Environment: Windows; Python 3.13, local Node/pnpm toolchain. No DB/Redis/S3/Vault/live receiver or Docker started. Structural validator `openapi-spec-validator 0.9.0` installed only into `%TEMP%/du-openapi-validator-sc04`; no project dependency/lockfile changed.

| Command / cwd `du-rework` | Result | Raw evidence |
|---|---|---|
| `python tools/openapi/gen_openapi.py` | exit 0; **NO-DROP paths=0, operations=0**; 58/62/51 final inventory | `generator.log`, `generator.exit.txt` |
| Same generator repeated | exit 0, byte-identical artifact SHA-256 | `generator-repeat.log`, `generator-repeat.exit.txt` |
| `python tools/openapi/validate_openapi.py` | exit 0; 37 canonical model projections match, refs resolve, declared operation IDs unique; **23/23 existing canonical example probes PASS** | `validator.log`, `validator.exit.txt` |
| `OpenAPIV30SpecValidator` via offline receipt runner | **0 structural errors**, exit 0. First exploratory run found 36 pre-existing missing parameter/schema errors; fixed in generator before final validation | `structural.log`, `structural.exit.txt` |
| `pnpm --filter @du/contracts exec jest --runTestsByPath tests/secret-catalog.test.ts tests/profile-callback.test.ts --runInBand` | **2 suites / 30 passed / 0 failed / 0 skipped**, exit 0 | `contracts-focused.log`, `contracts-focused.exit.txt` |
| `python coordination/reports/raw/sc-04-cb-05-openapi-sync-2026-10-06/verify-sync.py` | exit 0; generation/parity/structural/repeat/hash evidence recorded | `run-summary.json`, `SHA256SUMS.txt` |

Raw folder: [sc-04-cb-05 evidence](raw/sc-04-cb-05-openapi-sync-2026-10-06/run-summary.json). Artifact SHA-256: `7f0afb86c151e5ee204e82cc75c4dda3cfca1f14c51cf6ab403b51da26a46840`. Changed-file hashes: [SHA256SUMS.txt](raw/sc-04-cb-05-openapi-sync-2026-10-06/SHA256SUMS.txt). Focused test counts and example probes are distinct checks, not a combined unique-test claim.

## Handoff / acceptance

SC-04/CB-05 docs/generator work complete for implemented snapshot; SC/CB owners resolve M01..M03 before full feature acceptance. Independent reviewer checks schema fidelity, unavailable routes and BFF/Connector listener separation. Portal bundles the spec at build time, so build integrator must rebuild candidate and bind browser/API Reference checks to the new artifact hash; prior Portal UI/r3 receipts cannot prove this new spec is in the image. Remaining profiles/callback/secret live tests, encryption/resolution and security review remain OPEN. No parent tick or VERIFIED/ACCEPTED claim from this owner packet.
