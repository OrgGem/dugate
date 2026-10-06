from pathlib import Path
from urllib.parse import unquote
import re,json,hashlib,sys
sys.stdout.reconfigure(encoding='utf-8')
root=Path('D:/Git/dugate/du-rework')
baseline=json.loads((root/'coordination/reports/plan-update-805-2026-10-05.intake.json').read_text(encoding='utf-8'))['files']
paths=[root/name for name in ["tasks/README.md","tasks/PLAN-COMPLETION-2026-10-04.md","tasks/ADMIN-WEB-DELIVERY-2026-10-04.md","tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md","tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md","coordination/COORDINATION-TOPOLOGY.md","tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md","tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md","tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md","tasks/SHARED-PACKAGES-REDISTRIBUTION-2026-10-05.md","tasks/SCALE-HA-2026-10-05.md","coordination/reports/plan-review-730-2026-10-04.md","coordination/reports/plan-merge-fix-2026-10-04.md","coordination/reports/plan-refresh-736-740-2026-10-04.md","coordination/reports/plan-merge-fix-2-2026-10-04.md","coordination/reports/plan-refresh-741-745-2026-10-04.md","coordination/reports/plan-merge-fix-3-2026-10-04.md","coordination/reports/plan-refresh-746-750-2026-10-04.md","coordination/reports/verify-refresh-746-750-2026-10-04.md","coordination/reports/plan-chkpt-750-2026-10-04.md","coordination/reports/plan-update-763-2026-10-04.md","coordination/reports/plan-update-770-2026-10-04.md","coordination/reports/plan-update-780-2026-10-05.md","coordination/reports/plan-update-795-2026-10-05.md","coordination/reports/plan-update-800-2026-10-05.md","coordination/reports/w1-review-part2-2026-10-04.md","coordination/reports/w1-review-part3-2026-10-04.md","coordination/reports/w1-review-part4-2026-10-04.md","coordination/reports/w1-review-b2-2026-10-05.md","coordination/reports/p745-producer-impl-2026-10-04.md","coordination/reports/tapi01-closure-2026-10-04.md","coordination/reports/p730-prefconsume-2026-10-04.md","coordination/reports/p730-acquire-2026-10-04.md","coordination/reports/p730-sdk-consume-2026-10-04.md","coordination/reports/p745-carrier-design-2026-10-04.md","coordination/reports/p745-carrier-impl-a-2026-10-04.md","coordination/reports/p745-carrier-impl-b1-2026-10-04.md","coordination/reports/p745-carrier-impl-b2-2026-10-04.md","coordination/reports/design-review-carrier-2026-10-04.md","coordination/reports/impl-review-carrier-a-2026-10-04.md","coordination/reports/p745-ui-keys-2026-10-04.md","coordination/reports/uirev-p745-ui-keys-2026-10-04.md","coordination/reports/curl-spec-fix-2026-10-04.md","coordination/reports/br12-fix-2026-10-05.md","coordination/reports/audit-ext-2026-10-04.md","coordination/reports/audit-ext-2-2026-10-04.md","coordination/reports/doc-sync-tapi01-2026-10-05.md","coordination/reports/live-plan-refresh-2026-10-05.md","coordination/reports/live-test-prep-2026-10-04.md","coordination/reports/connector-wire-a-2026-10-05.md","coordination/reports/connector-wire-b-bff-2026-10-05.md","coordination/reports/connector-wire-b-ui-2026-10-05.md","coordination/reports/uirev-cw-b-ui-2026-10-05.md","coordination/reports/shell-red-fix-2026-10-05.md","coordination/reports/shell-red-fix-2-2026-10-05.md","coordination/reports/nav-dedupe-2026-10-05.md","coordination/reports/medium-2-2026-10-05.md","coordination/reports/credworkflow-impl-2026-10-05.md","coordination/reports/credworkflow-prep-2026-10-05.md","coordination/reports/encmeta-resultref-impl-2026-10-05.md","coordination/reports/encmeta-resultref-prep-2026-10-05.md","coordination/reports/encmeta-schema-impl-2026-10-05.md","coordination/reports/encmeta-schema-prep-2026-10-05.md","coordination/reports/p745-ui-keys-journey-2026-10-05.md","coordination/reports/p745-ui-mask-pw-2026-10-05.md","coordination/reports/commit-plan-prep-2026-10-05.md","coordination/reports/tick-proposal-2-2026-10-05.md","coordination/reports/cfgadm-ui-inventory-2026-10-05.md","coordination/reports/live-spec-ext-2026-10-05.md","coordination/reports/env-examples-sync-2026-10-05.md","coordination/reports/docs-connector-wire-2026-10-05.md","coordination/reviews/2026-10-05-0036-coordinator.md","coordination/reviews/2026-10-05-0044-coordinator.md","coordination/reviews/2026-10-05-0206-coordinator.md","coordination/reviews/2026-10-05-0218-coordinator.md","coordination/reviews/2026-10-05-0236-coordinator.md","coordination/reviews/2026-10-05-0250-coordinator.md"] if (root/name).exists()]
paths.append(root/'coordination/reports/plan-update-805-2026-10-05.md')
problems=[];links=0;anchors=0;graphs=0;definitions={}
def slug(heading):
 return re.sub(r'[^\w\- ]','',heading.lower()).replace(' ','-')
for p in paths:
 content=p.read_text(encoding='utf-8-sig')
 for i,line in enumerate(content.splitlines(),1):
  if (str(p.relative_to(root)) in baseline or p.name=='plan-update-800-2026-10-05.md') and line.rstrip()!=line:problems.append('trailing whitespace '+p.name+':'+str(i))
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
 for task in re.findall(r'^\| ((?:PLAN04-\d{2}|CONT-\d{2}|P730-[A-Z-]+|P745-[A-Z0-9-]+|P763-[A-Z0-9-]+|ORCH-PAR-\d{2}|ACUI-\d{2}|CFGADM-\d{2}|WTV-\d{2})) `\[[ x~]\]`',content,re.M):
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
  except ValueError:
   problems.append('graph cycle '+p.name)
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
 if name!='tasks/PLAN-COMPLETION-2026-10-04.md' and re.findall(r'\[[ x~]\]',s)!=pin['checkboxes']:problems.append('existing checkbox changed '+name)
 if re.findall(r'PAR-XA-[\w./-]+',s)!=pin['PAR_XA']:problems.append('PAR-XA drift '+name)
for name in ['PLAN-COMPLETION-2026-10-04.md','ADMIN-WEB-DELIVERY-2026-10-04.md','ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md']:
 if re.search(r'(?<![\w-])PAR-\d',(root/'tasks'/name).read_text(encoding='utf-8-sig')):problems.append('noncanonical PAR '+name)
wtv=(root/'tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md').read_text(encoding='utf-8-sig')
wtvrefs=re.findall(r'\]\(\.\./coordination/reports/(wtv\d{2}[a-z]?[^)]+)\)',wtv)
if len(wtvrefs)!=7 or '9 file test' in wtv:problems.append('WTV refs/count mismatch')
aweb=(root/'tasks/ADMIN-WEB-DELIVERY-2026-10-04.md').read_text(encoding='utf-8-sig')
lognames=['aweb04-wire-conformance','profile-phase1-verify','fpp1-closure-verify','aweb08-docs-ux-pointer','aweb08-legacy-inventory']
if any(aweb.count(']('+ '../coordination/reports/'+n+'-2026-10-04.md)')!=1 for n in lognames):problems.append('AWEB log refs mismatch')
for name in ['uirev-fullpage-planea-2026-10-05.md','p745-ui-mask-pw-2026-10-05.md','uirev-p745-ui-mask-2026-10-04.md']:
 if aweb.count(name)!=1:problems.append('AWEB update780 row ref missing '+name)
if aweb.count('plan-update-780-2026-10-05.md')<2:problems.append('AWEB update780 rows missing')
if aweb.count('plan-update-795-2026-10-05.md')<2:problems.append('AWEB update795 rows missing')
if aweb.count('plan-update-800-2026-10-05.md')<2:problems.append('AWEB update800 rows missing')
for name in ['live-spec-ext-2026-10-05.md','cfgadm-ui-inventory-2026-10-05.md','commit-plan-prep-2026-10-05.md','tester.md']:
 if aweb.count(name)<1:problems.append('AWEB update800 row ref missing '+name)
if 'Update 800 / current handoff' not in aweb:problems.append('AWEB current notice missing')
if 'L\u1ecbch s\u1eed update795 / superseded b\u1edfi update800' not in aweb:problems.append('AWEB 795 demote missing')
if '\u0394-DEV-03 pending user decision' not in aweb:problems.append('route decision not explicitly pending')
for row in ['CONT-01','CONT-04']:
 line=next(l for l in plan.splitlines() if l.startswith('| '+row+' '))
 if 'CFGADM' not in line:problems.append('CONT scope not folded '+row)
live=(root/'tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md').read_text(encoding='utf-8-sig')
if 'Connector (`:8081`)' in live or 'Connector `:8081`' in live:problems.append('stale active Connector port')
if '## 4. B\u1ed5 sung 2026-10-05' not in live:problems.append('LIVE-PLAN 4 missing')
for marker in ['LIV-CW-01','LIV-EM-01','LIV-CM-01','LIV-SS-01','LIV-PC-01']:
 if live.count(marker)<1:problems.append('LIVE-PLAN item marker '+marker)
if 'CFGADM[CFGADM' not in (root/'tasks/README.md').read_text(encoding='utf-8-sig'):problems.append('CFGADM graph missing')
readme=(root/'tasks/README.md').read_text(encoding='utf-8-sig')
if 'Legacy parity gaps / LPG holds' not in readme:problems.append('N1 missing LPG notice')
if 'LPG[ORCH-LPG-01/02' not in readme:problems.append('N3 missing LPG graph node')
boundary=readme.split('## Release boundary')[1]
if 'CFGADM-00..11' not in boundary or 'required' not in boundary:problems.append('N4 missing CFGADM release boundary')
if 'PLAN-UPDATE-805 (current)' not in readme:problems.append('README current notice missing')
if 'PLAN-UPDATE-795 (l\u1ecbch s\u1eed, superseded b\u1edfi update800)' not in readme:problems.append('README 795 demote missing')
if 'RPK-00' not in readme or 'RPK-00' not in plan:problems.append('RPK notice missing')
sec7=plan.split('## 7.')[1].split('## 8.')[0]
if '5/6' not in sec7 or '5/6' not in readme:problems.append('N2 dispatch metadata stale')
if '## 8. Checkpoint 735' not in plan:problems.append('backlog section missing')
receipt=(root/'coordination/reports/plan-refresh-736-740-2026-10-04.md').read_text(encoding='utf-8-sig')
for required in ['task_f0014eff828a','SDK-CONSUME','UI-INTEGRATE','WTV-07','USER-GATED','W2-B','N1','N2','N3','N4']:
 if required not in receipt:problems.append('receipt omission '+required)
l2files=['tasks/README.md','tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md','tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md','tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md']
l2remaining={name:len(re.findall(r'(?<!ORCH-)PAR-\d+',(root/name).read_text(encoding='utf-8-sig'))) for name in l2files}
if any(l2remaining.values()):problems.append('L2 remainder not zero')
readonly_pin=json.loads(r'''{"mtime_ns":"1791115337338853000","sha256":"e35edb80e2ee620deb7374ee30b88e3ea71b0ad17f0015bf8f8b1fd33fd3ec48","PAR_XA":["PAR-XA-01..05","PAR-XA-03","PAR-XA-03","PAR-XA-01","PAR-XA-02"]}''')
orchconfig=root/'tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md'
if hashlib.sha256(orchconfig.read_bytes()).hexdigest()!=readonly_pin['sha256'] or str(orchconfig.stat().st_mtime_ns)!=readonly_pin['mtime_ns']:problems.append('ORCH-CONFIG readonly pin drift')
if re.findall(r'PAR-XA-[\w./-]+',orchconfig.read_text(encoding='utf-8-sig'))!=readonly_pin['PAR_XA']:problems.append('ORCH-CONFIG PAR-XA drift')
for name in ['tasks/ADMIN-WEB-DELIVERY-2026-10-04.md','tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md']:
 content=(root/name).read_text(encoding='utf-8-sig')
 note=next((line for line in content.splitlines() if line.startswith('> **CURL Q1/Q2/Q3')), '')
 for text in ['Q1','fail-closed','Q2','heuristic','mask/unmask','Q3','onApply','accept-only','UI-INTEGRATE','INTEGRATION_PENDING','/admin/workflows','curl-ui-review-2026-10-04.md']:
  if text not in note:problems.append('CURL accepted pointer missing '+name+' '+text)
if 'L\u1ecbch s\u1eed update795; current evidence/status xem \u00a716 update800.' not in plan:problems.append('plan 795 demote missing')
current=plan.split('## 16. PLAN-UPDATE-800')[1] if '## 16. PLAN-UPDATE-800' in plan else ''
if not current:problems.append('update800 current status missing')
for text in ['checkpoint %5','COMMIT-PLAN-PREP','0 staged','VERIFY-SHELL-FIX','103','LIVE-SPEC-EXT','CFGADM-UI-INVENTORY','3 legacy-working','7 UI-missing','TICK-PROPOSAL-2','RCR-01','RCR-02','RCR-03','RCR-06','RCR-04','RCR-05','RCR-HTTP','RCR-RUNTIME','task_0a7e017eb66e','task_fa1463127729','snapshot 02:36','Fleet-check','PREP3','BACKFILL','STUB-EXT','801\u2013805','user-gated','8 c\u00e2u h\u1ecfi','SHARED-PACKAGES']:
 if text not in current:problems.append('update800 omission '+text)
for cycle in range(796,801):
 if not re.search(r'^\| '+str(cycle)+r' ',current,re.M):problems.append('backlog cycle missing '+str(cycle))
if '## 15. PLAN-UPDATE-795' not in plan or 'T-PROM-02 OFFLINE CHAIN CLOSED' not in plan:problems.append('update795 section lost')
newrows=re.findall(r'^\| (P745-[A-Z0-9-]+) \x60\[ \]\x60',plan,re.M)
expectedrows=['P745-PROMPT-PRODUCER','P745-SESSION-CONSUME','P745-UI-MASK','P745-UI-BROWSER','P745-CONNECTOR-WIRE','P745-PARAMETER-POLICY','P745-UI-KEYS']
if len(newrows)!=7 or set(newrows)!=set(expectedrows):problems.append('P745 open rows drift')
p763=re.findall(r'^\| (P763-[A-Z0-9-]+) \x60\[ \]\x60',plan,re.M)
if p763:problems.append('P763 offline tick missing')
topo=(root/'coordination/COORDINATION-TOPOLOGY.md').read_text(encoding='utf-8-sig')
roster=topo.split('## 1.')[1].split('## 2.')[0]
rows=[line for line in roster.splitlines() if line.startswith('|') and 'term_' in line]
handles=[re.search(r'term_[a-z0-9]+',line).group(0) for line in rows]
expected_handles=['term_58db0267','term_7cb640ae','term_4bca69af','term_822128f8','term_2ea0ce2e','term_3adb7228','term_37c6cebe','term_43f85ccc','term_19edcad8','term_ae2d7e42','term_c03791d1','term_ee7e9f33','term_4954d39e','term_a85c47f2','term_bac0ad06']
if len(handles)!=15 or len(set(handles))!=15 or set(handles)!=set(expected_handles):problems.append('canonical 15 roster membership mismatch')
for line in rows:
 if 'qwen_3' in line or 'qwen_4' in line:problems.append('removed Qwen in active roster')
for text in ['ENCMETA-BACKFILL-PREP','LIVE-SPEC-EXT DONE','CFGADM-UI-INVENTORY DONE','V-STUB-EXT','LIVE-READY-PREP3','VERIFY-SHELL-FIX PASS','RCR-HTTP running','RCR-RUNTIME running','STUB-EXT running','TICK-PROPOSAL-2 DONE']:
 if text not in roster:problems.append('roster current status missing '+text)
for doc,phrase in [('tasks/README.md','PLAN-UPDATE-805 (current)'),('coordination/COORDINATION-TOPOLOGY.md','Current update 800'),('tasks/ADMIN-WEB-DELIVERY-2026-10-04.md','Update 800 / current handoff'),('tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md','Update 800 (current)'),('tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md','Update 800 (current)')]:
 if phrase not in (root/doc).read_text(encoding='utf-8-sig'):problems.append('current notice missing '+doc)
for doc,phrase in [('tasks/README.md','PLAN-UPDATE-795 (l\u1ecbch s\u1eed, superseded b\u1edfi update800)'),('coordination/COORDINATION-TOPOLOGY.md','L\u1ecbch s\u1eed update795 (superseded b\u1edfi update800)'),('tasks/ADMIN-WEB-DELIVERY-2026-10-04.md','L\u1ecbch s\u1eed update795 / superseded b\u1edfi update800'),('tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md','L\u1ecbch s\u1eed update795 / superseded b\u1edfi update800'),('tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md','L\u1ecbch s\u1eed update795 / superseded b\u1edfi update800')]:
 if phrase not in (root/doc).read_text(encoding='utf-8-sig'):problems.append('demoted 795 notice missing '+doc)
if '(current xem update 800 d\u01b0\u1edbi)' not in cfg:problems.append('CFGADM 735 pointer stale')
if 'current evidence xem update 800 d\u01b0\u1edbi' not in cfg:problems.append('CFGADM top pointer stale')
currentreceipt=(root/'coordination/reports/plan-update-800-2026-10-05.md').read_text(encoding='utf-8-sig')
for text in ['PLAN-UPDATE-800','task_0a7e017eb66e','task_fa1463127729','RCR-01','RCR-06','VERIFY-SHELL-FIX','COMMIT-PLAN-PREP','LIVE-SPEC-EXT','CFGADM-UI-INVENTORY','TICK-PROPOSAL-2','ENV-EXAMPLES-SYNC','DOCS-CONNECTOR-WIRE','mtime_ns','SHA256','no commit','checkpoint %5','801\u2013805','8 c\u00e2u h\u1ecfi','RCR-HTTP','RCR-RUNTIME']:
 if text not in currentreceipt:problems.append('receipt omission '+text)
suite_paths=sorted((root/'tasks').glob('*.md'))+[root/'coordination/COORDINATION-TOPOLOGY.md']
suite_bare={str(p.relative_to(root)):len(re.findall(r'(?<!ORCH-)PAR-\d+',p.read_text(encoding='utf-8-sig'))) for p in suite_paths}
suite_bare={k:v for k,v in suite_bare.items() if v}
if suite_bare:problems.append('suite-wide bare PAR remainder '+json.dumps(suite_bare))
for p in suite_paths:
 if 'ORCH-ORCH-' in p.read_text(encoding='utf-8-sig'):problems.append('double-prefix '+str(p))
suite_par_xa=sum(len(re.findall(r'PAR-XA-[\w./-]+',p.read_text(encoding='utf-8-sig'))) for p in suite_paths)
if suite_par_xa!=18:problems.append('suite PAR-XA preservation count mismatch')
prefix=root/'coordination/reports/plan-update-805-2026-10-05'
before=Path(str(prefix)+'.plan.before.md').read_text(encoding='utf-8-sig')
expected=before
for row in ['P763-W1C-COMPOSE','P763-PROMPT-WIRING']:
 expected=expected.replace('| '+row+' `[ ]`','| '+row+' `[x]`')
if re.findall(r'\[[ x~]\]',plan)!=re.findall(r'\[[ x~]\]',expected):problems.append('checkbox delta exceeds two authorized rows')
oldids=re.findall(r'^\| ([A-Z][A-Z0-9-]+) `\[[ x~]\]`',before,re.M)
newids=re.findall(r'^\| ([A-Z][A-Z0-9-]+) `\[[ x~]\]`',plan,re.M)
if oldids!=newids:problems.append('task rows added/deleted/reordered')
for name,pin in baseline.items():
 if name not in ['tasks/PLAN-COMPLETION-2026-10-04.md','tasks/README.md']:
  path=root/name
  if hashlib.sha256(path.read_bytes()).hexdigest()!=pin['sha256'] or str(path.stat().st_mtime_ns)!=pin['mtime_ns']:problems.append('readonly pin drift '+name)
current=plan.split('## 17.',1)[1]
for a in range(1,7):
 if not re.search(r'^\| \*\*A'+str(a)+r' ',current,re.M):problems.append('adjudication missing A'+str(a))
for cycle in range(796,811):
 if not re.search(r'^\| '+str(cycle)+r' ',current,re.M):problems.append('fold/skeleton missing '+str(cycle))
w1=next(l for l in plan.splitlines() if l.startswith('| P763-W1C-COMPOSE '))
for token in ['[x]','offline','5913db5e','ae7e29ce','T-PROM-02','provider-use','ENCRYPTION_KEY']:
 if token not in w1:problems.append('W1C note missing '+token)
for token in ['DEV-03','1\u21926','8 c\u00e2u h\u1ecfi','T-PROM-02','provider-use','0032','RCR','A3']:
 if token not in current:problems.append('gate/scope missing '+token)
for name in ['tasks/README.md','tasks/PLAN-COMPLETION-2026-10-04.md','coordination/reports/plan-update-805-2026-10-05.md']:
 for i,line in enumerate((root/name).read_text(encoding='utf-8-sig').splitlines(),1):
  if line.rstrip()!=line:problems.append('trailing whitespace '+name+':'+str(i))
post_pins={name:{'mtime_ns':str((root/name).stat().st_mtime_ns),'sha256':hashlib.sha256((root/name).read_bytes()).hexdigest()} for name in baseline}
import difflib,subprocess
literal=''
for short,name in [('plan','tasks/PLAN-COMPLETION-2026-10-04.md'),('readme','tasks/README.md')]:
 old=Path(str(prefix)+'.'+short+'.before.md').read_text(encoding='utf-8-sig')
 new=(root/name).read_text(encoding='utf-8-sig')
 literal+=''.join(difflib.unified_diff(old.splitlines(keepends=True),new.splitlines(keepends=True),fromfile=name+' (intake)',tofile=name+' (current)'))
Path(str(prefix)+'.literal.diff').write_text(literal,encoding='utf-8',newline='')
cmd=['git','-c','core.autocrlf=false','-c','core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol','diff','--check','--','tasks/README.md','tasks/PLAN-COMPLETION-2026-10-04.md']
check=subprocess.run(cmd,cwd=root,capture_output=True,text=True,encoding='utf-8')
Path(str(prefix)+'.diff-check.raw.txt').write_text('command: '+' '.join(cmd)+'\nstdout:\n'+check.stdout+'stderr:\n'+check.stderr+'exit: '+str(check.returncode)+'\n',encoding='utf-8')
if check.returncode:problems.append('git diff --check failed')
staged=subprocess.run(['git','diff','--cached','--name-only'],cwd=root,capture_output=True,text=True)
summary={'docs_checked':len(paths),'local_links_checked':links,'anchors_checked':anchors,'task_definitions':len(definitions),'duplicate_task_definitions':len(duplicates),'acyclic_mermaid_graphs':graphs,'legacy_settings':len(keys),'CFGADM_open_rows':len(cfgrows),'P730_open_rows':len(p730),'P745_open_rows':len(newrows),'P763_offline_ticks':2,'other_checkbox_changes':0,'added_task_rows':0,'readonly_pins_checked':len(baseline)-2,'historical_topology_members':len(handles),'intake_agent_lanes':13,'suite_PAR_XA_tokens':suite_par_xa,'suite_bare_tokens':sum(suite_bare.values()),'fold_cycles':list(range(796,803)),'skeleton_cycles':list(range(803,811)),'diff_check_exit':check.returncode,'staged_files_observed':staged.stdout.splitlines(),'post_pins':post_pins,'errors':problems}
Path(str(prefix)+'.post-pins.json').write_text(json.dumps(post_pins,indent=2)+'\n',encoding='utf-8')
raw=json.dumps(summary,indent=2,ensure_ascii=True)+'\n'
Path(str(prefix)+'.validation.raw.json').write_text(raw,encoding='utf-8')
print(raw)
raise SystemExit(bool(problems))
