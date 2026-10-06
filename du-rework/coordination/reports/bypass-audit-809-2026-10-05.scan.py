from pathlib import Path
import datetime
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT/'coordination/reports/bypass-audit-809-2026-10-05'
QUERIES = {
 'slots': r'input_ref|payload_ref|response_ref|output_ref|prompt_overrides_ref|result_ref|session_ref|inputRef|payloadRef|responseRef|outputRef|promptOverridesRef|resultRef|sessionRef',
 'sql-read': r'(FROM|JOIN) (operations|tasks|human_waits|step_checkpoints)|SELECT \*|\.select\(',
 'crypto-open': r'readStoredText|readStored\(|openMetadata\(|sealer\.open|metadataCrypto\.open|createDecipheriv|unwrapDek|countUnsealedWithAuth',
 'plaintext-policy': r'allowPlaintext|ALLOW_PLAINTEXT|METADATA.*WINDOW|metadataReadPolicy|legacyPlaintext|return value|return raw|return .*plaintext',
 'sinks': r'logger\.|console\.|\.log\(|JSON\.stringify|writeFile|writeJson|audit\.|auditEvent|telemetry|\.message|\.set\(',
}
paths = set()
results = {}
for label, pattern in QUERIES.items():
 args = ['rg','--json','--hidden','--no-ignore',pattern,'.','--glob','*.{ts,tsx,js,cjs,mjs,py,sh,ps1,sql}','--glob','!**/node_modules/**','--glob','!**/dist/**','--glob','!**/tests/**','--glob','!**/test/**','--glob','!coordination/**','--glob','!docs/**','--glob','!tasks/**','--glob','!.git/**','--glob','!**/.env*']
 run = subprocess.run(args,cwd=ROOT,capture_output=True)
 raw = Path(str(BASE)+'.'+label+'.raw.jsonl')
 raw.write_bytes(run.stdout)
 matches = []
 for line in run.stdout.splitlines():
  row=json.loads(line)
  if row['type'] == 'match':
   data=row['data'];name=data['path']['text'];paths.add(name)
   matches.append({'path':name,'line':data['line_number']})
 results[label] = {'command_argv':args,'exit':run.returncode,'stderr':run.stderr.decode('utf-8',errors='replace'),'matches':len(matches),'files':len({r['path'] for r in matches}),'raw':raw.relative_to(ROOT).as_posix(),'raw_sha256':hashlib.sha256(run.stdout).hexdigest()}
 if run.returncode not in (0,1):
  raise SystemExit('rg failed '+label)
pins={}
for name in sorted(paths):
 p=ROOT/name;pins[p.relative_to(ROOT).as_posix()]={'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'mtime_ns':p.stat().st_mtime_ns}
result={'root':str(ROOT),'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mode':'read-only static grep, no DB/browser/crypto/product execution','head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'queries':results,'source_pins':pins}
Path(str(BASE)+'.intake.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:{a:v[a] for a in ['exit','matches','files']} for k,v in results.items()},indent=2))
