import json, sys, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NOW = "2026-10-01T14:00:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"

w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

key = "ctx_task_opsadmin_settings_journeys"
e = disp.get(key)
if e is None:
    print("MISSING", key)
else:
    e["status"] = "settled"
    e["receipt"] = (
        "du-rework/coordination/reports/codex-legacy-opsadmin-settings-journeys-2026-10-01.md | "
        "C4 VERIFIED against real code: recover-stalled flips matching rows to state=FAILED + errorCode=STALLED at "
        "recover-stalled/route.ts:54-55 (no retry-count check in that route; BullMQ attempts:3 lives separately in "
        "lib/queue/pipeline-queue.ts) - the receipt stated this precisely. analytics WHERE clauses are createdAt-only "
        "(route.ts:38,50,70,86) - apiKeyId appears only in SELECT/COALESCE labels, NOT as a scope predicate, so "
        "instance-wide aggregate is correct. /api/internal is in middleware BYPASS_PREFIXES (middleware.ts:8-15,24-26) - "
        "confirmed. POST /api/settings/test has no role check in the handler - CONFIRMED by reading the full file "
        "(only getSetting + provider call); precision note for the record: middleware still requires a NextAuth session "
        "for /api/settings/** (middleware.ts:61-69), so the honest finding is 'any authenticated user incl. VIEWER can "
        "trigger a live provider call with the server's stored key', not 'unauthenticated'. Receipt's phrasing "
        "'no role check in the handler itself' is accurate. bull-board isAdmin guard confirmed "
        "(bull-board/[[...slug]]/route.ts:24-28). §9 correctly labels client-directed identity selection + admin-key "
        "fallback MUST-NOT-REPLICATE across profile-endpoints/ext-overrides/test-profile-endpoint/workflows routes. "
        "§10 classify table present with file:line basis (cutover-required: stalled-recovery, retention, analytics, "
        "settings, health; post-cutover: bull-board, swagger UI) - satisfies ORCH-PAR-00 format requirement for this "
        "journey set. Rework counterpart claims (no global AppSetting route, no Bull Board, health probes PG/Redis) "
        "consistent with prior receipts."
    )
    e["lastObservedAt"] = NOW
    e["consecutiveUnfinishedChecks"] = 0
    e["blocker"] = None
    print("SETTLED", key)

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")

c = collections.Counter(x["status"] for x in disp.values())
print("watch-state total", len(disp), dict(c))
