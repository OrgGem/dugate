# Receipt - AWEB-COMPONENTS-INDEX-STALENESS-AUDIT-2026-10-10

> [!IMPORTANT]
> **RESUME POINT - lane Qwen-C, du-rework, written 2026-10-11.** A fresh session should read this
> block and the section below, then continue. Do not re-derive from the transcript, and do not
> re-run the audit.
>
> **Role.** Implementer lane on the shared du-rework checkout. No coordinator Run is bound to this
> terminal, so packets go out as `--type status` to `run:run_069ecd6957cd`. `worker_done` is NOT
> usable from here: it is an exact-Dispatch signal and this terminal holds no task-id or
> dispatch-id.
>
> **All 5 packets delivered, none accepted, 0 gates ticked.** Receipts, oldest last:
> 1. `receipt-cr10-oauth2-edge-2026-10-10.md` - CR10-03/04 oauth2-client stream bounds.
> 2. `receipt-aweb-i18n-language-alignment-2026-10-10.md` - first i18n pass, 2 leased files.
> 3. `receipt-aweb-i18n-comprehensive-2026-10-10.md` - i18n residue, 5 files, 0 Vietnamese lines left in src.
> 4. `docs-admin-web-components-staleness-2026-10-10.md` plus this receipt - staleness audit, rev 2.
>
> **Open, awaiting coordinator adjudication, none of it mine to do:**
> - Audit F1 through F6 are all source changes outside a read-only lease. F1 is an unused, drifted
>   duplicate type `BffHealthResponse`. F2 is a duplicated `parseAuditPage` and `severityVariant`,
>   both live, where the overview copy renders the `success` severity as `neutral` while production
>   code really writes that severity - a regression against the legacy shell it replaces. F8
>   deliberately carries no recommendation: 24 of the 88 barrel re-exports are unreachable, but a
>   deliberately complete type barrel is defensible, so that call is the plan owner's.
> - i18n residue: the earlier 140 pairs were character-counted but never quality-reviewed, and
>   translating `PRESET_SAMPLES` changed the provision payload, so newly provisioned workflows now
>   carry English where they carried Vietnamese.
>
> **Hard-won traps, each already cost a wrong answer:**
> - **Multi-line import blocks.** A line-by-line scan sees `import {`, never reads the names on the
>   following lines, and reports live code as dead. It nearly had me recommend deleting two functions
>   that two screens depend on. Always parse import blocks by regex.
> - **Resolve the `@/` alias.** A scan that cannot resolve it reports every component unused.
> - **A scan finds itself.** Every liveness pass matched my own scratch `.tmp-*.cjs`, the component
>   `README.md`, and the minified `dist/` bundle. Substring matching also reported 54 references to
>   `AdminApiClient` that were all the unrelated identifier `createAdminApiClient`. Scope to source
>   roots and delete scratch before the final pass.
> - **A Vietnamese diacritic scan must include Latin-1 Supplement, U+00C0 to U+00FF.** Omitting it
>   made me report zero Vietnamese lines while one survived in a file I had just edited; the same
>   blind spot is why the correct count was 21 and not the 19 an earlier pass measured.
> - **orchestration send:** pass the payload as a Python argv list, never a cmd.exe string. A
>   `--body` containing parentheses and slashes has already broken argument parsing on this host.
>
> **Shared-checkout reality.** Many lanes write `apps/admin-web` concurrently. Twice in this
> session a file I had measured changed underneath me, and once a receipt I had written had its
> mtime bumped by another process. **Re-verify with `git status --porcelain` immediately before
> writing any conclusion**, and re-read a file before overwriting it. An ` M` in git status does
> not mean this lane owns the diff.
>
> **Constraints honoured throughout.** No `git add`, no commit, no push, no live DB, Redis or S3,
> no product-code edit outside an explicit lease, and every document written with zero double
> quotes.

| Field | Value |
|---|---|
| Packet | AWEB-COMPONENTS-INDEX-STALENESS-AUDIT-2026-10-10 |
| Repo scope | `du-rework` only |
| Plan ref | summary-frontend-admin-workspace-delivery-2026-10-10.md |
| Lease | `coordination/reports/docs-admin-web-components-staleness-2026-10-10.md` |
| Deliverable | that document, plus this receipt |
| Date | 2026-10-10 |
| Work type | read-only audit, no product code touched |
| Revision | **rev 2** - the document was reviewed and rewritten before delivery |
| Status | ANALYSED · OFFLINE-VERIFIED · **NOT ACCEPTED**, no gate ticked |
| Bounds honoured | no git add / no commit / no push · zero double quotes in both documents |

---

## 1. Deliverable

`coordination/reports/docs-admin-web-components-staleness-2026-10-10.md`
sha256 `11f0a74be68b9bbbc2ae32bf8183d1c9da0ba792f0954c44b11198822439ee7e`
`doubleQuotes=0`, `trailingWhitespaceLines=0`, `strayEscapes=0`, 344 lines.

It audits every export of `src/components/**` (15 files) and `src/lib/api/index.ts`,
widening to `types.ts` and `client.ts` for F1 and F3, and to all 80 files of `src` for
the duplicate-name detection behind F2 and F7.

## 2. Findings

| # | Finding |
|---|---|
| F1 | `BffHealthResponse` is an unused, drifted duplicate of `AdminHealthSnapshot`; 3 counters differ only in nullability; 0 product consumers |
| F2 | `parseAuditPage` and `severityVariant` exist twice, both live, and disagree on the `success` severity that production code writes |
| F3 | `OperationTaskWire` is exported by the barrel source but not re-exported by the barrel |
| F4 | 2 of 80 files import `lib/api` leaf modules instead of the barrel |
| F5 | 11 exported component names have no code consumer; `tabs.tsx` is a wholly dead module still shipped via the star barrel |
| F6 | 4 exported names are test-only, and the two halves of that set need different treatment |
| F7 | zero duplicated exported type or interface names anywhere in `src` |
| F8 | **24 of the 88 names the barrel re-exports are never imported through the barrel** |

## 3. What the review pass changed, and why it matters

The first version was written, then reviewed. The review was not a polish pass; it found
four defects, one of which was a **missing headline finding**.

**F8 was absent.** The audit's own stated surface was `src/components/**` and
`src/lib/api/index.ts`, but nothing had checked whether the 88 names the barrel re-exports
are actually reached for. That is the question a barrel exists to answer, so version 1
answered the peripheral half of its own scope. Adding F8 needed a fresh import-block
regex over all 80 `src` files, then a name-by-name spot check.

**F2 was understated.** Version 1 derived the `success` mismatch from the contract alone.
The review grepped the writers and found `severity: 'success'` at 12 sites in
`modules/admin-actions/dispatcher.ts`, plus `http/routes/admin.ts:120`,
`admin-local/repository.ts:237,270` and `crypto-config-api.ts:314`. Further,
`app/admin/overview-view-models.ts:271` maps `operation.complete` to `success` and
`admin-overview-view-model.test.ts:540` asserts `auditSeverityBadge('success')` returns
`success`. So the Portal Overview is not only inconsistent with the Audit screen; it
renders an event class the **legacy shell it replaces** rendered as a success. Version 1
called the consequence cosmetic and never mentioned the regression. It is still cosmetic,
but a regression against the replaced surface is a different and stronger claim.

**One citation was wrong.** `overview-screen.tsx:41` was cited as the line that pulls
`parseAuditPage`; line 41 is `import {` and the name is at line 43. It is now cited as
the block, lines 41-46.

**One unverified assertion was cut.** Version 1 stated that the health endpoint
legitimately answers null for a counter it could not read. No live traffic was observed,
so the section now rests the argument on the type declarations that were actually read,
and says explicitly that runtime behaviour was not measured.

A fifth defect, formatting only, was fixed while running the required quote check: the
word `grep` plus a quoted pattern introduced 2 double quotes into the document and broke
the zero-quote bound. The line was reworded.

## 4. Verification

```text
npx tsc --noEmit -p tsconfig.json   -> exit 0, no diagnostics
node --test tests\*.test.mjs       -> tests 82 | suites 18 | pass 82 | fail 0 | exit 0
```

**Citation check - 23 of 23 correct.** Every file:line named in the document was read
back from the working tree and the expected substring asserted:

```text
audit/state.ts:135 severityVariant       ok
overview/state.ts:174 severityVariant    ok
audit/state.ts:45 parseAuditPage         ok
overview/state.ts:71 parseAuditPage      ok
trace-screen.tsx:12                      ok
api/types.ts:470                         ok
api/client.ts:65                         ok
api/types.ts:411                         ok
ui/index.ts:10                           ok
app-shell/app-shell.tsx:6, 27            ok
api/client.ts:85, 352, 158               ok
secrets/secrets-screen.tsx:332           ok
packages/contracts/src/public-api.ts:559 ok
modules/admin-actions/dispatcher.ts:512  ok
http/routes/admin.ts:120                 ok
auth/admin-local/repository.ts:237       ok
app/admin/crypto-config-api.ts:314       ok
app/admin/overview-view-models.ts:271    ok
tests/admin-overview-view-model.test.ts:540  ok
tabs.tsx = 57 lines (document claims 57) ok
```

One apparent citation failure was the **checker**'s fault, not the document's: it
demanded the word `state` at `audit-screen.tsx:23`, but line 23 is `import {` and the
`from './state'` specifier sits at line 31. The block citation is correct, and this is the
same multi-line import shape the document warns about in its own method section.

F8 was measured by an import-block regex, then spot-checked name by name because a text
search gives the wrong answer: several of the 24 are live symbols used as return types
inside `client.ts` (`ApiKeyPage` at 85, 86, 358, 361; `TenantPage` at 83, 352;
`ProfileMutationResult` at 158, 165, 172 and five more). They are reachable inside the
client and unreachable from the barrel. Two same-named symbols in other packages
(`ConnectorActivateParams` and `ConnectorRevisionTarget` in `packages/contracts`) are not
consumers of this barrel and were excluded.

## 5. Wrong answers produced during this packet

Recorded because an audit that quietly drops its own errors is not auditable.

1. **Line-by-line import scan** reported `parseAuditPage` and `severityVariant` dead.
   Both are used across a multi-line block. Had it stood, the document would have
   recommended deleting two functions two screens depend on.
2. **A regex block parser dropped 4 of 88 barrel names** and I reported 4 missing
   re-exports. Three were present at `index.ts` lines 46, 47 and 51; only
   `OperationTaskWire` is genuinely absent.
3. **The first verification pass matched its own scratch files**, `README.md` and the
   minified `dist/assets/*.js`, and reported every dead export as having consumers.
4. **The review pass repeated trap 3 twice.** A repo-wide grep for the F8 names matched
   the review script itself and reported all 24 as contested; and substring matching
   reported `AdminApiClient` as having 54 references that were all the unrelated
   identifier `createAdminApiClient`. Both were discarded and the counts re-derived from
   import blocks over source only.
5. **`StatePanel` was flagged unused** and is in fact used by `secrets-screen.tsx` lines
   15, 332 and 443 via the barrel. The same script mislabelled `Modal`, `ConfirmDialog` and
   `NativeSelect`; all four are used.

## 6. Deliberately not done

F1 through F6 each name a concrete follow-up. All are source changes and all are outside
this read-only packet, so none was performed. F8 deliberately names none: a deliberately
complete type barrel is a defensible design choice, and deciding otherwise is a
plan-owner call rather than a finding.

## 7. Limits

Static analysis only. No browser, no runtime, no tree-shaking measurement, no live
endpoint observed. F2 is backed by reading the production sites that write the `success`
severity, not by reading a live ledger; F1 rests on type declarations, not on observed
traffic. The plan ref was read but not inherited - every claim was re-derived from the
working tree, and where an earlier measurement disagreed the document records which one
won and why.

## 8. Shared-checkout note

While the review pass was running, this receipt's mtime changed from another process.
The content read back was identical to the revision already written, so nothing was lost,
but the document was re-read before being overwritten rather than trusted. This packet
made no product edits, so there was no other writer to a leased path.

## 9. Git state

```text
?? du-rework/coordination/reports/docs-admin-web-components-staleness-2026-10-10.md
?? du-rework/coordination/reports/receipt-docs-components-staleness-2026-10-10.md

git diff --cached --name-only   -> (empty)
```

Two untracked documents, nothing staged, nothing committed, no product file modified.
All scratch files created during this packet were deleted.
