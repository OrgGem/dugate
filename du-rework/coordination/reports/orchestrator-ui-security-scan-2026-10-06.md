# SEC-UI-20261006 — Orchestrator Portal / serving backend security scan

Status: **OPEN / SECURITY GATE FAILED**. User requested scanning the Orchestrator UI and no High/Critical vulnerabilities. This scan found a known High dependency vulnerability; no clean-security claim or acceptance is warranted. Product source, dependencies and deployment were not changed in this audit. Portal build regenerated its local dist output.

## Scope and evidence

- `apps/admin-web`: React/Vite Portal, manifests, client requests, rendering sinks and CSS tooling.
- `services/orchestrator`: Portal static mount, legacy/OIDC auth, sessions, BFF authentication/CSRF/tenant/role gates, upstream handling, listener guard and supporting observability code. Manual targeted review is not exhaustive SAST or a penetration test.
- Workspace lockfile audit includes shared packages and workers; distinguish those from Portal/backend production dependencies. Scanner advisory paths are representative, not exhaustive dependency paths: `pnpm why braces` separately proves backend test-tool exposure.
- Local toolchain: Node 22.16.0, pnpm 10.18.3. Node 24 migration remains planned, not verified here.
- Container selected from existing local images: `du-redact-orchestrator:20261005`, ID `sha256:783a3dddc348c5274d8a82d1b45f9ad43343420d95c4ad1fc19023c8cc502970`, created 2026-10-05T06:50:43.279034265Z, runtime Node 22.23.3. This image is an earlier snapshot, not proof of the current working tree or production image.

## Findings

| ID | Severity / status | Evidence and required remediation |
|---|---|---|
| SEC-UI-01 | **High / OPEN** | `braces@3.0.3`, GHSA-vfj7-8cjw-p6xm / CVE-2026-93687: stack-exhaustion denial of service for nested brace patterns. Audit reports `apps/admin-web > shadcn > fast-glob > micromatch > braces`. Backend `pnpm why braces` also confirms Jest/@types/jest/ts-jest chains. Build/test tool scope; no evidence of a remotely reachable Portal runtime glob parser. Cannot relabel the advisory as fixed based on that distinction. Current advisory lists affected versions <=3.0.3 and no patched version. Build/dependency owner must evaluate a patched upstream release, removal/replacement of affected tooling or a maintained verified patch. Removing shadcn alone is insufficient; its CSS is currently imported at `apps/admin-web/src/styles/app.css:4`. Do not override to an invented version or suppress advisory. |
| SEC-SHARED-02 | **High / OPEN, adjacent workspace scope** | `xlsx@0.18.5` through `packages/document-kit`, GHSA-4r6h-8v6p-xvw6 prototype pollution and GHSA-5pgg-2g8v-p4x9 ReDoS. Two advisories. Workspace production scan stays red. Not found as a production source import of Portal/Orchestrator in this targeted review; that does not prove every packaged artifact excludes it. Shared-library/worker owner must replace or source a verified maintained fixed release and validate parser semantics/build provenance; no npm patched version is offered by this audit. |
| SEC-UI-03 | **Medium / OPEN, manual assessment** | Legacy token login uses caller-provided redirect at `services/orchestrator/src/app/admin/auth-dispatch.ts:81`, emits it as Location at line165, without the existing `safeReturnTo` allowlist. Synthetic diagnostic reproduces 302 to `https://example.invalid/phishing` with a session cookie issued; no external request is sent. No proof of cookie disclosure or auth bypass. Applies to legacy branch when auth mode is unset, not an allegation against the protected OIDC flow. Auth owner should reuse the shared redirect allowlist and add adversarial regression cases; set explicit local/OIDC auth mode in deployment. |
| SEC-UI-04 | **Medium / OPEN, audit observability assessment** | Existing `admin-shell-session-lifecycle.test.ts:821` fails: expected structured auth.login_failed event, received undefined. Default sink at `shell-server.ts:749` supplies `{ event }`, but observed log lacks event. Requires tracing observability serialization/redaction and restoring safe event metadata without secrets. This failure is not evidence of an authentication bypass and should not be hidden by changing expectations alone. |
| SEC-IMAGE-05 | **High / OPEN, existing image** | Trivy reports **11 High package/advisory findings, 0 Critical** in bundled npm under `usr/local/lib/node_modules/npm/`. Affected installed packages: brace-expansion2.0.2 (five advisories), http-cache-semantics4.2.0, ip-address10.1.0, pacote19.0.2 and20.0.1, picomatch4.0.3, sigstore3.1.0. Most have fixed versions recorded in raw JSON; http-cache-semantics has no FixedVersion in this database. Build owner should evaluate removing unused package-manager tooling from the final runtime stage or refreshing a supported patched toolchain/image, preserving app runtime functionality. No application package reachability is inferred from npm tool findings; do not dismiss them for the requested image gate. Alpine3.24.2 OS packages: 0 High / 0 Critical in this scan. |

Advisory references: [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [SheetJS prototype pollution](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6), [SheetJS ReDoS](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9).

## Commands and results

Working directory unless noted: `D:\Git\dugate\du-rework`.

| Check | Result / raw evidence |
|---|---|
| `pnpm audit --json` | Audit exit1, 3 High / 0 Critical; `orchestrator-ui-security-audit-2026-10-06.json` |
| `pnpm audit --prod --json` | Audit exit1, 2 High / 0 Critical (xlsx); `orchestrator-ui-security-prod-audit-2026-10-06.json` |
| `pnpm audit --dev --json` | Audit exit1, 1 High / 0 Critical (braces); `orchestrator-ui-security-dev-audit-2026-10-06.json` |
| `pnpm --filter @du/orchestrator why braces` | Backend tooling chain confirmed; `orchestrator-ui-security-backend-braces-2026-10-06.txt` |
| `pnpm --filter @du/admin-web --filter @du/orchestrator list --depth 3 --json` | Bounded inventory, not full graph proof; `orchestrator-ui-security-dependencies-2026-10-06.json`. Initial depth-Infinity expansion was cancelled and its oversized output removed; no source changed. |
| `pnpm --filter @du/admin-web build` | Exit0, typecheck + Vite6.4.3 production build pass; chunk-size warning is not a security finding. Raw `orchestrator-ui-security-build-2026-10-06.txt` |
| Focused Jest batch, cwd `services/orchestrator` | Exit0: 14 suites pass, 1 suite skipped; 191 tests pass / 13 skipped. Raw `orchestrator-ui-security-tests-2026-10-06.txt` |
| Extended auth/session Jest batch, same cwd | Exit1: 10 suites pass / 1 fail; 215 tests pass / 1 fail. Raw `orchestrator-ui-security-auth-tests-2026-10-06.txt` |
| `node coordination/reports/orchestrator-ui-security-redirect-probe-2026-10-06.cjs` | Exit0 means diagnostic reproduced the vulnerability, **not** security acceptance. Safe fixture credentials only. Raw matching `.json`. |
| Trivy image scan | Scanner0.75.0, image `aquasec/trivy@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa`; fresh vulnerability DB downloaded during run. Completed exit0, 11 High / 0 Critical. Default scanner exit0 is completion, not a clean gate: this invocation did not set vulnerability exit-code1. Raw `orchestrator-ui-security-image-2026-10-06.json`. |

Image command: `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v D:\Git\dugate\du-rework\coordination\reports:/reports aquasec/trivy:latest image --scanners vuln --severity HIGH,CRITICAL --format json --output /reports/orchestrator-ui-security-image-2026-10-06.json du-redact-orchestrator:20261005`. Docker socket used read-only image inspection purpose; no service restart/deploy. Scanner pull digest recorded above. Image report contains image metadata; reviewed Env entries are standard image configuration, not deployment secrets.

Snapshot hashes: `orchestrator-ui-security-snapshot-2026-10-06.json`. Separate audit process exit confirmation: `orchestrator-ui-security-audit-exits-2026-10-06.json` (all/prod/dev exit1). Dependency scan counts and image findings overlap in concept and use different inventories/databases; do not sum them as unique vulnerabilities.

Focused Jest command: `pnpm exec jest --runInBand --config jest.unit.config.cjs --testPathPatterns='aweb|admin-oidc-flow|admin-shell-offline|admin-error-boundary-offline|session-store|runtime-admin-auth|pm-m02-ingress-fence|local-user-role-policy|bff-settings-identity|bff-connectors-actions'`.

Extended command: `pnpm exec jest --runInBand --config jest.unit.config.cjs --testPathPatterns='admin-shell-render|admin-shell-platform-mount|admin-shell-session-lifecycle|admin-shell-oidc|admin-oidc04|oidc-client|oidc-cookie-secure|oidc-claim-shape|oidc03-role|redis-session-repository'`.

PowerShell redirects native stderr with NativeCommandError wrappers in text logs; use final process exit and Jest summary, not the presence of that wrapper, to judge pass/fail. Audit output pipelines can return the writer exit; audit JSON vulnerability totals and audit process exit were checked separately.

## Security controls observed / limits

Portal CSP restricts scripts/connect to self and prevents framing; static mount authenticates before serving, rejects traversal/backslashes/NUL and limits asset extensions. Client sends same-origin cookies, not platform bearer credentials. Targeted rendering search found no dangerouslySetInnerHTML/innerHTML/eval/localStorage/sessionStorage sinks in Portal source. BFF routes inspected resolve session/principal, enforce tenant/role and CSRF before privileged writes; credential mapping is server-side. Passing tests substantiate representative cases, not every route/deployment.

PM-M02 live listener tests were skipped without DU_LIVE_INFRA; they are not passes. No live browser attack testing, production TLS/proxy/header configuration, multi-tenant real-infrastructure verification, exhaustive secret scan or general backend SAST was performed. Final Node24 candidate and its OS/runtime/dependency graph require a fresh scan after remediation.

Trivy found one language target (Node.js package inventory) whose vulnerable paths are bundled npm. This does not prove coverage of app dependencies flattened into compiled bundles or browser JS. Combine lockfile/dependency scans, build provenance/SBOM and final image scan; do not infer vulnerability-free application code from the absence of an application target.

## Integration handoff

Reuse existing build/dependency, auth/BFF, observability and shared-library owners under the common migration plan. Claim disjoint files before remediation; central manifest/lockfile/Docker owner serializes changes. Keep SEC-UI-01 and SEC-SHARED-02 OPEN until patched final graphs and image scans pass the High/Critical gate; rerun affected builds/security tests and obtain independent review. No task tick, commit, push or production cutover from this receipt.
