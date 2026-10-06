const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const browserRequire=createRequire(path.join(root,'tests/browser/package.json'));
const {chromium}=browserRequire('@playwright/test');
const {createAdminShellServer}=require(path.join(root,'services/orchestrator/dist/app/admin/shell-server.js'));
const {signCookie}=require(path.join(root,'services/orchestrator/dist/app/admin/shell-auth.js'));
const tenant='11111111-1111-4111-8111-111111111111';
const id1='cccccccc-1111-4111-8111-111111111111',id2='dddddddd-1111-4111-8111-111111111111',id3='eeeeeeee-1111-4111-8111-111111111111',newId='ffffffff-1111-4111-8111-111111111111';
const base={tenantId:tenant,businessId:'document-core',action:'ingest',createdAt:'2026-10-06T04:00:00.000Z',startedAt:'2026-10-06T04:00:05.000Z',completedAt:'2026-10-06T04:00:25.000Z',updatedAt:'2026-12-06T04:00:00.000Z'};
const ops=new Map([[id1,{...base,id:id1,state:'FAILED',errorCode:'HANDLER_ERROR'}],[id2,{...base,id:id2,state:'RUNNING',completedAt:null}],[id3,{...base,id:id3,state:'SUCCEEDED',startedAt:null,completedAt:null}]]);
const requests=[];let browser,shell,upstream;const passed=[];
const check=async(name,fn)=>{await fn();passed.push(name);console.log('PASS '+name);};
(async()=>{
  upstream=http.createServer((req,res)=>{
    let raw='';req.on('data',chunk=>{raw+=chunk});req.on('end',()=>{
      const url=new URL(req.url,'http://stub');requests.push({path:url.pathname+url.search,method:req.method,body:raw});
      res.setHeader('content-type','application/json');
      if(url.pathname==='/api/v1/operations'){
        const second=url.searchParams.get('cursor')==='second';
        return res.end(JSON.stringify({items:second?[ops.get(id3)]:[ops.get(id1),ops.get(id2)],total:3,limit:Number(url.searchParams.get('limit')),nextCursor:second?null:'second',prevCursor:second?'first':null}));
      }
      if(url.pathname.startsWith('/api/v1/operations/')){
        const op=ops.get(url.pathname.split('/').pop());
        return res.end(JSON.stringify({operation:op,requestInput:{data:{mode:'parse'},status:'NO_RULES',ruleCount:0},result:{note:'result'},artifacts:[],tasks:[{id:'task-1',taskKey:'root',kind:'root',state:'FAILED',attempt:3,maxAttempts:3,errorCode:'HANDLER_ERROR'}],serverNow:'2026-10-06T04:01:00.000Z'}));
      }
      if(url.pathname==='/api/v1/admin/actions'){
        const {action,params}=JSON.parse(raw);if(action==='operations.cancel'){const op=ops.get(params.operationId);op.state='CANCELLED';op.completedAt='2026-10-06T04:01:00.000Z';return res.end(JSON.stringify({operationId:op.id,state:op.state}));}
        if(action==='operations.retry'){ops.set(newId,{...base,id:newId,state:'ACCEPTED',startedAt:null,completedAt:null,retryOf:params.operationId});return res.end(JSON.stringify({operationId:newId,state:'ACCEPTED'}));}
      }
      res.statusCode=404;res.end(JSON.stringify({code:'NOT_FOUND'}));
    });
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  shell=createAdminShellServer({port:0,host:'127.0.0.1',cookieSecret:'request-browser-secret',adminToken:'request-browser-token',jsonBaseUrl:`http://127.0.0.1:${upstream.address().port}`,adminWeb:{distDir:path.join(root,'apps/admin-web/dist')},cookiePolicy:{trustProxyProtocol:false,requireSecure:false}});
  const {url}=await shell.listen(); browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});
  const now=Date.now();await page.context().addCookies([{name:'du_admin',value:signCookie('request-browser-secret',{iss:'du-admin-shell',role:'admin',iat:now,exp:now+3600000}),url}]);
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
  await page.goto(url+'/admin/web/operations');await page.getByRole('table',{name:'Operations',exact:true}).waitFor();
  await check('default newest sort and limit',async()=>{assert.ok(requests.some(r=>r.path.includes('sort=created_at%3Adesc')&&r.path.includes('limit=20')));});
  await check('terminal duration ignores maintenance updatedAt',async()=>{const row=page.getByRole('row').filter({has:page.getByRole('cell',{name:'FAILED',exact:true})});assert.ok((await row.textContent()).includes('25.0 s'));});
  await check('next/previous pagination uses cursor',async()=>{await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByRole('cell',{name:'SUCCEEDED',exact:true}).waitFor();assert.ok(requests.some(r=>r.path.includes('cursor=second')));await page.getByRole('button',{name:'Previous',exact:true}).click();await page.getByRole('cell',{name:'FAILED',exact:true}).waitFor();});
  await check('page size change resets cursor',async()=>{await page.getByLabel('Requests per page').selectOption('50');await page.waitForResponse(r=>r.url().includes('/admin/api/operations?')&&r.url().includes('limit=50'));const last=requests.filter(r=>r.path.startsWith('/api/v1/operations?')).at(-1);assert.ok(!last.path.includes('cursor='));});
  await check('detail exposes request input tasks errors and immutable times',async()=>{await page.getByRole('button',{name:'Detail',exact:true}).first().click();await page.getByRole('table',{name:'Request tasks'}).waitFor();assert.ok((await page.getByLabel('Request input').textContent()).includes('parse'));assert.ok((await page.locator('dl').textContent()).includes('20.0 s'));});
  await check('stop and retry traverse real BFF controls',async()=>{await page.getByRole('button',{name:'Stop',exact:true}).nth(1).click();await page.getByText('Request stopped.',{exact:true}).waitFor();assert.ok(requests.some(r=>r.method==='POST'&&r.body.includes('operations.cancel')));await page.getByRole('button',{name:'Retry',exact:true}).first().click();await page.getByText(`Retry created: ${newId}`,{exact:true}).waitFor();assert.ok(requests.some(r=>r.method==='POST'&&r.body.includes('operations.retry')));});
  await page.screenshot({path:path.join(__dirname,'request-controls-desktop-2026-10-06.png'),fullPage:true});
  await check('historical terminal duration remains unknown',async()=>{await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByRole('cell',{name:'SUCCEEDED',exact:true}).waitFor();const row=page.getByRole('row').filter({has:page.getByRole('cell',{name:'SUCCEEDED',exact:true})});assert.ok((await row.textContent()).includes('Unknown'));});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(__dirname,'request-controls-mobile-2026-10-06.png'),fullPage:true});
  await check('mobile no page overflow and no JavaScript errors',async()=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);assert.deepEqual(errors,[]);});
  console.log(JSON.stringify({passed:passed.length,failed:0,tests:passed,mode:'real Portal build and BFF; synthetic upstream, no business worker'},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();await shell?.close();if(upstream)await new Promise(resolve=>upstream.close(resolve));});
