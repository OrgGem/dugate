import pathlib,subprocess,json,hashlib,os
raw=pathlib.Path(__file__).resolve().parent
ctx=pathlib.Path((raw/'context-path.txt').read_text())
tag='candidate-portal-swagger-20261006-r4.1'
images={}
for service in ['orchestrator','connector','document-core','lc-checker','example-review']:
 name='du-'+service+':'+tag
 data=json.loads(subprocess.check_output(['docker','image','inspect',name]))[0]
 assert data['Config']['Labels']['du.candidate']=='verify-only'
 images[service]={'tag':name,'id':data['Id'],'repoDigests':data.get('RepoDigests',[]),'labels':data['Config']['Labels']}
 (raw/('image-inspect-'+service+'.json')).write_text(json.dumps(data,indent=2))
(raw/'images.json').write_text(json.dumps(images,indent=2))
code=(raw/'extract-bundled-openapi.cjs').read_text(encoding='utf-8-sig')
r=subprocess.run(['docker','run','--rm','--entrypoint','node',images['orchestrator']['tag'],'-e',code],capture_output=True)
(raw/'extract.stderr.txt').write_bytes(r.stderr); assert r.returncode==0,r.stderr
(raw/'bundled-openapi.json').write_bytes(r.stdout)
assert r.stdout==(ctx/'docs/21-openapi.json').read_bytes(),'Bundled bytes mismatch'
validator=pathlib.Path.cwd()/'du-rework/tools/openapi/validate_openapi.py'
(raw/'validator.py').write_bytes(validator.read_bytes())
r=subprocess.run(['python',str(validator),'--spec',str(raw/'bundled-openapi.json')],capture_output=True)
(raw/'bundled-validator.log').write_bytes(r.stdout+r.stderr); (raw/'bundled-validator.exit.txt').write_text(str(r.returncode)); assert r.returncode==0,r.stderr
code='const fs=require("fs"),crypto=require("crypto"); const a=fs.readdirSync("/app/migrations").filter(x=>/^003[56]_/.test(x)); if(a.length!==2) throw Error("migration files missing"); console.log(JSON.stringify(Object.fromEntries(a.map(x=>[x,crypto.createHash("sha256").update(fs.readFileSync("/app/migrations/"+x)).digest("hex")]))));'
m=json.loads(subprocess.check_output(['docker','run','--rm','--entrypoint','node',images['orchestrator']['tag'],'-e',code]))
for p,h in m.items(): assert hashlib.sha256((ctx/'services/orchestrator/migrations'/p).read_bytes()).hexdigest()==h
(raw/'migration-files.json').write_text(json.dumps(m,indent=2))
print('VERIFIED: 5 images, bundled OpenAPI byte-identical, validator exit 0, migrations 0035/0036 byte-identical')
