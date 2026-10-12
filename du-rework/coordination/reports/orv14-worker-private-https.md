# ORV14 Worker private HTTPS and tenant prompt defaults — owner handoff

**Owner scope:** document-core Worker configuration and runtime, immutable tenant-default prompt consumption, the narrow observability metadata projection, owner tests, and operator runbook. **Status:** source implementation frozen for Backend's shared build and the primary Worker's real integration verification. This report does not claim release acceptance.

## Implementation

`WORKFLOW_PRIVATE_HTTPS_ORIGINS` is parsed at Worker startup as an empty-by-default list of at most 64 canonical exact HTTPS origins. The parser and per-worker policy factory enforce the 8,192-byte list bound and 2,048-byte per-origin bound, reject duplicates and noncanonical entries, and freeze a copied sorted origin set. Startup metadata carries only the policy's `sha256:<64 lowercase hex>` digest. The observability projection allows only that exact key and shape; origin or URL strings and arrays remain dropped.

Each `startDocumentCoreWorker` call creates its own immutable policy closure and a fresh handler definition. Schema-workflow roots and branches share that closure through callbacks, file URL downloads, retries, and resumed work. Before either network path starts, `requireApprovedHttpsOrigin` still requires the immutable tenant schema pin to approve the URL origin; the policy enables private-network egress only when the same origin is also in the Worker deployment list. The existing `@du/egress` pinned transport and its DNS/address adjudication, TLS/SNI and CA checks, reserved-address denials, redirect refusal, response limits, timeouts, and cancellation fencing are unchanged.

The Worker now forwards the admitted tenant-default snapshot into its local task context only after schema and content-digest validation, copying and freezing its nested data. Each registered action handler supplies its action identity from the handler closure. Category prompts require a registered action/step and, for image/PDF/DOCX, content-detected formats from authorized artifacts; Compare and Generate use their fixed registered action/step pairs. Code and Profile precedence is preserved above tenant defaults, with the existing assembled callsite prompt as fallback. Template interpolation is applied to all five categories. Local prompt-step/category metadata is removed before provider options are sent. No current-settings fetch was added.

The operator instructions are in `orchestrator/docs/51-workflow-private-https-runbook.md`.

## Verification

Environment: Node `v24.21.0`, recorded in `coordination/reports/raw/orv14-worker-private-https/node-version.txt`. No package reinstall, shared build, or dist mutation was performed.

- Source-mapped Worker no-emit check passed with `/tmp/orv14-worker-tsconfig.json`; preserved config is `raw/orv14-worker-private-https/source-noemit-tsconfig.json`.
- Owner-test no-emit check passed with `/tmp/orv14-worker-test-tsconfig.json`; preserved config is `raw/orv14-worker-private-https/owner-test-tsconfig.json`.
- Source-mapped Jest run passed **4 suites / 59 tests**: the unique ORV14 owner suite, `config.test.ts`, `p745-carrier-impl-b2.test.ts`, and `wfa-runtime-join-merge.test.ts`. The Jest mapping resolves Worker SDK, document-kit, and observability to source; the two orchestration service entries remain on their existing dist test copies. Full output is `raw/orv14-worker-private-https/owner-targeted-tests.txt`.
- Scoped `git diff --check` across all owned source, test, and runbook files passed.

The owner suite covers empty default, canonical/duplicate/size boundaries (both parser and factory), per-worker isolation, schema/digest rejection, deep snapshot freezing, missing-snapshot compatibility, precedence, all five prompt categories and variables at the SDK connector adapter, metadata stripping, untrusted MIME/filename rejection, and startup digest logging without origin disclosure.

Two linked-package limitations remain for Backend's shared build. Native document-core no-emit against the currently linked declarations exits 2 on the pre-existing connector invocation call at `legacy-schema-runtime.ts:873` (`Expected 2-4 arguments, but got 5`); source-mapped no-emit passes against current package sources. With the normal linked observability dist, the unique startup-log test fails because that compiled consumer drops the new digest field. The exact output is preserved in `raw/orv14-worker-private-https/native-package-noemit.txt` and `raw/orv14-worker-private-https/linked-consumer-current-dist.txt`. Re-running the same owner suite with observability source mapped passes. No stale dist file was changed.

Repository-wide `git diff --check` reports trailing whitespace in unrelated pre-existing dirty reports, including `coordination/reports/antigravity-6.md`; the scoped owned-file check above passes. Existing dirty `businesses/document-core/src/manifest/document-core.manifest.ts` and `src/validation/input-normalizer.ts` hunks were preserved and are outside this handoff's source set.

The primary verification owner still needs to run the admitted workflow against a real local TLS service with PostgreSQL and Redis, observe the full worker-to-result path, and exercise private-origin approval negatives, TLS failure, redirects, forbidden address classes, and cancellation. The source-mapped adapter tests do not substitute for that evidence. Backend's shared build must include the observability source extension and refresh the compiled consumers before that actual Worker verification.

## Frozen source manifest

Starting hashes supplied in the dispatch packet for the four released Worker files:

| Source | Starting SHA-256 | Handoff SHA-256 |
|---|---|---|
| `businesses/document-core/src/config.ts` | `8fc3de0a16056617cc9ee665fb84058829c674271f4d32b8a44f6481304c5061` | `117390dc2653da5101026ffac300fe20125c31da550ff6ea8b212ed4b5408770` |
| `businesses/document-core/src/main.ts` | `3c60ebafb73ce22887e2383238eb6db59ea6e6bfc47bd502c3e408077ad8cfcd` | `13816a6e5d924ec1951fa8e25b15df4ed009b19de935118ce71faaea12cb5c84` |
| `businesses/document-core/src/worker.ts` | `131d4a246c0449b1b274b45a6735156a3e206fbc0ec6813f5ecb3db015c326fc` | `27a562c906d2cdf75fb6981b0d6eb27fc56c0632d430ef14b017180449801c34` |
| `businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts` | `c0e189a6f49ed020e58ac1bc631f102f784927e3e4970ec2ca2be090642ca80d` | `4583cb04a3b80894112fceee3da1367bcf16b9d956ad0d15d468190514af4e58` |

Additional released source and unique owner evidence:

| Source | Handoff SHA-256 |
|---|---|
| `businesses/document-core/src/workflow-private-https-policy.ts` | `69056abe47b4af09677f2c616ef9ebf11b92a4d8aaa5f0460b6d548acd5f2b4c` |
| `businesses/document-core/src/actions/prompt-application.ts` | `8360ade5046afa850927010a9f54ce170790c141fc4c721d638858fc993d26d1` |
| `businesses/document-core/src/actions/prompt-precedence.ts` | `adac4ff4e6573601875da38b3a98a94b36dc97396fff52b435849f6802999b10` |
| `businesses/document-core/src/types/context.ts` | `8852ff468a9663ef5dfd89b5a74c98d37488ae29f6cc63b1cb5b7d7ebf426d9f` |
| `businesses/document-core/tests/orv14-worker-private-https-owner.test.ts` | `b0b5d0b276a53e4dd6fbf01c69293da97c825c25b0567a7ebf53205165ea6ed4` |
| `orchestrator/packages/observability/src/log-metadata.ts` | `4999a79de5b0da53ac47e4f32a41b6920064e722eb6c10add5b190a0666bc19d` |
| `orchestrator/docs/51-workflow-private-https-runbook.md` | `bb14b5b3bedad2ba5912fe6404a45ede3936c4d90fc12620948f7fd805d9515d` |

The Backend build/consumer handoff must include the observability source leaf above and report the compiled consumer versions/hashes used by the primary tester.
