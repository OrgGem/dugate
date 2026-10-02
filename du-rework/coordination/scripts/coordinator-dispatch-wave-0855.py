#!/usr/bin/env python3
# Coordinator dispatch wave — 2026-10-01 08:55 +07 (Claude session, user-authorized)
import json, subprocess, collections

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
NOW = "2026-10-01T08:55:00+07:00"

DISPATCHES = [
 ("task_comp01_matrix", "term_27eb3380-f9c3-466a-8b4e-0b7fa0ad23fc",
  "DISPATCH task_comp01_matrix (tu Claude coordinator session, user uy quyen 2026-10-01). "
  "Nhiem vu: COMP-01a/01b/01c — characterization matrix READ-ONLY tu app/ + rework: "
  "(a) 6 core route + 31 sub-case: discriminator (mode/type/task/action), required/optional fields theo registry.ts, file/url policy, output + business action dich; "
  "(b) 3 workflow + schema + /services + /billing shapes; "
  "(c) lifecycle list/cancel/resume/download/DELETE + pagination + state map. "
  "Nguon co san: du-rework/docs/14-reference-compatibility.md (Legacy API spec from code). "
  "Ghi MISMATCH legacy spec-vs-code (catalog 28 vs 31, comment /api/v1/workflows vs path /api/v1/docs/workflows, guide /api/v1/extract sai path). "
  "Deliverable: ma tran + fixture nguon (file:line), receipt vao report cua ban. "
  "GIOI HAN: read-only app/ + rework source; KHONG sua source; KHONG tick gate; khong freeze contract (COMP-02 cho COMP-00). "
  "Gui status ve terminal coordinator nhu moi khi."),

 ("task_comp00_consumer_inventory", "term_4568d175-fdf8-4ff6-8916-9e787e232a58",
  "DISPATCH task_comp00_consumer_inventory (Claude coordinator session). COMP-01 headers cua ban da SETTLED (receipt qwen-platform.md) — cam on. "
  "Nhiem vu moi, READ-ONLY: inventory consumer legacy cua /api/v1/services, /api/v1/billing/balance, /api/v1/billing/usage, webhook_url. "
  "Quet app/ (UI, ServiceTestClient, chat), tests/, docs/ (DU_INTEGRATION_GUIDE...): route nao that su duoc goi, boi file:line nao. "
  "Output: bang route -> consumer file:line -> muc dung (submit/list/webhook) -> khuyen nghi parity/defer/retire kem ly do. "
  "Day la INPUT cho COMP-00 (Product/architect chot, ban khong tu chot). "
  "GIOI HAN: read-only; ghi vao report cua ban; KHONG sua source/docs/plan; KHONG tick gate. Gui status coordinator."),

 ("task_legacy_lifecycle_char", "term_63bf0dbc-d90e-406d-8089-37dfc45ed4bb",
  "ADJUDICATION tu coordinator (Claude session) cho cau hoi packet-vs-wire cua ban: "
  "CHOT theo COMP-00 quyet dinh #1 (tasks/API-COMPAT-DUGATE-2026-09-28.md dong 37): tren method/path legacy trung "
  "({POST /api/v1/docs/*}, operations list/detail/cancel/resume/download) WIRE LA LEGACY — {name, done, metadata, result|error}. "
  "{operation_id, status} KHONG duoc xuat hien tren path cu; canonical envelope chi o surface/version moi hoac opt-in. "
  "Mount point server.ts van serialize cho orchestrator owner lane — module router cua ban la helper, KHONG mount. "
  "Task COMP-03 router cua ban da SETTLED (receipt tester.md). "
  "DISPATCH moi task_legacy_lifecycle_char: READ-ONLY characterization app/api/v1/operations/[id]/{cancel,resume,download}/route.ts + operations DELETE: "
  "response/status fixture tung endpoint (cancel shape, resume {success,message}, download headers, DELETE 204?), state semantics (CANCELLED fake?, resume khong fence?) "
  "va MISMATCH vs rework. Output bang vao report cua ban; KHONG sua source; KHONG tick gate."),

 ("task_par00_classify", "term_742c2474-7ff2-427d-8db4-f4bd40d16129",
  "DISPATCH task_par00_classify (Claude coordinator session). ORCH-PAR-01 api-keys cua ban da SETTLED (receipt qwen-admin.md, dispatcher.ts +143, 29/29x3) — cam on. "
  "Nhiem vu moi: hoan tat ORCH-PAR-00 — phan loai tung Admin journey/legacy route (API key, profile, connection, workflow schema, settings, analytics, docs portal) "
  "vao {cutover-required, post-cutover, retire}, dua tren tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md hien co + doi chieu app/. "
  "Deliverable: bang phan loai co replacement API/owner/fixtures (input cho PAR-02..09). "
  "GIOI HAN: research; KHONG tick [x] PAR-00 (acceptance Product/architect); KHONG sua source; receipt vao report cua ban."),

 ("task_keyset_explain_fix", "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe",
  "DISPATCH task_keyset_explain_fix (Claude coordinator session) — task NHO vi quota cua ban con <50% 5h. "
  "Nhiem vu: sua 3 assertion trong suite admin-keyset-explain con mong ten chi muc cu (ExitCode 1, receipt tester.md:7694; plan live da chon ten moi). "
  "CHI sua file test, KHONG sua src. Chay suite green x3, ghi receipt vao tester.md. "
  "Neu do vi nguyen nhan khac → bao blocker, khong force pass. Dependency: khong co."),

 ("task_legacy_pagination_char", "term_2b05b203-549f-4428-b908-c303a2b187ec",
  "DISPATCH task_legacy_pagination_char (Claude coordinator session). Task wire-decoders cua ban da SETTLED (receipt qwen-platform.md, 10/10x3, tsc 0) — cam on. "
  "Nhiem vu moi READ-ONLY: characterization phan trang legacy operations list (app/api/v1/operations/route.ts): "
  "page_size (<=100, default 20), page_token (op-id keyset), filter (state list, 400 invalid), response {operations, next_page_token}; "
  "edge cases: token khong hop le, cross-tenant (neu apiKeyId null), empty state. Doi chieu rework keyset 6-value → bang MISMATCH. "
  "Output vao report cua ban; KHONG sua source; KHONG tick gate."),

 ("task_golden_test_inventory", "term_b2d08e87-4435-4323-8e14-b58fa1a6729b",
  "DISPATCH task_golden_test_inventory (Claude coordinator session). Wave 14 cua ban da SETTLED (receipt tester.md:11604) — cam on. "
  "Nhiem vu moi READ-ONLY: liet ke test legacy hien co tai app/ + tests/ (root D:/Git/dugate) co the seed golden fixture cho COMP-10-off — "
  "theo 6 route + lifecycle (list/detail/cancel/resume/download) + 3 workflow: file:line, case, output shape, nguon fixture. "
  "Output bang vao tester.md. GIOI HAN: KHONG viet test moi, KHONG sua source, KHONG tick gate — day la inventory cho wave sau."),

 ("task_legacy_error_char", "term_f1ed751c-4c2a-4563-9687-0a5b30c5900a",
  "DISPATCH task_legacy_error_char (Claude coordinator session). COMP-06 operations cua ban da SETTLED (receipt coordination/reports/raw/comp-06-legacy-operations-jest.txt, 27/27x3) — cam on. "
  "Nhiem vu moi READ-ONLY: inventory problem+json legacy — namespace https://dugate.vn/errors/*, mapping status (400/401/403/404/413/422/429/5xx), "
  "shape tu lib/errors.ts + apiError() + cac route app/api/v1/**; doi chieu canonical error rework → bang MISMATCH. "
  "Day la input cho COMP-02 freeze. Output vao report cua ban; KHONG sua source; KHONG tick gate."),

 ("task_workflow_runtime_char", "term_949d489b-0ce8-4242-a8c2-988362192922",
  "DISPATCH task_workflow_runtime_char (Claude coordinator session). Workflow-mapping cua ban da SETTLED (receipt tester.md) — cam on. "
  "Nhiem vu moi READ-ONLY: characterization runtime 3 workflow legacy (disbursement, lc-checker, doc-compare): "
  "luong tu app/api/v1/docs/workflows/route.ts -> submit -> lib/pipelines/workflow-engine.ts (checkpoint/HITL/resume/parallel), "
  "cung POST /api/v1/docs/workflows/schema output shape. Output bang semantics + MISMATCH → input COMP-09/P9-04. "
  "GIOI HAN: read-only app/; KHONG sua source rework; KHONG tick gate; receipt vao report cua ban."),
]

for task_id, handle, text in DISPATCHES:
    try:
        r = subprocess.run([ORCA, "orchestration", "dispatch", "--task", task_id, "--to", handle, "--json"],
                           capture_output=True, text=True, timeout=90, encoding="utf-8", errors="replace")
        d_ok = '"ok": true' in (r.stdout or "") or '"accepted": true' in (r.stdout or "")
        if not d_ok:
            d_ok = "FAIL:" + ((r.stdout or r.stderr or "")[:150])
    except Exception as e:
        d_ok = f"ERR {e}"
    try:
        r2 = subprocess.run([ORCA, "terminal", "send", "--terminal", handle, "--text", text, "--enter", "--json"],
                            capture_output=True, text=True, timeout=90, encoding="utf-8", errors="replace")
        out = r2.stdout or r2.stderr or ""
        s_ok = '"accepted": true' in out or '"ok": true' in out
        if not s_ok:
            s_ok = "FAIL:" + out[:150]
    except Exception as e:
        s_ok = f"ERR {e}"
    print(task_id, "| dispatch:", d_ok, "| send:", s_ok, flush=True)

# register in agent-watch-state.json
with open('coordination/agent-watch-state.json', encoding='utf-8') as f:
    w = json.load(f, object_pairs_hook=collections.OrderedDict)
for task_id, handle, _ in DISPATCHES:
    w['dispatches'][f"ctx_{task_id}"] = collections.OrderedDict([
        ("taskId", task_id), ("terminalHandle", handle),
        ("lastObservedAt", NOW), ("lastProgressAt", NOW),
        ("transcriptCursor", ""), ("consecutiveUnfinishedChecks", 0),
        ("lastNudgeAt", None), ("blocker", None),
        ("status", "running"), ("receipt", None), ("supervised", True),
    ])
w['lastCheckedAt'] = NOW
with open('coordination/agent-watch-state.json', 'w', encoding='utf-8') as f:
    json.dump(w, f, ensure_ascii=False, indent=2)
    f.write('\n')
print("watch-state updated:", len(DISPATCHES), "new, total", len(w['dispatches']))
