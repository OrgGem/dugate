# PLAT-MIG-02 inventory refresh — INVENTORY-REFRESH-883

Date: 2026-10-05  
Scope: read-only re-audit of the current worktree using the existing PLAT-MIG-00 export inventory. No source, tests, or inventory input was edited for this task. No repo candidate was created, no source was cut/copied/moved/rsynced, and nothing was staged or committed.

## Procedure and scope

Read `tools/repo-migration/verify-inventory.cjs`, its `README.md`, the PLAT-MIG-00 TSV, the prior snapshot JSON and the independent PLAT-MIG-02 verification receipt. The verifier hashes the listed files against the working tree, rejects paths outside the source root and symlinks, checks the product-path allowlist, and writes a new report only if its destination does not already exist. It does not use Git HEAD in place of the current worktree. Per its README, `SNAPSHOT_MATCH` means only that listed product-file hashes match; it is not a completeness or acceptance verdict.

Command run from `D:\Git\dugate`:

```text
node du-rework/tools/repo-migration/verify-inventory.cjs . du-rework/coordination/reports/plat-mig-00-export-inventory-2026-10-05.tsv du-rework/coordination/reports/plat-mig-snapshot-audit-2026-10-05-112704Z.json
```

The old audit `coordination/reports/plat-mig-snapshot-audit-2026-10-05.json` was not overwritten. The tool intentionally filters the broader 1,580-file PLAT-MIG-00 TSV to its product-path allowlist, so the audit's 1,032 files are a subset of that TSV. Environment files (including `.env.example`), logs, generated output and other forbidden paths remain excluded.

## Current snapshot result

| Measure | Prior snapshot | New snapshot |
|---|---:|---:|
| Audit JSON | `plat-mig-snapshot-audit-2026-10-05.json` | `plat-mig-snapshot-audit-2026-10-05-112704Z.json` |
| Generated at (UTC) | `2026-10-05T11:03:58.850Z` | `2026-10-05T11:27:04.881Z` |
| Status | `SNAPSHOT_MATCH` | `SNAPSHOT_MATCH` |
| Listed product files audited | 1,030 | 1,032 |
| Untracked listed product files | 246 | 248 |
| Listed-file hash drift | 0 | 0 |
| Source digest | `e415d76b2cfad1969563cc336271885da7b8fb1a3b3d9154feb881ade345e613` | `b6979e10bb2ea370e0f6acfc0053e9439863cb57bdecf8c224559d7bcddac270` |

The verifier exited `0`. The previous JSON remains byte-identical at SHA-256 `8f24df9f753fa7feb3288dea84818cd3cae526f1688686ab3ff2a8c635925296`.

## Exact comparison with the old snapshot

Comparison is by normalized inventory `path`; `changed hash` means the same path exists in both reports with unequal SHA-256.

**Added (2):**

- `du-rework/services/orchestrator/src/modules/connectors/probe-authorization.ts` — new hash `cde6c9f1ab43cea5efdf266bddc719bc8c06a61e3d7270db2604b9fbae7fc332`.
- `du-rework/services/orchestrator/tests/plat-mig-02-probe-authorization.test.ts` — new hash `5ddf7d6f53ec0021ad05ac294adf6b925127a2d7656e5f9295fd1b2634bcadf0`.

**Removed (0):** none.

**Hash changed (3):**

| Path | Prior SHA-256 | Current SHA-256 |
|---|---|---|
| `du-rework/services/orchestrator/src/http/routes/public.ts` | `94e6a6c94a52b5599d30fafedb2be8cc9455fb483f59ab63d0dee842e3fc4dfa` | `ef1f74714aa2f4b972ad6db0bb4aab62f6e0401fe9cff2c943043989a7eea97f` |
| `du-rework/services/orchestrator/tests/legacy-payload-migration.test.ts` | `70a4d9750599651ca49989fea2e6c7f9409e30350658a929f726199694ecd434` | `6a0e3f9a409f2e3429ef51cf89c632e9e9394132141fe1ebfd49ee5746403f23` |
| `du-rework/services/orchestrator/tests/usage-summary.test.ts` | `f44c916c9a8584bca1e360f8f817162d4a9e61fe1ab118e24e8b2e1ce2df672c` | `8b4af23057e4bdc1c703983d0ffba583105de6bb31266585892579d26ee4c925` |

No cause or wave attribution is inferred for the two test-file changes from hash comparison alone. The new `public.ts` hash agrees with the current PLAT-MIG-02 verifier receipt.

## PLAT-MIG-02 receipt digest check

All three current hashes are present in the new audit and match the supplied receipt prefixes:

| File | Current SHA-256 | Receipt prefix | Result |
|---|---|---|---|
| `services/orchestrator/src/modules/connectors/probe-authorization.ts` | `cde6c9f1ab43cea5efdf266bddc719bc8c06a61e3d7270db2604b9fbae7fc332` | `cde6c9f1` | match |
| `services/orchestrator/src/http/routes/public.ts` | `ef1f74714aa2f4b972ad6db0bb4aab62f6e0401fe9cff2c943043989a7eea97f` | `ef1f7471` | match |
| `services/orchestrator/tests/plat-mig-02-probe-authorization.test.ts` | `5ddf7d6f53ec0021ad05ac294adf6b925127a2d7656e5f9295fd1b2634bcadf0` | `5ddf7d6f` | match |

The independent evidence is in [verify-plat-mig-02-883-2026-10-05.md](verify-plat-mig-02-883-2026-10-05.md). This confirms the three file hashes only; it does not add a code review or deployment verdict.

## Limitations and boundary

This refresh proves hashes for the files listed and accepted by the verifier's product-path allowlist. It **does not prove inventory completeness**, identify every unlisted worktree file, establish external consumer coverage, or accept PLAT-MIG-02. A `SNAPSHOT_MATCH` is not a production-readiness verdict. The previous audit remains available for the exact path/hash delta above.
