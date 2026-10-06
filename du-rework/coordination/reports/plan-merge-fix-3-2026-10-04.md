# PLAN-MERGE-FIX-3 — L2 parent-doc sweep — 2026-10-04

**Owner:** codex_arch / plan editor. **Run:** `run_069ecd6957cd`; **task:** `task_03a10d6224a3`; **dispatch:** `ctx_e34c5df6e379`. [Spec](../dispatch-specs/2026-10-04-2010-PLAN-MERGE-FIX-3.md) là quyết định coordinator **sweep tiếp**, không alias-note, sau refresh 741–745. [L2-recheck](l2-closure-recheck-2026-10-04.md#2-residual-suite-wide--ngoài-scope-cần-quyết-định) ghi 58 residual tokens ở bốn parent docs; receipt này supersede trạng thái residual của snapshot đó, không sửa receipt lịch sử hoặc product status.

## 1. Delta applied

| Target | Bare numeric tokens trước → sau | Delta |
|---|---:|---|
| [ORCHESTRATOR-LEGACY-FEATURE-PARITY](../../tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md) | 27 → 0 | Parent/dependency references |
| [ORCH-PAR-00-INVENTORY-SURVEY](../../tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md) | 15 → 0 | Inventory/journey/dependency references |
| [ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES](../../tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md) | 13 → 0 | Policy/consumer/gate/handoff references |
| [ADMIN-CONTROL-PLANE-UI](../../tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md) | 3 → 0 | Profile/Connector references |

Regex `(?<!ORCH-)PAR-\d+` → `ORCH-` + matched token; **58/58 canonicalized**. Không đổi `PAR-XA-*`, `PAR-M*`, `PAR00-*`, existing `ORCH-PAR-*`, task definitions, canonical headings, line counts hoặc checkbox sequence. Không thêm alias-note. Gate/config/continuity/route/retire choices giữ nguyên; không source/test/ledger edits, tick hoặc commit/push. Các nhận định runtime/dispatch và residual trong receipts cũ vẫn là lịch sử tại timestamp đó.

## 2. Verification

CWD `D:\Git\dugate\du-rework`; verification **2026-10-04 20:17:19 +07**. Naming scan phủ **44 docs**: tất cả `tasks/*.md` + `coordination/COORDINATION-TOPOLOGY.md`; **suite-wide bare = 0**. Receipts lịch sử/specs/source không tính. Link/anchor/IDs/17-key validator phủ **19 docs** (suite kiểm trước + bốn parent docs + receipt mới), không claim link/ID scan trên mọi task file. Literal stdout:

```text
{"docs_checked": 19, "local_links_checked": 263, "anchors_checked": 18, "task_definitions": 78, "duplicate_task_definitions": 0, "acyclic_mermaid_graphs": 2, "legacy_settings": 17, "CFGADM_open_rows": 12, "P730_open_rows": 6, "WTV_receipt_refs": 7, "AWEB_appended_receipts": 5, "checkboxes_unchanged": 4, "backlog_cycles": [741, 742, 743, 744, 745], "N1_N4_delta": "APPLIED", "L2_remainder": {"tasks/README.md": 0, "tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md": 0, "tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md": 0, "tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md": 0}, "PAR_XA_preserved": {"LPG": 1, "ORCH_CONFIG": 5}, "Q1_Q2_Q3_pointers": 2, "suite_bare_docs_scanned": 44, "suite_bare_tokens": 0, "suite_bare_matches": {}, "canonical_headings_unchanged": 4, "line_counts_unchanged": 4, "errors": []}
ExitCode=0
```

Scoped command:

```powershell
git -c core.autocrlf=false -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check -- tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md coordination/reports/plan-merge-fix-3-2026-10-04.md
```

Literal stdout/stderr **empty**, **ExitCode=0**. Git kiểm tracked diff; Python kiểm whitespace trực tiếp cả 19 docs, bao gồm untracked. Anchor checks dùng heading slug/line-count, không render GitHub; external URLs không fetch. Definitions scan gồm ORCH-PAR/ACUI numeric task rows, không nhận MISMATCH/journey references thành tasks.

Pre-write literal:

```text
MTIME_HASH_GUARD=PASS files=4; CHECKBOX_GUARD=PASS files=4; PAR_XA_GUARD=PASS; HEADINGS_GUARD=PASS; LINE_COUNT_GUARD=PASS
```

Guards dùng mtime_ns decimal string + SHA-256 trước chuẩn bị delta và trước mỗi write; canonical headings, line counts, PAR-XA sequences và checkbox sequence **4/4 unchanged**. Không double prefix ORCH-ORCH. Không product/build/browser/live/DB tests; không source/test/ledger edits, tick hoặc commit/push. Kết quả **L2 applied/self-check clean** không là independent reviewer verdict hoặc product acceptance. Các holds/user decisions và receipt lịch sử giữ nguyên.

Post-delta pins; final extraction validator/scoped diff và post-receipt pin guard chạy lại sau receipt hoàn chỉnh:

| File | mtime_ns | SHA-256 |
|---|---|---|
| `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md` | `1791119687299090400` | `0974421d6d16cb72fe023bfb9cccb06e065343104af96f55d7d3a993f05c6813` |
| `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` | `1791119687299090400` | `2e736c9ca0b2253713d7ac21b7d42481e5b0a7f91b7a7135909ae94157cab5b6` |
| `tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md` | `1791119687300089700` | `4ce895eb8ce58c98965edddccc106adfa39c2130a9f7bd486127f302e587f7c8` |
| `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md` | `1791119687300089700` | `bca708f559b395217970af7a75f99630882ac4413d19f838c58c1944c67f6ffa` |

Receipt không chứa self-hash.


## 3. Reproducible read-only validator

```powershell
$planReceipt = Get-Content -Raw -Encoding UTF8 coordination/reports/plan-merge-fix-3-2026-10-04.md
$planValidator = [regex]::Match($planReceipt, '(?s)```python\r?\n(.*?)\r?\n```').Groups[1].Value
$planValidator | python -
```

```python
from pathlib import Path
from urllib.parse import unquote
import re,json,hashlib,sys
sys.stdout.reconfigure(encoding='utf-8')
root=Path('D:/Git/dugate/du-rework')
baseline=json.loads(r'''{"tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md":{"mtime_ns":"1791112789011859300","sha256":"281659f6d9f6858d9beb6fd3ea0c97056c223cd2e3b717311672320c800a2ab4","checkboxes":["[ ]","[x]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]"],"PAR_XA":["PAR-XA-04"],"bare_tokens":27,"headings":["# Orchestrator feature parity v\u1edbi DUGate c\u0169","## Nguy\u00ean t\u1eafc \u0111\u1ed1i chi\u1ebfu","## Ma tr\u1eadn legacy \u2192 rework","## MISMATCH c\u1ea7n kh\u00f3a tr\u01b0\u1edbc implementation","## Backlog theo ph\u1ee5 thu\u1ed9c","## Th\u1ee9 t\u1ef1 v\u00e0 cutover"],"line_count":65},"tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md":{"mtime_ns":"1791112789011859300","sha256":"14253ecc438c962a2cc1afd678dc8150aaf1fbc22eb0af3f4947c50b4c7fd806","checkboxes":["[ ]"],"PAR_XA":[],"bare_tokens":15,"headings":["# ORCH-PAR-00 \u2014 kh\u1ea3o s\u00e1t read-only Admin/control-plane cho cutover","## Scope v\u00e0 ph\u01b0\u01a1ng ph\u00e1p","## Inventory source hi\u1ec7n t\u1ea1i","## T\u1eadp con t\u1ed1i thi\u1ec3u \u0111\u1ec1 xu\u1ea5t tr\u01b0\u1edbc cutover","## Conditional/post-cutover ho\u1eb7c retire c\u00f3 ch\u1ee7 \u0111\u00edch","## MISMATCH v\u00e0 quy\u1ebft \u0111\u1ecbnh c\u1ea7n kh\u00f3a","## Dependency register c\u1ea7n Product k\u00fd (ch\u01b0a c\u00f3 consumer IDs)"],"line_count":70},"tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md":{"mtime_ns":"1791112789012859800","sha256":"1d4d05c496e1267617d7283eb4e81e5710597c071848e7ed234c9f5e2a5556ff","checkboxes":["[ ]"],"PAR_XA":["PAR-XA-01..05","PAR-XA-01","PAR-XA-02","PAR-XA-03","PAR-XA-04","PAR-XA-05","PAR-XA-01","PAR-XA-02","PAR-XA-03","PAR-XA-04","PAR-XA-05"],"bare_tokens":13,"headings":["# Contract ranh gi\u1edbi Orchestrator parity \u2194 legacy API compatibility","## Quy t\u1eafc chung","## `PAR-XA-01` \u2014 OpenAPI v\u00e0 docs portal","## `PAR-XA-02` \u2014 Hai lo\u1ea1i test v\u00e0 evidence","## `PAR-XA-03` \u2014 Profile locked-field policy m\u1ed9t l\u1ea7n duy nh\u1ea5t","## `PAR-XA-04` \u2014 Gate dependency kh\u00f4ng \u0111\u1ed5i ng\u1ea7m","## `PAR-XA-05` \u2014 Inventory m\u1ed9t chi\u1ec1u, kh\u00f4ng hai route matrix","## Handoff v\u00e0 \u0111i\u1ec1u ki\u1ec7n \u0111\u00f3ng c\u00e1c finding"],"line_count":73},"tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md":{"mtime_ns":"1791112657497585500","sha256":"c88f7d00dc8b9766db5c22b559291e5288b8f240eeefcf7e8752967fdcd827ad","checkboxes":["[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]"],"PAR_XA":[],"bare_tokens":3,"headings":["# Admin UI cho to\u00e0n b\u1ed9 c\u1ea5u h\u00ecnh Orchestrator \u2014 review v\u00e0 backlog (2026-10-02)","## Ti\u1ebfn \u0111\u1ed9 tri\u1ec3n khai 2026-10-02","## K\u1ebft qu\u1ea3 review UI/source hi\u1ec7n t\u1ea1i","## Nguy\u00ean t\u1eafc c\u1ea5u h\u00ecnh chung","## Backlog t\u00ednh n\u0103ng UI v\u00e0 API","## Th\u1ee9 t\u1ef1 tri\u1ec3n khai"],"line_count":58}}''')
paths=[root/name for name in ["tasks/README.md","tasks/PLAN-COMPLETION-2026-10-04.md","tasks/ADMIN-WEB-DELIVERY-2026-10-04.md","tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md","tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md","coordination/COORDINATION-TOPOLOGY.md","tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md","tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md","tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md","coordination/reports/plan-review-730-2026-10-04.md","coordination/reports/plan-merge-fix-2026-10-04.md","coordination/reports/plan-refresh-736-740-2026-10-04.md","coordination/reports/plan-merge-fix-2-2026-10-04.md","coordination/reports/plan-refresh-741-745-2026-10-04.md","tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md","tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md","tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md","tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md","coordination/reports/plan-merge-fix-3-2026-10-04.md"]]
problems=[];links=0;anchors=0;graphs=0;definitions={}
def slug(heading):
 return re.sub(r'[^\w\- ]','',heading.lower()).replace(' ','-')
for p in paths:
 content=p.read_text(encoding='utf-8-sig')
 for i,line in enumerate(content.splitlines(),1):
  if line.rstrip()!=line:problems.append('trailing whitespace '+p.name+':'+str(i))
 for target in re.findall(r'\]\(([^\s)]+)\)',content):
  target=target.strip('<>')
  if target.startswith(('http:','https:','app:','file:')):continue
  name,sep,fragment=target.partition('#')
  dest=(p.parent/unquote(name)).resolve() if name else p
  if re.match(r'^[A-Za-z]:/',name):dest=Path(name)
  links+=1
  if not dest.exists():problems.append('broken '+p.name+': '+target);continue
  if sep:
   anchors+=1
   text=dest.read_text(encoding='utf-8-sig')
   if re.fullmatch(r'L\d+',fragment):
    if int(fragment[1:])>len(text.splitlines()):problems.append('bad line anchor '+target)
   else:
    found=[slug(h) for h in re.findall(r'^#+\s+(.+)$',text,re.M)]
    if unquote(fragment) not in found:problems.append('bad heading anchor '+p.name+': '+target)
 for task in re.findall(r'^\| ((?:PLAN04-\d{2}|CONT-\d{2}|P730-[A-Z-]+|ORCH-PAR-\d{2}|ACUI-\d{2}|CFGADM-\d{2}|WTV-\d{2})) `\[[ x~]\]`',content,re.M):
  definitions.setdefault(task,[]).append(p.name)
 for task in re.findall(r'^\| `(ACUI-\d{2})` `\[[ x~]\]`',content,re.M):
  definitions.setdefault(task,[]).append(p.name)
 for task in re.findall(r'^## (ORCH-(?:PAR|LPG)-\d{2})[^\n]*`\[[ x~]\]`',content,re.M):
  definitions.setdefault(task,[]).append(p.name)
 for task in re.findall(r'^\| `(AWEB-\d{2})` \|',content,re.M):
  definitions.setdefault(task,[]).append(p.name)
 for graph in re.findall(r'```mermaid\s*\n(.*?)```',content,re.S):
  graphs+=1;adj={}
  for a,b in re.findall(r'^\s*(\w+)(?:\[[^\n]*?\])?\s*-->\s*(\w+)',graph,re.M):adj.setdefault(a,set()).add(b)
  visited=set();stack=set()
  def visit(n):
   if n in stack:raise ValueError('cycle')
   if n in visited:return
   stack.add(n)
   for m in adj.get(n,[]):visit(m)
   stack.remove(n);visited.add(n)
  try:
   for node in adj:visit(node)
  except ValueError:problems.append('graph cycle '+p.name)
duplicates={k:v for k,v in definitions.items() if len(v)>1}
if duplicates:problems.append('duplicate task definitions '+json.dumps(duplicates))
cfg=(root/'tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md').read_text(encoding='utf-8')
section=cfg.split('## 3.')[1].split('## 4.')[0]
keys=re.findall(r'^\| `([a-z0-9_]+)` \|',section,re.M)
expected='ai_provider ai_api_key ai_model ai_image_prompt ai_pdf_prompt ai_docx_prompt ai_compare_prompt ai_generate_prompt openai_api_key openai_base_url api_secret_key s3_endpoint s3_bucket s3_access_key s3_secret_key s3_region s3_cache_ttl_hours'.split()
if len(keys)!=17 or set(keys)!=set(expected):problems.append('17-key map mismatch')
cfgrows=re.findall(r'^\| (CFGADM-\d{2}) `\[ \]`',cfg,re.M)
plan=(root/'tasks/PLAN-COMPLETION-2026-10-04.md').read_text(encoding='utf-8-sig')
p730=re.findall(r'^\| (P730-[A-Z-]+) `\[ \]`',plan,re.M)
if len(cfgrows)!=12 or len(p730)!=6:problems.append('CFGADM/P730 open rows mismatch')
for name,pin in baseline.items():
 s=(root/name).read_text(encoding='utf-8-sig')
 if re.findall(r'\[[ x~]\]',s)!=pin['checkboxes']:problems.append('checkbox changed '+name)
for name in ['PLAN-COMPLETION-2026-10-04.md','ADMIN-WEB-DELIVERY-2026-10-04.md','ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md']:
 if re.search(r'(?<![\w-])PAR-\d',(root/'tasks'/name).read_text(encoding='utf-8-sig')):problems.append('noncanonical PAR '+name)
wtv=(root/'tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md').read_text(encoding='utf-8-sig')
wtvrefs=re.findall(r'\]\(\.\./coordination/reports/(wtv\d{2}[a-z]?[^)]+)\)',wtv)
if len(wtvrefs)!=7 or '9 file test' in wtv:problems.append('WTV refs/count mismatch')
aweb=(root/'tasks/ADMIN-WEB-DELIVERY-2026-10-04.md').read_text(encoding='utf-8-sig')
lognames=['aweb04-wire-conformance','profile-phase1-verify','fpp1-closure-verify','aweb08-docs-ux-pointer','aweb08-legacy-inventory']
if any(aweb.count(']('+ '../coordination/reports/'+n+'-2026-10-04.md)')!=1 for n in lognames):problems.append('AWEB log refs mismatch')
if '\u0394-DEV-03 pending user decision' not in aweb:problems.append('route decision not explicitly pending')
for row in ['CONT-01','CONT-04']:
 line=next(l for l in plan.splitlines() if l.startswith('| '+row+' '))
 if 'CFGADM' not in line:problems.append('CONT scope not folded '+row)
live=(root/'tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md').read_text(encoding='utf-8-sig')
if 'Connector (`:8081`)' in live or 'Connector `:8081`' in live:problems.append('stale active Connector port')
if 'CFGADM[CFGADM' not in (root/'tasks/README.md').read_text(encoding='utf-8-sig'):problems.append('CFGADM graph missing')
readme=(root/'tasks/README.md').read_text(encoding='utf-8-sig')
if 'Legacy parity gaps / LPG holds' not in readme:problems.append('N1 missing LPG notice')
if 'LPG[ORCH-LPG-01/02' not in readme:problems.append('N3 missing LPG graph node')
boundary=readme.split('## Release boundary')[1]
if 'CFGADM-00..11' not in boundary or 'required' not in boundary:problems.append('N4 missing CFGADM release boundary')
sec7=plan.split('## 7.')[1].split('## 8.')[0]
if '5/6' not in sec7 or '5/6' not in readme:problems.append('N2 dispatch metadata stale')
if '## 8. Checkpoint 735' not in plan:problems.append('backlog section missing')
for cycle in range(741,746):
 if not re.search(r'^\| '+str(cycle)+r' \|',plan,re.M):problems.append('missing backlog cycle '+str(cycle))
receipt=(root/'coordination/reports/plan-refresh-736-740-2026-10-04.md').read_text(encoding='utf-8-sig')
for required in ['task_f0014eff828a','SDK-CONSUME','UI-INTEGRATE','WTV-07','USER-GATED','W2-B','N1','N2','N3','N4']:
 if required not in receipt:problems.append('receipt omission '+required)
l2files=['tasks/README.md','tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md','tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md','tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md']
l2remaining={name:len(re.findall(r'(?<!ORCH-)PAR-\d+',(root/name).read_text(encoding='utf-8-sig'))) for name in l2files}
if any(l2remaining.values()):problems.append('L2 remainder not zero')
for name,pin in baseline.items():
 if re.findall(r'PAR-XA-[\w./-]+',(root/name).read_text(encoding='utf-8-sig'))!=pin['PAR_XA']:problems.append('PAR-XA drift '+name)
readonly_pin=json.loads(r'''{"mtime_ns":"1791115337338853000","sha256":"e35edb80e2ee620deb7374ee30b88e3ea71b0ad17f0015bf8f8b1fd33fd3ec48","PAR_XA":["PAR-XA-01..05","PAR-XA-03","PAR-XA-03","PAR-XA-01","PAR-XA-02"]}''')
orchconfig=root/'tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md'
if hashlib.sha256(orchconfig.read_bytes()).hexdigest()!=readonly_pin['sha256'] or str(orchconfig.stat().st_mtime_ns)!=readonly_pin['mtime_ns']:problems.append('ORCH-CONFIG readonly pin drift')
if re.findall(r'PAR-XA-[\w./-]+',orchconfig.read_text(encoding='utf-8-sig'))!=readonly_pin['PAR_XA']:problems.append('ORCH-CONFIG PAR-XA drift')
for name in ['tasks/ADMIN-WEB-DELIVERY-2026-10-04.md','tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md']:
 content=(root/name).read_text(encoding='utf-8-sig')
 note=next((line for line in content.splitlines() if line.startswith('> **CURL Q1/Q2/Q3')), '')
 for text in ['Q1','fail-closed','Q2','heuristic','mask/unmask','Q3','onApply','accept-only','UI-INTEGRATE','INTEGRATION_PENDING','/admin/workflows','curl-ui-review-2026-10-04.md']:
  if text not in note:problems.append('CURL accepted pointer missing '+name+' '+text)
current=plan.split('## 9. Checkpoint 740')[1] if '## 9. Checkpoint 740' in plan else ''
if not current:problems.append('checkpoint 740/current backlog missing')
for text in ['(b) MET 19:30','P2-FIX','11/11','DD-05','MEDIUM-1','MEDIUM-2','Part 2','mask/unmask','SKIP','LIVE-READY-PREP2','WTV-07','58','server']:
 if text not in current:problems.append('current status omission '+text)
currentreceipt=(root/'coordination/reports/plan-refresh-741-745-2026-10-04.md').read_text(encoding='utf-8-sig')
for text in ['task_5766b4f2482a','ctx_e2e74c2c6dc9','task_6d21a84909fd','(b) MET 19:30','W1c','11/11','MEDIUM-1','DD-05','LIVE-READY-PREP2','58 bare tokens','pending','user-gated']:
 if text not in currentreceipt:problems.append('current receipt omission '+text)
if 'Current checkpoint 740' not in (root/'coordination/COORDINATION-TOPOLOGY.md').read_text(encoding='utf-8-sig'):problems.append('current topology notice missing')
suite_paths=sorted((root/'tasks').glob('*.md'))+[root/'coordination/COORDINATION-TOPOLOGY.md']
suite_bare={str(p.relative_to(root)):len(re.findall(r'(?<!ORCH-)PAR-\d+',p.read_text(encoding='utf-8-sig'))) for p in suite_paths}
suite_bare={k:v for k,v in suite_bare.items() if v}
if suite_bare:problems.append('suite-wide bare PAR remainder '+json.dumps(suite_bare))
for name,pin in baseline.items():
 content=(root/name).read_text(encoding='utf-8-sig')
 if re.findall(r'^#+ .+$',content,re.M)!=pin['headings']:problems.append('canonical headings changed '+name)
 if len(content.splitlines())!=pin['line_count']:problems.append('line count changed '+name)
 if 'ORCH-ORCH-' in content:problems.append('double-prefix '+name)
summary={'docs_checked':len(paths),'local_links_checked':links,'anchors_checked':anchors,'task_definitions':len(definitions),'duplicate_task_definitions':len(duplicates),'acyclic_mermaid_graphs':graphs,'legacy_settings':len(keys),'CFGADM_open_rows':len(cfgrows),'P730_open_rows':len(p730),'WTV_receipt_refs':len(wtvrefs),'AWEB_appended_receipts':len(lognames),'checkboxes_unchanged':len(baseline),'backlog_cycles':[741,742,743,744,745],'N1_N4_delta':'APPLIED' if not problems else 'CHECK_ERRORS','L2_remainder':l2remaining,'PAR_XA_preserved':{'LPG':1,'ORCH_CONFIG':len(readonly_pin['PAR_XA'])},'Q1_Q2_Q3_pointers':2,'suite_bare_docs_scanned':len(suite_paths),'suite_bare_tokens':sum(suite_bare.values()),'suite_bare_matches':suite_bare,'canonical_headings_unchanged':len(baseline),'line_counts_unchanged':len(baseline),'errors':problems}
print(json.dumps(summary,ensure_ascii=True))
raise SystemExit(bool(problems))
```
