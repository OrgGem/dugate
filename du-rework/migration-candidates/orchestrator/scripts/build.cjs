const {spawnSync}=require('node:child_process');
const result=spawnSync(process.execPath,[process.env.npm_execpath,'-r','run','build'],{cwd:require('node:path').resolve(__dirname,'..'),stdio:'inherit'});
if(result.error)throw result.error; process.exitCode=result.status ?? 1;
