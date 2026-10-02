# RED-EVIDENCE — đào sâu 2 test đỏ FUNCTEST-B (read-only, KHÔNG sửa)

## Mục tiêu

Biến 2 test đỏ từ FUNCTEST-B thành evidence đủ sâu để lane sở hữu fix ngay,
không cần hỏi lại. Read-only tuyệt đối: chạy test + đọc code, KHÔNG sửa bất kỳ file nào.

## Hai mục tiêu đỏ (từ `codex-functest-b-orchestrator-offline-2026-10-02.md`)

1. `tests/adm-base-03-safe-error-offline.functional.test.ts:210`
   — `Expected substring: "deferred section render error"`, `Received: ""`. Suite 18/1, exit 1.
2. `tests/admin-shell-session-lifecycle.test.ts:790`
   — `Expected length: 1`, `Received: []`. Suite 50/1, exit 1.

## Được phép làm

- Chạy isolated rerun từng suite (`npx jest --runInBand <file>` từ
  `services/orchestrator`), capture **FULL jest output** (không chỉ assertion line):
  tên test fail, stack trace, console output xung quanh, seed/config liên quan.
- Đọc code read-only để trace: assertion fail đang exercise production path nào
  (file:line của route/renderer/handler liên quan), input/fixture nào dẫn tới đó.
- So sánh với suite xanh lân cận (cùng thư mục prefix `adm-base-03` / `admin-shell-*`)
  để xác định đây là assertion drift, fixture drift, hay behavior đổi thật.
- Ghi giả thuyết root-cause theo mức: (a) chắc chắn từ evidence, (b) có thể, cần owner xác nhận.

## Cấm

- KHÔNG sửa bất kỳ file source/test nào (kể cả test đỏ — chỉ ghi nhận).
- KHÔNG chạy suite live/infra (giữ đúng 30-file deny-list của FUNCTEST-B +
  `rv0104-live-encryption.test.ts`); lane này chỉ rerun 2 file trên, zero infra.
- KHÔNG chạy test `businesses/document-core/**` (D3 lease đang active).
- KHÔNG `npm install`, không đụng lockfile, `server.ts`, `contracts/src`,
  `tasks/*.md`, `AGENTS.md`, execution overlay.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG copy/tái hiện lỗi bảo mật legacy khi đọc code
  (x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext fallback,
  fake CANCELLED) — chỉ ghi nhận factual.

## Acceptance

Receipt → `coordination/reports/` prefix `codex-`
(`codex-red-evidence-functest-b-2026-10-02.md`):

1. Mỗi test đỏ: full failure literal (test name, assertion, received, stack rút gọn),
   lệnh literal + exit code của isolated rerun (xanh hay vẫn đỏ).
2. Trace read-only: file:line production path + fixture/input dẫn tới fail.
3. Verdict mỗi case: assertion-drift / fixture-drift / behavior-change-thật + độ tin cậy.
4. Đề xuất fix 1–3 dòng cho lane sở hữu (mô tả, KHÔNG tự sửa).

## COMMON

Task evidence read-only (không sửa file) → không cần COMP-00, không va chạm
lease (COMP-02..09 implementation vẫn bị cấm tuyệt đối khi chưa có COMP-00;
D3 lease worker.ts/manifest/recipes không đụng; rework encryption module không
đụng; `server.ts` single-integrator — lane này KHÔNG sửa server.ts).
Exclusive lease không áp dụng (không giữ file). Không tái hiện lỗi bảo mật
legacy (x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext
fallback, fake CANCELLED). Không tick gate. Không commit thay đổi lane khác.
Không nhắm nocobase-10. Không sửa AGENTS.md, tasks/README.md, execution
overlay. Test chuyên ngành là evidence không phải blocker. DEV TEST ISOLATION
(lane này zero infra nên không cần).
