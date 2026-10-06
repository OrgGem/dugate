# PLAN-MERGE-FIX-2 — doc-only — 2026-10-04

**Owner:** codex_arch / plan editor. **Run:** `run_069ecd6957cd`; **task:** `task_b29ad0ac15b9`; **dispatch:** `ctx_583ba610d5c1`. [Dispatch spec](../dispatch-specs/2026-10-04-1945-PLAN-MERGE-FIX-2.md) cho phép naming sweep bốn file và CURL decision pointers AWEB/CFGADM. Không source/test/ledger/dispatch edits, tick task/gate hoặc commit/push.

## 1. L2 sweep applied

Chọn **canonical rename**, không thêm alias-note: cùng task dùng một prefix `ORCH-PAR-##` để không nhầm thành task/register khác. Regex `(?<!ORCH-)PAR-\d+` chỉ đổi bare numeric references, giữ `PAR-XA-*`, `ORCH-PAR-*`, PAR namespace prose và shorthand `/15` trong cùng group. [cc_1 delta-2](plan-graph-delta-2-2026-10-04.md#3-l2-remainder--verdict) là input lịch sử, không sửa receipt reviewer.

| File | Bare lines trước → sau | Tokens đổi | Delta |
|---|---:|---:|---|
| [README](../../tasks/README.md) | 3 → 0 | 4 | Field-level link label, ORCH-PAR-00 dependency và phase row; một dòng có hai bare tokens |
| [WTV](../../tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md) | 1 → 0 | 1 | Field-level link label |
| [CFGADM](../../tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md) | 25 → 0 | 25 | Scope/inventory/parent/dependency references; 17-key map và 12 open rows giữ nguyên |
| [LPG](../../tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md) | 4 → 0 | 4 | Parent/dependency references; decision/lease holds giữ nguyên |

Tổng **33 dòng / 34 tokens**; AWEB không có bare numeric PAR trước/sau, chỉ cập nhật CURL pointers. ORCH-CONFIG read-only, giữ nguyên năm `PAR-XA-*` references; LPG giữ một `PAR-XA-01..05` reference. Không fork/rename task IDs, không tạo row mới.

## 2. CURL decisions đã được coordinator chấp nhận

[curl-ui-review](curl-ui-review-2026-10-04.md#5-kết-luận) đề xuất Q1/Q2/Q3; coordinator chấp nhận lúc **19:45** theo packet/user và dispatch spec. Đã đưa notice vào AWEB/CFGADM, re-anchor snapshot 735 từng ghi OPEN và append decision row AWEB; history row OPEN ở snapshot 19:20 vẫn giữ, được notice/row mới supersede.

| Question | Contract được chấp nhận / handoff UI-INTEGRATE |
|---|---|
| Q1 | Fail-closed malformed/missing flags, unsupported method/URL, command substitution; harmless ignored flags giữ notes/warning |
| Q2 | Giữ heuristic auto-mask; **bổ sung per-form-field toggle mask/unmask** để operator đánh dấu unknown-name secret trước Apply. Raw header values luôn ẩn trong preview; không coi heuristic nhận diện được mọi secret |
| Q3 | `onApply` **accept-only**, đưa transient in-memory draft vào editable parent form; không autosave/network/backend mutation/browser storage |

Quyết định contract không chứng minh toggle đã được code, browser chạy hoặc route đã được duyệt. Reviewer verdict vẫn **COMPONENT_SPEC_VERIFIED / INTEGRATION_PENDING**, **không UI_APPROVED**. UI-INTEGRATE cần mounted build/browser proof paste→preview→mask/unmask→Apply→form, custom-secret-field và keyboard tests; save/test/activate dùng backend thật. **Δ-DEV-03 `/admin/workflows` tiếp tục user-gated**; không tự quyết router/nav/redirect hoặc product choices khác. Các live, CONT, LPG và WTV-07 holds không đổi trong packet này.

## 3. Verification

CWD `D:\Git\dugate\du-rework`; first verification **2026-10-04 19:45:27 +07**. Read-only Python validator source ở §4; command đọc fenced source từ chính receipt rồi chạy stdin. Literal stdout:

```text
{"docs_checked": 13, "local_links_checked": 210, "anchors_checked": 13, "task_definitions": 56, "duplicate_task_definitions": 0, "acyclic_mermaid_graphs": 2, "legacy_settings": 17, "CFGADM_open_rows": 12, "P730_open_rows": 6, "WTV_receipt_refs": 7, "AWEB_appended_receipts": 5, "checkboxes_unchanged": 5, "backlog_cycles": [736, 737, 738, 739, 740], "N1_N4_delta": "APPLIED", "L2_remainder": {"tasks/README.md": 0, "tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md": 0, "tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md": 0, "tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md": 0}, "PAR_XA_preserved": {"LPG": 1, "ORCH_CONFIG": 5}, "Q1_Q2_Q3_pointers": 2, "errors": []}
ExitCode=0
```

Scoped command:

```powershell
git -c core.autocrlf=false -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check -- tasks/README.md tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md tasks/ADMIN-WEB-DELIVERY-2026-10-04.md coordination/reports/plan-merge-fix-2-2026-10-04.md
```

Literal stdout/stderr **empty**, **ExitCode=0**. Git chỉ kiểm tracked diff; validator cũng kiểm trailing whitespace trực tiếp cho toàn bộ 13 docs, bao gồm untracked files/receipts. External URL không được fetch; anchors kiểm heading slug hoặc line-count, không render GitHub. Task ID scan là definitions trong suite (56, gồm AWEB table), không cộng references thành task mới. Scope 13 docs khác cc_1 10-doc checker; không so chênh lệch link/definition counts như regression.

Pre-write guard literal:

```text
MTIME_HASH_GUARD=PASS files=5; EXACT_REPLACEMENTS=PASS; CHECKBOX_GUARD=PASS files=5; PAR_XA_GUARD=PASS
```

Guard mtime_ns decimal string + SHA-256 chạy trước chuẩn bị delta và trước mỗi write. Checkbox sequence **5/5 unchanged**; `PAR-XA-*` sequences giữ nguyên; ORCH-CONFIG mtime/hash read-only pin không đổi. Product/test/build/browser/live/DB/Redis/S3/Vault không chạy. Không sửa nguồn sản phẩm, test, receipt lịch sử hoặc ledger; không tick task/gate, commit/push. Không gỡ CONT/LPG/WTV-07 hoặc user-gated Δ-DEV-03.

Post-delta pins; final extraction validator/diff-check và post-receipt guard chạy lại sau khi receipt hoàn chỉnh:

| Plan file | mtime_ns | SHA-256 |
|---|---|---|
| `tasks/README.md` | `1791117821940742000` | `f0578f95d2d247c3737241c779297aabb05d393d4bf292b919832b6a1ec762a6` |
| `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` | `1791117821940742000` | `44b205cf1dc8190306fdc85985ba5b509507d9d79e1ce33dfd4693fbdbf576cb` |
| `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` | `1791117821940742000` | `d56b44b0b574157458756feed04889e7fc4937d6791ae81a9fac8cf7250a6ab8` |
| `tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md` | `1791117821940742000` | `39bb68bf26fa1040ba3a7e93c6b55b9b9eecb5282931614234fdd58d68dfffd6` |
| `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` | `1791117821940742000` | `e6bc453023b2cf29362a184ee7bcbda29067b7c5a610c9b3e465b0d008df9f3e` |

ORCH-CONFIG read-only SHA-256: `e35edb80e2ee620deb7374ee30b88e3ea71b0ad17f0015bf8f8b1fd33fd3ec48`. Chính receipt không chứa self-hash.


## 4. Reproducible read-only validator

```powershell
$planReceipt = Get-Content -Raw -Encoding UTF8 coordination/reports/plan-merge-fix-2-2026-10-04.md
$planValidator = [regex]::Match($planReceipt, '(?s)```python\r?\n(.*?)\r?\n```').Groups[1].Value
$planValidator | python -
```

```python
from pathlib import Path
from urllib.parse import unquote
import re,json,hashlib,sys
sys.stdout.reconfigure(encoding='utf-8')
root=Path('D:/Git/dugate/du-rework')
baseline=json.loads(r'''{"tasks/README.md":{"mtime_ns":"1791116763683549700","sha256":"54bb4bb21adb843682a2c07c3e0c90a5ff5ca7458f6c7550a2bc72d2f9f66f52","checkboxes":["[~]","[ ]","[x]","[x]","[~]","[ ]","[~]","[x]","[~]","[ ]","[~]","[x]","[ ]"],"bare_PAR_tokens":4,"bare_PAR_lines":3,"PAR_XA":[]},"tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md":{"mtime_ns":"1791115236316861300","sha256":"301569a528c984557c541399f64bc87ded68f50727fd0d795688d39f274abec4","checkboxes":["[x]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]"],"bare_PAR_tokens":1,"bare_PAR_lines":1,"PAR_XA":[]},"tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md":{"mtime_ns":"1791116763683549700","sha256":"d2bfc168080b2541630fee98165d4a2ed95ac05ebb0fd2fc36c6e86a1cb97743","checkboxes":["[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]","[ ]"],"bare_PAR_tokens":25,"bare_PAR_lines":25,"PAR_XA":[]},"tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md":{"mtime_ns":"1791116763683549700","sha256":"875a5c24453fdf26c9fd7e47c565bf051143a1c13d7f0fe3964f9f50d321f4c6","checkboxes":["[x]","[ ]","[ ]"],"bare_PAR_tokens":4,"bare_PAR_lines":4,"PAR_XA":["PAR-XA-01..05"]},"tasks/ADMIN-WEB-DELIVERY-2026-10-04.md":{"mtime_ns":"1791116763683549700","sha256":"11016d9442bef9403e63ad21c6a8853c11d27eeb5cab56f3452b06cb3e40c531","checkboxes":["[x]"],"bare_PAR_tokens":0,"bare_PAR_lines":0,"PAR_XA":[]}}''')
paths=[root/name for name in baseline]+[root/'tasks/PLAN-COMPLETION-2026-10-04.md',root/'coordination/COORDINATION-TOPOLOGY.md',root/'tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md',root/'tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md',root/'coordination/reports/plan-review-730-2026-10-04.md',root/'coordination/reports/plan-merge-fix-2026-10-04.md',root/'coordination/reports/plan-refresh-736-740-2026-10-04.md',root/'coordination/reports/plan-merge-fix-2-2026-10-04.md']
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
 for task in re.findall(r'^\| ((?:PLAN04-\d{2}|CONT-\d{2}|P730-[A-Z-]+|CFGADM-\d{2}|WTV-\d{2})) `\[[ x~]\]`',content,re.M):
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
for cycle in range(736,741):
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
summary={'docs_checked':len(paths),'local_links_checked':links,'anchors_checked':anchors,'task_definitions':len(definitions),'duplicate_task_definitions':len(duplicates),'acyclic_mermaid_graphs':graphs,'legacy_settings':len(keys),'CFGADM_open_rows':len(cfgrows),'P730_open_rows':len(p730),'WTV_receipt_refs':len(wtvrefs),'AWEB_appended_receipts':len(lognames),'checkboxes_unchanged':len(baseline),'backlog_cycles':[736,737,738,739,740],'N1_N4_delta':'APPLIED' if not problems else 'CHECK_ERRORS','L2_remainder':l2remaining,'PAR_XA_preserved':{'LPG':1,'ORCH_CONFIG':len(readonly_pin['PAR_XA'])},'Q1_Q2_Q3_pointers':2,'errors':problems}
print(json.dumps(summary,ensure_ascii=True))
raise SystemExit(bool(problems))
```
