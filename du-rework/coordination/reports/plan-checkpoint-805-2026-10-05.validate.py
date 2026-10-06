from pathlib import Path
from urllib.parse import unquote
import ast
import difflib
import hashlib
import json
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'coordination/reports/plan-checkpoint-805-2026-10-05'
intake = json.loads(Path(str(BASE)+'.intake.json').read_text(encoding='utf-8'))
errors = []
diffs = []
checks = []
pins = {}
oldtexts = {}
for name, meta in intake['files'].items():
    before = (ROOT / meta['snapshot']).read_bytes()
    after = (ROOT / name).read_bytes()
    if hashlib.sha256(before).hexdigest() != meta['sha256']:
        errors.append(name+': intake SHA mismatch')
    old = before.decode('utf-8-sig')
    now = after.decode('utf-8-sig')
    oldtexts[name] = old
    cb0 = re.findall(r'\[[ xX~]\]', old)
    cb1 = re.findall(r'\[[ xX~]\]', now)
    if cb0 != cb1:
        errors.append(name+': checkbox vector changed')
    if name.endswith('PLAN-COMPLETION-2026-10-04.md'):
        if not after.startswith(before):
            errors.append('PLAN old bytes changed')
        if after != before+b'\n\n'+Path(str(BASE)+'.section.md').read_bytes():
            errors.append('PLAN differs from exact section20 append')
    else:
        candidate = now.replace('PLAN-UPDATE-805b (historical; superseded by checkpoint805)', 'PLAN-UPDATE-805b (current)', 1)
        candidate = re.sub(r'^> \*\*PLAN-CHECKPOINT-805 \(current\):\*\*[^\n]*\n', '', candidate, count=1, flags=re.M)
        # Exactly one new blank line accompanies the inserted notice.
        if candidate.replace('\r\n', '\n') != old.replace('\r\n', '\n').replace('\n', '\n\n', 1):
            errors.append('README changed outside notice/header demotion')
    diffs.append(''.join(difflib.unified_diff(old.splitlines(keepends=True), now.splitlines(keepends=True), fromfile=meta['snapshot'], tofile=name)))
    checks.append({'file': name, 'checkbox_count': len(cb1), 'checkbox_vector_unchanged': cb0 == cb1})
    pins[name] = {'sha256': hashlib.sha256(after).hexdigest(), 'bytes': len(after)}

plan = (ROOT/'tasks/PLAN-COMPLETION-2026-10-04.md').read_text(encoding='utf-8')
section = plan.split('## 20. PLAN-CHECKPOINT-805', 1)[1]
required = ['A7', 'A8', 'A9', 'REVIEW-803', 'REVIEW-804', 'ACCEPTED-OFFLINE', 'APPROVED-WITH-CONDITIONS', 'A1–A5', 'B1–B5', 'G-ENC', 'VFY-ENC09-803', 'VFY-PLAN-805B', 'MIGRATION-VERIFY-TRAP-FIX', 'IDENTITY-ROLE-POLICY', 'CRED-LIMITS-801', 'ADMINWEB-MAP', 'GAP-INVENTORY-803', 'DOCS-CATALOG-HONESTY', '13/13', 'TRACE-RECONCILE-803', 'UI-BACKLOG-803', 'UI-CONTRACT-MATRIX', 'UI-CHECKLIST', 'BUILD-DIGEST-AUDIT', 'index-Bs0p8VRI.js', 'index-BZ2-Edjb.js', 'CFGADM-DOCS-CSRF-FIX', 'BFF-SETTINGS-IDENTITY', 'WINDOW-DESIGN-803', 'SETTINGS-WRITER-DESIGN', 'DEPLOYMENT-ADAPTER-DESIGN', 'BACKFILL-LEFTOVER-COUNTER', 'UI-REVIEW-DOCS-CSRF', 'REVIEW-805', 'LEASE-AUDIT-803', 'plaintext-readable', 'b088eec', 'DEV-03']
for token in required:
    if token not in section:
        errors.append('Missing checkpoint token '+token)
for turn in range(806,811):
    if '**'+str(turn)+'**' not in section:
        errors.append('Missing next turn '+str(turn))
for name in ['P763-W1C-COMPOSE', 'P763-PROMPT-WIRING', 'G-ENC']:
    oldrow = next((line for line in oldtexts['tasks/PLAN-COMPLETION-2026-10-04.md'].splitlines() if line.startswith('| '+name+' ')), None)
    if oldrow and oldrow not in plan.splitlines():
        errors.append('Gate row changed '+name)

# Reuse the preceding checkpoint's broad document/link/anchor/task/graph scan.
# Its historical per-file mutation assertions are intentionally not executed.
previous = (ROOT/'coordination/reports/plan-update-805b-2026-10-05.validate.py').read_text(encoding='utf-8')
paths_node = next(node for node in ast.parse(previous).body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id == 'paths' for t in node.targets))
paths = eval(compile(ast.Expression(paths_node.value), '<prior-document-inventory>', 'eval'), {'root': ROOT})
for target in re.findall(r'\]\(([^\s)]+)\)', section):
    path = (ROOT/'tasks'/target.partition('#')[0]).resolve()
    if path.is_file() and path.suffix == '.md' and path not in paths:
        paths.append(path)
namespace = {'paths':paths, 'root':ROOT, 'baseline':{}, 're':re, 'json':json, 'unquote':unquote, 'Path':Path}
scan = previous[previous.index('problems=[];'):previous.index('cfg=(root/')]
exec(scan,namespace)
errors.extend(namespace['problems'])

run = subprocess.run(['git','diff','--check','--',*intake['files']],cwd=ROOT,capture_output=True)
Path(str(BASE)+'.diff-check.raw.txt').write_text('command: git diff --check -- '+ ' '.join(intake['files'])+'\nexit: '+str(run.returncode)+'\nstdout:\n'+run.stdout.decode('utf-8',errors='replace')+'\nstderr:\n'+run.stderr.decode('utf-8',errors='replace'),encoding='utf-8')
if run.returncode:
    errors.append('diff-check exit '+str(run.returncode))
head = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
if head != intake['head']:
    errors.append('HEAD changed during checkpoint')
Path(str(BASE)+'.literal.diff').write_text(''.join(diffs),encoding='utf-8',newline='')
Path(str(BASE)+'.post-pins.json').write_text(json.dumps({'head':head,'files':pins},indent=2)+'\n',encoding='utf-8')
result = {'document_checks_only':True,'checks':checks,'documents_scanned':len(paths),'local_links_checked':namespace['links'],'anchors_checked':namespace['anchors'],'graphs_checked':namespace['graphs'],'task_definitions_checked':len(namespace['definitions']),'duplicate_task_definitions':namespace['duplicates'],'required_checkpoint_markers':len(required),'next_turns':[806,807,808,809,810],'checkbox_changes':0 if all(c['checkbox_vector_unchanged'] for c in checks) else 'error','diff_check_exit':run.returncode,'head':head,'errors':errors}
Path(str(BASE)+'.validation.raw.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print(json.dumps(result,indent=2,ensure_ascii=False))
sys.exit(1 if errors else 0)
