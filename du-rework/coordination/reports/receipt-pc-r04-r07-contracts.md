# Receipt — Contracts extension for PC-R04 & PC-R07

| Field | Value |
| :--- | :--- |
| Packet | `FOLLOWUP-CONTRACTS-PC-R04-R07` — *Contracts Extension for PC-R04 & PC-R07* |
| Dispatch | [`FOLLOWUP-CONTRACTS-PC-R04-R07-dispatch.txt`](../dispatch-specs/FOLLOWUP-CONTRACTS-PC-R04-R07-dispatch.txt) |
| Plan rows | `PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md` PC-R04 (line 102), PC-R07 (line 105) |
| Worker | `dsh_2` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Timestamp | 2026-10-21 09:15 +07:00 |
| Lease respected | **Only** `packages/contracts/src/profile-groups.ts` and `packages/contracts/tests/profile-groups-v2.test.ts` were written. No `services/**`, no `apps/**`, no `index.ts`. |
| Status | **COMPLETE** — contracts typecheck 0, full contracts suite 36/36 suites (631 tests), orchestrator service typecheck 0, consumer suites 71/71. |

**Tóm tắt (VI).** PC-R04: `ResolutionFingerprintPartsV2` giờ tách `tenantDefaultsAiRevision` / `tenantDefaultsPromptRevision` / `tenantDefaultsDigest`, workflow pin mang thêm `slug`, và payload hash thay đổi tương ứng — golden vector được re-pin; fingerprint cũ (pre-R04) **cố ý** không còn khớp (server luôn recompute nên chỉ có thể ra `409 PROFILE_CHANGED`, không bao giờ accept stale). PC-R07: thêm `ParameterSourceSchema` / `ParameterResolutionSchema` và field optional `parameterResolution` trên `ProfileGroupFunctionSchema` (catalog DTO). Có 1 xung đột văn bản cần coordinator chốt: dispatch ghi `policySettings`, còn master plan + manifest capability (PC-01) dùng `profileSettings` — tôi giữ literal canonical theo plan và nhận `policySettings` như alias được chuẩn hoá (§2.2). Thêm 9 unit test (J1–J5, K1–K4).

---

## 1. PC-R04 — fingerprint inputs

### 1.1 Contract changes (`src/profile-groups.ts`)

| Item | Change | Anchor |
| :--- | :--- | :--- |
| Parts interface | `tenantDefaultsAiRevision?`, `tenantDefaultsPromptRevision?`, `tenantDefaultsDigest?` added; `tenantDefaultsRevision?` kept and marked `@deprecated` as the pre-R04 back-compat field | `:464-491` |
| Legacy mapping | `tenantDefaultsAiRevision ?? tenantDefaultsRevision ?? null`; prompt/digest default to `null` | `:535-538` |
| Hashed payload | flat `tenantDefaultsAiRevision`, `tenantDefaultsPromptRevision`, `tenantDefaultsDigest` (dispatch wording, not a nested object) | `:558-560` |
| Workflow pin | `workflow` now `{ slug?: string; revision: number; digest: string } \| null`; the payload carries `slug: slug ?? null` so an omitted slug is one identity | `:489`, `:564-570` |
| Domain constant | `FINGERPRINT_VERSION` stays `'2'` (the *API* version), with a comment recording that the payload was extended by PC-R04 and is intentionally incomparable across builds | `:493-502` |

Why the defaults are three flat inputs rather than one nested object: the dispatch names the three payload keys explicitly, and per-source tests (`J1`/`J5`) read better against flat keys. `requestDigest` is unchanged (`canonicalRequestHash`), so request normalization behaviour is untouched.

### 1.2 Re-pinned golden vector (regression pin)

| Value | Digest |
| :--- | :--- |
| pre-R04 fingerprint (now unreachable **by design**) | `sha256:b226e4ef5fe63282b5286d64dfe63e3bdf535a5867fc8816b1db31445c8a7b46` |
| PC-R04 fingerprint for the same canonical fixture | `sha256:38fc7569935274af990ca6808e705489e95a8427fe6cd95e7b2c996b22c44c40` |
| `canonicalRequestHash(submission)` (unchanged) | `sha256:5670835bd3436b8af329dc069f5e9eb5938239e07d71f4be02bc220503f55a64` |

The new constant was produced **before** running the suite, from a hand-built payload passed through `canonicalize` + `sha256` (only the canonicalizer is shared with the implementation), matching how PC-01's original vector was derived. `F1` now pins it (`tests/profile-groups-v2.test.ts:422`).

### 1.3 Compatibility statement

A fingerprint produced by a pre-R04 build can never match the new computation. That is the intended fix (PC-R04: prompt changes must invalidate the fingerprint). It is safe because the fingerprint is a **concurrency guard, never stored authority** (plan §"DTO and route contract"): preview and submit both recompute it server-side, so a rolling deploy can only produce a fail-closed `409 PROFILE_CHANGED`, never a stale acceptance. Consumers must not persist or replay an old fingerprint value.

## 2. PC-R07 — parameter source mapping in discovery

### 2.1 Contract changes

| Item | Change | Anchor |
| :--- | :--- | :--- |
| `ParameterSourceSchema` | `'requestDefaults' \| 'profileSettings'` canonical, `'policySettings'` accepted as an input alias and transformed to `'profileSettings'` | `:80-83` |
| `ParameterResolutionSchema` | `z.record(string(1..128), ParameterSourceSchema)` — one source per declared property | `:86-89` |
| Types | `ParameterSource`, `ParameterResolution` exported | `:83`, `:90` |
| Catalog DTO | optional `parameterResolution` added to `ProfileGroupFunctionSchema` (still `.strict()`) | `:107` |

Placement is deliberate: the mapping lives on the **catalog function descriptor** only. The saved-config DTO already separates the two value bags (`policy.parameters` = profileSettings, `requestDefaults`), so duplicating a per-property source map there would create a second source of truth that can drift from the manifest. Discovery (catalog) + the two bags are sufficient for the editor to save each value to its declared source.

`index.ts` was **not** edited (outside this packet's lease). Both new schemas still reach consumers through the existing `export * from './profile-groups'`; only the explicit bundler-static list misses them. If a browser bundle must statically discover them, a one-line follow-up in `index.ts` is needed (separate lease).

### 2.2 Spec conflict: `policySettings` vs `profileSettings` (needs coordinator confirmation)

| Source | Literal |
| :--- | :--- |
| Master plan §"Manifest parameter and lock resolution" item 2 | `'requestDefaults' \| 'profileSettings'` |
| Manifest capability already shipped by PC-01 (`ParameterResolutionCapabilitySchema`, `manifest.ts`) | `'requestDefaults' \| 'profileSettings'` |
| This follow-up dispatch (§2) | `z.enum(['policySettings', 'requestDefaults'])` |

If the catalog emitted `policySettings` while the manifest capability says `profileSettings`, the editor would key its save target off a value the manifest never produces — a silent mapping bug. Resolution implemented here:

- the **canonical output literal stays `profileSettings`** (plan + shipped PC-01 surface win);
- `policySettings` is **accepted** and normalized, so a producer following the dispatch text still parses instead of 500-ing;
- `ParameterSourceSchema.parse('policySettings') === 'profileSettings'` is pinned by test `K2`.

If the coordinator instead wants `policySettings` as the canonical wire literal, that is a coordinated change across `manifest.ts` (PC-01), the catalog projection (PC-03) and the UI (PC-08) — not a local edit, and not in this lease.

## 3. Tests added (`tests/profile-groups-v2.test.ts`)

| ID | Case | Anchor |
| :--- | :--- | :--- |
| F1 (re-pin) | golden == `sha256:38fc7569…c44c40`; requestDigest unchanged | `:422` |
| J1 | prompt revision change moves the digest with AI fixed; AI change moves it too; the two are not interchangeable | `:726` |
| J2 | defaults digest change moves the digest; absent digest ≡ explicit `null` | `:747` |
| J3 | legacy `tenantDefaultsRevision` folds into the AI slot; explicit AI wins over the deprecated field; AI ≠ prompt | `:773` |
| J4 | workflow slug participates; omitted slug ≡ `slug: undefined` | `:794` |
| J5 | AI revision, prompt revision and digest are three distinct inputs (set size 3) | `:814` |
| K1 | catalog function parses a declared mapping and round-trips | `:841` |
| K2 | `policySettings` normalizes to `profileSettings` | `:851` |
| K3 | unknown source, non-record mapping and an empty property name are rejected | `:863` |
| K4 | mapping is optional (absent ⇒ field absent) and the DTO stays strict | `:879` |

## 4. Verification actually run

| # | Command | Result |
| :--- | :--- | :--- |
| 1 | `packages/contracts`: `tsc --noEmit -p tsconfig.json` | **exit 0** |
| 2 | `packages/contracts`: `tsc -p tsconfig.json` (emit `dist` for downstream `@du/contracts` consumers) | **exit 0** |
| 3 | `packages/contracts`: `jest --runInBand tests/profile-groups-v2.test.ts` | **exit 0 — 45/45** (36 + 9 new) |
| 4 | `packages/contracts`: `jest --runInBand` (whole package) | **exit 0 — 36 suites / 631 tests passed** |
| 5 | `services/orchestrator`: `tsc --noEmit -p tsconfig.json` (no service edits; proves the interface change is additive) | **exit 0** |
| 6 | Consumer suites: `jest --config jest.unit.config.cjs tests/profile-v2-http.test.ts tests/profile-groups-v2-offline.test.ts tests/profile-groups-v2-routes-offline.test.ts` | **exit 0 — 3 suites / 71 tests** (PC-05 fingerprint user + PC-03 v2 suites) |

Row 5/6 are the safety net for a contract-only packet: the new fields are optional, so PC-05's existing `computeResolutionFingerprint` call site (which passes only `tenantDefaultsRevision`) compiles and behaves correctly without an edit.

## 5. Deviations from the dispatch snippet (all deliberate)

1. **Defaults fields are optional, not required.** The snippet shows `tenantDefaultsAiRevision: number | null` (required) but also requires a `tenantDefaultsRevision?` back-compat path — those contradict each other. `services/orchestrator/src/modules/operations/submission.ts:1152-1180` (and `tests/profile-v2-http.test.ts:280-307`) only pass the legacy field, and services are outside this lease. Optional fields keep the package additive; required fields would force a coordinated services patch for zero runtime gain.
2. **`ParameterResolutionSchema` is a non-optional record, with `.optional()` at the field.** The snippet defines the schema itself as `.optional()`; observable validation is identical (absent is allowed), but the schema stays reusable and the `ParameterResolution` type does not silently include `undefined`.
3. **`policySettings` alias** — see §2.2.
4. **Workflow slug is optional and normalized to `null`.** Existing pins have no slug; requiring it would break every stored workflow pin, while `null` gives one deterministic identity for "no slug".

## 6. Follow-ups created by this packet (other lanes)

| Lane | Work |
| :--- | :--- |
| PC-03 | Project the manifest capability onto `parameterResolution` in the catalog builder; it must emit the canonical `profileSettings` literal (the schema normalizes the old spelling, but do not rely on it). |
| PC-05 | Pass `tenantDefaultsAiRevision`, `tenantDefaultsPromptRevision` and `tenantDefaultsDigest` from the admission snapshot at `submission.ts:1152` (today only `tenantDefaultsRevision` is passed, so prompt-only changes still do not move the fingerprint until this lands — the contract is ready, the caller is not). |
| PC-08 | Read the mapping from the catalog and save each parameter only to its declared source; no client-side inference from schema overlap. |
| PC-09 | Regression: preview → change prompt revision only → submit must 409 `PROFILE_CHANGED`; preview → change AI revision only → same; unchanged refs → 200. |
| Coordinator | Confirm the `policySettings` vs `profileSettings` decision (§2.2). |

## 7. Evidence boundary

Source + unit-test level only. No service source was edited; no live PG/HTTP suite was run in this packet (the shared DB migration-ledger baseline is still missing, per `receipt-pc04-keys.md` §6). No deployment, image or running-container claim is made. `dist/` for `@du/contracts` was rebuilt locally so downstream consumers resolve the extension; it is git-ignored and not part of the deliverable.
