# AWEB-I18N-LANGUAGE-ALIGNMENT-2026-10-10 — receipt

| Field | Value |
|---|---|
| Packet | AWEB-I18N-LANGUAGE-ALIGNMENT-2026-10-10 |
| Repo scope | du-rework only |
| Plan ref | survey-workflows-connectors-2026-10-10.md §2.3 + W-E |
| Lease (only these 2 files) | orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx · orchestrator/apps/admin-web/src/features/overview/operations-monitor-dashboard.tsx |
| Survey date of the plan | 2026-10-10 |
| Date of this work | 2026-10-10 |
| Status | IMPLEMENTED · VERIFIED-OFFLINE · **NOT ACCEPTED** (0 gate ticked) |
| Bounds honoured | no git add / no commit / no push · zero double quotes in this file |

---

## 0. Read this first — the lease was moving under me

Both leased files were already ` M` (uncommitted) when I started, and **the workflows
file changed twice while I worked**:

| When | workflows-screen.tsx | dashboard |
|---|---|---|
| my baseline snapshot | 1190 lines, sha `7fe55774` | 762 lines, sha `85fc8af7` |
| mid-read (another lane) | 1213 lines, sha `52e2f008` | unchanged `85fc8af7` |
| after my batch-2 write | sha `44ea4dae` | sha `44324deb` |
| at this moment | **1217 lines**, sha `7797884b` | 763 lines, sha `44324deb` |

I confirmed the file was quiescent over a 12 s window (3 samples, 1 distinct hash)
before writing, and I re-verified Vietnamese count **after** the later lane change:
still **0 lines in both files**, so my translation survived it.

I worked around the risk structurally rather than by timing: **every edit was a
content-anchored substring swap with an exact-occurrence assertion**, never a
line-number edit and never a whole-file rewrite. If a phrase had been absent or
ambiguous the script refuses to write — which it genuinely did once (see §3).

---

## 1. What changed

Both files went from mixed Vietnamese/English to **English only**, matching the other
14 admin-web screens.

| File | Vietnamese lines before | after | pairs applied |
|---|---:|---:|---|
| workflows-screen.tsx | 84 | **0** | 41 + 48 = 89 |
| operations-monitor-dashboard.tsx | 51 | **0** | 51 |
| **total** | **135** | **0** | **140** |

### Representative mappings

**Workflows** — error and notice strings:
Vietnamese `Không thể tải danh sách workflows.` → `Unable to load the workflow list.`
· `Đã kích hoạt thành công workflow mẫu ${...}` → `Provisioned the sample workflow ${...}`
· `Bạn có chắc chắn muốn hủy kích hoạt workflow ${...}` → `Retire the workflow ${...}`
· `Lỗi khi hủy kích hoạt` → `Error while retiring the workflow`
· `Dán JSON schema vào đây...` → `Paste the JSON schema here...`
· `Xác Nhận Kích Hoạt` → `Confirm Activation`

**Workflows** — the specific phrases the packet named are covered: `Đã hủy kích hoạt`
(now `Retired workflow`), `Dán JSON schema vào đây` (now `Paste the JSON schema
here...`), and the dashboard card that mixed `Đang chạy` with `Unavailable` inside
one component is now uniformly `Running` / `Unavailable`.

**Dashboard** — timeframe labels `Phút/Giờ/Ngày/Tuần/Tháng` → `Minute/Hour/Day/Week/Month`
· `Tỷ lệ Thành công` → `Success rate` (2 sites) · `Thành công` → `Succeeded` (4 sites)
· `Chưa có operation nào được thực hiện trong hệ thống.` → `No operations have been
executed in the system yet.` · `Orphans Tasks kiểm tra:` → `Orphan tasks checked:`

Four section comments (`Section 1/2`, `Modal 1/2`) were translated too, so the file
carries no Vietnamese outside string literals either.

---

## 2. Verification (literal output)

Typecheck:

```text
npx tsc --noEmit -p tsconfig.json
-> exit 0, no diagnostics
```

Tests (admin-web has **no** `test` script in package.json; the suite runs via
`node --test` over the six `tests/*.test.mjs` files):

```text
node --test tests\audit-state.test.mjs tests\operations-state.test.mjs \
  tests\profiles-row-key.test.mjs tests\profiles-state.test.mjs \
  tests\trace-state.test.mjs tests\worker-instance-state.test.mjs

  tests  54
  suites 12
  pass   54
  fail   0
-> exit 0
```

Bundle, as extra evidence that the JSX still compiles:

```text
npx vite build
-> 2698 modules transformed
   dist/assets/index-aGI71coj.js   1,054.15 kB
   built in 8.66s, exit 0
```

Baseline was captured **before** any edit: typecheck exit 0, 54/54 pass, so the green
above is not a pre-existing-passing artefact of my change — the suite was green before
and after, and my change neither broke nor relied on it.

Residual-language scan (derived from the file, not a hand-listed phrase set — a
Vietnamese-diacritic regex over `U+0100-U+024F`, `U+1EA0-U+1EF9`, `U+0300-U+036F`,
so it cannot miss a string a phrase list would):

```text
workflows-screen.tsx              => 0 Vietnamese lines
operations-monitor-dashboard.tsx  => 0 Vietnamese lines
```

Line counts moved only from the concurrent lane, never from my edits: each swap is
within a line, and the exact-once assertion guarantees no line was added or dropped.

---

## 3. Methodological note: one proof I tried and rejected

I wanted to show that **only string content** changed, and attempted to prove it by
reverse-applying the translation mapping and checking the sha256 returned to the
pre-edit baseline. **The dashboard reverse did not match, and that result is
meaningless — it does not indicate damage.** Root cause identified:

The reverse `Refresh` → `Làm mới` also hits the **pre-existing JSX identifier
`RefreshCw`** (imported at dashboard line 10 and workflows line 7, used at 6 render
sites). The naive reverse would rewrite `<RefreshCw` into something broken. The same
class of ambiguity exists for `Status`, `Created`, `Failed`, `Cancelled`, `Running` —
words that were already English in the file. So the reverse map is **not injective**,
and failing to recover the baseline proves only that the reverse was ambiguous.

Note the reverse script computed hashes in memory and **never wrote to disk**, so no
corruption occurred. I am recording the failed proof rather than quietly dropping it.

What I rely on instead, honestly weighted:

1. `tsc --noEmit` exit 0 — and the package tsconfig has `noUnusedLocals` +
   `noUnusedParameters` on, so a dangling identifier from a bad edit would fail it.
2. `vite build` exit 0, 2698 modules.
3. 54/54 tests.
4. Zero Vietnamese lines by a diacritic scan.
5. Each of the 140 replacements asserted **exactly one** occurrence before writing;
   49 of them were rejected on a first attempt and fixed, which is direct evidence
   the assertion is real rather than decorative.

Item 5 is worth dwelling on: the dashboard script refused to write twice, reporting
`MISS got=2 want=1 :: Thời gian xử lý` and `MISS got=4 want=1 :: Thành công`. I did
not loosen the assertion — I located the real occurrence counts (a containing phrase
`Bảng Tần suất & Thời gian xử lý` was being replaced after its own substring, and
`Thành công` legitimately appears 4 times) and corrected the order and the expected
counts.

---

## 4. One consequence the coordinator should adjudicate

**`PRESET_SAMPLES` is both display copy and provision payload.** The preset
`schema` object is loaded into the import textarea (workflows line ~527) and sent to
`provisionWorkflow` (lines ~326 and ~363). Inside it, `input_schema.properties.*.label`
and `nodes.*.description` are Vietnamese.

I translated them, because they render directly in the UI — the test-run form renders
`prop.label` and `prop.description` verbatim, and the flow diagram renders
`node.description`. Leaving them Vietnamese would have left the screen mixed, which is
exactly what W-E forbids.

The consequence, stated plainly: **newly provisioned workflows now carry English
`label` / `description` text in their stored schema**, where previously they carried
Vietnamese. This changes the bytes of the payload, so a digest computed over a
re-provisioned preset will differ from the Vietnamese-era digest. It does **not**
touch any already-stored workflow — existing catalog rows keep their original schema.

This is a policy call, not a code defect, and it is **outside my remit to decide**.
If the coordinator wants the preset schema payload frozen byte-for-byte, the fix is to
move the display strings out of `schema` and into the sibling `PresetSample` fields
(`name`/`description`/`badge` are display-only and already separate). Flagging, not
doing.

---

## 5. Git state

```text
git status --porcelain -- <the two leased files>
 M du-rework/orchestrator/apps/admin-web/src/features/overview/operations-monitor-dashboard.tsx
 M du-rework/orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx

git diff --cached --name-only   -> (empty)
```

Both were already ` M` before I started (concurrent lanes), so `M` here is **not** a
statement that I own the whole diff. No staging, no commit, no push. Final hashes:
workflows `7797884b04e28f3c…`, dashboard `44324deb9b534fa1…`.

Every scratch file this task created was deleted; `du-rework/.tmp-coverage-gaps`
predates this work and was left alone.

---

## 6. Not verified

- **No browser or runtime check.** I did not load either screen. The claim that the
  UI now reads English is derived from the source strings, not from a rendered page.
- **No e2e run** against `tests/browser/**` (the Playwright suites); those need a
  harness boot and were not in the packet.
- **No translator review.** The English is my own rendering; a native review of
  wording (for example `Retired workflow` vs `Deactivated workflow`, or `Succeeded`
  vs `Success`) has not happened. Vocabulary was chosen to match the existing
  English screens, not from a project glossary — **there is no glossary in the repo**,
  which is arguably why the drift appeared in the first place.
- I did not touch the 14 other screens, the backend, or any contract.
