#!/usr/bin/env python3
# Cycle ~11:00 - settle 4 receipts (C2). Read-only lanes; no source edits.
import json, collections
p = r'D:\Git\dugate\du-rework\coordination\agent-watch-state.json'
d = json.load(open(p, encoding='utf-8'), object_pairs_hook=collections.OrderedDict)
disp = d['dispatches']
NOW = "2026-10-01T11:00:00+07:00"

def settle(sub, receipt):
    hits = [k for k in disp if sub in k]
    if not hits:
        print("MISSING", sub); return
    k = hits[0]
    e = disp[k]
    e['status'] = 'settled'
    e['receipt'] = receipt
    e['lastObservedAt'] = NOW
    e['consecutiveUnfinishedChecks'] = 0
    print("SETTLED", k)

settle("workflow_three_process_char",
  "reports/codex-new.md:671 COMP-01b legacy workflow wire (3 process workflows = POST /api/v1/docs/workflows multipart, process required, 202 + Operation-Location route.ts:113, body {name,done:false,metadata{state:RUNNING,progress_percent:0}}; legacy form apiKeyId is NOT auth - route.ts:74-85 falls back to OLDEST ADMIN key => MNR; schema workflow { schemaSlug, ...input } spread at schema/route.ts:50-56 lets input.schemaSlug overwrite the validated slug => selector-integrity MNR; doc-compare accepts 1 file at HTTP bound but workflow needs >=2 (doc-compare.ts:46-56), no upper bound; rework mapping for all 3 ABSENT - legacy-workflow-mapping.ts has none of disbursement/lc-checker/doc-compare, resolveLegacySchemaSlug unmounted; owners COMP-09 + P9-01..03; NO alias to 6 core actions; ticks no gate)")

settle("local_admin_auth_gap",
  "reports/codex-local-auth-cutover-characterization-2026-10-01.md (LOCAL-00 PARTIAL, LOCAL-01 ABSENT - no admin_local_users / DU_ADMIN_AUTH_MODE / password verifier, LOCAL-02..06 PARTIAL, NONE PRESENT; evidence-not-verdict, ticks no gate; identity paths: legacy Credentials JWT carries db user id/username/role (lib/auth.ts:17-48), rework legacy token shell deriveRoleFromToken accepts caller-selected 'role:<role>:<value>' form (shell-router.ts:519-540) => MNR, legacy du_admin cookie carries role with no user subject; shared bearer -> platform principal (rbac.ts:25-40, server.ts:2799-2809) must not stand as human identity; main.ts:105-129 does not pass adminShellCookieSecret and attachAdminShell refuses without both; no unverified identity-header path found in inspected surfaces)")

settle("compat_mount_surface",
  "reports/qwen-platform.md:5109 MUC 54 (TOAN BO BE MAT COMPAT VA CHI PHI MOUNT) + ledger row 54 at qwen-platform.md:152 - 9-item mount change list; verified server.ts sha 22afb2ff UNCHANGED; compat/ still unmounted on the wire; read-only, no source edit, ticks no gate")

settle("par04_schema_gap",
  "reports/qwen-platform.md:5197 MUC 55 READ-ONLY CHARACTERIZATION: J05 WORKFLOW-SCHEMA AUTHORING (field-level, F1-F5) - explicitly RETRACTS the 'expected-failure test' framing ('a test that fails today does not discharge a defect'); count corrected to 3 partial / 8 absent / 1 present-but-different-domain (A3 manifest authoring exists - earlier '9 absent' wrongly folded it); F1-F5 tables with file:line; section-5-vs-3 conflict posed as questions Q1-Q4 for COMP-00 instead of a verdict the lane picks; reusable assets named: business_versions digest-immutability (registry.ts:61-96), SCHEMA_LIMITS (version.ts:24-32); one nudge sent 10:53; limits held, ticks no gate")

d['lastCheckedAt'] = NOW
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(p, 'a', encoding='utf-8').write('\n')

from collections import Counter
c = Counter(e['status'] for e in disp.values())
print("total", len(disp), dict(c))