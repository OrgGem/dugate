from pathlib import Path
import difflib
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'coordination/reports/trace-reconcile-803-2026-10-05'
intake = json.loads(Path(str(BASE)+'.intake.json').read_text(encoding='utf-8'))
errors = []
checks = []
pins = {}
diffs = []
links = 0
required = ['FU-ENCMETA-R4', 'FU-ENCMETA-ADMIN', 'ENCMETA-ENC09-KIND', 'ENV-EXAMPLE-FIX', 'VFY-ENC09-803', 'VFY-PLAN-805B', 'MIGRATION-VERIFY-TRAP-FIX', 'IDENTITY-ROLE-POLICY', 'CRED-LIMITS-801', 'V1-BOOT-DENIAL-DECISION', 'BUILD-DIGEST-AUDIT-803', 'live-admin-web.spec.ts', 'A1-A6', 'DEV-03', 'backfillLegacyPayloads', 'NOT SATISFIED', 'CHANGES_REQUIRED']
required += [f'W802-{i:02}' for i in range(1,9)] + [f'803-{i:02}' for i in range(1,7)]
for name, meta in intake.items():
    p = ROOT / name
    old = (ROOT / meta['snapshot']).read_bytes()
    current = p.read_bytes()
    prefix = current.startswith(old)
    if not prefix:
        errors.append(name+': old bytes changed')
    if hashlib.sha256(old).hexdigest() != meta['sha256']:
        errors.append(name+': snapshot pin mismatch')
    added = current[len(old):].decode('utf-8') if prefix else ''
    oldboxes = re.findall(rb'\[[ xX~]\]', old)
    boxes = re.findall(rb'\[[ xX~]\]', current)
    if oldboxes != boxes:
        errors.append(name+': checkbox vector changed')
    for token in required:
        if token not in added:
            errors.append(name+': missing '+token)
    data_rows = [line for line in added.splitlines() if line.startswith('| ') and not line.startswith('| Packet')]
    for row in data_rows:
        if '*owner*' not in row:
            errors.append(name+': row lacks owner provenance: '+row[:100])
        if 'verified by codex_arch' in row or '| VERIFIED |' in row:
            errors.append(name+': false self-verification/promotion')
    for target in re.findall(r'\]\(([^)]+)\)', added):
        links += 1
        if not (p.parent / target).resolve().is_file():
            errors.append(name+': broken appended link '+target)
    pins[name] = {'sha256': hashlib.sha256(current).hexdigest(), 'bytes': len(current)}
    checks.append({'file': name, 'old_byte_prefix_equal': prefix, 'old_bytes': len(old), 'appended_bytes': len(current)-len(old), 'unchanged_checkbox_count': len(boxes), 'owner_attributed_rows': len(data_rows)})
    diffs.append(''.join(difflib.unified_diff(old.decode('utf-8').splitlines(keepends=True), current.decode('utf-8').splitlines(keepends=True), fromfile=meta['snapshot'], tofile=name)))
literal = ''.join(diffs)
Path(str(BASE)+'.literal.diff').write_text(literal, encoding='utf-8', newline='')
Path(str(BASE)+'.post-pins.json').write_text(json.dumps(pins, indent=2)+'\n', encoding='utf-8')
run = subprocess.run(['git', 'diff', '--check', '--', *intake], cwd=ROOT, capture_output=True)
raw = 'command: git diff --check -- '+ ' '.join(intake)+'\nexit: '+str(run.returncode)+'\nstdout:\n'+run.stdout.decode('utf-8', errors='replace')+'\nstderr:\n'+run.stderr.decode('utf-8', errors='replace')
Path(str(BASE)+'.worktree-diff-check.raw.txt').write_text(raw, encoding='utf-8')
scoped = []
for name, meta in intake.items():
    check = subprocess.run(['git', '-c', 'core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol', 'diff', '--no-index', '--check', '--', str(ROOT / meta['snapshot']), str(ROOT / name)], cwd=ROOT, capture_output=True)
    scoped.append({'file': name, 'exit': check.returncode, 'stdout': check.stdout.decode('utf-8', errors='replace'), 'stderr': check.stderr.decode('utf-8', errors='replace')})
    # --no-index implies --exit-code: 1 denotes an expected content diff.
    # --check whitespace errors produce diagnostics, normally exit 2 or 3.
    if check.returncode not in (0, 1) or check.stdout:
        errors.append(name+': intake-relative diff-check exit '+str(check.returncode))
Path(str(BASE)+'.diff-check.raw.txt').write_text(json.dumps(scoped, indent=2)+'\n', encoding='utf-8')
receipt = Path(str(BASE)+'.md')
if not receipt.exists():
    errors.append('receipt missing')
diagnostics = re.findall(r'^du-rework/(docs/[^:]+):(\d+): ([^\n]+)', run.stdout.decode('utf-8', errors='replace'), flags=re.M)
new_diagnostics = [d for d in diagnostics if d[0] not in intake or int(d[1]) > len((ROOT / intake[d[0]]['snapshot']).read_bytes().splitlines())]
if new_diagnostics:
    errors.append('HEAD diff-check includes appended-line diagnostics')
result = {'scope': 'document-only; no product suite/live/browser/build rerun', 'checks': checks, 'appended_links_checked': links, 'required_tokens_per_doc': len(required), 'checkbox_changes': 0 if all(c['unchanged_checkbox_count'] == len(re.findall(rb'\[[ xX~]\]', (ROOT / intake[c['file']]['snapshot']).read_bytes())) for c in checks) else 'error', 'intake_relative_diff_check_exits': [c['exit'] for c in scoped], 'no_index_exit_1_means_expected_content_diff': True, 'intake_relative_whitespace_diagnostics': sum(bool(c['stdout']) for c in scoped), 'worktree_vs_HEAD_diff_check_exit': run.returncode, 'HEAD_whitespace_diagnostics_in_preserved_prefix': len(diagnostics)-len(new_diagnostics), 'HEAD_whitespace_diagnostics_in_append': len(new_diagnostics), 'errors': errors}
Path(str(BASE)+'.validation.raw.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
print(json.dumps(result, indent=2))
sys.exit(1 if errors else 0)
