# Secret-hygiene sweep — 2026-10-02

Read-only, pattern-based review of the `du-rework/` working tree. This receipt contains no matched credential values; lengths below are metadata only. It is not a credential-validity test.

## Scope and method

- Scanned 1,546 files; 1,527 text files were examined and 19 binary files skipped. Excluded directory segments `node_modules`, `.git`, `dist`, `coverage`, `tmp`, `temp`, `log`, and `logs`, plus `.log` and `.tmp` files. The current `.cache` directory was not excluded by the requested rules.
- Direct-pattern checks covered Vault token, OpenAI-style key, AWS access-key, GitHub-token, Slack-token, and PEM private-key markers. Literal assignment checks covered quoted values assigned to `password`, `secret`, `token`, or `apiKey` (case-insensitive) in source/config-like files.
- Results: 253 match instances in 105 grouped file/classification rows: 250 classified `placeholder/mock` and 3 `real-looking`. A file/line can appear more than once when distinct patterns or literals occur on that line. Candidate types and line numbers are exhaustive for this scan; values are deliberately omitted.
- `placeholder/mock` means explicit fixture/mock/redaction/truncation context or an evident test fixture; it does not imply the text should be copied into production. `real-looking` means no reliable placeholder marker was found. It does not prove that a credential is valid.

## Unresolved real-looking candidates

| Location | Type | Classification / note |
|---|---|---|
| `coordination/reports/qwen-cost.md:67` | OpenAI-style key pattern; length 27 | real-looking; credential validity unknown. Appears in report prose. |
| `coordination/reports/qwen3.md:1600` | OpenAI-style key pattern; length 20 | real-looking; credential validity unknown. Appears inside a quoted connection-string example in report prose. |
| `services/orchestrator/src/app/admin/shell-server.ts:374` | Literal `apiKey` assignment; length 43 | real-looking static literal in production code; no explicit placeholder marker found. Its purpose/validity was not established by this offline sweep. |

These three findings prevent a defensible “no real-looking secret remains” conclusion. No credential was validated or tested against a service; treat these as unresolved candidates pending owner/security review.

## Complete redacted hit inventory

Each `line(length)` entry gives the source line and matched-value length (or marker length for PEM). No matched value is reproduced.

| File | Classification | Type: line(length) |
|---|---|---|
| `businesses/document-core/tests/helpers/test-target-guard.ts` | placeholder/mock | literal password: 44(3) |
| `businesses/document-core/tests/multi-container-e2e.integration.test.ts` | placeholder/mock | literal apiKey: 118(23) |
| `businesses/document-core/tests/p8-01-traceability-harness.test.ts` | placeholder/mock | literal token: 170(23) |
| `businesses/document-core/tests/profile-binding-fixture.test.ts` | placeholder/mock | literal apiKey: 90(8), 117(8), 143(8), 162(8), 197(12), 292(7) |
| `businesses/example-review/tests/example-review-continuation.integration.test.ts` | placeholder/mock | literal apiKey: 23(41) |
| `businesses/example-review/tests/example-review.test.ts` | placeholder/mock | OpenAI-style key: 134(29) |
| `coordination/dispatch-receipts.md` | placeholder/mock | OpenAI-style key: 264(8) |
| `coordination/dispatch-specs/2026-10-02-1028-secret-hygiene-sweep.md` | placeholder/mock | Vault token: 5(8), 14(9), 14(17) |
| `coordination/reports/claude.md` | placeholder/mock | OpenAI-style key: 1308(8) |
| `coordination/reports/coordinator-antigravity.md` | placeholder/mock | OpenAI-style key: 858(11), 868(15), 895(15) |
| `coordination/reports/openclaude.md` | placeholder/mock | OpenAI-style key: 540(13), 553(13) |
| `coordination/reports/qwen-cost.md` | real-looking | OpenAI-style key: 67(27) |
| `coordination/reports/qwen2.md` | placeholder/mock | OpenAI-style key: 1272(6) |
| `coordination/reports/qwen3.md` | placeholder/mock | OpenAI-style key: 2317(8), 2546(15), 2626(15) |
| `coordination/reports/qwen3.md` | real-looking | OpenAI-style key: 1600(20) |
| `coordination/requests/qwen3.md` | placeholder/mock | OpenAI-style key: 489(11) |
| `coordination/review-evidence/code-review-2026-09-23.cjs` | placeholder/mock | literal secret: 45(23) |
| `coordination/reviews/2026-10-02-1022-coordinator.md` | placeholder/mock | Vault token: 11(8) |
| `coordination/WAVE-39-ORCHESTRATOR-REALLOCATION.md` | placeholder/mock | OpenAI-style key: 2083(13) |
| `packages/connector-client/tests/network-boundaries.boundary.test.ts` | placeholder/mock | literal TOKEN: 48(3) |
| `packages/connector-client/tests/transport.test.ts` | placeholder/mock | literal TOKEN: 16(11) |
| `packages/contracts/tests/dto.test.ts` | placeholder/mock | literal apiKey: 175(3) |
| `packages/contracts/tests/multipart-contract.test.ts` | placeholder/mock | literal TOKEN: 30(36) |
| `packages/contracts/tests/usage-event-export.test.ts` | placeholder/mock | literal secret: 81(12) |
| `packages/contracts/tests/usage-metrics.test.ts` | placeholder/mock | OpenAI-style key: 101(14), 235(28), 365(27); literal apiKey: 101(14) |
| `packages/contracts/tests/vault-policies.test.ts` | placeholder/mock | OpenAI-style key: 28(35); literal SECRET: 28(35) |
| `packages/contracts/tests/vault-ref.test.ts` | placeholder/mock | OpenAI-style key: 139(8); PEM private-key marker: 181(31) |
| `packages/observability/tests/elasticsearch-collector.test.ts` | placeholder/mock | literal apiKey: 44(26), 54(25) |
| `packages/observability/tests/observability.test.ts` | placeholder/mock | OpenAI-style key: 17(9), 64(42), 127(41), 281(39), 312(14); literal apiKey: 17(9), 281(39), 312(14); AWS access key: 29(20), 67(20), 130(20); Slack token: 65(38), 128(37); GitHub token: 66(30); Vault token: 70(29), 133(29); PEM private-key marker: 102(31), 136(31) |
| `packages/worker-sdk/tests/artifact-multipart.test.ts` | placeholder/mock | literal token: 442(18), 465(18), 654(18) |
| `packages/worker-sdk/tests/artifact-read-metadata.test.ts` | placeholder/mock | literal token: 28(18), 126(18), 202(18) |
| `packages/worker-sdk/tests/artifact-stat.test.ts` | placeholder/mock | literal token: 21(18) |
| `packages/worker-sdk/tests/artifact-streams.test.ts` | placeholder/mock | literal TOKEN: 35(11) |
| `packages/worker-sdk/tests/connector-session.test.ts` | placeholder/mock | literal token: 272(3) |
| `packages/worker-sdk/tests/enc-read-roundtrip-proof.test.ts` | placeholder/mock | literal token: 107(1) |
| `packages/worker-sdk/tests/fan-out.test.ts` | placeholder/mock | literal TOKEN: 25(10) |
| `packages/worker-sdk/tests/rv01-03-fail-closed.test.ts` | placeholder/mock | literal token: 161(1) |
| `packages/worker-sdk/tests/worker-service-auth.test.ts` | placeholder/mock | literal token: 247(33) |
| `packages/worker-sdk/tests/worker.test.ts` | placeholder/mock | literal token: 492(3) |
| `packages/worker-sdk/tests/workspace-reference-wiring.test.ts` | placeholder/mock | literal token: 84(6), 100(6), 110(6), 124(6), 137(6), 149(6) |
| `services/connector/tests/p8-03-convergence.test.ts` | placeholder/mock | OpenAI-style key: 285(34); literal secret: 305(14) |
| `services/connector/tests/r1-d-03-mock-provider-reconciliation.functional.test.ts` | placeholder/mock | OpenAI-style key: 373(21), 386(21), 402(12), 454(12), 469(12), 493(12), 524(12), 545(12), 581(12), 628(26), 671(9) |
| `services/connector/tests/revision-binding.db.test.ts` | placeholder/mock | OpenAI-style key: 334(18) |
| `services/connector/tests/runtime-foundations.test.ts` | placeholder/mock | literal secret: 136(10) |
| `services/connector/tests/secret-resolver.test.ts` | placeholder/mock | OpenAI-style key: 27(22), 28(22), 29(22) |
| `services/connector/tests/token-renewal.test.ts` | placeholder/mock | Vault token: 16(20), 17(20) |
| `services/orchestrator/src/app/admin/shell-server.ts` | real-looking | literal apiKey: 374(43) |
| `services/orchestrator/src/compat/legacy-headers.ts` | placeholder/mock | literal token: 130(0) |
| `services/orchestrator/src/modules/auth/local-primitives/authenticate.ts` | placeholder/mock | literal password: 63(0) |
| `services/orchestrator/tests/adm-base-03-safe-error-offline.functional.test.ts` | placeholder/mock | OpenAI-style key: 22(29); literal SECRET: 142(19); literal TOKEN: 143(17) |
| `services/orchestrator/tests/admin-action-dispatcher.test.ts` | placeholder/mock | literal SECRET: 34(24); literal apiKey: 271(1), 287(1), 343(7), 763(1); literal secret: 381(0) |
| `services/orchestrator/tests/admin-actions-vault04-offline.functional.test.ts` | placeholder/mock | OpenAI-style key: 28(22), 29(22) |
| `services/orchestrator/tests/admin-api-keys.test.ts` | placeholder/mock | literal apiKey: 294(0), 315(5) |
| `services/orchestrator/tests/admin-audit-list-page.test.ts` | placeholder/mock | literal SECRET: 42(8) |
| `services/orchestrator/tests/admin-audit-mount.test.ts` | placeholder/mock | literal TOKEN: 20(17); literal SECRET: 21(18) |
| `services/orchestrator/tests/admin-audit-query.test.ts` | placeholder/mock | literal TOKEN: 19(17); literal SECRET: 20(18) |
| `services/orchestrator/tests/admin-audit-route.test.ts` | placeholder/mock | literal TOKEN: 23(3); literal SECRET: 24(3) |
| `services/orchestrator/tests/admin-audit-toolbar.test.ts` | placeholder/mock | literal SECRET: 26(8) |
| `services/orchestrator/tests/admin-crypto-config-wiring.test.ts` | placeholder/mock | literal secret: 1069(15) |
| `services/orchestrator/tests/admin-error-boundary-offline.test.ts` | placeholder/mock | literal SECRET: 224(22); literal TOKEN: 225(20) |
| `services/orchestrator/tests/admin-error-boundary.test.ts` | placeholder/mock | OpenAI-style key: 26(8) |
| `services/orchestrator/tests/admin-idempotency.test.ts` | placeholder/mock | literal apiKey: 185(2), 185(2), 219(3), 262(5), 332(3), 333(9), 391(3), 392(9), 598(3), 599(5) |
| `services/orchestrator/tests/admin-list-contract-conformance.test.ts` | placeholder/mock | literal secret: 289(8) |
| `services/orchestrator/tests/admin-operations-list-pagination.test.ts` | placeholder/mock | literal secret: 560(52), 628(52), 1036(1), 1215(52) |
| `services/orchestrator/tests/admin-operations-sort-http-offline.test.ts` | placeholder/mock | literal token: 689(35) |
| `services/orchestrator/tests/admin-overview-triage.test.ts` | placeholder/mock | OpenAI-style key: 607(15), 619(15) |
| `services/orchestrator/tests/admin-profile-view-model.test.ts` | placeholder/mock | OpenAI-style key: 277(19), 602(29), 621(29) |
| `services/orchestrator/tests/admin-shell-auth.test.ts` | placeholder/mock | literal SECRET: 23(23) |
| `services/orchestrator/tests/admin-shell-oidc-mount.test.ts` | placeholder/mock | literal password: 134(8) |
| `services/orchestrator/tests/admin-shell-platform-mount.test.ts` | placeholder/mock | literal TOKEN: 48(26); literal SECRET: 49(27); literal token: 232(5); OpenAI-style key: 541(13), 625(13); literal apiKey: 541(13) |
| `services/orchestrator/tests/admin-shell-render.test.ts` | placeholder/mock | OpenAI-style key: 653(13), 677(13); literal apiKey: 653(13) |
| `services/orchestrator/tests/admin-shell-router.test.ts` | placeholder/mock | literal TOKEN: 79(12), 109(3); literal SECRET: 110(3); literal token: 134(4) |
| `services/orchestrator/tests/admin-shell-server.test.ts` | placeholder/mock | literal TOKEN: 37(22); literal SECRET: 38(23); literal token: 154(5); OpenAI-style key: 608(13), 647(13); literal apiKey: 608(13) |
| `services/orchestrator/tests/admin-shell-session-lifecycle.test.ts` | placeholder/mock | literal token: 409(2) |
| `services/orchestrator/tests/admin-view-model.test.ts` | placeholder/mock | literal token: 433(8), 450(8), 461(8) |
| `services/orchestrator/tests/artifact-read-decrypt-offline.test.ts` | placeholder/mock | literal SECRET: 39(34) |
| `services/orchestrator/tests/artifact-read-download-route.test.ts` | placeholder/mock | literal SECRET: 42(30) |
| `services/orchestrator/tests/blob-wire-binary.test.ts` | placeholder/mock | literal token: 100(28) |
| `services/orchestrator/tests/br12-isolation-offline.test.ts` | placeholder/mock | literal token: 56(14) |
| `services/orchestrator/tests/connector-credentials-offline.functional.test.ts` | placeholder/mock | OpenAI-style key: 24(24), 235(8) |
| `services/orchestrator/tests/connector-revision-http-offline.functional.test.ts` | placeholder/mock | OpenAI-style key: 282(5), 293(5), 294(5), 310(5), 322(5), 327(5), 328(5) |
| `services/orchestrator/tests/credential-legacy-transition-offline.test.ts` | placeholder/mock | OpenAI-style key: 27(21) |
| `services/orchestrator/tests/delivery-encryption.test.ts` | placeholder/mock | PEM private-key marker: 75(27) |
| `services/orchestrator/tests/encryption-boot-options.test.ts` | placeholder/mock | Vault token: 44(17), 44(17), 121(17), 130(17), 248(14), 249(14) |
| `services/orchestrator/tests/gsec-sentinel-rbac.boundary.test.ts` | placeholder/mock | literal secret: 109(5) |
| `services/orchestrator/tests/legacy-action-router.test.ts` | placeholder/mock | literal secret: 635(43) |
| `services/orchestrator/tests/legacy-headers.test.ts` | placeholder/mock | literal token: 22(6), 43(9), 49(3), 232(10) |
| `services/orchestrator/tests/legacy-operations.test.ts` | placeholder/mock | literal secret: 104(9) |
| `services/orchestrator/tests/local-primitives.test.ts` | placeholder/mock | literal PASSWORD: 14(28); literal password: 98(14), 102(14), 130(7), 134(7) |
| `services/orchestrator/tests/log-collector.test.ts` | placeholder/mock | literal apiKey: 13(17) |
| `services/orchestrator/tests/mock-vault-harness-offline.functional.test.ts` | placeholder/mock | OpenAI-style key: 78(20); literal SECRET: 78(20) |
| `services/orchestrator/tests/oidc03-role-action-tenant-offline.test.ts` | placeholder/mock | literal apiKey: 295(1), 359(3), 364(4) |
| `services/orchestrator/tests/runtime.test.ts` | placeholder/mock | literal apiKey: 2318(25); literal secret: 2915(10), 2927(6), 2957(6), 2989(6) |
| `services/orchestrator/tests/usage-drilldown.test.ts` | placeholder/mock | literal token: 243(17), 262(18), 274(18); literal apiKey: 263(15), 275(15) |
| `services/orchestrator/tests/usage-summary.test.ts` | placeholder/mock | OpenAI-style key: 56(18), 322(18); literal token: 56(18) |
| `services/orchestrator/tests/webhook-delivery-encryption.test.ts` | placeholder/mock | literal SECRET: 50(14) |
| `services/orchestrator/tests/webhook-error-boundaries.boundary.test.ts` | placeholder/mock | literal SECRET: 64(6); literal token: 163(6) |
| `services/orchestrator/tests/webhook-reclaim-fence.live.test.ts` | placeholder/mock | literal SECRET: 42(12) |
| `tests/browser/src/admin-mock.ts` | placeholder/mock | literal token: 578(20) |
| `tests/harness/mock-vault/server.ts` | placeholder/mock | Vault token: 122(9) |
| `tests/integration/p8-01-traceability.integration.test.ts` | placeholder/mock | literal apiKey: 61(21) |
| `tests/integration/p8-04-security-isolation.integration.test.ts` | placeholder/mock | OpenAI-style key: 741(37), 750(37); literal apiKey: 741(37) |
| `tests/integration/sec-int-01-credential-lifecycle.integration.test.ts` | placeholder/mock | OpenAI-style key: 63(15) |
| `tests/login/tests/log-redaction.test.ts` | placeholder/mock | GitHub token: 17(13), 242(40); literal apiKey: 17(13); AWS access key: 18(20), 243(20); literal secret: 168(11); Slack token: 241(22); Vault token: 245(26); PEM private-key marker: 246(31) |
| `tests/unit/sentinel-sink-matrix.test.ts` | placeholder/mock | OpenAI-style key: 20(37); Vault token: 21(29), 143(9) |

## RV0104 live-encryption case

The historical hit is separately classified as **real-looking**: in incident commit `6fb5294`, `services/orchestrator/tests/rv0104-live-encryption.test.ts:39` and `:40` each match the Vault-token family. These historical matches are not included in the working-tree inventory above.

| Source state | Vault-family matches | Encryption env references | Decryption env references |
|---|---:|---:|---:|
| Working tree | 0 | 3 | 3 |
| Git index | 0 | 3 | 3 |
| Current `HEAD` (`f2be0de`) | 0 | 3 | 3 |
| Incident commit `6fb5294` | 2 | 0 | 0 |

The current target file is tracked and has no path-specific `git status` change. Both `RV0104_VAULT_ENC_TOKEN` and `RV0104_VAULT_DEC_TOKEN` are referenced in the working tree, index, and `HEAD`; neither variable is set in this verification shell. The incident commit object still contains the two Vault-family matches, but `6fb5294` is not an ancestor of current `HEAD` and no current local branch contains it. This is consistent with a rewritten/amended branch history; this read-only local check does not establish remote push status or whether GitHub has rescanned it.

## Recommendations and limitations

Add a push/PR secret scanner over staged diffs and commit history, with narrow reviewed allowlists for synthetic fixtures; schedule a periodic full-tree scan and alert on newly introduced candidates. Pattern-based matching is incomplete and can produce false positives; it does not establish credential validity or replace GitHub secret scanning/push protection.
