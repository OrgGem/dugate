# ORV15 Admin owner checks

I added unit coverage for the retry, tenant-scope, partial-upload, and guided-override behaviors called out in the ORV15 packet. The regression test initially failed to compile because the production helper had no shared tenant-attempt registry or identity-scoped upload cache. I added those helpers and wired the Docs, Workflow, and Connector screens to them.

`TenantAttemptRegistry` keeps attempts in their captured tenant scope, rejects stale updates that would replace a different accepted request, and clears an accepted operation only when its matching terminal operation ID is observed. `FileArtifactCache` reuses an upload only for the same `File` object under the same tenant and API key. The callers now share those rules. The existing Connector editor tenant-keyed remount and the guided static-field/header controls were already present at the selected base, so I left their implementation unchanged and tested their public helper behavior.

The new regression tests cover an uncertain request followed by 401/403/409, preservation of the original key/body/artifact IDs, accepted-to-terminal handling, late tenant A updates while tenant B is selected, blocking a different workflow revision while an attempt remains unresolved, retry after a partial upload failure, and static-field/header edits that preserve profile locks and sibling data.

Focused Jest passed 3 suites and 15 tests, including the prior retry/editor and finance export owner suites. Admin web TypeScript no-emit passed under Node 24.21. `git diff --check` passed. Exact commands, raw outputs, and the source SHA-256 manifest are in [the owner receipt](raw/orv15-admin-owner/receipt.json).

These are offline owner checks. No component renderer is installed in the existing harness, so the tests exercise the production immutable-attempt/file-cache and workflow-editor seams directly. No browser, served bundle, API server, external provider, image build, or live service was run; this report makes no independent review or full Admin acceptance claim.
