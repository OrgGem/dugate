from pathlib import Path
import difflib
import hashlib
import json
import re
import subprocess
import sys
import unicodedata
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'coordination/reports/a8-claim-fix-803-2026-10-05'
DOC = ROOT / 'docs/04-data-state.md'
SNAP = Path(str(BASE)+'.before.md')
OLD = '- **Cột TEXT:** `result_ref` là cột text (0001) — envelope được bọc dạng **JSON text** (cùng convention `input_ref`), không phải object thô; reader dùng `readStoredText` và **fail-closed** (`NOT_SEALED`) khi giá trị trông giống envelope mà thiếu seam/không mở được.'
NEW = '- **Cột TEXT:** `result_ref` là cột text (0001) — envelope được bọc dạng **JSON text** (cùng convention `input_ref`), không phải object thô; trong backfill window hiện tại, cả 4 call-site của `readStoredText` truyền `allowPlaintext=true`: reader mở được sealed envelope khi có seam phù hợp và đọc legacy plaintext verbatim (best-effort); legacy rows vẫn plaintext-readable. Fail-closed `NOT_SEALED` chỉ có hiệu lực sau window switch (A3/A2), chưa được enforce ở các call-site hiện tại (A8).'

if '--apply' in sys.argv:
    if SNAP.exists():
        raise SystemExit('Intake snapshot exists; refuse repeat mutation.')
    old = DOC.read_bytes()
    if old.count(OLD.encode('utf-8')) != 1:
        raise SystemExit('Expected exactly one old claim.')
    SNAP.write_bytes(old)
    DOC.write_bytes(old.replace(OLD.encode('utf-8'), NEW.encode('utf-8'), 1))
    print('Replaced exactly one claim; all other bytes preserved.')
    raise SystemExit(0)

old = SNAP.read_bytes()
current = DOC.read_bytes()
errors = []
if current != old.replace(OLD.encode('utf-8'), NEW.encode('utf-8'), 1):
    errors.append('Change differs from the single authorized claim replacement.')
if re.findall(rb'\[[ xX~]\]', old) != re.findall(rb'\[[ xX~]\]', current):
    errors.append('Checkbox vector changed.')
if 'at-rest encrypted' in NEW:
    errors.append('Forbidden encryption claim in replacement.')

def anchors(path):
    text = path.read_text(encoding='utf-8-sig')
    result = set()
    used = {}
    for heading in re.findall(r'^#{1,6}\s+(.+?)\s*#*$', text, flags=re.M):
        heading = re.sub(r'<[^>]+>', '', heading).lower()
        slug = ''.join(ch for ch in heading if ch in '-_ ' or unicodedata.category(ch)[0] in 'LN').replace(' ', '-')
        n = used.get(slug, 0)
        used[slug] = n+1
        result.add(slug if n == 0 else slug+'-'+str(n))
    result.update(re.findall(r'(?:id|name)=["\']([^"\']+)', text))
    return result

links_checked = 0
anchors_checked = 0
line_refs_checked = 0
for target in re.findall(r'\]\(([^)]+)\)', current.decode('utf-8')):
    target = target.split(' "', 1)[0].strip('<>')
    if re.match(r'^[a-zA-Z]+:', target):
        continue
    path, _, fragment = unquote(target).partition('#')
    dest = (DOC.parent / path).resolve() if path else DOC
    links_checked += 1
    if not dest.is_file():
        errors.append('Missing local link: '+target)
    elif fragment:
        anchors_checked += 1
        line_ref = re.fullmatch(r'L(\d+)(?:-L(\d+))?', fragment)
        if line_ref:
            line_refs_checked += 1
            start = int(line_ref.group(1))
            end = int(line_ref.group(2) or start)
            if not 1 <= start <= end <= len(dest.read_text(encoding='utf-8-sig').splitlines()):
                errors.append('Out-of-range line reference: '+target)
        elif fragment not in anchors(dest):
            errors.append('Missing anchor: '+target)
oldhead = re.findall(rb'^#{1,6} .+$', old, flags=re.M)
newhead = re.findall(rb'^#{1,6} .+$', current, flags=re.M)
if oldhead != newhead:
    errors.append('Headings/anchor definitions changed.')
literal = ''.join(difflib.unified_diff(old.decode('utf-8').splitlines(keepends=True), current.decode('utf-8').splitlines(keepends=True), fromfile=SNAP.relative_to(ROOT).as_posix(), tofile=DOC.relative_to(ROOT).as_posix()))
Path(str(BASE)+'.literal.diff').write_text(literal, encoding='utf-8', newline='')
run = subprocess.run(['git', 'diff', '--check', '--', 'docs/04-data-state.md'], cwd=ROOT, capture_output=True)
Path(str(BASE)+'.diff-check.raw.txt').write_text('command: git diff --check -- docs/04-data-state.md\nexit: '+str(run.returncode)+'\nstdout:\n'+run.stdout.decode('utf-8', errors='replace')+'\nstderr:\n'+run.stderr.decode('utf-8', errors='replace'), encoding='utf-8')
if run.returncode:
    errors.append('git diff --check exit '+str(run.returncode))
pins = {'before_sha256': hashlib.sha256(old).hexdigest(), 'after_sha256': hashlib.sha256(current).hexdigest(), 'literal_diff_sha256': hashlib.sha256(Path(str(BASE)+'.literal.diff').read_bytes()).hexdigest()}
Path(str(BASE)+'.post-pins.json').write_text(json.dumps(pins, indent=2)+'\n', encoding='utf-8')
result = {'file': 'docs/04-data-state.md', 'single_claim_only': current == old.replace(OLD.encode('utf-8'), NEW.encode('utf-8'), 1), 'checkbox_changes': 0, 'headings_unchanged': oldhead == newhead, 'local_links_checked': links_checked, 'link_fragments_checked': anchors_checked, 'line_reference_fragments_checked': line_refs_checked, 'heading_definitions_checked': len(newhead), 'diff_check_exit': run.returncode, 'errors': errors}
Path(str(BASE)+'.validation.raw.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
print(json.dumps(result, indent=2))
sys.exit(1 if errors else 0)
