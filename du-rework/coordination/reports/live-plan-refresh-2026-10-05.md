# LIVE-PLAN-REFRESH — thêm 5 live item mới vào live-test-plan — cc_2 — 2026-10-05

**Packet:** coordinator 01:34 (+07). **Mode:** doc-only; offline; no commit; không tick.
**Boundary:** 1 doc + receipt này. Không chạm source/tests/plan khác.

---

## 0. TL;DR

`tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md` được **append** một section mới **`## 4. Bổ sung 2026-10-05 — Live item MỚI`** với 5 item đúng packet — mỗi item đủ **Điều kiện tiên quyết + Cách chạy + Kỳ vọng**, dẫn nguồn tới receipt impl/prep tương ứng:

| ID mới | Item | Nguồn chính |
|---|---|---|
| `LIV-CW-01` | credworkflow Vault chain (writer thật + compose + E2E) | `credworkflow-impl-2026-10-05.md` §5 |
| `LIV-EM-01` | ENCMETA result_ref backfill window (ENC-09) | `encmeta-resultref-impl-2026-10-05.md` §4 |
| `LIV-CM-01` | connector management round-trip | `connector-wire-a-2026-10-05.md` §5 |
| `LIV-SS-01` | session provider-side (sessionRef non-null) | `connector-session-leg-2026-10-05.md` |
| `LIV-PC-01` | carrier observed provider request | `p745-carrier-impl-b2-2026-10-04.md` §5–§9 + PLAN §13 MISMATCH-CLEAR rider |

**Phần cũ giữ nguyên byte-for-byte** — chứng minh bằng sha256 (xem §2). **0 xoá, 0 sửa** dòng nào của §§1–3.

## 1. Nội dung mỗi item (tóm tắt)

- **LIV-CW-01**: env `DU_VAULT_KV_OPTIONS`/`DU_VAULT_KV_TOKEN` + connector `:8091`; chuỗi `upsert→bootstrap→credential_rotate(CAS)→activate→test→disable` + `vault-live.test.ts`; expect version tăng thật, mapping lỗi 412/403/503 + 0 request/0 audit khi Vault down, no-secret sentinel, refuse-boot khi env partial. GAP: connector-side reader (D5) vẫn "later".
- **LIV-EM-01**: PG thật + legacy plaintext rows + crypto seam; writer seal → envelope JSON text trên 2 cột; đọc lại qua R1/R2/R3; window `true` → legacy verbatim, `false` → `NOT_SEALED` fail-closed; tamper/cross-slot/cross-tenant deny. Backfill thật = window riêng.
- **LIV-CM-01**: connector `:8091` + `connectorBaseUrls` (+`connectorManagementHeaders`); list/revision thật, 5 action `connector.upsert|activate|disable|retire|test`; expect redaction, 409 CAS no-audit, 503 trước side-effect, 502 không echo, audit principal, idempotency replay.
- **LIV-SS-01**: provider/mock **có xử lý sessionRef** (hiện 0); json + multipart, capture provider request, hash parity; Δ-1/Δ-2/Δ-3 ghi policy decision trước khi tính parity.
- **LIV-PC-01**: publish A → capture provider request → publish B giữa chừng → retry/child/HITL vẫn A; vector MISMATCH-CLEAR (cleared exact không hồi sinh `_default` — disposition tại packet B); precedence đủ; no raw prompt in durable sinks; observed request là bằng chứng bắt buộc.

## 2. Evidence byte-for-byte (append-only)

```
PRE  (trước sửa): sha16 = 439804D36D44D0FE · mtime 2026-10-04 19:02:16 · 334 dòng
POST (sau sửa) : sha16 = 0A093B6A2E68D338 · 420 dòng (+86)

PROOF: sha256 của "334 dòng đầu + newline" của file POST
       = 439804d36d44d0fe  ==  PRE-hash  → phần cũ byte-identical 100%, chỉ có thêm.
```
(Đọc link mới: 5 đường dẫn `../coordination/reports/<receipt>.md` đều tồn tại trên đĩa; ID `LIV-CW-01/EM-01/CM-01/SS-01/PC-01` không trùng bất kỳ ID nào khác trong doc.)

## 3. "Giữ 8 câu hỏi cũ" — discrepancy phải nói thẳng

Yêu cầu packet: *"Giữ 8 câu hỏi cũ"*. **Tôi không tìm thấy danh sách 8 câu hỏi nào trong repo** để tham chiếu:
- `grep -i 'câu hỏi'` trên `coordination/**/*.md` → **0 hit** (gồm cả reviews/dispatch-specs).
- Doc live-plan (§§1–3 đã đọc toàn bộ 334 dòng) không có mục câu hỏi nào; `PLAN-COMPLETION` §4 có **4 dòng gate**, §3 SUPERSET có bảng 5 nhóm câu hỏi admin, §6 journeys = 7 — không nơi nào là "8".
- Hệ quả: **không có gì bị xoá/sửa** (byte-proof §2) nên *mọi* nội dung cũ — kể cả nếu "8 câu hỏi" nằm trong doc này dưới dạng khác — đều được giữ nguyên tuyệt đối. Nếu danh sách 8 câu hỏi nằm ở file khác (ngoài repo hoặc file tôi chưa biết), đề nghị coordinator chỉ đích danh path để tôi không đoán.

## 4. Limitations / boundary

- Doc-only: không chạy test/suite; không tick bất kỳ checkbox nào; không commit/push.
- Các "expected" trong §4 tái hiện đúng behavior pins từ receipt nguồn (offline) — **chưa phải live evidence**; chạy live vẫn cần window + namespace cô lập + role matrix như doc cũ quy định.
