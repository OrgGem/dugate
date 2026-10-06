import io
import json

BASE = "du-rework/coordination/reports/raw/verify-plat-mig-03-905/"
for name in ("connector-40-jest.json", "client-22-jest.json", "proxy-19-jest.json"):
    doc = json.load(io.open(BASE + name, encoding="utf-8"))
    print("==", name, "==")
    print("success=%s suites=%d/%d tests passed=%d failed=%d pending=%d todo=%d total=%d"
          % (doc["success"], doc["numPassedTestSuites"], doc["numTotalTestSuites"],
             doc["numPassedTests"], doc["numFailedTests"], doc["numPendingTests"],
             doc.get("numTodoTests", 0), doc["numTotalTests"]))
    for tr in doc["testResults"]:
        short = tr["name"].replace("\\", "/").split("/tests/")[-1]
        statuses = {}
        for a in tr["assertionResults"]:
            statuses[a["status"]] = statuses.get(a["status"], 0) + 1
        print("  suite %-70s %s %s" % (short, tr["status"], statuses))
        for a in tr["assertionResults"]:
            if a["status"] != "passed":
                print("    NOT PASSED: %s | %s" % (a["status"], a["fullName"]))
    if name.startswith("connector"):
        print("  -- per-test statuses (all 4 suites) --")
        for tr in doc["testResults"]:
            short = tr["name"].replace("\\", "/").split("/tests/")[-1]
            for a in tr["assertionResults"]:
                print("   %-7s %-60s %s" % (a["status"], short, a["fullName"]))
