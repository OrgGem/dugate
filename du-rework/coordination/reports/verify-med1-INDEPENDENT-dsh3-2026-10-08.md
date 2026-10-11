# Independent test leg A — MED-1 (READ-ONLY) — 2026-10-08

**Vai trò:** independent test leg A, **chỉ MED-1** (không verify trùng target của agent khác).
**Quy tắc đã tuân thủ:** read-only, **không** sửa source, **không** sửa test, **không** commit / `git add` / push, **không** tick gate, **không** hand-edit `docs/21-openapi.json`, **không** đọc/in `.env.live`, offline (không PostgreSQL, không Redis, **không** claim DB window). Deliverable: **đúng một file** — receipt này (không tạo raw log riêng).
**cwd mọi lệnh:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · Node `v22.23.3`.
**Revision lúc chạy:** HEAD `72e225ae5465e5a648c34bf31fbabbd182763233` (branch `codex/fix-workflow-builder`), working tree dirty.
**Digest nội dung đã kiểm (SHA-256):**
| File | Digest | Trạng thái |
|---|---|---|
| `src/db/migrations.ts` | `519fd20731acac579acde4f5908844ddf98c4948661e408ad64e1c74852d5eed` | ` M` (MED-1 half-2 **chưa commit**) |
| `tests/med1-verify-migrations-object-drift.test.ts` | `aa628a88a664056b4424d1a980e1eaecc54d42f613a7aadbf224fdacc8eb0945` | `??` (untracked) |
| `tests/med1-migration-ledger-object-drift.test.ts` | `0d63375d38822876032d46a45bc9d087168855254ab48f6dc267b6d41c3b5f0c` | `??` (untracked) |
| `tests/migrations-ledger-guard.test.ts` | `107a827766a4db48cd53f0d74e33dcc69b5ee33ae945b5390aa08a0678f63ff8` | tracked, sạch |
| `tests/migration-verify-trap-fix.test.ts` | `ea96a823c5757d89953b59dc47953e6f7884be4ecc229d37132a903b0596e6d3` | tracked, sạch |

## Kết quả 4 lệnh (chạy lần lượt, mỗi lệnh 1 lần, không retry)

### Lệnh 1
```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-verify-migrations-object-drift.test.ts
```
- **exit code: 0**
- `Test Suites: 1 passed, 1 total`
- `Tests:       1 passed, 1 total`
- `PASS tests/med1-verify-migrations-object-drift.test.ts` (2.738 s)

### Lệnh 2
```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts
```
- **exit code: 0**
- `Test Suites: 1 passed, 1 total`
- `Tests:       12 passed, 12 total`
- `PASS tests/med1-migration-ledger-object-drift.test.ts` (2.806 s)

### Lệnh 3
```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/migrations-ledger-guard.test.ts tests/migration-verify-trap-fix.test.ts
```
- **exit code: 0**
- `Test Suites: 2 passed, 2 total`
- `Tests:       25 passed, 25 total`
- `PASS tests/migration-verify-trap-fix.test.ts` · `PASS tests/migrations-ledger-guard.test.ts` (2.699 s)

### Lệnh 4
```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```
- **exit code: 0**
- **không output** (0 dòng stdout/stderr)
- *Disclosure:* trong cùng một shell call tôi gọi `tsc` **hai lần** — lần 1 để lấy exit code, lần 2 chỉ để đếm số dòng output (`OUTPUT_LINES=0`); **cả hai lần đều exit 0 và 0 dòng**. Không có lần chạy nào bị bỏ hoặc che.

## RED

**Không có test nào đỏ.** Không có tên test / expected / received nào để báo; không retry để lấy xanh, không sửa test, không skip/hide bất kỳ test nào. Tổng: **4 lệnh, 38 test passed (1 + 12 + 25), 4 suite passed, 4 exit code 0.**

## Giới hạn

- MED-1 half-2 là **thay đổi chưa commit** (`src/db/migrations.ts` dirty, digest ghi ở trên) và hai suite MED-1 là file **untracked** ⇒ kết luận gắn với **working tree** tại HEAD `72e225ae…`, không phải nội dung HEAD.
- Offline: các suite dùng fake `Db`/ledger in-memory; **không** chạy PostgreSQL/Redis thật, không browser/deployment gate, không claim DB window.
- Lượt này **không** đọc code để phân tích seam (đó là phần của leg khác); chỉ chạy test + tsc theo đúng packet.
