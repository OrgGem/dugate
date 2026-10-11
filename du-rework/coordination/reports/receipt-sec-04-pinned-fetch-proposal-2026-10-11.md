# Proposal receipt: SEC-OR-20261011-04 pinned fetch response construction

Date: 2026-10-11  
Task: SEC-OR-20261011-04-PINNED-FETCH-PROPOSAL  
Scope: `du-rework/orchestrator`  
Finding: `coordination/reports/orchestrator-security-review-2026-10-11.md`, SEC-OR-20261011-04

## Assessment

The proposed direction is correct and directly addresses the reported crash. `fulfillResponse` currently converts every `IncomingMessage` into a non-null Web stream and passes that stream to `new Response`. A non-null body is invalid for status 204, 205, and 304. Since this helper runs from the asynchronous Node response callback, the resulting synchronous `TypeError` escapes the Promise executor and is uncaught by the caller's `await` handler.

## Recommended change

1. Determine whether the response is bodyless before calling `unwrapEncoding` or `Readable.toWeb`. Use `null` as the Response body for statuses 204, 205, and 304, and for every response to a HEAD request regardless of status. Preserve status, status text, and valid headers.
2. Consume or destroy the underlying `IncomingMessage` for bodyless responses so the socket is released and no discarded stream is left active. Prefer draining a conforming empty response; destroy the response or request on abort or conversion failure. Do not expose an unexpected body for a status whose semantics prohibit one.
3. Put the complete synchronous response conversion inside a try/catch in the response callback. This includes decompression setup, conversion to a Web stream, header projection, and Response construction. On failure, clean up the stream/request and call the outer Promise reject callback with the error; do not throw from the event callback.
4. The redirect path uses a detached async IIFE. Ensure that path also routes unexpected exceptions to the same rejection and cleanup path, rather than leaving a rejected IIFE unobserved.

Rejecting the Promise is the right transport contract: the webhook caller catches failures and records a failed delivery, while source acquisition maps fetch errors and removes its partial file. Promise rejection still requires callers to observe the returned Promise; these two production call paths already do. A malformed-compression error raised later while a caller reads the response body is a body-stream failure, distinct from a synchronous Response-construction error, and should be tested at body consumption rather than claimed as covered by the constructor catch.

## Regression coverage recommended

- Use an isolated loopback upstream to verify 204, 205, 304, and HEAD return a Response with the expected status and `body === null`, and that the caller's Promise settles without an uncaught process exception.
- Verify an ordinary 200 response still exposes its bytes, and verify a 204 webhook result remains a successful 2xx delivery.
- Exercise a response-construction failure through a narrow test seam, if available, and assert Promise rejection plus socket cleanup. Test invalid compressed content separately by consuming the response body and asserting the stream read rejects without an uncaught exception.
- Keep `allowPrivateNetworks` limited to isolated loopback tests; it is not a production setting implied by this fix.

## Offline test evidence

- Command: `pnpm --dir orchestrator/packages/egress test`
- Result: PASS, 3 Jest suites, 34 tests, 0 failures, exit code 0.
- A source search of `orchestrator/packages/egress/tests` found no coverage for status 204, 205, 304, or method HEAD. The green baseline therefore does not resolve this finding.

## Scope and status

This is a proposal and analysis only. No product code or tests were changed. SEC-OR-20261011-04 remains open until the response path is fixed and the null-body, callback rejection, cleanup, and caller behavior are independently verified. No git add, commit, or push was performed; no gate was ticked.
