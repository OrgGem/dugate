// Synthetic local test only. Never prints response bodies, messages, or values.
const {createRequire}=require('node:module');
const sdkRequire=createRequire(require.resolve('/app/node_modules/@du/worker-sdk'));
const {RuntimeClient}=sdkRequire('./runtime-client.js');
for(const method of ['requestUploadGrant','saveStep','requestAccessGrant','finalizeArtifact','requestInvocationGrant']) {
  const original=RuntimeClient.prototype[method];
  RuntimeClient.prototype[method]=async function(...args){
    try{return await original.apply(this,args);}catch(error){
      const issues=Array.isArray(error.issues)?error.issues.map(issue=>({code:issue.code,path:issue.path.filter(part=>typeof part==='string'&&/^[A-Za-z]+$/.test(part))})):[];
      process.stdout.write(JSON.stringify({diagnosticMethod:method,errorName:error.name,issues})+'\n');
      throw error;
    }
  };
}
const {DefaultTaskContext}=sdkRequire('./task-context.js');
const originalFacade=DefaultTaskContext.prototype.createConnectorFacade;
DefaultTaskContext.prototype.createConnectorFacade=function(){
  const facade=originalFacade.call(this);
  const invoke=facade.invoke;
  facade.invoke=async(...args)=>{try{return await invoke(...args);}catch(error){
    process.stdout.write(JSON.stringify({diagnosticMethod:'connector.invoke',errorName:error.name,issues:Array.isArray(error.issues)?error.issues.map(issue=>({code:issue.code,path:issue.path.filter(part=>typeof part==='string'&&/^[A-Za-z]+$/.test(part))})):[]})+'\n');
    throw error;
  }};
  return facade;
};
new (require('/app/dist/main.js').DocumentCoreProcess)().start().catch(()=>{});
