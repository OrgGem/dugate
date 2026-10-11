# Verify độc lập (DSH) — MDB-POLICY-01 connector policy — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc) cho packet MDB-POLICY-01.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa code (không revert, không mutation tạm); **KHÔNG** tick gate; artifact ghi thêm: receipt này + raw log.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator`.
**Node:** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-mdb-policy-01-2026-10-10/DSH/` (`policy-run1..3.log`, `mdb01-delta.log`, `tsc.log`, `SHA256SUMS.txt`).

## 0. Đối tượng kiểm (digest khớp receipt gốc §7)

| File | Dòng | sha256 |
|---|---:|---|
| `scripts/ldba-context-provider.cjs` | 267 | `25bd4e059963e1f080cfb98db4dc381c1672cff3a82942644ae47980f0136088` |
| `tests/mdb-policy-01-connector.test.cjs` | 307 | `b51bccaddfce2476a493b823b9cc44cdea12630f70f7d48495829da91104d45d` |

Cả hai digest **khớp chính xác** con số receipt khai (và số dòng provider 267 khớp).

## 1. Bằng chứng chạy (REAL_EXIT đo ngay sau mỗi lệnh)

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node --test tests/mdb-policy-01-connector.test.cjs` (lần 1) | **0** | `# tests 20` · `# pass 20` · `# fail 0` |
| 2 | y hệt, lần 2 (tiến trình riêng) | **0** | `# tests 20` · `# pass 20` · `# fail 0` |
| 3 | y hệt, lần 3 (tiến trình riêng) | **0** | `# tests 20` · `# pass 20` · `# fail 0` |
| 4 | `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/mdb-01-composition-provider.test.ts` | **1** | `Tests: 1 failed, 1 passed, 2 total` — **DELTA 1 tái lập**, xem §2 |
| 5 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output |

⇒ Suite mới của MDB-POLICY-01 **20/20 xanh, 3/3 lượt exit 0**, trùng khớp receipt §5.2. Typecheck exit 0 (§5.3).

## 2. DELTA 1 — xác nhận độc lập (đây là chặn thật, không phải suy đoán)

Chạy lại suite của MDB-01 (file **ngoài lease** của packet này) cho kết quả nguyên văn:

```
expect(received).rejects.toMatchObject()
Received promise resolved instead of rejected
Resolved to value: {code: 'INVALID_SOURCE', reason: 'connector preparation …'}   (khối trích in lại bằng nháy đơn vì receipt này không dùng ký tự nháy kép)
41 |       code: 'CONTEXT_POLICY_REQUIRED',
```

- Assertion đang đỏ nằm ở `tests/mdb-01-composition-provider.test.ts:41`: nó đòi `prepareConnector({}, {})` **reject** với `code: 'CONTEXT_POLICY_REQUIRED'`; sau policy mới, hàm **resolve** với `{ skipped: true, code: 'INVALID_SOURCE', reason: … }`.
- **Lease boundary được tôn trọng:** file này vẫn là `??` (untracked) với **mtime `10-09 17:35`** — không bị sửa trong lượt MDB-POLICY-01 (mtime test mới là `10-10 15:16`). Tức xung đột là **do thay đổi hành vi của policy**, không phải do ai sửa test của MDB-01.
- Theo receipt §4, việc trả `skipped` cho input hỏng là **đúng yêu cầu packet** (thay stub fail-closed bằng policy thật). Nhưng hệ quả là **suite offline của orchestrator hiện có 1 test đỏ** cho tới khi MDB-01 owner (hoặc coordinator cấp lease) cập nhật assertion sang contract mới.

## 3. Verdict

| Hạng mục | Kết quả |
|---|---|
| Suite MDB-POLICY-01 (20 test) | **PASS** — 3/3 lượt exit 0 |
| Digest provider + test | **KHỚP** receipt gốc |
| Typecheck orchestrator | **PASS** — exit 0 |
| Boot contract (8 callback) + 6 callback còn fail-closed | **ĐẠT** theo thiết kế test (2 regression guard xanh ở cả hai trạng thái, theo receipt §1/§5.1) |
| DELTA 1 (xung đột contract với MDB-01) | **TÁI LẬP ĐỘC LẬP** — 1 test đỏ ở `mdb-01-composition-provider.test.ts:41`, nguyên nhân đúng như receipt mô tả |
| DELTA 2 (`staticFormFields` + 15 field hiển thị không có chỗ trong strict schema) | **Ghi nhận** — quyết định sản phẩm, không phải lỗi kỹ thuật của lượt này |

⇒ **MDB-POLICY-01: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline (20/20 ×3, tsc 0)**, nhưng **có 2 delta chặn ACCEPTED** và **còn 1 test đỏ trong suite orchestrator** do DELTA 1. Không tick gate.

## 4. GAP / open items

1. **DELTA 1 cần người quyết:** cập nhật assertion của MDB-01 sang contract mới (`skipped` + `INVALID_SOURCE` cho input hỏng, vẫn fail-closed cho 6 callback khác) — cần lease trên `tests/mdb-01-composition-provider.test.ts`. Cho tới lúc đó, **suite orchestrator có 1 RED** và không nên coi là xanh toàn phần.
2. **DELTA 2 cần product owner quyết:** 16 field hiển thị của LDBA-05 (gồm `staticFormFields`) không nằm trong `ConnectorRevisionConfigSchema` (`.strict()`, 9 key) ⇒ policy chỉ emit 8 key runtime, nghĩa là các field đó **mất khi migrate**. Ba lựa chọn: bổ sung schema, bảng ghi riêng, hoặc chấp nhận mất — không phải quyết định của verifier.
3. **A1 = NOT PROVEN** (receipt §0): kết quả này **không** cho phép chạy backfill thật; runner vẫn trả `BLOCKED_TIMEZONE_UNVERIFIED`. Tôi không kiểm chứng nhánh A1 trong lượt này.
4. **Chưa re-run 3 suite LDBA-03** (receipt §5.4 khai 14 red pre-existing, A/B identical): ngoài ngân sách lượt này, tôi **không** xác nhận con số 43/29/14 — cần lượt riêng nếu muốn chốt.
5. **`.cjs` không được `tsc` phủ** (`tsconfig.json` chỉ include `src/**/*.ts`) ⇒ lỗi của provider chỉ lộ ở runtime qua test; typecheck xanh **không** chứng minh provider đúng.
6. **Chưa commit:** cả hai file là `??` untracked ⇒ kết quả gắn digest §0.

## 5. Xác nhận

- Không `git add`, không commit, không push (không có gì staged); không tick gate; không sửa source/test — kể cả không sửa file MDB-01 đang đỏ và không revert để lấy RED.
- Receipt này tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
