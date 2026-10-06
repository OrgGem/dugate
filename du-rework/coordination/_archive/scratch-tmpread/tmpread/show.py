#!/usr/bin/env python3
import json, re, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

for p in sys.argv[1:]:
    try:
        d = json.load(open(p, encoding='utf-8'))
    except Exception as e:
        print(p, "ERR", e); continue
    t = d.get("result", {}).get("terminal", d)
    lines = t.get("tail") or []
    print("=" * 78)
    print(p.split("c3_")[-1].replace(".json",""), "| status =", t.get("status"))
    for l in lines:
        s = l if isinstance(l, str) else json.dumps(l, ensure_ascii=False)
        s = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', s)
        if s.strip():
            print("   ", s[:360])
