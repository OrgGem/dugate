# Frontend shared UI handoff

Status: source frozen for the independent integration build and review.

## Changed files

- `orchestrator/apps/admin-web/src/components/ui/button.tsx`: child content now uses a non-wrapping inline-flex row, so icons and text passed together stay aligned. Loading still disables the button and sets `aria-busy`; loading spinner and decorative icon behavior are unchanged.
- `orchestrator/apps/admin-web/src/components/ui/field.tsx`: a single non-fragment child keeps its explicit control id and the label targets that id; helper/error ids and `aria-describedby`, `aria-errormessage`, and `aria-invalid` are wired to that control. Fragments and multiple children (including Input+datalist) remain untouched and their first explicit child id is used for the label. Messages remain visible after the control and wrap on narrow widths.
- `orchestrator/apps/admin-web/src/components/ui/table.tsx`: added `TableContainer maxHeight?: number | string` (inline max-height and two-axis scrolling; keyboard focus while bounded, named `role=region` when an `aria-label` is supplied), `TableHeader sticky?: boolean`, `Table density="compact"`, and callback-only `TablePagination`.
- `orchestrator/apps/admin-web/src/components/ui/README.md`: documents the contracts, multi-child accessibility setup, and control-row alignment guidance.
- `orchestrator/apps/admin-web/src/components/ui/shared-ui-primitives.test.mjs`: focused SSR checks for button icon/text and loading markup, pagination availability/pending/accessibility, and FormField id/message wiring plus multi-child datalist ids.

`src/components/ui/index.ts` already re-exports all of `table.tsx`, so `TablePagination` is available from the UI barrel without a barrel edit.

## API handoff

- `TableContainer maxHeight?: number | string`; omitted means horizontal-only scrolling. Set `aria-label` on a bounded container when it should be announced as a named region. Pair with `TableHeader sticky` for a sticky header.
- `Table density?: 'default' | 'compact'`.
- `TablePagination`: required `hasPreviousPage`, `hasNextPage`; optional `onPreviousPage`, `onNextPage`, `pending`, `status`, `previousLabel`, `nextLabel`, `ariaLabel`, `className`. Defaults are “Previous page”, “Next page”, and “Table pagination”. It invokes supplied callbacks and does not slice loaded rows or infer totals.
- For mixed field/action rows, align actions to the control row and place dynamic descriptions/errors after that row. `items-start` on the complete FormField/action row aligns the action with the label; `items-end` can move it when a message appears. A responsive label-height offset may be used only while controls are side-by-side.
- Base UI tabs already support `<TabsPanel value="..." keepMounted>`; inactive kept panels receive `hidden`, `inert`, and `tabIndex=-1`. No tabs API changes were needed.

The API and alignment notes were sent directly to `frontend_navigation`, `frontend_configuration_pages`, `frontend_ux_review`, and the coordinator before page consumers were edited.

## Validation

- `node --test src/components/ui/shared-ui-primitives.test.mjs`: passed, 4 tests (raw output: `coordination/reports/frontend-shared-ui-test.log`).
- `git diff --check` on the shared UI source/doc files: passed; Git printed only the existing README line-ending normalization warning.
- First `npm run build` attempt: TypeScript stopped at a concurrent in-progress page edit, `src/features/businesses/businesses-screen.tsx:240` (`TS2657: JSX expressions must have one parent element`). Raw output is in `coordination/reports/frontend-shared-ui-build-first.log`. This was an integration blocker observed during page edits, not a completed final build result. The coordinator requested the independent verifier rerun the package build after page owners freeze.
- `npm run lint` is not defined in `apps/admin-web/package.json`.
- Browser layout verification remains with the coordinator/integration verifier.

## SHA-256

- `src/components/ui/button.tsx`: `E26A1B82D14F5EC88029AFCBBDED46F435AD5BED90DE78C03C1531A6301A7B85`
- `src/components/ui/field.tsx`: `D37C4A1A426935A9D92D3A71DC02E9D1B22D9A1D2F108515CC3F5857A427BD19`
- `src/components/ui/table.tsx`: `F44AFCFA9EFEDC38B95C9F9CA99B3CC623ACBEFED55ABEAD1B2DA39698910523`
- `src/components/ui/README.md`: `FD67E9F58E9DC63AC452DC8383E83221A994A3021686346E432ECAA5DFC9E45C`
- `src/components/ui/shared-ui-primitives.test.mjs`: `FA4900EB4EA305323B41800A967E4574AC98B373D4E811219F722D31176373E6`
- `coordination/reports/frontend-shared-ui-test.log`: `8CBF92437FFE2E3582B18398F115045A5C84191572B3A38EE76944A0E4DCD0D1`
