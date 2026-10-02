#!/usr/bin/env python3
import json, collections, os
os.chdir(r"D:\Git\dugate\du-rework")
NOW = "2026-10-01T09:12:00+07:00"
p = 'coordination/agent-watch-state.json'
w = json.load(open(p, encoding='utf-8'), object_pairs_hook=collections.OrderedDict)
v = w['dispatches']['ctx_task_legacy_lifecycle_char']
v['status'] = 'settled'
v['receipt'] = "reports/tester.md:11788 (COMP-07-LEGACY-LIFECYCLE-CHAR; fixture matrix + 3 hard findings + MISMATCH M1-M12; header says 03:50 but written 09:06 — timestamp anomaly flagged)"
v['lastObservedAt'] = NOW
w['lastCheckedAt'] = NOW
json.dump(w, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(p, 'a', encoding='utf-8').write('\n')
print("settled ctx_task_legacy_lifecycle_char ->", v['receipt'][:60])
