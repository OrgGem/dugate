from pathlib import Path
from urllib.parse import unquote
import difflib
import hashlib
import json
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')
root = Path(__file__).resolve().parents[2]
prefix = root / 'coordination/reports/wave-802-packets-2026-10-05'
plan_path = root / 'tasks/PLAN-COMPLETION-2026-10-04.md'
receipt_path = Path(str(prefix) + '.md')
before = Path(str(prefix) + '.plan.before.md').read_text(encoding='utf-8-sig')
plan = plan_path.read_text(encoding='utf-8-sig')
baseline = json.loads(Path(str(prefix) + '.intake.json').read_text(encoding='utf-8'))
errors = []
if not plan.startswith(before):
    errors.append('Existing plan sections changed instead of append-only packet detail')
if re.findall(r'\[[ x~]\]', before) != re.findall(r'\[[ x~]\]', plan):
    errors.append('Checkbox changed')
section = plan.split('## 18. Wave 802', 1)[-1]
packets = re.findall(r'^\| \*\*(W802-\d{2}) ', section, re.M)
if packets != [f'W802-{n:02}' for n in range(1, 9)]:
    errors.append('Expected eight unique packet rows')
for row in [line for line in section.splitlines() if line.startswith('| **W802-')]:
    if len(row.split('|')) != 6:
        errors.append('Packet missing ID/lane, objective/dependency, write lease or acceptance/consumer column')
for token in ['/admin/web/identity', '/admin/api/identity/users/:id', '/admin/web/workflows',
              '/admin/web/docs', 'DEV-03', 'dsh_2', 'ENCRYPTION_KEY', '5913db5e', 'ae7e29ce',
              'AbortSignal', 'binds', 'T-PROM-02', 'ctx_ca5bfe6f4d7f', 'ctx_1423c997ab4c',
              'ctx_53190290a0e2', 'SETTINGS-WIRE-BASE', 'task_0f77d71cabd1', '/admin/api/settings']:
    if token not in section:
        errors.append('Missing route/condition/attempt ' + token)
for name, pin in baseline.items():
    if name != 'tasks/PLAN-COMPLETION-2026-10-04.md':
        path = root / name
        if hashlib.sha256(path.read_bytes()).hexdigest() != pin['sha256'] or str(path.stat().st_mtime_ns) != pin['mtime_ns']:
            errors.append('Read-only pin changed ' + name)
post = {name: {'sha256': hashlib.sha256((root/name).read_bytes()).hexdigest(),
               'mtime_ns': str((root/name).stat().st_mtime_ns)} for name in baseline}
Path(str(prefix) + '.post-pins.json').write_text(json.dumps(post, indent=2) + '\n', encoding='utf-8')
literal = ''.join(difflib.unified_diff(before.splitlines(keepends=True), plan.splitlines(keepends=True),
                                    fromfile='PLAN (wave802 intake)', tofile='PLAN (packet proposals)'))
Path(str(prefix) + '.literal.diff').write_text(literal, encoding='utf-8', newline='')
command = ['git', '-c', 'core.autocrlf=false', '-c',
           'core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol',
           'diff', '--check', '--', 'tasks/PLAN-COMPLETION-2026-10-04.md']
check = subprocess.run(command, cwd=root, capture_output=True, text=True, encoding='utf-8')
Path(str(prefix) + '.diff-check.raw.txt').write_text(
    'command: ' + ' '.join(command) + '\nstdout:\n' + check.stdout + '\nstderr:\n' + check.stderr +
    '\nexit: ' + str(check.returncode) + '\n', encoding='utf-8')
if check.returncode:
    errors.append('git diff --check failed')
raw_path = Path(str(prefix) + '.validation.raw.json')
if not raw_path.exists():
    raw_path.write_text('{}\n', encoding='utf-8')
links = 0
anchors = 0
for path, content in [(plan_path, plan), (receipt_path, receipt_path.read_text(encoding='utf-8-sig'))]:
    for n, line in enumerate(content.splitlines(), 1):
        if line.rstrip() != line:
            errors.append('Trailing whitespace ' + path.name + ':' + str(n))
    for target in re.findall(r'\]\(([^\s)]+)\)', content):
        if target.startswith(('https:', 'http:', 'app:', 'file:')):
            continue
        name, sep, fragment = target.strip('<>').partition('#')
        dest = (path.parent / unquote(name)).resolve() if name else path
        links += 1
        if not dest.exists():
            errors.append('Missing link ' + target)
        elif sep:
            anchors += 1
            headings = re.findall(r'^#+\s+(.+)$', dest.read_text(encoding='utf-8-sig'), re.M)
            slugs = [re.sub(r'[^\w\- ]', '', h.lower()).replace(' ', '-') for h in headings]
            if unquote(fragment) not in slugs:
                errors.append('Missing heading anchor ' + target)
result = {'packets': packets, 'checkbox_changes': 0 if not any('Checkbox' in e for e in errors) else 'FAIL',
          'existing_sections_preserved': plan.startswith(before), 'readonly_pins_checked': len(baseline)-1,
          'local_links_checked': links, 'anchors_checked': anchors, 'diff_check_exit': check.returncode,
          'post_pins': post, 'errors': errors}
raw_path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, indent=2))
raise SystemExit(bool(errors))
