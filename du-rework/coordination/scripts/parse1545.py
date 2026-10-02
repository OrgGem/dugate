import json, sys, glob, os, re

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

pat = re.compile(r'"(?:text|content|preview|output)"\s*:\s*"((?:[^"\\]|\\.)*)"')

for f in sorted(glob.glob(r"D:/Git/dugate/.qwen/tmp/c15*-*.json")):
    if "terms" in f:
        continue
    tag = os.path.basename(f)[6:20]
    try:
        d = json.load(open(f, encoding="utf-8"))
    except Exception as e:
        print("==", tag, "PARSE_FAIL", str(e)[:80])
        continue
    s = json.dumps(d.get("result", d), ensure_ascii=False)
    parts = pat.findall(s)
    tail = " | ".join(parts)[-450:] if parts else s[-450:]
    print("==", tag, "==")
    print(tail.replace("\\n", " ")[:450])
    print()
