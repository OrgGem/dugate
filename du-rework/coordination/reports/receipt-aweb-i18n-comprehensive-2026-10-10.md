# AWEB-I18N-COMPREHENSIVE-ALIGNMENT-2026-10-10 — receipt

| Field | Value |
|---|---|
| Packet | AWEB-I18N-COMPREHENSIVE-ALIGNMENT-2026-10-10 |
| Repo scope | du-rework only |
| Plan ref | verify-aweb-i18n-stage-count-INDEPENDENT-DSH-2026-10-10.md §2 + §5 bullet 1 |
| Lease as written | operations-screen.tsx · api-docs-screen.tsx · workflows-screen.tsx · identity-screen.tsx · **features/operations/operations-monitor-dashboard.tsx** |
| Lease as applied | same, except the dashboard — its real path is **features/overview/**, not features/operations/ (see §1) |
| Date | 2026-10-10 |
| Status | IMPLEMENTED · VERIFIED-OFFLINE · **NOT ACCEPTED** (0 gate ticked) |
| Bounds honoured | no git add / no commit / no push · **zero double quotes in this file** |

---

## 1. Two things the coordinator needs before reading anything else

### 1a. The lease path for the dashboard does not exist

The packet lists `features/operations/operations-monitor-dashboard.tsx`. I probed it
before touching anything:

```text
if exist src\features\operations\operations-monitor-dashboard.tsx  -> LEASE-PATH-MISSING
if exist src\features\overview\operations-monitor-dashboard.tsx   -> REAL-PATH-EXISTS
```

I worked on **`features/overview/operations-monitor-dashboard.tsx`** — the file that
actually holds the Vietnamese line, and the same file I edited in the previous
i18n packet. This is the stale dispatch-spec path trap: a lease that names a
non-existent file should never be silently substituted, so I am recording the
substitution explicitly rather than burying it.

### 1b. My own previous packet's zero-lines claim was wrong, and I found it myself

The previous receipt (`receipt-aweb-i18n-language-alignment-2026-10-10.md`) claimed
*Vietnamese lines 135 → 0* over its 2 files. **The dashboard line was still there.**

Cause, fully diagnosed: my detector was `[U+0100-U+024F U+1EA0-U+1EF9 U+0300-U+036F]`,
which **omits Latin-1 Supplement (`U+00C0-U+00FF`)** — exactly where the toned vowels
à á â ã è é ê ì í ò ó ô õ ù ú û ý live. The surviving line carried lowercase
`thành công` (à is `U+00E0`), so the scan never saw it. Compounding it, my replacement
map used the capitalised form only, which would not have matched anyway.

So this is **not** merely a scope ambiguity between *2 files* and *all of src*. There is
a real missed line of my own making. The independent verifier's 19-line count is the
one that was right, and my 0 was an artefact of a bad regex.

The corrected detector is a **superset** of both my earlier range and the verifier's
43-character set, which is why it finds 21 rather than 19:

| File | verifier §2 | mine | Δ |
|---|---:|---:|---|
| operations-screen.tsx | 9 | **10** | +1 |
| api-docs-screen.tsx | 6 | 6 | — |
| workflows-screen.tsx | 2 | **3** | +1 |
| identity-screen.tsx | 1 | 1 | — |
| operations-monitor-dashboard.tsx | 1 | 1 | — |
| **total** | **19** | **21** | +2 |

The two extra are `Lượt {task.attempt}` and one other line whose detection relied on a
Latin-1 vowel — i.e. the same blind spot, caught this time. The objective asked for
*truly 0*, so I fixed all 21 rather than stopping at 19.

---

## 2. What changed

**22 content-anchored replacements across 5 files. Vietnamese lines 21 → 0.**

### api-docs-screen.tsx (7 replacements over 6 lines)

`Chọn một API operation từ danh sách bên trái để xem tài liệu chi tiết.` → *Select an
API operation from the list on the left to view its detailed documentation.*
· `Mô tả / Description` → *Description*
· `Không có mô tả chi tiết.` → *No detailed description is available.*
· `Tiêu chuẩn RFC 7807` → *RFC 7807 standard*; `Phản hồi mang cấu trúc mã lỗi gồm` →
*The response carries an error structure of*
· `204 No Content (Phản hồi không mang nội dung thân body).` → *204 No Content (the
response carries no body content).*
· `Trạng thái phản hồi không yêu cầu nội dung payload body bổ sung.` → *This response
status requires no additional payload body.*

### operations-screen.tsx (10)

`Không có yêu cầu nào đang chạy (non-terminal) trong danh sách được chọn để hủy.` →
*None of the selected requests are running (non-terminal), so there is nothing to
cancel.* · `Đã chọn: ` → *Selected:* · `Bỏ chọn` → *Clear selection* · `Lượt ` →
*Attempt* · `1. Tiếp nhận` → *1. Received* · `2. Thực thi` → *2. Executing* ·
`Chờ phân phối` → *Awaiting dispatch* · `3. Hoàn tất` → *3. Completed* ·
`Đang xử lý` → *Processing* · `Chưa có thông tin tiến trình` → *No progress
information is available yet*

### workflows-screen.tsx (3)

success AlertBanner title (double-quoted JSX attribute) → *Success* ·
`Danh Sách Workflows (` → *Workflow List (* · `Sao chép JSON` → *Copy JSON*

### identity-screen.tsx (1)

`chưa managed` → *not managed yet*

### operations-monitor-dashboard.tsx (1)

`✓ … thành công` → *✓ … succeeded* — now parallel with the neighbouring `✗ … errors`,
which was already English. This single line is the defect the previous packet missed.

---

## 3. Verification (literal output)

Typecheck:

```text
npx tsc --noEmit -p tsconfig.json
-> exit 0, no output, no diagnostics
```

Tests (admin-web has **no** `test` script in package.json; the suite runs via
`node --test`):

```text
node --test tests\*.test.mjs
  tests  72
  suites 15
  pass   72
  fail   0
-> exit 0
```

(The independent verifier measured 62/13/62/0. The count is now 72/15/72/0 — **another
lane added tests in between**. The 72 run includes every test the verifier saw.)

Bundle, as evidence the JSX still compiles:

```text
npx vite build
-> 2698 modules, dist/assets/index-mWPChVFG.js 1,054.06 kB, built in 8.89s, exit 0
```

The residual-language scan, on the whole `src` tree:

```text
TOTAL_VIETNAMESE_LINES=0 across 78 src files
inLease=0 outOfLease=0
```

`outOfLease=0` matters: nothing Vietnamese was left anywhere outside my lease either, so
the objective *truly 0 across admin-web src* is met, not merely met inside 5 files.

Line counts moved only from concurrent lanes, never from my edits: every swap was
within a line. Current: operations 912 · api-docs 750 · workflows 1216 · identity 434 ·
dashboard 762.

---

## 4. Method, including two mistakes of mine that the guard caught

Each replacement was **content-anchored with an exact-once assertion per file** — never
a line-number edit, never a whole-file rewrite. Any miss or ambiguity aborts the write,
so a concurrent lane edit cannot be half-applied.

That guard fired on my own work. On the first attempt **2 of 22 pairs were rejected**,
and **both were my context-reading errors, not file problems**:

```text
MISS count=0 :: workflows-screen.tsx :: 'Thành công'
MISS count=0 :: operations-monitor-dashboard.tsx ::  metricCount(telemetry.succeeded)} thành công
```

- I searched for the success banner title wrapped in **single** quotes; the file uses a
  **double**-quoted JSX attribute.
- I searched for `metricCount(...)` preceded by a **space**; the line has a **brace**.

I did not loosen the assertions — I re-read the actual lines and corrected the two
patterns, then applied them (2/2, failures 0). For the record: the first batch still
wrote the 20 pairs that matched in the same file set, which is why this arrived as two
sequential passes rather than one.

I also rejected a proof rather than report it. I had hoped to show *string content
only* changed by reverse-applying the mapping and checking the sha256 returned to the
pre-edit baseline. **That reverse is not injective** and therefore cannot prove it:
the English tokens I introduced collide with pre-existing identifiers, most sharply
`RefreshCw` — a real component imported and rendered in both the dashboard and the
workflows screen — so a naive `Refresh` → `Làm mới` reverse would rewrite that
identifier. Words such as `Status`, `Created`, `Failed`, `Running` collide the same way.
I am reporting this as a rejected method, not as evidence. (The reverse script computed
hashes in memory and never wrote to disk, so nothing was corrupted.)

What I rely on instead: typecheck exit 0 with `noUnusedLocals` +
`noUnusedParameters` on; vite build exit 0; 72/72 tests; and the 0/78/0 Vietnamese scan
using a detector that is a superset of the two previously-used detectors.

---

## 5. Residual risk I did not close

The one-line dashboard defect existed because my previous scan had a blind spot, and
that blind spot also means the **previous packet's translation of 140 pairs has never
been re-read by anyone with a correct detector for a second class of error**: a
Vietnamese phrase that happened to contain **no** Latin-1 vowel would not have been
missed, but an English string that was **only partially** translated would not be
caught by a character scan at all. The verifier already flagged this in §2 of its own
report — it counted characters and did not judge translation quality.

I did not review the earlier 140 pairs for meaning, register, or context. I only
closed the character-level residue. If the coordinator wants quality assurance on
those, that is a separate packet and a native-speaker read.

---

## 6. Git state

```text
git status --porcelain -- orchestrator/apps/admin-web/src   (relevant lines)
 M .../features/api-docs/api-docs-screen.tsx
 M .../features/identity/identity-screen.tsx
 M .../features/operations/operations-screen.tsx
 M .../features/overview/operations-monitor-dashboard.tsx
 M .../features/workflows/workflows-screen.tsx

git diff --cached --name-only   -> (empty)
```

Those five are my lease. The tree also carries many other ` M` / `??` / ` D` paths
(`state.ts`, `profiles/*`, `lib/api/*`, `router.tsx`, `app-shell.tsx`, `features/audit/`,
`features/trace/`, the deleted `api-keys` route) — **those belong to other lanes and I
touched none of them.** No staging, no commit, no push. All scratch files created by
this task were deleted; `du-rework/.tmp-coverage-gaps` predates this work and was left
alone.

---

## 7. Not verified

- **No browser, no runtime.** The claim that these screens now read English is derived
  from source strings, not from a rendered page.
- **No e2e** against `tests/browser/**` — needs a harness boot and was not in the packet.
- **No quality review of the earlier 140 pairs** (§5). This packet is residue cleanup.
- **No glossary exists in the repo.** Vocabulary was matched against the existing
  English screens by eye. That absence is plausibly the root cause of the drift.
