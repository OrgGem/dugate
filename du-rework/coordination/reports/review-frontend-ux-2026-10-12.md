# Frontend source review checkpoints

Reviewer: frontend_ux_review, gpt-6.1-sol high, read-only; no tests executed. Owner evidence alone is not visual/runtime approval.

## Shared/navigation packet

All initial frozen hashes matched receipts. Navigation preserves route URLs, platform-only API Keys and incident grants, prefix-active parents, operational cursors/filter population and deep-link readers. Shared Button/FormField/table behavior is acceptable apart from a narrow sizing conflict: nonshrinking button content plus account name/profile suffix and Logout can overflow at 320px. Nav owner subsequently froze a bounded caller repair including a narrow shell fix, Trace control-row alignment, proper Secrets catalog paging, and bounded Audit/Usage/API Keys/Identity/Workflow/overview collections. Re-review of that packet remains pending.

## Initial configuration packet — changes needed

All 15 initial TSX hashes matched receipts.

- Business detail: auto-selecting when the selected workflow profile is absent from the current Profiles page changes an independent selection during paging. Select automatically only when selection is empty; preserve current selection across page changes.
- Profile catalog: a pending page A response can replace scope B after tenant/business change or Refresh because page replacement lacks current scope/request-generation guards. Guard initial/refresh/page results and errors, invalidate stale requests, preserve selected draft separately.
- Business registry: index/history advanced before request success, while Retry loaded the first cursor without resetting index/history. Commit paging state after successful fetch, or retry the actual current page consistently.
- Assigned-profile search and admin catalog filter/Refresh rows: `items-start` aligns actions to labels; add input-row alignment while allowing messages below controls.
- Connector catalog: new row/name selection bypasses the prior busy mutation lock; an A mutation can refresh over newly selected B. Disable the name button while busy and guard row/helper/keyboard selection centrally.
- Settings metadata: disposition labels “Retired”/“Ported” imply completed migration decisions; catalog metadata calls for “Retirement planned”/“Port mapping”.

Businesses/Profiles owner and Connectors/Settings owner have reopened their exact leases for these repairs. The remaining reviewed configuration behavior preserves full connector list calculations, kept/hidden/inert panels, saved tenant attempts, UNKNOWN guards, revision choices and controls. No aggregate approval until revised hashes and browser/build evidence are checked.

## Independent browser coverage

Verifier owns isolated new spec/config with browser-routed mock data and a real shell/session harness. Fresh build and actual viewport/theme screenshots are pending repair freezes. Required regressions include long account name at 320px, error/action alignment, real paging, delayed response versus filter/refresh, failed-page retry consistency, workflow selection across profile pages, pending connector action versus selection, and kept drafts. Connector UNKNOWN reconciliation remains source-only unless a mock scenario is added; no production service/deployment proof is claimed.

## Repaired source checkpoints

The independent reviewer approved the bounded caller repairs, including the narrow account row, Trace action offsets, and existing cursor/export/grant behavior. Secrets' delayed-mutation tenant race was repaired with live scope validation before loader dispatch, scoped cursor storage, and scope/generation guards on read completion. The reviewed Secrets hash was `75D7DB859FE45128BF97DDA9C3AA22984A894EF9998AA74551ABD208E651BDD6`; a subsequent unused-import-only compiler repair is pending evidence continuity.

Connectors/Settings repairs are source-approved: selection uses a synchronous mutation lock and disabled name action, while metadata now says “Retirement planned” and “Port mapping”. Browser mutation/selection coverage is still pending.

Business registry now commits page state after successful fetch and retries the failed cursor. Cockpit preserves an independent, tenant/business-scoped workflow profile selection with a pinned option across Profiles paging. Profile catalog reads guard scope and request generation on results, errors and finalizers; assigned reads retain live tenant checks and role-specific APIs. The final semantic re-review found no new actionable regression. Final Profile approval is held for normalization of a nullable cursor type discovered by integrated package typecheck. Integrated typecheck also found the unused Secrets import; the configuration worker has a narrowly expanded repair lease for these two compiler fixes.

Final source review approved those compiler repairs. Profile hash `63F8CED7B13F26867935271A4B393E26B531ED99D7567AA53D1E9987158D647B` maps absent nullable cursors to `undefined` while retaining the existing absence guard. Secrets hash `77891849AC0F5EE2CBD4AB59CB5922A130B271C1D1B37F8F815E50EF9BAEA525` removes only the unused import, preserving the prior scope repair. Business/Cockpit hashes match the repaired freeze. All prior source findings are closed; integrated build and browser evidence remain separate.

## First actual browser run

Fresh admin-web typecheck/build passed. Playwright discovered and executed nine tests: three passed, six failed. Navigation/grants, long account/Trace validation alignment, and stale profile filter response passed. This run is diagnostic, not aggregate browser approval.

Independent source review confirmed an actionable Operations density failure: a legitimate 515-character business ID wraps without bounds in the list cell and the action row may stack. The measured row height was 169px. The configuration worker receives only `operations-screen.tsx` for a bounded summary with full accessible value and reachable horizontal actions; no shared component/API changes.

Verifier classified other initial failures: Secrets fixture nextCursor did not match its comparison and replayed page one; delayed Secrets mutation interception did not match actual fixture ID; Business failed-page state unmounts the ready pager, so exact cursor request sequence replaces a visibility assertion; Workflow content fits horizontally, so its bounds/vertical/keyboard checks remain without artificially demanding overflow. Connector detail fixture currently returns 404 and is still being diagnosed. Preserve the failed raw run separately from corrected verification.

Operations density repair is independently source-approved at hash `580927B311CB35E584844E44DB85A3CB38EE693EC72278782A802ED51F023A27`. Full business text/title/detail remains accessible; all action labels, handlers, conditions and keyboard access remain. No cursor/filter/action/permission behavior changed. An extra existing state suite exposed unchanged stale fixtures omitting required filter strings/sort/flags; reviewer confirmed both state and test files were unchanged at diagnosis. The implementation worker now has a validation-only lease to complete fixture inputs while preserving assertions and product state.

Diagnostic browser rerun confirmed delayed Secrets mutation/tenant isolation. Further corrected harness mismatches: mobile tenant selector requires opening navigation; Business error action label is “Try again”; nested connector revision requests need a path-segment matcher rather than a glob limited to the catalog URL; sticky table geometry should measure a sticky header cell rather than the moving `thead`. The final fresh-build run must supersede these diagnostic results before browser approval.

## Visual and final scope checkpoint

Independent visual review of desktop/tablet/mobile Operations images found no material responsive blocker: compact rows, accessible stacking, and no whole-page horizontal overflow. It found a minor 768px readability issue where inherited word-breaking split Finished/Total elapsed headings and abbreviated IDs. A narrow nowrap repair is source-approved at hash `FF3C537C09FDD931B498ED142DE57EDAA1173FB593F9E0DCCB9F352CDF50F58B`; final rebuild/visual recheck remains pending. Mobile primary filters place results below the first viewport, which review accepted as normal stacking with advanced filters already collapsed.

Primary inspected representative 1440-light, 768-light, and 320-dark viewport screenshots. Unlike the earlier full-page image, they show no sticky-header capture distortion. The actual eight-case Operations matrix has been generated; geometry and final screenshots must be retained after later detail assertions.

Latest full browser run has nine of ten scenarios passing. Settings now proves the edited draft value survives tab return; Business proves failed-cursor retry and independent workflow profile persistence; Connectors proves pending mutation lock and later normal selection. The remaining Operations detail step still receives a harness 404 and is being diagnosed from exact request URLs. This is not a final ten-test pass.

Read-only Git scope audit reports 37 tracked changed files, all under admin-web, and clean `git diff --check HEAD`. New frontend tests, browser verification, coordination documents and raw evidence are untracked; the pre-existing 2026-10-11 receipt remains distinct. No backend/auth/schema/worker edits or commit/push occurred in this frontend task.

## Final acceptance evidence

Primary inspected final source build/typecheck logs (`raw/frontend-browser-20261012-final-12`), actual passing Operations log (`final-13`, one test passed), and final 768-light/320-dark viewport images. The header and abbreviated ID now remain readable on one line, and no whole-page horizontal overflow or overlap appears in these representative images. The targeted Operations run includes all eight viewport/theme captures and preserves the 49px long-business-ID row, bounded region, cursor navigation, detail UNKNOWN alert and disabled retry. Final source hash is `FF3C537C09FDD931B498ED142DE57EDAA1173FB593F9E0DCCB9F352CDF50F58B`.

Nine other browser scenarios passed in `final-05`, including Settings edited draft retention. That batch had one failed Operations fixture step; the final targeted passing run closes it. Do not present the prior batch as ten of ten. The fixture now matches collection/detail routes and uses a 123-character operation ID within the BFF path contract. Failed diagnostic and setup logs remain preserved. Browser data bypasses the normal BFF data path; connector UNKNOWN reconciliation remains source-only. Existing browser-package lint errors and Vite externalization/bundle warnings remain documented limits, not task test passes or live deployment proof.

Operations state fixtures are independently approved with all assertions preserved, and primary inspected the raw 24-of-24 passing log. Together with the focused 20-test suite, these establish scoped test evidence; no full-project suite pass is claimed.
