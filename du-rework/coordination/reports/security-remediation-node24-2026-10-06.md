# SECURITY-VULN-REMEDIATION-NODE24 — 2026-10-06

Task `task_c025dd92a61d`, context `ctx_a8b139d8529b`. **Implementation and focused verification complete; overall security/release acceptance remains OPEN.** No remote, commit, push or cutover. All source changes are in canonical `du-rework`; existing isolated migration candidates were not silently rewritten.

## Remediation

### SheetJS/xlsx

Replaced npm0.18.5 resolution with official SheetJS CE0.20.3 through the root pnpm override and document-kit manifest. The vendor's [installation documentation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) identifies its CDN as the release source. The unmodified release tarball is now `vendor/xlsx-0.20.3.tgz`, with upstream Apache-2.0 license retained inside it, provenance in `vendor/README.md`, SHA256 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`, and generated lockfile SHA512 integrity. A local versioned artifact avoids relying on mutable URL content for future builds. Both previously reported High xlsx advisories disappear from the new dependency audit.

### braces

Registry still reports latest3.0.3; [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) has no patched published release. Applied a real local security backport using pnpm `patchedDependencies`, `patches/braces@3.0.3.patch`. It enforces a non-configurable128-level parser nesting ceiling for braces and parentheses before recursive cleanup, and iteratively checks AST depth/node budget/repeated child nodes before compile/expand/stringify recursion. AST parent/prev links are not traversed. Excessive inputs throw a controlled SyntaxError/code instead of causing recursive stack exhaustion. Inputs deeper than128 are intentionally rejected; ordinary ranges, alternatives, escaped braces and representative glob patterns retain their behavior.

**No package version was falsified and no advisory was ignored.** pnpm audit still flags High against upstream version3.0.3 because it cannot assess patch contents. Classify the CVE as locally mitigated with focused evidence, pending independent patch review; the requested scanner-clean High/Critical acceptance is **not closed**. Track removal of this patch when a verified upstream fixed release becomes available.

### Node24/build/runtime

- Latest Node24 release checked via official `nodejs.org/dist/index.json`: **24.21.0 LTS** (2026-09-07).
- Canonical Docker base: `node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`; actual pulled version24.21.0 confirmed. Same base for build and runtime; five compatibility Dockerfiles regenerated using `scripts/docker/sync-dockerfiles.cjs`.
- Sixteen root/workspace manifests now require `>=24.21.0 <25`; existing Node typings moved to24.x and lockfile regenerated. Root packageManager pins pnpm10.18.3; `.node-version` and `.nvmrc` pin24.21.0. No global nvm switch: local verification used an isolated official Windows Node24 archive whose SHA256 was checked against upstream SHASUMS256 (`158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`).
- Docker copies patches/vendor before frozen fetch/install. Final runtime stage removes unused npm/corepack/Yarn tools, addressing exposure from bundled package-manager dependencies in the older scan. Removal was checked in the actual Orchestrator image.
- Worker deploy initially failed because pnpm rebased local xlsx tarball resolution into `/deploy/<worker>/vendor`. `build-runtime.cjs` now rewrites that tarball location to the source artifact in **build-container-only** deployment lockfiles, preserving integrity and versions. Canonical lockfile stays unchanged; actual offline deploy then passes for all three workers.

## Verification

Cwd: `D:\Git\dugate\du-rework`. Node24 commands used `$taskNode` from the isolated temp archive and the existing corepack pnpm entrypoint; child scripts resolve Node24 through task-local PATH. No real provider or product DB/service was invoked.

| Check | Result / raw receipt |
|---|---|
| pnpm install, then `install --offline --frozen-lockfile --ignore-scripts` | Exit0. `security-remediation-node24-install-vendor-2026-10-06.txt`, `security-remediation-node24-frozen-install-2026-10-06.txt` |
| `node --test tools/security/braces-security.test.cjs` on Node24 | **10/10 pass**, exit0; actual UI and backend Jest chains resolve the same patch. Balanced/unbalanced4,000-level patterns below maxLength, boundary128/129, direct AST depth/width/child cycles, normal patterns checked. Raw `security-remediation-node24-braces-tests-2026-10-06.txt` |
| `pnpm --filter @du/document-kit exec jest --runInBand` | **130/130 pass**, 10 suites, exit0; includes spreadsheet parsing and archive security. Raw `security-remediation-node24-document-tests-2026-10-06.txt` |
| `pnpm --filter @du/admin-web build` | Typecheck/Vite production build pass, exit0; usual chunk-size warning. Raw `security-remediation-node24-ui-build-2026-10-06.txt` |
| Focused Orchestrator auth/BFF/management/security suites | **115 pass / 1 fail**, seven suites; exit1. Existing `admin-shell-session-lifecycle.test.ts:821` security-event logging failure persists (already reproduced before this task). Raw `security-remediation-node24-backend-tests-2026-10-06.txt` |
| `docker build --target <component> -t du-security-node24-<component>:20261006 .` | **All five final builds exit0:** Orchestrator, Connector, Document Core, LC Checker, Example Review. TypeScript and offline deploy executed in Linux Node24 build containers. Raw `security-remediation-node24-<component>-final-build-2026-10-06.txt`; exit map in `security-remediation-node24-component-build-exits-2026-10-06.json` |
| Runtime version/tooling and worker xlsx smoke | All five images report Node24.21.0. Orchestrator npm/corepack/Yarn absence check exit0. Real Document Core image resolves xlsx0.20.3 and completes XLSX write/read round-trip, exit0; raw `security-remediation-node24-worker-xlsx-smoke-2026-10-06.json` |
| Full `pnpm audit --json` | **1 High (patched braces), 1 Moderate (sprintf-js), 0 Critical**, exit1. `security-remediation-node24-audit-2026-10-06.json` |
| Production `pnpm audit --prod --json` | **0 High / 0 Critical, 1 Moderate**, exit1 due to Moderate. `security-remediation-node24-prod-audit-2026-10-06.json` |

The newly returned Moderate advisory `sprintf-js` GHSA-hp3w-g68c-fv3c has no patched version in the current audit; production path includes document-kit→mammoth→argparse. It is OPEN, not suppressed or counted as a successful clean audit. The task fixes the specified High issues, not that unrelated formatter implementation.

Transient verification corrections: first braces test fixture exceeded upstream maxLength and was corrected to an8,001-character payload; first document test command incorrectly passed `--` and discovered zero tests, then the explicit exec command above ran130 tests. Initial worker tarball deployment failures are retained in non-final build logs; final builds validate the integration fix. No failed/skipped run is represented as a pass.

Exact final image IDs: `security-remediation-node24-images-2026-10-06.json`. Source/artifact hashes: `security-remediation-node24-hashes-2026-10-06.json`. Scanner results must match these final IDs, not earlier trial builds.

## Image scan disposition

Trivy0.75.0 is pinned as `aquasec/trivy@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa`. First DB download from mirror.gcr.io failed with context deadline exceeded, exit1; this is **scanner failure**, not a vulnerability count. The second run successfully used official ghcr.io/aquasecurity/trivy-db:2 and a persistent task cache, with severity HIGH,CRITICAL and `--exit-code 1`.

**Final Orchestrator image: 0 High / 0 Critical, scanner exit0**, for image ID `sha256:f5be4e60b5ab4f5205724a57268ffb83653dc7f503ff64ae3a19767b2844f6fb`, exactly matching the final build inventory. OS Alpine3.24.2 and detected Node.js package targets are present in the raw report. `security-remediation-node24-image-2026-10-06.json` and scanner log record this result; final inventory/package detection does not prove coverage of vulnerability patterns hidden inside compiled Portal/application code.

**All five final images scanned: 0 High / 0 Critical each, exit0 each.** Connector, Document Core, LC Checker and Example Review reused the freshly downloaded database, and all five report image IDs match the recorded final inventory. Summary: `security-remediation-node24-image-summary-2026-10-06.json`; scan exit map: `security-remediation-node24-image-scan-exits-2026-10-06.json`; raw per-component scan JSONs sit beside this receipt. Database UpdatedAt `2026-10-06T01:08:27.80517672Z`, DownloadedAt `2026-10-06T02:32:32.412304873Z`, recorded in `security-remediation-node24-scanner-db-2026-10-06.json`. CycloneDX SBOMs generated separately for the five final images; Orchestrator inventory contains91 components. These clean High/Critical image scans do not override the patched-braces development audit finding, Moderate sprintf-js finding or failed security-event test.

Task-scoped `git diff --check` using repository defaults exited0, raw `security-remediation-node24-diff-check-2026-10-06.txt`. An earlier broad check found pre-existing EOF whitespace in an unrelated legacy-payload migration; it was not edited. A check overriding core.autocrlf falsely treated CRLF as trailing whitespace; the normal repository-configured scoped check is the applicable one.

## Closeout roadmap / remaining holds

1. Independent reviewer must examine the local braces patch and its bounded behavior before mitigation acceptance. Keep unfiltered audit findings visible; do not introduce an ignore just to make the gate green. Replace with supported fixed upstream release when available.
2. Exact-image High/Critical scans and SBOM generation now cover both services and three workers. Re-run after any candidate/image changes; retain dependency provenance where compiled code/package inventories are incomplete. A future scanner/DB error leaves its verification gate OPEN, not zero findings.
3. Existing candidate/worker-template owners refresh frozen exports with patches, vendor artifact, overrides, lockfile, Docker/engine/type changes and provenance, then run isolated build/conformance tests. A nested `businesses/document-core/template/package.json` discovered during this run still declares Node20 and requires its owning lane's update; it was not silently changed under another writer's lease. Master Plan template/candidate baseline is therefore not fully closed.
4. CI/deployment/docs owners adopt `.node-version`, matching pnpm pin and exact Docker digest; distinguish legacy root docs workflow (currently Node20) from rework pipelines. Record maintenance owner and refresh cadence for Node security patches/base OS/digest and tarball updates; no stale digest forever.
5. Fix/reverify the pre-existing security-event test and remaining SEC-UI/CR06/ingress/E2E holds through their existing owners. These dependency/build changes do not fix legacy open redirect, Vault/session wiring or HANDLER_ERROR.
6. Final VFY/Claude review must use the same refreshed candidate/image hashes and verify worker→Runtime/Connector, Portal/session/CSRF and artifacts/results before release. No production cutover is authorized by this receipt.

Patch edit workspace cleanup was rejected by automatic execution review (`blocked by policy`). It remains local at `tools/security/braces-patch-work`, ignored by `tools/security/.gitignore`; the deployed patch is the separate pinned file in `patches/`, not that edit directory. No permission request or destructive workaround was used.
