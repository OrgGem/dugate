# Receipt — PC-R06 / PC-R07 browser gates (lock preservation + declared parameter sources)

| Field | Value |
| :--- | :--- |
| Findings | `PC-R06` (locked request default must survive a value edit) and `PC-R07` (render only the declared parameter source) — browser-interaction gates |
| Dispatch | [`du-rework/coordination/dispatch-specs/FOLLOWUP-PC-R06-R07-BROWSER-dispatch.txt`](../dispatch-specs/FOLLOWUP-PC-R06-R07-BROWSER-dispatch.txt) |
| Plan rows | [`PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md`](../../tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md) §"PC-R06", §"PC-R07" |
| Worker | DeepSeek Worker 0 (Frontend & Admin Workbench Specialist) — `deepseek-v4.1-flash` |
| Status | **COMPLETE.** Case 7 (R06 gate) and case 8 (R07 gate) added and **executed green** in headless Chromium; the whole 9-case spec passes; browser test tsconfig typechecks with 0 errors. |
| Evidence level | **Real browser execution** against the built admin-web bundle served by the real `createAdminShellServer` harness, with the BFF stubbed per route (`page.route`). No PostgreSQL/Redis, no deployed container. |
| Date | 2026-10-21 (host clock at run time) |

**Tóm tắt (VI).** Đã thêm hai case đúng theo hai browser gate và **chạy thật** bằng Chromium headless:

- **Case 7 (PC-R06)** — fixture có request default `language: { value: 'en', isLocked: true }`, input schema **không** có `defaultLocked`. Test mở editor, sửa giá trị thành `fr`, bấm lưu, đọc body PUT thật từ browser: `requestDefaults.language === { value: 'fr', isLocked: true }` và `expectedRevision === 4`. Sau đó **reload toàn trang**, mở lại group: giá trị `fr` và trạng thái khoá vẫn hiển thị.
- **Case 8 (PC-R07)** — fixture opt-in: `review:opt` khai báo `enableReasoning: requestDefaults`, `maxParallelItems: profileSettings` (và cố ý overlap `profileSchema`); fixture capability-free: `review:legacy` không có `parameterResolution`. Test assert `enableReasoning` chỉ xuất hiện ở Request defaults (không ở Profile settings), field client-input `text` không xuất hiện ở đâu, Profile settings của function opt-in chỉ có `maxParallelItems`; function legacy giữ toàn bộ profile schema và hiển thị thông báo "requires an opt-in manifest capability (parameterResolution)" với **không** control request-default nào.

Kết quả chạy: 2 gate case **2 passed (4.3s)**; toàn bộ spec **9 passed (13.5s)**; `tsc --noEmit` của browser test project **exit 0**. Hai ảnh chụp bằng chứng được lưu tại `du-rework/coordination/evidence/pc-r06-r07-browser/`.

---

## 1. Required gates (verbatim intent)

- **PC-R06:** *"Include a UI interaction test, not only a handcrafted save-body test. Load a locked request default with no schema `defaultLocked`, edit only its value, save and reload: it remains locked."*
- **PC-R07:** *"Render only declared parameter source in editor: With the opt-in manifest capability, declared `requestDefaults` appear only in request-defaults editor; profile-only settings appear in profile settings."*

Both are now cases in [`profile-groups-v2.spec.ts`](../../tests/browser/admin-web/profile-groups-v2.spec.ts): case **7** = R06, case **8** = R07 (the former workbench case is renumbered to **9**).

---

## 2. Case 7 — locked request default survives edit + save + reload

**Fixture** (`lockedGroup()` / `LOCK_CATALOG`):

```ts
inputSchema:  { properties: { language: { type: 'string', title: 'Language' } } }   // NO defaultLocked
parameterResolution: { language: 'requestDefaults' }
requestDefaults: { language: { value: 'en', isLocked: true } }
```

The lock therefore can only come from the explicit metadata — the exact PC-R06 condition.

**Interaction (what the browser does):**

1. Logs in, opens **Profiles → Groups**, selects *Locked defaults*, expands the function editor.
2. Asserts the read-only lock indicator: `Locked: clients cannot override this value.`
3. Asserts the field value is `en`, edits **only the value** to `fr` (`fill` on `Request default for extract.invoice: Language`).
4. Clicks **Save configuration revision**.
5. Asserts the outgoing PUT body — captured from the page, not handcrafted:
   - `expectedRevision === 4`;
   - `requestDefaults.language` deep-equals `{ value: 'fr', isLocked: true }`.
6. Asserts the success banner (`Saved configuration revision 5`), reopens the (collapsed) `<details>` if the post-save catalog refresh remounted it, asserts the lock indicator still renders.
7. **Reload gate:** `page.goto('<shell>/admin/profiles')` (full document reload; the session cookie persists), re-enters Groups, re-selects the group, expands the function, asserts the input value is `fr` **and** the lock indicator is still present (the stub echoes the read-shaped group on PUT, so the reload is a genuine server round-trip).
8. Screenshot: `pc-r06-locked-default-preserved.png` (archived).

Result: `ok … 7. a locked request default keeps isLocked:true after editing its value and saving (2.2s)`.

---

## 3. Case 8 — declared-source partition and capability notice

**Fixture** (`sourceGroup()` / `SOURCE_CATALOG`), same business/version with two functions:

| Function | `parameterResolution` | `profileSchema` | `inputSchema` |
| :--- | :--- | :--- | :--- |
| `review:opt` | `{ enableReasoning: 'requestDefaults', maxParallelItems: 'profileSettings' }` | `enableReasoning` (overlap, intentional), `maxParallelItems` (required) | `text` (client input), `enableReasoning` |
| `review:legacy` | *(absent)* | `tone` | `text` |

**Assertions (all scoped to the function's `<section aria-label="…">` region):**

- `Profile settings for review:opt` contains `Max parallel items *` and **no** `Enable reasoning` control → the overlap resolves to request defaults only.
- `Request defaults for review:opt` contains `Enable reasoning` and **no** `Text` control → undeclared input properties are caller input, not request defaults.
- `Request defaults for review:legacy` shows the capability notice (`Request defaults require an opt-in manifest capability (parameterResolution)…`) and renders **zero** request-default controls.
- `Profile settings for review:legacy` still contains `Tone` → legacy behaviour keeps the whole profile schema.
- Screenshot: `pc-r07-declared-source-partition.png` (archived).

Result: `ok … 8. the editor partitions fields by parameterResolution and warns without it (1.3s)`.

---

## 4. Spec/harness corrections needed to make the file executable

The dispatch allows fixing the spec. Executing it exposed latent problems in the test harness (never previously run end-to-end). All fixes are **test-only** and are in `tests/browser/`:

| # | Symptom observed | Cause | Fix |
| :--- | :--- | :--- | :--- |
| 1 | Every case died with `Portal unavailable — cannot read properties of undefined (reading 'state')` | The app shell polls `/admin/api/health` and renders `health.queueIntegrity.state`; the catch-all stub answered `{}` | Stub `/admin/api/health` with the full `AdminHealthSnapshot` in both installers |
| 2 | Group selection showed `The profile group response did not match the API contract` | The client requests the group with `?tenantId=…`; a Playwright glob ending at the id does not match the query | Match the detail route with `new RegExp('/…/v2/<id>(?:\\?|$)')` (also fixed for the two PC-08 groups) |
| 3 | Case 1: `Enabled for extract.invoice` not found | The per-function editor is inside a collapsed `<details>`; its controls are not in the accessibility tree until opened | Click the function `<summary>` before asserting/filling |
| 4 | Case 3: `.check()` timed out although the click landed | Acknowledgement is **single-use**: the checkbox is replaced by a status line, so `check()`'s post-condition can never hold | Click the checkbox, assert the durable status text, then use the confirm button |
| 5 | Case 6: strict-mode violation on `getByText('409 PROFILE_GROUP_V2_REQUIRED')` | Both the configuration banner and the keep-mounted access pane render the code | Assert `.first()` (either banner proves the typed refusal) |
| 6 | Case 9: `rev 4 · access v7` never matched | A PowerShell round-trip had mojibake'd the middle dot in the regex (`Â·`), so the literal did not match the rendered `·` | Restore the UTF-8 characters (verified: 0 mojibake lines remain) |

No application source was changed for these cases: the fixes are in the spec's fixtures/stubs/selectors.

---

## 5. Acceptance #3 — browser test tsconfig now passes

`tsc --noEmit` in `tests/browser` was **red (18 errors) before** this packet, unrelated to the new cases. Because acceptance requires the check to pass, the following test-only changes were made (all inside `tests/browser/`, the dispatch's lease):

| File | Change | Why |
| :--- | :--- | :--- |
| `tests/browser/tsconfig.json` | `baseUrl` + `paths` mapping `@/*` → `apps/admin-web/src/*`; `declaration`/`declarationMap` disabled | Three app modules imported by the harness used the `@/` alias (unresolvable here); inherited `declaration: true` triggered `TS2742` for a pnpm-symlinked zod type in a service module |
| `tests/browser/admin-web/harness.ts` | `outFile` narrowed to `string` via `outFileArg` | Module-level narrowing does not survive into the async `main()` closure → `writeFileSync(string \| undefined)` |
| `tests/browser/admin-web/p745-ui-keys.spec.ts` | Fixture `apiKeyId` made required-but-possibly-undefined; builder calls updated to the current `(detail, …, action)` signatures; expected bodies include `action`; static guards updated to the current call sites; publish-slice guard scoped to the profiles call | The spec predated the builders' `action` parameter and failed typecheck (7 arity errors + fixture mismatch) |

`apps/admin-web` and `services/orchestrator` were **not** modified by this packet.

---

## 6. Verification (actually run)

### 6.1 Static/build checks

| # | Command | Literal result | Exit |
| :--- | :--- | :--- | :--- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` in `tests/browser` | no diagnostics | **0** |
| 2 | `node node_modules/@playwright/test/cli.js test --list --config <one-off config>` | `Total: 9 tests in 1 file` (cases 7 and 8 present by title) | **0** |

### 6.2 Browser execution

Harness booted from source (writes `{url, token, dist, stubUrl, …}` and serves the built `orchestrator/apps/admin-web/dist`):

```
pnpm dlx tsx tests/browser/admin-web/harness.ts %TEMP%\pc-r06-r07-harness.json
# → http://127.0.0.1:57611, token aweb01b-browser-token, stub :57610
```

Playwright (headless Chromium 1243, 1 worker, 90 s test timeout, `page.route` stubs inside the spec):

| Run | Result |
| :--- | :--- |
| `--grep "locked request default\|partitions fields"` (the two gates) | **`2 passed (4.3s)`**, exit 0 |
| full spec (all nine cases) | **`9 passed (13.5s)`**, exit 0 — cases: zero-key create 1.5 s, two counters 1.1 s, grant issue 1.7 s, revoke 1.4 s, rollback copy 1.4 s, CHILD_PROJECTION 1.2 s, **R06 lock 2.2 s**, **R07 partition 1.3 s**, workbench 1.2 s |

Archived evidence:

- `du-rework/coordination/evidence/pc-r06-r07-browser/pc-r06-locked-default-preserved.png` (165 187 B)
- `du-rework/coordination/evidence/pc-r06-r07-browser/pc-r07-declared-source-partition.png` (220 893 B)

---

## 7. Scope boundary and limitations

- **Real browser, stubbed platform.** The tests run the real built SPA against the real shell server, but every `/admin/api/*` response is routed by the spec. They prove UI interaction and the exact outgoing payloads; they do **not** prove backend enforcement (covered by the PC-R06/PC-R07 state suites and the BFF suites).
- **No DB/Redis, no container.** The harness uses an in-memory session store and a scripted upstream; no PostgreSQL/Redis was touched, and no deployed image is claimed.
- **Harness tooling.** Booting the harness required `pnpm dlx tsx` (fetched `tsx` over the network in this session). The temporary Playwright config and harness JSON live in `%TEMP%` and are not repository inputs.
- **p745 spec**: typecheck fixed and refreshed to the current builder API; its runtime suite was **not** executed in this session (it targets a different harness seam).
- **Test-only changes**: no application source, contract, migration or service module was modified to make these cases pass. Where the run exposed an app behaviour (single-use acknowledgement control), the test asserts the actual durable state rather than forcing a component change outside the lease.

---

*End of receipt. Two gate cases added, executed, and passing; the file's full 9-case suite passes end-to-end.*
