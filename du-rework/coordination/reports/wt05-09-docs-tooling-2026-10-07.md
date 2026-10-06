# WT-05 + WT-08 + WT-09 — Docs sync, Migration count tests, .gitattributes (qwen_2) — 2026-10-07

**Task:** WT-05 (LOW) + WT-08 (LOW) + WT-09 (LOW) · plan `tasks/CODE-REVIEW-FOLLOWUP-WTREE-2026-10-07.md` §2.2 (muc 2.2 khong ton tai trong file — tien hanh theo dispatch).
**Scope:** Docs, Tests, .gitattributes ONLY. Khong sua core code. **Khong commit, khong push** (code freeze).

## 1. WT-05 — Docs sync (`docs/08-connector-api.md`)

- Dong 7: `POST /admin/api/secrets` **da co route create reachable qua BFF** (khong con 405/unreachable).
- Dong 9: **admission pin writer da co tai `submission.ts:400-409`**; production callback secret resolver van can theo CB-02.
- Diffstat: `4 +--` (2 cap thay theo focus).

## 2. WT-08 — Migration count tests

Muc tieu: khong dem cung so luong migration (33), derive linh hoat tu thu muc that.

### 2.1 `migration-verify-trap-fix.test.ts`
Regex cu chua `33` va `32` -> derive tu `rows.length` (tu `loadMigrationFiles(MIGRATIONS_DIR)`):

```ts
const registered = rows.length;
const claimed = registered + 1;
new RegExp('SELECT count\\(\\*\\) reports ' + claimed + ' row\\(s\\)'),
new RegExp('only ' + registered + ' distinct sequence\\(s\\)')
```

### 2.2 `migration-0032-rollback.test.ts` — gap THUOC THUC su khong chi hardcode

- Pre-seed chuyen tu `sequence < 32` sang **`sequence !== 32`**.
- Expected ledger size chuyen tu `toBe(32)` sang `files.filter((f) => f.sequence !== 32).length + 1`.
- **Phat hien khi chay:** thu muc migrations da len **36 file (0001..0036)**. Test cu pre-seed `<32` => 0032..0036 deu pending => `first.applied` nhan 5 thay vi 1 (nhan `-Expected -0 +Received +4`). Fix `!== 32` lam test dung dac biet "chi 0032 pending" va **ben voi thu muc lon them**.

### Bang chung migration (literal)

```
cd du-rework/services/orchestrator
node node_modules/jest/bin/jest.js --runInBand tests/migration-verify-trap-fix.test.ts tests/migration-0032-rollback.test.ts
Test Suites: 2 passed, 2 total
Tests:       14 passed, 14 total
Exit Code: 0
```

## 3. WT-09 — .gitattributes chuan hoa

`du-rework/.gitattributes` (ton tai o day; khong co file o repo root): them chuan hoa toan repo.

- `* text=auto eol=lf` — text luu LF trong repo; working-tree tren Windows co materialize CRLF nhung khong gay canh bao byte-diff drift.
- Pin ro `*.ts/.tsx/.js/.cjs/.mjs/.json/.md/.sql/.yaml/.yml/.sh` = LF.
- Windows-native `*.ps1/.bat` = CRLF (cmd/PowerShell can).
- Giu nguyen 4 rule Docker cu (`Dockerfile`, `**/Dockerfile`, `*.yml`, `scripts/docker/*.cjs` = LF).
- Binary khong bao gio EOL-convert: `png/jpg/jpeg/gif/ico/pdf/woff/woff2/zip/gz` = binary.
- Diffstat: `33 ++++++` (append, khong xoa rule cu).

## 4. Kiem tra OpenAPI (literal)

```
cd du-rework
python tools/openapi/validate_openapi.py
paths=58 x-absent=9
SC-CB-CANONICAL-SCHEMAS-VALIDATED count=37 refs=resolved operationIds=unique
OPENAPI-EXAMPLES-VALIDATED
Exit Code: 0
```

## 5. Bang chong tong

| Kiem tra | Command | Exit Code |
|---|---|---|
| OpenAPI | `python tools/openapi/validate_openapi.py` | **0** (37 canonical schemas validated) |
| Migration tests | `node .../jest.js --runInBand <2 files>` | **0** (14/14 passed, 2 suites) |

```
git diff --stat (4 files):
  du-rework/.gitattributes                          | 33 ++++++
  du-rework/docs/08-connector-api.md                |  4 +--
  .../tests/migration-0032-rollback.test.ts         | 12 ++++--
  .../tests/migration-verify-trap-fix.test.ts       | 17 ++++----
  4 files changed, 55 insertions(+), 11 deletions(-)
```

## 6. Ghi chu / gioi han

- **Khong commit, khong push.**
- Docs-only va test-only; **khong dua vao core code**.
- WT-09: ghi `du-rework/.gitattributes` (file ton tai o day). Repo root khong co `.gitattributes`; khong tao moi de tranh conflict voi file hien hanh.
- Plan `§2.2` khong co noi dung WT-05/08/09 trong file plan (chi dispatcher) — tien hanh theo dispatch prompt.
