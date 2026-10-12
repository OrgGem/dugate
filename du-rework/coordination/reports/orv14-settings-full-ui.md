# ORV14 Settings full UI owner receipt

**Task:** ORV14-SETTINGS-FULL-UI  
**State:** implementation owner checkpoint; independent verification and acceptance remain pending  
**Receipt time:** 2026-10-11 23:41 UTC  
**Repository:** `/workspace/dugate/du-rework`, branch `codex/fix-workflow-builder`  
**Owned source lease:** `orchestrator/apps/admin-web/src/features/settings/**`  
**Unique artifacts:** `tests/orv14-settings-full-ui-owner.test.mjs`, `docs/50-admin-settings-guide.md`, this receipt, and `coordination/reports/raw/orv14-settings-full-ui/**`

## Delivered UI behavior

- Replaced the old no-writer Settings notice with real tenant AI/prompt, platform retention, and storage-generation forms backed by the released typed Admin client. Existing scoped configuration, migration readiness, Settings catalog, tenant context, local/OIDC session, role, CSRF, and same-origin controls remain in the route.
- Tenant AI drafts select an active exact Connector revision; model values, reason, saved revision, effective Profile/key/endpoint, typed action parameters, and up to four uploaded artifacts feed the real signed provider-test flow. Publish requires a tested draft and server response/usage evidence. Unknown acknowledgements keep the same idempotency key for recheck. Endpoint display strips URL user-info, query, and fragment.
- The prompt editor exposes all five defaults (`image`, `pdf`, `docx`, `compare`, `generate`), exact English and Vietnamese preset copies, local diff, placeholder checks, versioned draft/publish/history/rollback, and effective snapshot/digest. Required variables are `{file1}` / `{file2}` for compare and `{user_prompt}` / `{input_content}` for generate. Presets are local form changes until saved.
- Platform retention exposes effective/draft/history, bounded integer forms, publish, and rollback. Storage exposes current/history reads, PostgreSQL minimal stage body, S3 typed settings, exact managed Secret Catalog references, write-only create/rotate, stage diff, real generation tests, activation confirmation, retained-generation rollback, and idempotent unknown-result handling. No database URL, credential plaintext read, manual UUID/JSON entry, fake READY state, or global-write-adapter banner was added.
- Connector search filters exact tenant-owned ACTIVE rows and renders at most 100 results per step with a “Show next 100” control. Connector responses and Settings reads are tagged against the selected tenant so old tenant state is not rendered or submitted after a tenant change.

## Remaining functional gaps

These are contract/consumer limitations, not green UI claims:

1. **Tenant-operator AI Connector selection is blocked.** The typed Connector list route is platform-Admin-only (`GET /admin/api/connectors`); tenant operators are permitted by the global Settings read/write route but have no tenant-scoped Connector list client/BFF route. The UI does not call the platform-only list for a tenant operator and disables AI draft creation/test when it cannot validate an exact active Connector. Prompt defaults remain available. Backend was asked to add/freeze the tenant-scoped list contract; no such contract was available at this checkpoint.
2. **Storage credential list is limited to its first page.** The Admin client and BFF allow a cursor parameter, but `listSecretsFromDb` currently ignores it, caps `limit` at 200, and always returns `nextCursor: null`; the route has no search (`q`) parameter. The UI makes the 200-row limit explicit and only searches returned metadata. An older active credential cannot be selected from this UI until the backend cursor is implemented; a new credential revision can be created instead.
3. **Tenant defaults are pinned but prompt/AI consumers are not proven.** Orchestrator resolves the AI and all five prompt fields at submission, seals the snapshot by operation ID, opens it in runtime, and exposes it through the Worker SDK task context. No active worker/business consumer in this repository selects the five slots or the AI provider/model snapshot. Root independently confirmed the required `businesses/document-core` consumer is absent and has notified Backend. A real consumer implementation and behavioral receipt remain required before claiming runtime use.
4. **Retention scheduling is partial.** Cache TTL and output-retention values are consumed by maintenance cleanup previews/confirmations. `cleanupIntervalSeconds` is written/read but has no scheduled consumer in the current source; publishing it does not prove an automated cleanup schedule.
5. **UI acceptance is pending.** This owner did not run the served Docker Compose browser suite, viewport/theme/keyboard/overflow passes at 1440/768/390/320, or an independent UI review. No owner UI acceptance is claimed. Final VFY and the required independent review must run against the exact pinned bundle.

The Settings page displays revision/digest and storage receipt states returned by their APIs; this receipt does not treat those projections as proof of provider/runtime use beyond the concrete upstream provider-test receipt and the storage test receipt.

## Owner checks

Commands ran from `/workspace/dugate/du-rework/orchestrator/apps/admin-web`, using `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node` (`v24.21.0`):

| Command | Outcome | Raw receipt |
| --- | --- | --- |
| Final run 2026-10-11 23:41 UTC: `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | PASS, exit 0; whole admin-web TypeScript project | [typecheck.out](raw/orv14-settings-full-ui/typecheck.out) |
| Final run 2026-10-11 23:41 UTC: `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node --test tests/orv14-settings-full-ui-owner.test.mjs` | PASS, 3 passed / 0 failed / 0 skipped; exact preset mirror/placeholders, same-origin API/CSRF/idempotency and minimal Postgres body, UI wiring and secret handling | [owner-test.out](raw/orv14-settings-full-ui/owner-test.out) |
| `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node --version` | PASS, `v24.21.0` | [node-version.out](raw/orv14-settings-full-ui/node-version.out) |

The owner test emitted Node's `MODULE_TYPELESS_PACKAGE_JSON` warning while loading the existing server defaults module as ESM; all assertions passed. No dependency installation, shared build, Docker Compose run, network call, database mutation, production operation, staging, commit, or push occurred in this UI owner turn.

## Source manifest and lease handoff

`source-manifest.sha256` pins every current file under the settings source lease plus the unique owner test and guide. SHA-256 values at this checkpoint:

```text
7affd8656e0701bf07a3437f310f760673aefdb2c3efa937b64f63fd66bc3b9c  orchestrator/apps/admin-web/src/features/settings/catalog.ts
34334f99675fc9253edf4f17983f05d83422901a1e3980a64d695652248ce98e  orchestrator/apps/admin-web/src/features/settings/configuration-revisions.tsx
3032eaefc036a107bb187d2d53516e3320a5d9b2db147c171be0387cd6be904b  orchestrator/apps/admin-web/src/features/settings/endpoints.ts
b2890dc3d37e30aee5bd610f7239a56258b6c72d20eb254284476f20a4e950d8  orchestrator/apps/admin-web/src/features/settings/global-tenant-settings.tsx
c0dc928532a7320f9d7b1327d7a42086fc74f1cc4b941d13cd1de8a8dfbdf4dd  orchestrator/apps/admin-web/src/features/settings/migration-readiness.tsx
adf132b05e827f9bb8b9b7345e4a9069cd1a7624a2d605bafce1fad128fac03b  orchestrator/apps/admin-web/src/features/settings/prompt-presets.ts
826045aed60b2db19ed9076aff8cfda375157e9c78e427218d9cda258bb1f81f  orchestrator/apps/admin-web/src/features/settings/safe-display.ts
35ff39c466136973be6220af86cd4ff88b37c826e8e11c3e074ad43ad7a29b2c  orchestrator/apps/admin-web/src/features/settings/scope.ts
acbdd0913ec9da1c4248c3311bb0c6c515b0571d5402976c562646adf8883aa9  orchestrator/apps/admin-web/src/features/settings/settings-screen.tsx
c439340c086d256e2b529ae765107dc080ad6a1474178bdf047a2481989a6f52  orchestrator/apps/admin-web/src/features/settings/state.ts
12eca9193ba2a63e10a144051fde7aec6c66d3a427162a1a1ab0345a4918bd8d  orchestrator/apps/admin-web/src/features/settings/storage-generation-panel.tsx
5ae587da507633b489aceee86498b0899ac946819f92b9c54118fd14bd397b54  orchestrator/apps/admin-web/tests/orv14-settings-full-ui-owner.test.mjs
beef2cde824c52a8a751c55acc411d3d78130ace3ebd7adcd898688b77e2b7d9  docs/50-admin-settings-guide.md
```

The source lease is released at this checkpoint with no UI writes in flight. Parent may now pin this manifest for independent browser verification or dispatch a later focused UI follow-up for the tenant-scoped Connector list/secret-catalog continuation contracts. The newly dispatched reviewer must use the exact current source hashes above; subsequent source changes require a new compile/test receipt and manifest.
