"""Receipt-only static integrity checks; no product/DB/crypto execution."""
import hashlib
import difflib
import json
import re
import subprocess
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'coordination/reports/bypass-audit-809-2026-10-05'
receipt = BASE.with_suffix('.md')
manifest = json.loads(BASE.with_suffix('.intake.json').read_text(encoding='utf-8'))
body = receipt.read_text(encoding='utf-8')
BASE.with_suffix('.literal.diff').write_text(''.join(difflib.unified_diff(
    [], body.splitlines(keepends=True), fromfile='/dev/null',
    tofile=str(receipt.relative_to(ROOT)).replace('\\', '/'))), encoding='utf-8')
errors = []
links = []
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
for target in re.findall(r'\]\(([^)]+)\)', body):
    if target.startswith(('http:', 'https:')):
        continue
    file, _, anchor = target.partition('#')
    path = (receipt.parent / file).resolve()
    if not path.is_file():
        errors.append('Missing local link: ' + target)
        continue
    if anchor.startswith('L'):
        number = int(anchor[1:])
        if not 1 <= number <= len(path.read_text(encoding='utf-8').splitlines()):
            errors.append('Out-of-bounds line: ' + target)
    links.append({'target': target, 'sha256': sha(path)})
for marker in ['BA-%02d' % i for i in range(1, 10)] + [
    'A8 caveat', 'A12', 'Static chain proven', 'No fleet/test total',
    'human_waits.response_ref', 'operations.prompt_overrides_ref',
    'step_checkpoints.output_ref', 'step_checkpoints.session_ref',
    'tasks.payload_ref', 'operations.input_ref', 'tasks.result_ref',
    'operations.result_ref', 'user alone grants final A2 GO']:
    if marker not in body:
        errors.append('Missing scope marker: ' + marker)
for number, line in enumerate(body.splitlines(), 1):
    if line.rstrip() != line:
        errors.append('Trailing whitespace line %d' % number)
if re.search(r'^\s*[-*] \[[xX]\]', body, re.M):
    errors.append('Unexpected checked task row in receipt')
raw = {}
for name, query in manifest['queries'].items():
    path = ROOT / query['raw']
    digest = sha(path)
    raw[name] = {'sha256': digest, 'matches': query['matches'],
                 'files': query['files'], 'exit': query['exit']}
    if digest != query['raw_sha256']:
        errors.append('Raw scan digest mismatch: ' + name)
drift = []
for name, pin in manifest['source_pins'].items():
    path = ROOT / name
    current = sha(path) if path.is_file() else None
    if current != pin['sha256']:
        drift.append({'path': name, 'intake_sha256': pin['sha256'],
                      'current_sha256': current})
BASE.with_suffix('.source-drift.json').write_text(
    json.dumps({'source_pin_count': len(manifest['source_pins']),
                'changed': drift}, indent=2) + '\n', encoding='utf-8')
git = subprocess.run(['git', 'diff', '--check', '--', str(receipt.relative_to(ROOT))],
                     cwd=ROOT, capture_output=True, text=True)
if git.returncode:
    errors.append('git diff --check failed')
head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT,
                      capture_output=True, text=True).stdout.strip()
result = {'utc': datetime.now(timezone.utc).isoformat(),
          'mode': 'receipt/links/raw hash/source drift only; no live verification',
          'receipt_sha256': sha(receipt), 'head': head,
          'intake_head': manifest['head'], 'links_checked': len(links),
          'links': links, 'raw_scans': raw,
          'source_pin_count': len(manifest['source_pins']),
          'source_drift_count': len(drift),
          'git_diff_check': {'exit': git.returncode, 'stdout': git.stdout,
                             'stderr': git.stderr,
                             'caveat': 'Git ignores untracked receipts; whitespace also checked directly'},
          'errors': errors, 'status': 'PASS' if not errors else 'FAIL'}
BASE.with_suffix('.validation.json').write_text(json.dumps(result, indent=2) + '\n',
                                               encoding='utf-8')
print(json.dumps({k: v for k, v in result.items() if k not in ['links', 'raw_scans']},
                 indent=2))
raise SystemExit(1 if errors else 0)
