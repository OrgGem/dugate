# CR10-03/04 OAuth2 token acquisition completion receipt

**Date:** 2026-10-10 15:15 UTC

**Owner evidence:** Codex implementation and offline verification

**Runtime:** Node v24.21.0, Windows/PowerShell

**Repository:** `D:\Git\dugate`

**No git add, commit, push, or gate/checkbox changes were made.**

## Work completed

- `oauth2-client.ts` creates one acquisition deadline before resolving the client secret. The same abort signal and deadline cover secret resolution, all attempts and retry backoff, DNS/pinned transport, response headers, and every streamed body read. A timeout stops later retries. Secret providers receive the optional abort signal.
- The response byte limit is enforced incrementally for each stream chunk. Responses without a chunk-readable body fail closed without calling `response.text()`. Null bodies are treated as empty. Early status/content-type/content-length rejections cancel the body; stream cleanup does not block returning the timeout or size failure.
- The shared pinned egress transport now races DNS resolution against the request abort signal and checks abort before preparing the request or opening a socket. DNS answers are still adjudicated as a set and the approved address is the one dialed; token credentials are never automatically forwarded across redirects.
- Added regression coverage for one timeout across retries, cancellation of retry delay after timeout, a slow secret resolver, streams without a bounded reader, and DNS answers arriving after timeout. Updated the traceability matrix, test inventory, and acceptance evidence as owner notes only.

## Verification

All final test commands ran offline on Node v24.21.0. The OAuth2/callback cases use synthetic streams, controlled resolver answers, and local loopback listeners only; no public IdP, production credential, live database, or Redis was used.

| Command | Working directory | Result |
|---|---|---|
| `node node_modules\jest\bin\jest.js --runInBand --runTestsByPath tests/cr10-oauth2-body-and-egress.test.ts tests/cr10-oauth2-stream-bounds.test.ts tests/cb-03-outbound-auth.test.ts tests/cb-02-webhook-result-delivery.test.ts tests/cb02c-retry-callback-pin.test.ts tests/cb02-admission-writer.test.ts tests/cb02b-profile-publish-callback.test.ts tests/cb03-composition-resolver.test.ts tests/vfy-cb01-dispatch-matrix.test.ts` | `D:\Git\dugate\du-rework\orchestrator\services\orchestrator` | **Exit 0; 9 suites, 111 passed / 111 total, 0 failed.** |
| `node ..\..\services\orchestrator\node_modules\jest\bin\jest.js --runInBand --runTestsByPath tests/egress-ssrf-redirect-matrix.boundary.test.ts tests/egress-ssrf-deny-matrix.boundary.test.ts tests/egress-boundaries.boundary.test.ts` | `D:\Git\dugate\du-rework\orchestrator\packages\egress` | **Exit 0; 3 suites, 34 passed / 34 total, 0 failed.** |
| `node node_modules\typescript\bin\tsc --noEmit -p tsconfig.json` | `D:\Git\dugate\du-rework\orchestrator\services\orchestrator` | **Latest run exit 2:** `src/http/routes/admin.ts:644,733` each report `Expected 4 arguments, but got 5`. These AWEB call sites are outside the CR10 files and were not changed in this task. |
| `node ..\..\services\orchestrator\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json` | `D:\Git\dugate\du-rework\orchestrator\packages\egress` | **Exit 0; no diagnostics.** |
| `git diff --check -- du-rework/docs/19-traceability-audit-matrix.md du-rework/docs/28-test-inventory.md du-rework/docs/35-acceptance-baseline.md du-rework/orchestrator/services/orchestrator/src/modules/webhooks/oauth2-client.ts du-rework/orchestrator/packages/egress/src/pinned-fetch.ts` | `D:\Git\dugate` | **Exit 0; no whitespace errors.** |

Raw test and typecheck outputs are under [`raw/cr10-oauth2-complete-2026-10-10/`](raw/cr10-oauth2-complete-2026-10-10/): `oauth2-regression.log`, `egress-regression.log`, `orchestrator-typecheck.log`, and `egress-typecheck.log`.

## Limits and status

The offline checks prove behavior against controlled DNS and loopback fixtures, not a real public HTTPS identity provider or production DNS/network topology. Independent review and acceptance remain open. These owner checks do not tick or close any gate.
