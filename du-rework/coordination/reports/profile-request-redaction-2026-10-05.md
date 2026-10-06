# PROFILE-REQUEST-REDACTION-20261005

Direct user-authorized implementation, following completed Docker repair. Scope: per-profile regex rules for Admin/operator request input display; server-side redaction before BFF/HTML/React serialization; all service logs retain metadata only and never input/output contents. No commit/task ticks or acceptance verdict.

Design: optional profile `requestRedaction` rules (`pattern`, regex flags, replacement default `[REDACTED]`). Configuration is revisioned with the existing profile CAS/authorization paths. New additive SQL migration adds the rules column; existing migrations/specs remain unchanged. Admin input projection uses the union of pinned and current rules, so adding a rule protects historical requests without changing execution input. Missing/corrupt policy, decrypt errors, oversized/deep payloads or regex budget failures hide input entirely. Workers/public clients continue using original input.

Regex evaluation runs off the HTTP thread with time/size/concurrency bounds. Profile rule count/pattern size/syntax/flags are validated on write. No browser raw-input toggle. Original artifact downloads are outside JSON request redaction and remain governed by existing artifact authorization.

Log boundary: allowlisted metadata and registered static event messages; discard/redact payloads and arbitrary fields/messages. Shared logger and collector enforce it; raw console exception/config paths migrate to the shared logger. Regressions use sentinel input/output/PII values across levels/sinks and check absence.

## Implementation / checks / acceptance

| Implemented | Checked by this implementation session | Acceptance |
| --- | --- | --- |
| Contract, profile DB/revision/read path, server input projection and Admin Web editor/viewer | Focused contract/unit/HTTP/browser suites and isolated Docker/PostgreSQL run below | No independent reviewer verdict; no acceptance/task checkbox changed |
| Shared metadata-only logger, collector spool/delivery filtering and five service entrypoints | All log levels, child/base fields, errors and sentinel payloads; actual compiled logger in Docker | Separate from release acceptance |
| Additive migration 0033 | Fresh Compose database migrated successfully before API; real profile writes/reads | No existing migration edited |

## Exact verification

Date: 2026-10-05. CWD for commands: `D:\Git\dugate\du-rework`. Shared uncommitted workspace; no commit was created. All counts below are from final raw runs, with **0 failed, 0 skipped and actual exit code 0**.

| Command / scope | Passed | Raw output |
| --- | ---: | --- |
| `pnpm --filter @du/contracts exec jest --runInBand tests/profile-policy.test.ts tests/profile-commands.test.ts` | 40 | [contracts](profile-request-redaction-2026-10-05-contracts.log) |
| `pnpm --filter @du/orchestrator exec jest --runInBand tests/request-redaction.test.ts tests/request-redaction-persistence.test.ts tests/p730-prof03-invariant1.test.ts tests/p730-prof03-publish-cas.test.ts tests/aweb04-bff-profiles.test.ts tests/request-redaction-http.test.ts` | 70 | [Orchestrator](profile-request-redaction-2026-10-05-orchestrator-final.log) |
| Full `@du/observability` Jest suite, three suites | 44 | [observability](profile-request-redaction-2026-10-05-observability-final.log) |
| `pnpm --filter @du/example-review exec jest --runInBand tests/r1-e-unreadable-evidence.test.ts` | 11 | [Example Review](profile-request-redaction-2026-10-05-example-final.log) |
| `pnpm --filter @du/document-core exec jest --runInBand tests/config.test.ts` | 25 | [Document Core](profile-request-redaction-2026-10-05-document-core-final.log) |
| `pnpm --filter @du/browser-tests exec playwright test --config admin-web/playwright.config.ts request-redaction.spec.ts --output test-results-request-redaction-final`, `ADMIN_UI_PREVIEW_URL=http://127.0.0.1:25173` | 3 | [browser](profile-request-redaction-2026-10-05-browser-final.log) |
| `node --test tests/deployment/request-redaction-live.cjs tests/deployment/smoke.cjs`, isolated environment/project below | 14 | [live Docker + PostgreSQL](profile-request-redaction-2026-10-05-live-final.log) |
| `node --test tests/deployment/docker.test.cjs` | 20 | [Compose/build regression](profile-request-redaction-2026-10-05-compose-regression.log) |

**227 distinct tests passed**, without counting earlier partial/repeated runs again. HTTP tests exercise the real route over a real local HTTP server with mocked persistence; browser tests use controlled BFF fixtures. The four new Docker tests use the compiled runtime, a real isolated PostgreSQL database and the running real HTTP API. They prove rule persistence/carry-forward, pinned + active rules on historical input, explicit clearing with pinned protection, unchanged stored execution input and compiled metadata-only logging. The other ten Docker checks validate production dependencies/non-root packages, process/migration status, all worker network paths and Admin login/assets.

Build commands: `docker build --target <service> -t du-redact-<service>:20261005 -f Dockerfile .` for `orchestrator`, `connector`, `document-core`, `lc-checker`, `example-review`: **all five exit 0**. Docker source builds invoke `tsc` for each service and runtime dependency; Orchestrator additionally invokes Admin Web `tsc --noEmit` + Vite. Logs: [Orchestrator](profile-request-redaction-2026-10-05-build-orchestrator.log), [Connector](profile-request-redaction-2026-10-05-build-connector.log), [Document Core final](profile-request-redaction-2026-10-05-build-document-core-final.log), [LC Checker](profile-request-redaction-2026-10-05-build-lc-checker.log), [Example Review](profile-request-redaction-2026-10-05-build-example-review.log). The final Document Core rebuild includes the non-object environment guard found by its regression test. Existing Vite large-chunk warning remains, exit 0. Host build artifacts/dependencies are excluded; BuildKit dependency cache was used.

Image IDs/runtime users: [image evidence](profile-request-redaction-2026-10-05-images.log). No remote deployment or commit.

## Environment and cleanup

Synthetic credentials outside repository, ports 23100/23101/23180, isolated Compose project **du-fix-redaction-20261005** and its own fresh database/queue volumes. `docker compose --env-file <synthetic redaction.env> -p du-fix-redaction-20261005 up -d --no-build --wait --wait-timeout 120` exited 0; [startup](profile-request-redaction-2026-10-05-docker-up.log). Thirty-three migrations were bundled, including the new column used by successful real profile revision writes.

Verified each volume's Compose project label before `down --volumes`; [cleanup](profile-request-redaction-2026-10-05-cleanup.log), exit 0. Owned Vite preview was stopped. Other projects/resources were untouched. Images and test evidence retained. Admin cookie/network smoke has the same loopback TLS-proxy simulation limits as the [Docker repair receipt](docker-fix-all-2026-10-05.md).

## Diagnostics retained and limits

Initial browser fixtures used an endpoint-derived row name while targeting the profile name, and missed query strings on the operation list; fixture selectors/routes were corrected and final 3/3 passed. Initial live fixture omitted required `correlation_id`; the real schema rejected it, fixture corrected, final 14/14 passed. Existing tests expecting a `[REDACTED]` marker in arbitrary fields were updated to assert omission and sentinel absence under the stronger metadata-only contract. Document Core environment parsing now explicitly rejects non-object input instead of throwing an incidental null property error. Earlier red outputs remain diagnostic artifacts, not passes.

Original artifact downloads/file bodies are not rewritten by JSON request redaction. Profiles with no rules expose input to authorized Admin/operators, explicitly labelled in UI. Stored payloads remain governed by existing encryption/retention. Historical log files are not deleted; collector forwarding filters replayed records. These checks do not claim a full business/provider E2E run or independent release acceptance.

API references: [Node 22 worker threads](https://nodejs.org/docs/latest-v22.x/api/worker_threads.html). Feature usage/limits: [guide](../../docs/profile-request-redaction.md).
