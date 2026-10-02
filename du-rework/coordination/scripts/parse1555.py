import json, sys, re

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

pat = re.compile(r'"(?:text|content|preview|output)"\s*:\s*"((?:[^"\\]|\\.)*)"')

FILES = ["c1555-review", "c1555-q27", "c1555-q45", "c1555-q74", "c1555-q63"]

for f in FILES:
    try:
        d = json.load(open(r"D:/Git/dugate/.qwen/tmp/" + f + ".json", encoding="utf-8"))
    except Exception as e:
        print("=====", f, "FAIL", str(e)[:60])
        continue
    s = json.dumps(d.get("result", d), ensure_ascii=False)
    parts = pat.findall(s)
    print("=====", f, "=====")
    print((((" | ".join(parts)) or s)[-700:]).replace("\\n", " ")[:700])
    print()
