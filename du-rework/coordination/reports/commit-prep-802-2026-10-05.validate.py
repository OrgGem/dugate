from pathlib import Path
from urllib.parse import unquote
import hashlib
import json
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')
root = Path(__file__).resolve().parents[2]
prefix = root / 'coordination/reports/commit-prep-802-2026-10-05'
report = Path(str(prefix) + '.md')
snapshot = json.loads(Path(str(prefix) + '.snapshot.json').read_text(encoding='utf-8'))
content = report.read_text(encoding='utf-8')
errors = []
rows = re.findall(r'^\| \*\*(c[1-6]) ', content, re.M)
if rows != [f'c{i}' for i in range(1, 7)]:
    errors.append('Six unique baseline group rows missing or reordered')
for row in [line for line in content.splitlines() if line.startswith('| **c')]:
    if len(row.split('|')) != 7:
        errors.append('Group lacks scope/offline/live/UI/dependency columns')
if re.search(r'\[[ x~]\]', content):
    errors.append('Checkbox/task ticks unexpectedly present')
for token in ['RCR', '0032', 'CREDWORKFLOW', 'ENCMETA', 'CW-B', 'CFGADM P1',
              'CFGADM P2', 'CFGADM P3', 'SETTINGS-WIRE-BASE', '8ccdbab15d44cca1',
              '0b8ed8ed715bbd16', 'ENCRYPTION_KEY', 'AbortSignal', 'binds',
              'T-PROM-02', 'DEV-03', 'task_b26e9232f603', 'task_aac120f86260']:
    if token not in content:
        errors.append('Missing refreshed evidence/condition ' + token)
guarded = ['tasks/PLAN-COMPLETION-2026-10-04.md', 'tasks/README.md',
           'coordination/reports/commit-plan-prep-2026-10-05.md']
for name in guarded:
    pin = snapshot['pins'][name]
    path = root / name
    if hashlib.sha256(path.read_bytes()).hexdigest() != pin['sha256'] or str(path.stat().st_mtime_ns) != pin['mtime_ns']:
        errors.append('Read-only document pin drift ' + name)
for n, line in enumerate(content.splitlines(), 1):
    if line.rstrip() != line:
        errors.append('Trailing whitespace line ' + str(n))
raw_path = Path(str(prefix) + '.validation.raw.json')
if not raw_path.exists():
    raw_path.write_text('{}\n', encoding='utf-8')
links = anchors = 0
for target in re.findall(r'\]\(([^\s)]+)\)', content):
    if target.startswith(('http:', 'https:', 'app:')):
        continue
    name, sep, fragment = target.strip('<>').partition('#')
    dest = (report.parent / unquote(name)).resolve() if name else report
    links += 1
    if not dest.exists():
        errors.append('Missing link ' + target)
    elif sep:
        anchors += 1
        headings = re.findall(r'^#+\s+(.+)$', dest.read_text(encoding='utf-8-sig'), re.M)
        slugs = [re.sub(r'[^\w\- ]', '', heading.lower()).replace(' ', '-') for heading in headings]
        if unquote(fragment) not in slugs:
            errors.append('Missing anchor ' + target)
staged = subprocess.run(['git', 'diff', '--cached', '--name-only'], cwd=root,
                        capture_output=True, text=True, encoding='utf-8')
source_drift = []
for name, pin in snapshot['pins'].items():
    if name not in guarded and hashlib.sha256((root/name).read_bytes()).hexdigest() != pin['sha256']:
        source_drift.append(name)
result = {'groups': rows, 'local_links_checked': links, 'anchors_checked': anchors,
          'readonly_document_pins_checked': len(guarded), 'checkboxes_added': 0,
          'staged_query_argv': ['git', 'diff', '--cached', '--name-only'],
          'staged_query_exit': staged.returncode, 'staged_query_stdout': staged.stdout,
          'staged_query_stderr': staged.stderr, 'source_drift_since_snapshot': source_drift,
          'product_tests_run': False, 'receipt_sha256': hashlib.sha256(report.read_bytes()).hexdigest(),
          'errors': errors}
raw_path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, indent=2))
raise SystemExit(bool(errors) or bool(staged.returncode))
