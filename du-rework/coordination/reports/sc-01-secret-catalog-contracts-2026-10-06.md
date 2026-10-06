# SC-01 — Secret catalog schemas & ValueSource contract freeze — receipt

Task: `SC-01` under `tasks/SECRET-CATALOG-2026-10-06.md`. Owner: OpenCode 1 (`oc_1`), platform contracts & catalog
integrator. Date: 2026-10-06. No commit, no push.
Status: **contract freeze IMPLEMENTED + offline tests green; SC-02..05 and VFY-SC-01 stay OPEN.** No repository,
admin API, resolver, migration or Portal code was changed.

## 1. What was frozen

`packages/contracts/src/secret-catalog.ts` (exported via `packages/contracts/src/index.ts`):

| Area | Frozen artifact |
|---|---|
| ValueSource | `ValueSourceSchema` object tagged union: `literal` (write-only, 1..64 KiB, NUL rejected) or `secret_ref` (`secretId` uuid). `parseValueSourceStrict` throws `ValueSourceParseError('AMBIGUOUS_STRING')` for any single string, including `vault://…`; `isValueSource` for guards |
| Catalog entry | `SecretCatalogEntrySchema`: `catalogVersion 1`, `secretId` uuid, `tenantId` uuid, display `name` (bounded label, control chars rejected), `purpose` enum (connector/profile-callback/OIDC/source/generic), `services` ∈ {orchestrator, connector}, `provider`, `state` ∈ {ACTIVE, DISABLED, REVOKED}, `revision ≥ 1`, optional `rotation` metadata |
| Providers | `managed_value` (value lives encrypted in the approved backend) or `vault_reference` (`connectionId`, `mount`, `path`, `field`, optional `namespace`, explicit `version` mode `pinned(n)` \| `latest`); path is a bounded relative locator — schemes, absolute paths, `..`, empty segments and control chars rejected |
| No plaintext readback | `SecretCatalogEntryReadSchema` = entry + `valueConfigured` + `usageReferences`, `.strict()` with **no `value` member**; `ValueSourceReadSchema` = `{kind:'literal', configured:true}` or safe `secret_ref` metadata (name/state/revision, no value); literal readback with a `value` key fails; `SECRET_VALUE_RESOLVE_API = 'none'` documents the policy |
| Write DTOs | `SecretCatalogCreateSchema` (managed_value requires the write-only literal; vault_reference forbids one), `SecretCatalogRotateSchema` (CAS `expectedRevision` + literal only), `SecretCatalogDisableSchema` (CAS + reason), `SecretCatalogListPageSchema` (≤200 items, cursor only) |
| Identity semantics | Consumers persist `secretId` (immutable); `name` is a display label and rename never rebinds; `usageReferences` is the dependency index that prevents unsafe deletion |

## 2. Security rules encoded (spec mapping)

- **No ambiguous strings / implicit `vault://`** — object union + strict parser (tested for `vault://`, bare
  strings, empty string).
- **No plaintext readback anywhere** — read schemas are strict and value-free; entry/list/read DTOs reject a
  payload carrying `value`/`plaintext` (tested). Masking is a UI concern; storage encryption remains the SEC-ENC
  writer's job.
- **Literal credentials are write-only and encrypted before persistence** — documented on the literal schema; the
  contracts only carry the value from the write boundary to the writer.
- **Vault links are locators, not URLs/hashes** — scheme/absolute/traversal/empty-segment rejection (tested);
  mount/path/field scopes, capability gating and read-permission probes remain server-side (SC-02).
- **Permissions explicit** — purpose + services are required; listing does not imply resolution
  (`SECRET_VALUE_RESOLVE_API = 'none'`), platform/tenant scope is explicit via `tenantId`.
- **CAS/rotation** — rotate/disable require `expectedRevision`; rotation metadata is bounded; omitted update
  preserves and explicit clear is a separate disabled/revoked transition.

## 3. Changed paths and hashes

| File | SHA-256 |
|---|---|
| `packages/contracts/src/secret-catalog.ts` (new) | `EA465415C527F2189051B39CAEFED71452E9ACBD54E5FE0562479C5F027B3164` |
| `packages/contracts/src/index.ts` (export line) | `6976173277548AFC795C00BAC6DDA71740D956D03D2527A9196F2EE1AD9FDB17` |
| `packages/contracts/tests/secret-catalog.test.ts` (new) | `0BEB389A88BD4821DA076E63C6D8A0027E338290464823CF9DDB5807317B895D` |

No file under `services/orchestrator/src/modules/secrets/**` was created or changed: the repository/admin API is the
SC-01 implementation slice on top of this freeze and was not part of this dispatch's work items (schemas + tests).
No migration is required for a pure contract freeze; `docs/21-openapi.json` untouched.

## 4. Test evidence (real runs, cwd `du-rework`)

| Command | Exit | Result | Log |
|---|---|---|---|
| `pnpm --filter @du/contracts exec jest --runTestsByPath tests/secret-catalog.test.ts --verbose` | **0** | **14 passed / 14** | `coordination/reports/raw/sc-01/secret-catalog-new-test.log` |
| `pnpm --filter @du/contracts build` | 0 | `tsc` clean | `.../contracts-build.log` |
| `pnpm --filter @du/contracts test` (full suite) | **0** | **30 suites / 567 tests passed** | `.../contracts-full-suite.log` |

Negative coverage: ambiguous/`vault://` strings; empty/oversized/NUL literals; extra keys on both ValueSource
branches; literal readback with `value`; secret-ref read without name/state/revision; entry/list payloads carrying
`value`/`plaintext`; duplicate services; unknown purpose/state/service; non-uuid ids; revision 0; control characters
in names; vault scheme strings, absolute paths, `..`, empty segments, control chars, multi-segment field/mount,
missing version; managed create without value and vault create with value; rotate without CAS/with secret_ref/with
extra plaintext; disable without reason; list over 200 items or with an unknown `total` key.

## 5. Limitations / handoff

- SC-01 implementation slice still to land: metadata table/repository, admin create/link/rotate/disable with
  CAS/idempotency/audit, dependency index enforcement and a list/read admin API (all on top of these DTOs).
- SC-02 owns: Vault connection capability gating, mount/path allowlist, read-permission safe probe, managed
  write/rotate into the encrypted backend, runtime resolution with bounded caches and fail-closed semantics.
- SC-03 (Portal) and SC-04 (consumer adoption: connector/profile-callback/OIDC/source) build on the same
  ValueSource union; SC-05 owns docs/OpenAPI regeneration.
- No live Vault/PG flow is claimed; VFY-SC-01 inspects real storage sentinels and tenant/purpose negatives.
- Evidence hashes: `secret-catalog-new-test.log`
  `288A531134BC7552FCA057CB17C58DAA9F22631790246B71CA44A89C9D310A1C`,
  `contracts-full-suite.log` `C94204BBAA5D5D9E9A270FC21F97A6286AC651A197AD81F343F14D82CB8AA2EF`,
  `contracts-build.log` `F7E1113A0CAF22697C7C28FFC2D2E8283A2D197285AFC2F906FCEB36CEC06C78`.
- Next: SC-02/03/04 on separate leases against this frozen module; independent verify + review before acceptance.
  No commit/tick/push performed.
