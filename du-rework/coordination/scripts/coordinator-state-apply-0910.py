#!/usr/bin/env python3
import json, collections, os
os.chdir(r"D:\Git\dugate\du-rework")
NOW = "2026-10-01T09:10:00+07:00"
NEW = {
 "ctx_task_keyset_planner_flake_fix": ("task_2df6119d17f7", "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe"),
 "ctx_task_legacy_webhook_char":       ("task_ed1362e79e4e", "term_2b05b203-549f-4428-b908-c303a2b187ec"),
 "ctx_task_profile_override_char":     ("task_f24f9edfaa9e", "term_b2d08e87-4435-4323-8e14-b58fa1a6729b"),
 "ctx_task_legacy_auth_fence_char":    ("task_efeb2095d340", "term_f1ed751c-4c2a-4563-9687-0a5b30c5900a"),
}
SETTLE = {
 "ctx_task_legacy_pagination_char": "reports/qwen-platform.md:4942 (legacy pagination MISMATCH; helper 27/27 but server.ts does not import it)",
 "ctx_task_golden_test_inventory": "reports/tester.md:11741 (golden fixture inventory: 6 routes + lifecycle + 3 workflows; gaps listed)",
 "ctx_task_legacy_error_char": "reports/codex-legacy-error-inventory-2026-10-01.md (3 legacy serializers; lib/errors.ts unused; urn:du:error vs dugate.vn/errors/*)",
}
p = 'coordination/agent-watch-state.json'
w = json.load(open(p, encoding='utf-8'), object_pairs_hook=collections.OrderedDict)
for k, (run_tid, handle) in NEW.items():
    w['dispatches'][k] = collections.OrderedDict([
        ("taskId", k[4:]), ("terminalHandle", handle),
        ("lastObservedAt", NOW), ("lastProgressAt", NOW),
        ("transcriptCursor", ""), ("consecutiveUnfinishedChecks", 0),
        ("lastNudgeAt", None), ("blocker", None),
        ("status", "running"), ("receipt", None), ("supervised", True),
        ("runTaskId", run_tid),
    ])
for k, r in SETTLE.items():
    if k in w['dispatches']:
        w['dispatches'][k]['status'] = 'settled'
        w['dispatches'][k]['receipt'] = r
        w['dispatches'][k]['lastObservedAt'] = NOW
    else:
        print("MISSING", k)
w['lastCheckedAt'] = NOW
json.dump(w, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(p, 'a', encoding='utf-8').write('\n')
print("watch-state OK, total", len(w['dispatches']))
for k in list(NEW) + list(SETTLE):
    v = w['dispatches'][k]
    print(" ", k, "->", v['status'])
