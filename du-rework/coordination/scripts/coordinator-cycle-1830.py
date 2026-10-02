# Coordinator cycle 2026-10-01 18:30: settle E2/E4/P9-01, RV01-01 DB-window claim, dispatch D1+D2
import json, sys, subprocess, datetime
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T18:30:00+07:00"
W = r"D:/Git/dugate/du-rework/coordination/agent-watch-state.json"

FOOTER = (
    "\n\nRANH BUỘC CHUNG: lease exclusive đúng file nêu trên, không sửa source của lane khác. "
    "TUYỆT ĐỐI KHÔNG tái hiện lỗi bảo mật legacy: không nhận x-api-key-id/apiKeyId từ client để chọn tenant/key, "
    "không ADMIN fallback, không list-no-resolve (resolveApiKey bằng hash của x-api-key), không plaintext fallback "
    "khi encryption bật (fail-closed), không fake terminal state CANCELLED. Không tick gate nào. "
    "Không commit thay đổi của lane khác. Không nhắn nocobase-10. Không sửa du-rework/AGENTS.md, "
    "tasks/README.md, execution overlay. Test chiêm riêng là evidence, không phải blocker. "
    "DEV TEST ISOLATION: DB/Redis/S3 namespace riêng của lane nếu cần infra."
)

D1_SPEC = (
    "PACKET D1 (18:30 cycle) — P9-01 follow-up F1/F2/F3/F6: đăng ký disbursement workflow vào document-core.\n"
    "MỤC TIÊU: receipt codex-p9-01-disbursement-2026-10-01.md §6 liệt kê 8 follow-up ngoài lease của P9-01; "
    "F1/F2/F3/F6 nằm trong lease của lane bạn (manifest/recipes/validation/index) và E1 đã đóng lane — giao ngay.\n"
    "1. F1: đăng ký workflow disbursement trong src/manifest/document-core.manifest.ts (action/handler kind, connector slots), "
    "tương thích typed continuation primitives ở src/pipelines/workflows/disbursement/ (spawn-children | wait-for-input | terminate) — ĐỌC file pipeline đó, không sửa nó.\n"
    "2. F2: thêm recipe selectors + step id ổn định trong src/recipes/recipe-definitions.ts và src/recipes/step-keys.ts khớp stage "
    "classify → extract → approval → crosscheck → report của disbursement.\n"
    "3. F3: thêm entry discriminator extract `type` / analyze `task` mà workflow expects trong src/validation/input-normalizer.ts.\n"
    "4. F6: export tối thiểu từ src/index.ts (chỉ bổ sung export, không tái cấu trúc).\n"
    "FILE LEASE: businesses/document-core/src/manifest/document-core.manifest.ts, src/recipes/recipe-definitions.ts, "
    "src/recipes/step-keys.ts, src/validation/input-normalizer.ts, src/index.ts + test mới/riêng trong document-core/tests (count-neutral).\n"
    "CẤM ĐỤNG (user decision đang treo): corpus-regression corpus entries và all-variants-e2e fixture cho DOC-02-06/DOC-03-06/DOC-03-07 "
    "(F8) — KHÔNG tự làm; F4 host wiring (main.ts/server.ts) và F5 real connector ports ngoài packet này.\n"
    "ACCEPTANCE:\n"
    "a) Workflow disbursement hiện diện trong manifest với đúng kind/slots; recipe selectors + step ids + discriminators khớp stage names; export từ index.ts.\n"
    "b) npx tsc --noEmit (tsconfig.json + tsconfig.test.json của document-core) exit 0.\n"
    "c) npx jest --runInBand: KHÔNG có failure mới so với baseline verbatim đã biết — baseline hiện là "
    "'Test Suites: 3 failed, 49 passed, 52 total; Tests: 4 failed, 810 passed, 814 total' với 3 suite đỏ "
    "corpus-regression.test.ts:248 / all-variants-e2e.test.ts:377 / bullmq-smoke.test.ts:298 (đã attributed: thiếu fixture F8 + Redis 6380 timeout). "
    "Nếu count assertion trong manifest.test.ts/traceability.test.ts vỡ vì registration, REPORT số liệu thật — KHÔNG làm suy yếu assertion, KHÔNG đổi 31.\n"
    "d) Receipt ghi rõ: lệnh chạy + kết quả literal 'Tests: N passed, N total' + tsc exit code, append vào "
    "coordination/reports/codex-p9-01-disbursement-2026-10-01.md (mục mới) hoặc file receipt mới.\n"
    "DEPENDENCY: không phụ thuộc COMP-00 (đây là nội bộ business registration, không mount wire legacy)."
    + FOOTER
)

D2_SPEC = (
    "PACKET D2 (18:30 cycle) — COMP-03b fix có evidence: header identity deny-list chưa đủ + query không strict + thiếu test orphan `type`.\n"
    "NGUỒN: receipt codex-verify-compat-decoders-2026-10-01.md (verify độc lập, khác lane với tác giả module) — 1 Medium + 2 Low. "
    "Coordinator đã đọc code xác nhận: FORBIDDEN_IDITY_HEADERS (legacy-input-decoders.ts:157-163) chỉ có 4 key "
    "x-api-key-id/x_api_key_id/x-tenant-id/x-user-id; assertNoIdentityHeaders (:340-350) lowercase rồi so, nhưng "
    "'authorization' và các spelling body-style dùng làm header (apiKeyId, api_key_id, xApiKeyId, tenantId, userId, role) bị bỏ qua thay vì reject.\n"
    "MỤC TIÊU:\n"
    "1. (Medium) Mở rộng FORBIDDEN_IDENTITY_HEADERS: thêm 'authorization' + các spelling body-style identity "
    "(apiKeyId, api_key_id, xApiKeyId, tenantId, userId, role) — giữ reject case-insensitive, cùng lỗi IDENTITY_FIELD_FORBIDDEN, "
    "thông báo nêu rõ identity resolve từ x-api-key.\n"
    "2. (Low) Query strict: hiện collectFields bỏ qua query (:498-508) và chỉ đọc query.sync (:318-320) — unknown query key bị drop im lặng. "
    "Chuyển sang fail-closed: cho phép đúng allow-list {'sync'} (đọc lại registry/legacy code để xác nhận không có query param hợp lệ nào khác "
    "trước khi chặn; nếu tìm thấy evidence query param legacy thật sự, REPORT thành adjudication cho COMP-00 thay vì tự nới lỏng).\n"
    "3. (Low) Test orphan thiếu `type`: thêm case `type` là extra field trên action KHÔNG phải extract (behavior hiện đã reject qua allow-list — chỉ thiếu test), "
    "và giữ nguyên 6 tên orphan đang test.\n"
    "FILE LEASE: services/orchestrator/src/compat/legacy-input-decoders.ts, services/orchestrator/tests/compat-decoders.test.ts. "
    "KHÔNG đụng legacy-operation-serializers.ts (PASS toàn phần), contracts, server.ts, main.ts.\n"
    "ACCEPTANCE:\n"
    "a) npx jest --runInBand tests/compat-decoders.test.ts: literal 'Tests: N passed, N total' với N >= 43 + test mới, exit 0.\n"
    "b) npx tsc --noEmit -p services/orchestrator/tsconfig.json exit 0.\n"
    "c) Hard-check giữ nguyên (tự chứng minh bằng test): không ADMIN fallback/bearer fallback mới; x-api-key-id vẫn bị reject; "
    "CANCELLED/TIMED_OUT vẫn map từ canonical state thật, không fabricated; unknown body field vẫn reject.\n"
    "d) Receipt: append vào coordination/reports/ (file mới hoặc mục fix), ghi lệnh + kết quả literal + diff tóm tắt.\n"
    "DEPENDENCY: COMP-03b là module half — plan API-COMPAT-DUGATE-2026-09-28 cho phép chạy trước COMP-00 với interface tạm khóa; "
    "KHÔNG mount route, KHÔNG tick COMP-03/COMP-00."
    + FOOTER
)

RV0101_MSG = (
    "Coordinator claim DB window (18:30): namespace du_test_rv0101_* được claim chính thức cho acceptance 4-7 của RV01-01 — "
    "dùng riêng, không đụng PG default :5433 hay prefix lane khác; destructive chỉ trong schema/namespace riêng của bạn; "
    "Redis/S3 nếu cần thì prefix/DB riêng. Chạy acceptance 4-7 (image thật + S3 + Vault PUT ciphertext, byte-scan, decrypt ngoài repo, "
    "negative boot matrix) và ghi verbatim kết quả vào qwen-platform.md. Item #8 main.ts wiring để lại cho RV01-02 — "
    "sẽ giao cùng lane này sau khi acceptance xong. Không tick gate, không commit, không nhắn nocobase-10."
)

def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")

def send(handle, text):
    rc, out = run(["orca", "terminal", "send", "--terminal", handle, "--text", text, "--enter"])
    ok = "input_accepted" in out or rc == 0
    print(f"SEND {handle[:16]} rc={rc} ok={ok} {out.strip()[:160]}")
    return ok

def task(title, display, spec):
    rc, out = run(["orca", "orchestration", "task-create", "--run", RUN,
                   "--task-title", title, "--display-name", display, "--spec", spec])
    print(f"TASK {display} rc={rc} {out.strip()[:200]}")
    return rc == 0

# --- C2: settle E2, E4, P9-01 ---
w = json.load(open(W, encoding="utf-8"))
d = w["dispatches"]

def settle(key, receipt, summary, ts=NOW):
    r = d[key]
    r["status"] = "settled"
    r["receipt"] = receipt
    r["summary"] = summary
    r["settledAt"] = ts
    r["lastObservedAt"] = ts
    r["consecutiveUnfinishedChecks"] = 0
    r.pop("blocker", None)
    print("SETTLED", key)

settle("ctx_task_local01_cli_lifecycle",
    "codex-local01-admin-local-users-2026-10-01.md#local-01-cli-and-migration-rollback-follow-up-2026-10-01",
    "E2 done 17:49. CLI disable-admin/reset-password/rotate-credentials (password từ stdin, không bao giờ trong argv; "
    "output generic identical; audit-in-tx) + private-schema double-apply rollback smoke; Tests: 21 passed, 21 total exit 0; "
    "tsc -p services/orchestrator/tsconfig.json exit 0 sau khi LOCAL-02 settle. LOCAL-00 questions giữ nguyên (blocker user).")

settle("ctx_task_verify_compat_decoders",
    "codex-verify-compat-decoders-2026-10-01.md",
    "E4 done 17:56 — verify ĐỘC LẬP (khác lane với tác giả module). PASS: no ADMIN/bearer fallback; terminal state honest "
    "(CANCELLED/TIMED_OUT map từ canonical state, done = state membership, không suy diễn); purity; mutation 43→3 failed "
    "khi no-op unknown-field guard, SHA-256 restore byte-identical. FAIL Medium: header deny-list thiếu 'authorization' + "
    "body-style spellings; FAIL Low: query keys im lặng drop; FAIL Low: orphan 'type' thiếu test. Fact COMP-00: 4-slot cursor ≠ bare op-ID. "
    "Fix packet D2 dispatched 18:30.")

settle("ctx_task_p9_01_disbursement",
    "codex-p9-01-disbursement-2026-10-01.md",
    "P9-01 done — typed continuation (spawn-children|wait-for-input|terminate), 5 files 1019 lines + 660-line test; "
    "Tests: 45 passed, 45 total; tsc 0×2; full suite 810 passed/4 failed attributed pre-existing (byte-identical khi gỡ module); "
    "bullmq-smoke = Redis 6380 timeout 600s. 2 defects tự bắt (joinToken không enforce, failedChildren local). "
    "8 follow-ups F1-F8 ngoài lease; F1/F2/F3/F6 → D1 dispatched 18:30; F4/F5 blocked/wire; F8 = user decision.")

# RV01-01: keep running, blocker cleared by claim
r = d["ctx_task_rv0101_boot_encryption"]
r["lastObservedAt"] = NOW
r["lastNudgeAt"] = NOW
r["summary"] = ("Bootstrap packet receipt (qwen-platform.md §5) + ledger 56/57 verified; at prompt 18:25. "
                "Acceptance 4-7 blocked on DB window claim -> coordinator claim SENT 18:30 (du_test_rv0101_*). "
                "Keep running; settle after acceptance receipt; RV01-02 handoff to this lane then.")
r.pop("blocker", None)

w["updated"] = NOW
w["summary"] = {s: sum(1 for v in d.values() if v.get("status") == s)
                for s in ("settled", "historical", "running", "failed", "fenced")}
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("watch:", len(d), w["summary"])

# --- C2: RV01-01 claim + C3: dispatch D1, D2 ---
send("term_4568d175-fdf8-4ff6-8916-9e787e232a58", RV0101_MSG)

ok1 = send("term_2b05b203-549f-4428-b908-c303a2b187ec", D1_SPEC)
task("P9-01 registration F1/F2/F3/F6 — document-core manifest/recipes/validators",
     "ctx_task_p901_registration", D1_SPEC)

ok2 = send("term_949d489b-0ce8-4242-a8c2-988362192922", D2_SPEC)
task("COMP-03b fix — header identity deny-list + query strictness + orphan type test",
     "ctx_task_fix_compat_header_denylist", D2_SPEC)

print("DISPATCH done ok1=%s ok2=%s" % (ok1, ok2))
