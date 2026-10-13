# Frontend bounded repair packet receipt

Date: 2026-10-12

## Scope delivered

- Kept the approved contextual navigation groups and original route URLs. Access & security groups `/security`, `/identity`, `/api-keys`, and `/secrets`; API Keys remains shown only for a platform Admin. Resources groups `/api-docs` and `/docs`; Bootstrap remains a distinct sidebar entry. The app-shell account name now truncates within the narrow header row while keeping the Profile suffix and Logout control visible.
- Added server-cursor First/Previous/Next navigation to the Secrets catalog, retaining the BFF-provided cursor and resetting page history when tenant scope changes. The loader pairs cursors with tenant scope, rejects callbacks captured by an old tenant before dispatch, invalidates old requests synchronously on scope changes, and guards success, failure, paging, and loading commits after await. This prevents a late mutation refresh from issuing an old-tenant request or superseding the current tenant’s catalog load. Dialog drafts and mutation state are unchanged.
- Bounded the Audit, Usage, System Operations, and Overview result tables with named keyboard-scroll regions, compact rows, and sticky headers while keeping their existing server paging/filter/export semantics.
- Bounded the API Keys and Identity loaded lists; labeled Identity assignment option regions. Existing pagination, edit drafts, and role/key guards remain in place.
- Bounded cost adjustment and cost policy revision history regions without changing export or mutation handling. Made Workflow connector-slot mapping a named, keyboard-accessible two-axis scroll region with a sticky header.
- Aligned Trace and Security actions with their input/control rows; helper and validation messages remain below their controls.

## Validation

- `node --test tests/orv15-frontend-bounded-repair.test.mjs`: passed, 3 source-contract tests. These checks pin the scope/cursor guards but do not simulate delayed mutation responses.
- `git diff --check` for the leased source files: passed, including the Secrets follow-up.
- Package typecheck/build and browser geometry verification were not run in this packet; they are pending the independent final verifier. The browser verifier should exercise the delayed mutation-A / tenant-B catalog sequence, and the 320 px profile-header geometry.
- Raw focused test output: `coordination/reports/rawfrontend-bounded-repair-focused-test.txt`.

## Frozen source hashes

SHA-256 values for the source/test snapshot after the focused check:

| File | SHA-256 |
|---|---|
| `src/app-shell/app-shell.tsx` | `FF9A4F31A74513020B6C6E7B533FE83C421FD595720236648BB6173C68DC9DB3` |
| `src/features/trace/trace-screen.tsx` | `406C50D2CE3F23776C178A500A3901350B76FF9EF9125FDB66C20DA04BB7F135` |
| `src/features/secrets/secrets-screen.tsx` | `75D7DB859FE45128BF97DDA9C3AA22984A894EF9998AA74551ABD208E651BDD6` |
| `src/features/audit/audit-screen.tsx` | `1946F40AE800F099CA196523D30F8F7FD6092F7C27279C2D6DAD0310DB831F41` |
| `src/features/usage/usage-screen.tsx` | `889F97F0BFDA66AA1F532ACCCBE63AB08BAB269E77275946FFE492C783F3E29F` |
| `src/features/usage/cost-adjustment-panel.tsx` | `4BAC291E40C7FDA8568DF8252B80ABF1F9A044E7127D59D119BA57748570EE71` |
| `src/features/usage/cost-policy-panel.tsx` | `9CE1BF3B70F1B268CBCB1218FD61B6C3CE3F191DF3858915A1C151FC367E96A1` |
| `src/features/security/security-screen.tsx` | `A1A8FC9FAB94795DEE6B032EC4233FB357FA2FC90C5A99E85FE6BCF7D6627DE8` |
| `src/features/api-keys/api-keys-screen.tsx` | `8BEBE896CF5B33E49A156856538A106A2EA575420F0CBAC97AEF4078AFAB544F` |
| `src/features/identity/identity-screen.tsx` | `54000A5BC010386BFB01EE37F39E3770DB681E9A4FF8320C6FFE8D3130770807` |
| `src/features/workflows/workflows-screen.tsx` | `B267C69A6FC75B928D82AFFDB91EB33FD6BCAEBF8544EA854E9C42791302125D` |
| `src/features/overview/operations-monitor-dashboard.tsx` | `5F5E69804C3A11EC689FFB0103AE4EFF0F25B1AEC321E23513F263EE747BEE14` |
| `tests/orv15-frontend-bounded-repair.test.mjs` | `36E775BD145AB9377553DE2677DE530D049836A8CCCF113FD69B448DEE8D76AD` |
