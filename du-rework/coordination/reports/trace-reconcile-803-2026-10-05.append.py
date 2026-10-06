from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'coordination/reports/trace-reconcile-803-2026-10-05'
FILES = [
    'docs/19-traceability-audit-matrix.md',
    'docs/28-test-inventory.md',
    'docs/35-acceptance-baseline.md',
]

def receipt(name):
    return f'[{name}](../coordination/reports/{name})'

tester = receipt('tester.md')
rows = [
 ('FU-ENCMETA-R4', 'SDK canonical taskId/resultRef/errorCode precede snake_case aliases; server DTO no longer drops children. fan-out.test.ts: 21/21 x3, exit 0; SDK tsc 0.', 'codex_worker_1', receipt('encmeta-r4-sdk-fix-2026-10-05.md'), 'Offline injected fetch. Actual deployed runtime/worker exchange remains live-only.'),
 ('FU-ENCMETA-ADMIN / REVIEW-802 S1', 'Admin operation-detail projection opens envelope with operation tenant/slot/row UUID; fake seam 5 cases, focused 21/21 x3; Claude S1 APPROVED. VFY-802 focused 5/5 x3 plus actual admin-bearer route probe.', 'qwen_2; Claude reviewer; independent tester', receipt('encmeta-admin-projection-fix-2026-10-05.md') + '; ' + receipt('claude.md') + '; ' + tester, 'Offline fake/scripted dependencies; route probe is not a real PG/key-provider deployment. A3 dual-read expiry remains open.'),
 ('ENCMETA-ENC09-KIND', 'Inventory includes operations.result_ref/tasks.result_ref; PG-store implementation exercised with fake DB: 14 new + 9 existing = 23/23 x3. Two real owner bugs fixed: tasks lacks tenant_id (join operations); crypto refId must be row UUID, not composite store address. Mutations: composite 5 RED, window 1 RED, restored.', 'qwen_1', receipt('encmeta-enc09-kind-2026-10-05.md'), 'Offline SQL-shape/store tests, not PG planner/transaction rollback. Existing-test +1/-1 lease deviation still requires ratify-or-revert.'),
 ('VFY-ENC09-803', 'Independent ENC09 suites 23/23 x3 and SDK 21/21 x3, all exit 0. One actual createMetadataCrypto AES-GCM probe backfills and opens through public R1 /result and runtime R2 GET-children; actual runtime DTO feeds SDK. Wrong UUID rejects CONTEXT_MISMATCH; closed store window gives MIGRATION_STORE_UNAVAILABLE, zero writes.', 'independent tester', tester + ' (VFY-ENC09-803)', 'Offline deterministic provider/scripted DB, not live Vault/PG. No production caller of ResultRefPgMigrationStore/backfillLegacyPayloads; no deployed bounded-window wiring. Runtime allowPlaintext=true remains A3 OPEN.'),
 ('ENV-EXAMPLE-FIX', 'Vault bindings optional when all absent: workflow off, capability false, surface 503, boot allowed. Enable requires OPTIONS + TOKEN; INITIAL_BINDINGS optional. OPTIONS JSON requires vaultAddress; kvMount/requestTimeoutMs optional. Partial requested config rejects boot; explicit config overrides env.', 'qwen_2', receipt('env-example-fix-2026-10-05.md'), 'Offline documentation correction; no runtime change or live Vault proof.'),
 ('CFGADM P1 / REVIEW-802 S2', 'Claude S2 APPROVED for honest disabled 17-key deployment catalog. At review snapshot Settings grep in contracts returned zero: no read DTO, settings BFF wire or writer. CFGADM-01/02/03/04 catalog only; UI does not prove settings save/test/cleanup.', 'qwen_5; Claude reviewer', receipt('cfgadm-port-p1-2026-10-05.md') + '; ' + receipt('claude.md'), 'Offline catalog approval only. SETTINGS-WIRE-BASE then router/client registration by dsh_2 must precede real browser wire evidence; writer remains disabled until authorized contract/capability exists.'),
 ('CFGADM P2 / REVIEW-802 S3', 'Claude S3 APPROVED-WITH-CONDITIONS: safe role allowlist, local/both + session admin + capability gate, CSRF/idempotency and readback; intercepted UI CRUD is not real BFF. HTTP identity routes absent at review snapshot; role policy security fix required.', 'codex_worker_1; Claude reviewer', receipt('cfgadm-port-p2-2026-10-05.md') + '; ' + receipt('claude.md'), 'Offline adapter evidence. IDENTITY-ROLE-POLICY -> IDENTITY-BFF-ROUTES (trusted server caller, dsh_2 router/client) -> real browser route checks + fresh review; no live identity acceptance.'),
 ('CFGADM P3 / REVIEW-802 S4', 'Claude S4 APPROVED-WITH-CONDITIONS: workflows disabled/zero workflow API, docs endpoint catalog/workbench. No AI wizard contract/BFF; safe response projection remains required.', 'dsh_2; Claude reviewer', receipt('cfgadm-port-p3-2026-10-05.md') + '; ' + receipt('claude.md'), 'Offline shell/catalog scope. DEV-03 user-gated; docs POST CSRF defect needs CFGADM-DOCS-CSRF-FIX and new digest review; AI wizard contract must precede UI.'),
 ('UI contract section 5 / BUILD-DIGEST-AUDIT-803', 'On index-Bs0p8VRI.js: identity UI_APPROVED, workflows-disabled UI_APPROVED, settings-catalog UI_APPROVED; docs CHANGES_REQUIRED (session bootstrap absent -> missing X-CSRF-Token -> 403 CSRF_REJECTED). Audit confirms those verdicts match that build at audit time, not a fifth invented surface verdict.', 'Antigravity UI reviewer', receipt('uirev-cfgadm-port-2026-10-05.md') + '; ' + receipt('build-digest-audit-803-2026-10-05.md'), 'Offline/local browser audit. JS SHA256 8ccdbab15d44cca1886895475ef3a2ae4352304fa2dc235cf1b93c793348c1d7; CSS index-BffJF1YL.css SHA256 baf331d4ea62f3274fc1ac9e83ea049787fc7f786fac6330fbf69de3457bf021. Subsequent source/build changes require affected-route re-review; no whole-app or live approval.'),
 ('V1-CONDITIONS-802', 'Condition (a) NOT SATISFIED: actual production entrypoint boots with both ENCRYPTION_KEY and NEXTAUTH_SECRET absent, x3 using disposable PG/Redis. Resolver missing-key probe generic Error, code/status null, no network; INGESTION_FAILED retry classification is source-path inference. Condition (b) tick-note PASS: verified 5913db5e, additive W1C hunk preserved at ae7e29ce.', 'independent tester', tester + ' (V1-CONDITIONS-802)', 'Offline disposable boot is actual entrypoint, not production live-cell proof. Parent T-PROM-02/provider-use/live stay open; existing offline ticks untouched.'),
 ('V1-BOOT-DENIAL-DECISION', 'Claude selects policy (b): allow boot + one boot warning + typed configured-cipher consumption denial 500 AUTH_DECRYPT_FAILED. AUTH_DECRYPT_FAILED already exists in SourceAuthDenialCode and PERMANENT_CODES; do not add another code-list entry. Proposed resolver catch + boot warning, acceptance 5a-5e.', 'Claude decision owner', receipt('v1-boot-denial-decision-2026-10-05.md'), 'Offline design input, not implemented/accepted behavior proof. Need missing-key/corrupt-tag denial, actual permanent classification, healthy/legacy regressions, real entrypoint warning, reviewer verdict before GO; real cipher rows/key rotation/upstream live gates remain.'),
 ('MIGRATION-0032-ROLLBACK-PREP', 'Nullable jsonb session_ref, migration-before-code ordering; fake runner six cases x3. No rollback framework. Drop column while ledger 32 remains gives false-green verifyMigrations. Dropping sealed continuation refs is destructive; backup/export and direct information_schema jsonb/nullable checks required.', 'qwen_1', receipt('migration-0032-rollout-prep-2026-10-05.md'), 'Offline prep only, no DDL executed. Restore/COPY sketch not validated; no automatic rollback claimed. Actual schema/locks/row counts/backup sign-off live-only.'),
 ('MIGRATION-VERIFY-TRAP-FIX', 'Owner adds independent ledger count/distinct-sequence check and orphan sequence detection; eight new cases, three migration suites 31/31 x3 exit 0, tsc 0. Existing ledger test fake adjusted (+3 lines deviation).', 'qwen_1', receipt('migration-verify-trap-fix-2026-10-05.md'), 'Offline fake DB. Fix closes unread/collapsed ledger and orphan traps, NOT missing physical schema objects; direct schema validation and rollback preparation still required.'),
 ('IDENTITY-ROLE-POLICY', 'New createUser validates trusted caller/requested roles before DB/audit: ADMIN > USER > VIEWER; bind ADMIN->admin, USER->operator, VIEWER->viewer. Bootstrap createAdmin remains CLI-only. New five-test suite passes, typecheck 0. Existing repository suite 7 pass/3 fail (audit bind-position drift) disclosed.', 'codex_worker_1', receipt('identity-role-policy-2026-10-05.md'), 'Offline fake DB security fix, not HTTP wiring. BFF must derive callerRole from server auth, never JSON; existing audit-suite failures and route/browser review remain before acceptance.'),
 ('CRED-LIMITS-801 / W802-05', 'V3 limitations receive real abort timer test (configured 60ms), explicit-config-over-complete-env object identity test, bind-capturing harness positive-control leak/forbidden-SQL self-test. G7 fake chain actually issues zero SQL; assert empty intentionally, do not claim credential DB writes. Two suites 11/11 x3 exit 0, tsc 0; pg count-query mock repaired.', 'qwen_5', receipt('cred-limits-801-2026-10-05.md'), 'Offline timer/scripted dependencies, no Vault/PG. Timeout test structurally load-bearing, not mutation-proven. connector-http-store/connector-management-store AbortSignal.timeout paths outside scope; live credentials/provider tests open.'),
 ('VFY-PLAN-805B', 'Independent rerun document validator exit 0: 84 documents, 621 links, 56 anchors; identical 26-checkbox vector and A1-A6, zero checkbox changes/new task rows. Source/raw hashes match producer receipt.', 'independent tester', tester + ' (VFY-PLAN-805B); ' + receipt('plan-update-805b-2026-10-05.md'), 'Offline document evidence only; earlier two P763 offline ticks pre-existed intake. Does not settle coordinator tasks, authorize commits, or establish live readiness.'),
 ('live-admin-web.spec.ts', 'Historical owner receipt lists 9 browser journeys and gate-OFF 9 skips; not executed in this session.', 'qwen_2', receipt('trace-reconcile-802-2026-10-05.md'), 'live-gated; skipped/listed tests are not passed live journeys. No new execution or status promotion.'),
]

packets = '''
| Packet | Intended consumer / dependency and measurable acceptance | Provenance / scope |
|---|---|---|
| W802-01 ROUTE-REGISTER | Identity -> workflows-disabled -> docs; dsh_2 owns router/client. Route navigation/refresh and capability/blocked-state browser checks after wire/role prerequisites. | *owner* transcribed wave-802-packets; offline plan, live gates retained |
| W802-02 SETTINGS-WIRE-BASE | Settings contract DTO + BFF read + disabled writer contract; freeze safe read projection, register route before real browser evidence. No invented settings mutation. | *owner* transcribed wave-802-packets; offline plan |
| W802-03 ENCMETA-WINDOW | Production backfill entrypoint, bounded window and A3 reader expiry; closed window zero writes and real PG/key-provider checks after live authorization. | *owner* transcribed wave-802-packets; offline plan + live-gated execution |
| W802-04 RESULTREF-READERS | SDK/admin/ENC09 row-context agreement; retain VFY-ENC09-803 offline probe, real persisted R1/R2/admin interoperability remains live-only. | *owner* transcribed wave-802-packets; offline partial evidence |
| W802-05 CRED-LIMITS | V3 timeout/override/SQL-capture checks now owner-reported 11/11 x3; independent review and live provider dependencies remain. | *owner* transcribed wave-802-packets and CRED-LIMITS-801; offline |
| W802-06 V1-CONDITIONS | Replace disproven fail-fast premise with decision policy (b); typed denial/permanent classification/boot warning evidence before GO; preserve existing tick-note scope. | *owner* transcribed wave-802-packets and Claude decision; offline plan, live gates open |
| W802-07 VERIFY-REVIEW | Independent targeted verification and reviewer/UI verdicts pinned to source/build; no offline-to-live or whole-app promotion. | *owner* transcribed wave-802-packets; offline plan |
| W802-08 RECONCILE-TRACE | Append named receipts to trace/inventory/baseline with offline/live boundaries; document validation only. | *owner* transcribed wave-802-packets; offline plan |
| 803-01 FIX-DOCS-CSRF | Session/bootstrap X-CSRF-Token on actual test POST, rebuild/digest and fresh docs UI_APPROVED; no render-only closure. | *owner* transcribed ui-backlog-803; offline proposal, browser/real-route proof pending |
| 803-02 WORKFLOW-TREE-SCAFFOLD | DEV-03 user decision + frozen workflow contract first; disabled until unblocked, safe empty/read-only capability behavior. | *owner* transcribed ui-backlog-803; user-gated proposal |
| 803-03 WORKFLOW-IMPORT-MODAL | Depends on 803-02/gate; reject XXE/DTD and unknown nodes, preview makes zero network requests. | *owner* transcribed ui-backlog-803; offline proposal |
| 803-04 SETTINGS-EDITOR-WIRE | SETTINGS-WIRE-BASE + route registration first; actual writer/adapter/capability needed for Save. Keep/Replace/Clear, CAS/idempotency, no DOM/storage/log secret leakage. | *owner* transcribed ui-backlog-803; offline proposal, writer gated |
| 803-05 PROMPT-WIZARD-MODAL | AI wizard contract/BFF absent at review snapshot: freeze them first, preserve placeholders, draft diff only and no auto-publish. | *owner* transcribed ui-backlog-803; offline proposal |
| 803-06 NAV-POLISH-A11Y-803 | dsh_2 router/client integration and disjoint shell/overview lease; keyboard links, no 404, 320px reflow, gate visibility and fresh affected-route review. | *owner* transcribed ui-backlog-803; offline proposal |
'''

intake = {}
for i, name in enumerate(FILES):
    p = ROOT / name
    before = p.read_bytes()
    if b'TRACE-RECONCILE-803 append-only evidence' in before:
        raise SystemExit('Already appended: ' + name)
    snapshot = Path(str(BASE) + f'.{i+1}.before.md')
    if snapshot.exists():
        raise SystemExit('Snapshot already exists: ' + str(snapshot))
    snapshot.write_bytes(before)
    intake[name] = {'sha256': hashlib.sha256(before).hexdigest(), 'bytes': len(before), 'snapshot': snapshot.relative_to(ROOT).as_posix()}

Path(str(BASE)+'.intake.json').write_text(json.dumps(intake, indent=2)+'\n', encoding='utf-8')
for i, name in enumerate(FILES):
    focus = [
        'Trace scope: SDK/runtime child DTO, admin projection, ENC09 inventory/backfill and admin UI consumers mapped to named receipts and retained gaps.',
        'Inventory scope: per-suite focused counts below are transcribed execution evidence, not a new fleet census. One-off AES-GCM probe was removed by its verifier after execution; its raw output is the evidence, not a persistent suite.',
        'Acceptance scope: this addendum records evidence and quoted scoped reviewer verdicts only. It does not change any acceptance row or close a user/live gate. Owner test greens and design decisions are not acceptance promotions.',
    ][i]
    text = '\n\n## TRACE-RECONCILE-803 append-only evidence (codex_arch, 2026-10-05)\n\n'
    text += focus + '\n\n'
    text += 'All earlier content remains byte-for-byte intact. Every product/test claim below is *owner* transcribed from the linked receipt, including independently reported tester and reviewer work; codex_arch did not rerun product suites, build, browser, boot, DB or crypto probes in this session. Status: evidence recorded only; no row promoted to VERIFIED and no fleet total calculated. Offline means local/fake/disposable dependencies as qualified per row, not deployed production evidence. Later receipt findings below qualify earlier addenda without rewriting them.\n\n'
    text += '| Packet / requirement | Recorded scoped evidence | Attribution and source | Offline / live boundary and outstanding condition |\n|---|---|---|---|\n'
    for ident, evidence, owner, source, boundary in rows:
        text += f'| {ident} | {evidence} | *owner* {owner}, transcribed from {source} | {boundary} |\n'
    text += '\n### Wave 802 and UI 803 packet trace (proposals, not completion ticks)\n\n'
    text += 'Sources: *owner* transcribed ' + receipt('wave-802-packets-2026-10-05.md') + ' and ' + receipt('ui-backlog-803-2026-10-05.md') + '. Packet dependencies below retain newly discovered gaps; they do not dispatch work or authorize gate changes.\n'
    text += packets
    text += '\nA1-A6 retained; commit go/no-go 1-6, the eight live-window questions and DEV-03 remain user-gated. A3 legacy dual-read policy is OPEN. No source edits, task ticks, commit, stage, push or live-window authorization result from this evidence fold.\n\n'
    text += 'Document integrity evidence is separate: [TRACE-RECONCILE-803 receipt](../coordination/reports/trace-reconcile-803-2026-10-05.md) records only checks verified by codex_arch this session (exact old-byte prefix, unchanged checkbox vector, appended links, literal diff, post-write hashes and diff-check).\n'
    with (ROOT / name).open('ab') as out:
        out.write(text.encode('utf-8'))
print('Appended three evidence sections; snapshots/intake saved.')
