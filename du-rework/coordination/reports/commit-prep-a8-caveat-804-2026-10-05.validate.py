from pathlib import Path
import difflib
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT/'coordination/reports/commit-prep-a8-caveat-804-2026-10-05'
DOC = ROOT/'coordination/reports/commit-prep-803-2026-10-05.md'
SNAP = Path(str(BASE)+'.before.md')
WARNING = '**A8 / REVIEW-803 mục 5:** encryption best-effort trong backfill window, legacy rows vẫn plaintext-readable; tuyệt đối không claim at-rest encrypted tới khi PRE-SWITCH mục 3 hoàn tất.'
UI = 'Docs CSRF fix + UI_APPROVED đã đóng blocker UI theo coordinator (build index-BZ2-Edjb.js /2296c26628f4a454); verdict Bs0p8VRI là lịch sử. c4 mở lại để xét scope sau fix/review, nhưng actual live identity/tenant/session/CAS và mọi live condition vẫn còn; quyết định GO chưa đổi, vẫn cần user go/no-go.'

def update(before):
    text = before.decode('utf-8')
    lines = text.splitlines(keepends=True)
    found = set()
    for i,line in enumerate(lines):
        ending = '\r\n' if line.endswith('\r\n') else '\n' if line.endswith('\n') else ''
        if line.startswith('| **c3 claim/P2**'):
            lines[i] = line.rstrip('\r\n').rsplit(' |',1)[0]+' '+WARNING+' |'+ending
            found.add('c3')
        elif line.startswith('| **c4 W3 atomic backend**'):
            line = line.replace('**docs CHANGES_REQUIRED**.', '**docs CHANGES_REQUIRED tại snapshot cũ**; '+UI+'.')
            line = line.replace('Docs fix đợi SETTINGS-WIRE-BASE receipt; current combined UI-inclusive scope HOLD tới missing CSRF fix+re-review.', 'Docs CSRF fix + fresh UI_APPROVED đã mở lại UI scope; live conditions và user GO vẫn giữ nguyên.')
            lines[i] = line
            found.add('c4')
        elif line.startswith('## 4. Delta wave802'):
            lines[i] = line+ending+WARNING+ending+ending+'Cập nhật c4: '+UI+ending
            found.add('section4')
        elif line.startswith('ENCMETA/ENC09 store optional window guard'):
            lines[i] = line.rstrip('\r\n')+' '+WARNING+ending
            found.add('line72')
        elif line.startswith('6. Backend-only c4'):
            lines[i] = line.replace('UI-inclusive AWEB/docs phải đợi CSRF actual POST/header test và fresh exact-build verdict.', 'UI-inclusive AWEB/docs đã có CSRF fix + UI_APPROVED theo coordinator; các điều kiện actual live POST/identity/tenant và user GO vẫn còn, không tự cấp GO.')
            found.add('checklist_c4')
    if found != {'c3','c4','section4','line72','checklist_c4'}:
        raise ValueError('Expected exact five update sites: '+str(found))
    return ''.join(lines).encode('utf-8')

if '--apply' in sys.argv:
    if SNAP.exists():
        raise SystemExit('Refuse repeat mutation; snapshot exists.')
    before = DOC.read_bytes()
    after = update(before)
    SNAP.write_bytes(before)
    DOC.write_bytes(after)
    print('Applied three A8 warnings and consistent c4 status updates.')
    raise SystemExit(0)

before = SNAP.read_bytes()
after = DOC.read_bytes()
errors = []
if after != update(before):
    errors.append('Unexpected change outside authorized replacements')
if re.findall(rb'\[[ xX~]\]',before) != re.findall(rb'\[[ xX~]\]',after):
    errors.append('Checkbox changes')
if after.decode('utf-8').count(WARNING) != 3:
    errors.append('Expected three A8 warnings')
oldrows = re.findall(rb'^\| \*\*c[1-6].*$',before,re.M)
newrows = re.findall(rb'^\| \*\*c[1-6].*$',after,re.M)
if len(oldrows)!=6 or len(newrows)!=6:
    errors.append('Six group rows missing')
for n in [0,1,4,5]:
    if oldrows[n] != newrows[n]:
        errors.append('Unrelated group row changed')
oldheaders = re.findall(rb'^#+ .*$',before,re.M)
if oldheaders != re.findall(rb'^#+ .*$',after,re.M):
    errors.append('Heading/anchor definitions changed')
links = re.findall(r'\]\(([^\s)]+)\)',after.decode('utf-8'))
for target in links:
    path, _, fragment = target.partition('#')
    dest = (DOC.parent/path).resolve() if path else DOC
    if not dest.is_file():
        errors.append('Missing link '+target)
    elif fragment:
        headings = [re.sub(r'[^\w\- ]','',h.lower()).replace(' ','-') for h in re.findall(r'^#+\s+(.+)$',dest.read_text(encoding='utf-8-sig'),re.M)]
        if fragment not in headings:
            errors.append('Missing anchor '+target)
literal = ''.join(difflib.unified_diff(before.decode('utf-8').splitlines(keepends=True),after.decode('utf-8').splitlines(keepends=True),fromfile=SNAP.relative_to(ROOT).as_posix(),tofile=DOC.relative_to(ROOT).as_posix()))
Path(str(BASE)+'.literal.diff').write_text(literal,encoding='utf-8',newline='')
run = subprocess.run(['git','diff','--check','--',DOC.relative_to(ROOT).as_posix()],cwd=ROOT,capture_output=True)
Path(str(BASE)+'.diff-check.raw.txt').write_text('git diff --check exit '+str(run.returncode)+'\n'+run.stdout.decode('utf-8',errors='replace')+run.stderr.decode('utf-8',errors='replace'),encoding='utf-8')
if run.returncode:
    errors.append('diff-check nonzero')
pins = {'before_sha256':hashlib.sha256(before).hexdigest(),'after_sha256':hashlib.sha256(after).hexdigest()}
Path(str(BASE)+'.post-pins.json').write_text(json.dumps(pins,indent=2)+'\n',encoding='utf-8')
result = {'scope':'document-only, no GO decision/checkbox/source/commit change','authorized_replacements_only':after==update(before),'A8_warning_sites':3,'six_group_rows':len(newrows),'local_links_checked':len(links),'anchors_checked':sum('#' in t for t in links),'headings_unchanged':oldheaders==re.findall(rb'^#+ .*$',after,re.M),'diff_check_exit':run.returncode,'errors':errors}
Path(str(BASE)+'.validation.raw.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result,indent=2))
sys.exit(1 if errors else 0)
