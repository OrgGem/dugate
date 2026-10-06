#!/usr/bin/env python3
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
d = json.load(open(sys.argv[1], encoding='utf-8'))
terms = d.get('result', {}).get('terminals') or d.get('terminals') or []
if isinstance(terms, dict):
    terms = list(terms.values())
for t in terms:
    if not isinstance(t, dict):
        continue
    print(t.get('handle'), '|', t.get('status'), '|', (t.get('title') or t.get('name') or '')[:60],
          '|', (t.get('lastMessage') or t.get('last') or '')[:80].replace('\n',' '))
