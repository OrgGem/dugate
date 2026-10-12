# Independent phase 3 source review

Reviewer `/root/requirements_alignment`, gpt-6.1-sol high, read-only. Frozen template/SDK test changes and UI only; mutable profile repairs excluded. Verdict: WOC-08 **APPROVED at source level**; UI **CHANGES NEEDED** for one P2.

**P2 navigation:** `profile-group-editor.tsx:703` and `initial-bindings.tsx:10` link to `/connectors`; application is mounted at `/admin/` (`vite.config.ts:13`, `router.tsx:28,66`). Use base-aware/router navigation and click both links in built-SPA smoke. Assigned to the original Luna max UI owner.

Receipt correction: UI GET/list do not send selected apiKeyId; current source matches final intended backend contract. Server derives the current ACTIVE tenant key from memberships; DTO.apiKey hydrates editor. Rollback retains expectedRevision/targetRevision. Create/replace sends selected existing key. Correct receipt/hash manifest, no gratuitous API argument change.

Reviewer independently checked all 11 vendor source fingerprints against vendor/canonical hashes. Ten exact copies and one selected-exports barrel are accurately labelled. TypeScript aliases and conformance harness target isolated vendored sources/output. Registration, deferred claims, capability refusal, watchdog and reservations match canonical. Affected SDK assertions retain rejection/no-download/no-dispatch and secret redaction. INVOCATION_UNKNOWN retains same-ID retry; provider count demonstrates a mock ledger, not Connector service E2E.

Crypto byte-parity drift is baseline-only for this packet: three current Git blobs match baseline exactly. Failure remains; AAD edits not authorized. Other UI source matches grouping, measured counts, separate enable/default, catalogs, multi-business CAS, unavailable functions and platform-admin fence. Version labels do not claim public explicit multi-version admission.

Owner evidence: vendor lock 61/61, five template vectors, affected SDK 103 pass + one todo, UI nine focused pass. Full UI 26 failures unresolved without baseline attribution. Reviewer ran no tests/build/services. Process crash/network partitions, image provenance and actual Connector→mock-provider E2E remain open gates. Final profile review and narrow UI repair re-review pending.
