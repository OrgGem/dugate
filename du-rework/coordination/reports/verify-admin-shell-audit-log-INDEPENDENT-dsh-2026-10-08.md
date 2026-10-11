# VERIFY ĐỘC LẬP (leg 2, terminal DSH) — admin-shell security audit event qua log metadata allowlist — 2026-10-08

**Vai trò:** leg verify độc lập thứ hai. **Quy tắc:** KHÔNG sửa source, KHÔNG sửa test, KHÔNG commit/add/push, KHÔNG tick gate, không hand-edit `docs/21-openapi.json`, offline (không claim DB window). Scope: `du-rework` ONLY.
**Đối tượng:** fix `packages/observability/src/log-metadata.ts` — audit event `{kind, reason, method, pathname}` trước đây bị allowlist metadata drop; nay có nhánh `event` bounded.
**Đường dẫn receipt:** packet yêu cầu `verify-admin-shell-audit-log-INDEPENDENT-2026-10-08.md`, nhưng **leg khác đã chiếm** (receipt tồn tại, Node `v22.16.0`). Tôi **không ghi đè**; receipt của tôi ở `…-INDEPENDENT-dsh-2026-10-08.md` (hậu tố lane) và **có đối chiếu** với leg kia ở §4.
**Revision:** HEAD `df3f955e877fe87bd190461736c40861e2fe78d5` (branch `codex/fix-workflow-builder`), working tree dirty.
`packages/observability/src/log-metadata.ts`: SHA-256 `d89a43b3154537ac5d8b49e97cf21ba59f590c19f891011e40ecdbb159998e4` — **khớp** hash `d89a43b3…` nêu trong context; đây là file **duy nhất** dirty trong `packages/observability` (`git status --porcelain` = 1 dòng ` M …/src/log-metadata.ts`).
**Toolchain leg này:** Node `v22.23.3` + PowerShell (leg kia: Node `v22.16.0`).
**Raw:** `coordination/reports/raw/verify-admin-shell-audit-log-INDEPENDENT-2026-10-08/` (`cmd1-admin-shell.log`, `cmd2-observability.log`, `cmd2b-observability-NODE_ENV-test.log`, `cmd3-tsc.log`, `SHA256SUMS-dsh.txt`).

## 1. Ba lệnh packet — literal + exit code

| # | Command (cwd ghi rõ) | Exit | Literal |
|---|---|---|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-shell-session-lifecycle.test.ts` — cwd `orchestrator/services/orchestrator` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 51 passed, 51 total`** · 3.877 s — **đạt kỳ vọng** |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.config.cjs` — cwd `orchestrator/packages/observability` | **1** | `Test Suites: 1 failed, 2 passed, 3 total` · **`Tests: 1 failed, 43 passed, 44 total`** · 1.558 s — **KHÔNG đạt kỳ vọng 44/44** (xem §2a) |
| 3 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` — cwd `orchestrator/services/orchestrator` | **0** | **không output** (0 byte ngoài dòng `EXIT_CODE=0` tôi ghi thêm) — **đạt kỳ vọng** |
| 2b | *chẩn đoán (không thuộc packet):* lặp lệnh 2 với `NODE_ENV=test` | **0** | `Test Suites: 3 passed, 3 total` · **`Tests: 44 passed, 44 total`** |

## 2. Trả lời a/b/c

### (a) Test nào FAIL? → **1 test trong lệnh 2, và nó KHÔNG liên quan tới fix (artifact môi trường của terminal này)**

- Tên đầy đủ: **`structured logger › emits the required structured JSON schema with stable environment and correlation fields`**
- File:dòng: **`packages/observability/tests/observability.test.ts:240`** (`expect(lines[0]).toMatchObject({…})`)
- Expected / Received literal:
  ```
  - "environment": "test",
  + "environment": "prod",
  ```
- **Root cause (đọc source):**
  - `packages/observability/src/logger.ts:55` — `const configured = value ?? process.env.DU_ENVIRONMENT ?? process.env.APP_ENV ?? process.env.NODE_ENV;` → `:96` `this.environment = resolveEnvironment(opts.environment)`.
  - Shell của leg này có **`NODE_ENV=production`** (`DU_ENVIRONMENT`/`APP_ENV` rỗng). Jest **không ghi đè** `NODE_ENV` đã tồn tại ⇒ logger resolve `prod`, test kỳ vọng `test`.
  - Bằng chứng độc lập: lệnh **2b** (cùng suite, chỉ đổi `NODE_ENV=test`) → **exit 0, 44 passed / 44 total**.
  - Diff của fix (đọc `git diff`): chỉ thêm `IDENTIFIER_VALUE`, `EVENT_FIELDS` + `eventLogRecord` và nhánh `event`; **không chạm** logic `environment` ⇒ RED này không thể do fix.
- **Kết luận (a):** RED của lệnh 2 là **FAIL thật trong shell này**, báo nguyên văn, **không retry để lấy xanh** (2b ghi rõ là chẩn đoán, không thay thế kết quả lệnh 2). Ở môi trường chuẩn (NODE_ENV không bị kế thừa `production`) suite đạt đúng **44/44 exit 0**.

### (b) Assertion tại `tests/admin-shell-session-lifecycle.test.ts:821` có bị nới/đổi? → **KHÔNG, còn nguyên ✅**

```ts
820:     const record = JSON.parse(first) as { event: AdminSecurityEvent };
821:     expect(record.event).toEqual({
822:       kind: 'auth.login_failed',
823:       reason: 'invalid_token',
824:       method: 'POST',
825:       pathname: '/admin/login',
826:     });
827:     expect(first).not.toContain('SENTINEL-SOCKET-LEAK-6666');
```
- Vẫn **`toEqual`** (nghiêm ngặt toàn object), vẫn đúng **4 khoá** `{kind, reason, method, pathname}` — không đổi sang `toMatchObject`, không thêm/bớt khoá, không nới giá trị; dòng `:827` (chống leak sentinel) còn nguyên.
- Test này **PASS** trong lệnh 1 (51/51) ⇒ event thật sự đi qua được projection.

### (c) `log-metadata.ts` có `EVENT_FIELDS` không? → **CÓ ✅**

- **`packages/observability/src/log-metadata.ts:25`**:
  ```ts
  const EVENT_FIELDS = new Set(['kind', 'reason', 'method', 'pathname', 'action']);
  ```
- Dùng tại **`:30`** (`if (!EVENT_FIELDS.has(key)) continue;` — drop khoá lạ; chỉ nhận `string` khớp `IDENTIFIER_VALUE` hoặc `number` hữu hạn) và tại nhánh **`:50-55`** của `metadataLogRecord`:
  ```ts
  } else if (key === 'event' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
    out.event = eventLogRecord(child as Record<string, unknown>);
  ```
  (comment `:51-54` = W-SEC-AUDIT-TAXONOMY-1: chỉ object bounded này được qua; scalar `event` rơi xuống luật identifier).
- `IDENTIFIER_VALUE` ở `:17` (`/^[A-Za-z0-9_.:@/+\-]{1,160}$/`), tái dùng cho nhánh identifier `:61`.

## 3. Verdict

- Lệnh 1 **exit 0 / 51 passed** ✅ · lệnh 3 **exit 0 / không output** ✅ · lệnh 2 **exit 1 / 43 passed, 1 failed** ❌ — nguyên nhân là `NODE_ENV=production` kế thừa từ shell (2b: `NODE_ENV=test` → **44/44 exit 0**), **không do fix, không do assertion**.
- (b) assertion `:821` nguyên vẹn; (c) `EVENT_FIELDS` tồn tại `:25`, dùng đúng thiết kế bounded-object.
- **Không tick gate nào.** Không sửa source/test; file tôi ghi = receipt này + raw log của lượt verify.

## 4. Đối chiếu leg kia (cùng fix, terminal khác)

| Hạng mục | Leg kia (Node v22.16.0) | Leg này (Node v22.23.3) | Nhận xét |
|---|---|---|---|
| Lệnh 1 | exit 0 · 51/51 | exit 0 · 51/51 | **trùng** |
| Lệnh 2 | exit 0 · 44/44 | **exit 1 · 43/44** (`environment: test→prod`) | khác biệt **do môi trường shell** (leg này có `NODE_ENV=production`); 2b chứng minh |
| Lệnh 3 | exit 0 · 0 byte | exit 0 · 0 byte | **trùng** |
| (b) assertion `:821` | còn nguyên | còn nguyên | **trùng** |
| (c) `EVENT_FIELDS` | `:25`, dùng `:29-35`/`:51-56` | `:25`, dùng `:30`/`:50-55` | **trùng** (lệch ±1 dòng do cách đếm hunk) |
| (a) FAIL | không có | có 1 (environment) | leg này bổ sung: suite observability **nhạy cảm với `NODE_ENV` kế thừa** |

⇒ Không mâu thuẫn về bản chất fix: cả hai leg xác nhận (b)/(c) và lệnh 1/3; khác biệt duy nhất là một **environment hazard** mà leg kia không gặp.

## 5. Giới hạn

- Không chạy full offline lane, không live PG/Redis, không browser gate — không claim.
- Lệnh 2b là chẩn đoán môi trường do tôi thêm; kết quả lệnh 2 (RED) vẫn là kết quả chính thức của packet trong shell này.
- Không truy nguyên ai/bao giờ export `NODE_ENV=production` trong terminal (ngoài phạm vi; chỉ ghi giá trị quan sát được lúc chạy). Đề xuất owner cân nhắc ghim `NODE_ENV` trong `packages/observability/jest.config.cjs` (hoặc assert qua `DU_ENVIRONMENT`) để suite không phụ thuộc shell — **không tự sửa**.
