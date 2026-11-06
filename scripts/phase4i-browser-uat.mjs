/**
 * Phase4I real-browser UAT with an IN-MEMORY synthetic isolated execution DB.
 * All identities, stock measurements and evidence in this script are fixtures,
 * NOT actual physical records or source authenticity proof.
 */
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'vite';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from './setup.mjs';
import {provisionLocalDriverUat} from './local-driver-uat.mjs';
import {createStagingApiHandler} from '../server/v1/staging-http.mjs';
import {createIsolatedExecutionSchema} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {extendUnifiedOperationalSchema} from '../server/v1/phase4g-schema.mjs';
import {extendPhase4E} from '../server/v1/phase4e-schema.mjs';
import {prepareOpeningBalance,approveOpeningBalance} from '../server/v1/phase4e-inventory-reconciliation.mjs';

const dir=await mkdtemp(path.join(os.tmpdir(),'aimoc-phase4i-browser-'));
const legacy=await createEmbeddedDatabase();
const execDb=await createEmbeddedDatabase();
let vite,server,chrome,ws;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 await bootstrap(legacy,path.join(dir,'access.json'));
 await provisionLocalDriverUat(legacy,{localOnly:true,accessPath:path.join(dir,'driver.json')});
 const admin=(await legacy.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='admin'")).rows[0];
 const driver=(await legacy.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='driver1'")).rows[0];
 const stock=(await legacy.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='stock1'")).rows[0];
 const src=(await legacy.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document.crushers[0].id;
 await createIsolatedExecutionSchema(execDb);
 await extendIsolatedExecutionSchema(execDb);
 await extendUnifiedOperationalSchema(execDb);
 await extendPhase4E(execDb);
 const q=(sql,args=[])=>execDb.query(sql,args);
 await q('INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t) VALUES($1,$2,0)',[src,'sku_browser']);
 await q('INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES($1,$2,$3)',
  ['driver_browser',driver.id,'UAT Simulated Driver']);
 await q(`INSERT INTO aimoc_execution_v1.driver_identity_bindings
  (driver_id,user_id,credential_authority,identity_evidence_ref,provisioned_by,verified_by,verified_at,status)
  VALUES($1,$2,'uat_fixture','qa_browser_identity_only','qa_provisioner','qa_independent_verifier',now(),'ACTIVE')`,
  ['driver_browser',driver.id]);
 await q("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck_browser',45)");
 await q('INSERT INTO aimoc_execution_v1.crusher_location_refs(crusher_id,crusher_name,source_stockpile_id,status) VALUES($1,$2,$3,$4)',
  ['crusher_browser','UAT Synthetic Crusher',src,'ACTIVE']);
 await q("INSERT INTO aimoc_execution_v1.loading_point_refs(loading_point_id,crusher_id,loading_point_name,verification_status) VALUES('point_browser','crusher_browser','UAT Loading Point','UNVERIFIED')");
 await q("INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission) VALUES($1,$2,'stockpile.loading.confirm')",[stock.id,src]);
 await q("INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission) VALUES($1,$2,'stockpile.departure.confirm')",[admin.id,src]);
 const opened=await prepareOpeningBalance(execDb,{actorId:stock.id,locationId:src,skuId:'sku_browser',
  measuredT:'100.000000',measurementRef:'qa_phase4i_opening',measuredAt:new Date(Date.now()-10000).toISOString(),
  evidenceDigest:createHash('sha256').update('SYNTHETIC UAT ONLY').digest('hex')});
 await approveOpeningBalance(execDb,{actorId:admin.id,reconciliationId:opened.reconciliation_id});
 const api=createStagingApiHandler({legacyDb:legacy,executionDb:execDb});
 vite=await createServer({server:{middlewareMode:true,host:'127.0.0.1',hmr:{port:9860+process.pid%100}},appType:'spa'});
 server=http.createServer((req,res)=>req.url.startsWith('/api')?api(req,res):vite.middlewares(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const users=JSON.parse(await readFile(path.join(dir,'access.json'),'utf8')).users;
 const account=users.find(x=>x.username==='admin');
 const login=await fetch(base+'/api/login',{method:'POST',
  headers:{Origin:base,'Content-Type':'application/json'},
  body:JSON.stringify({username:'admin',password:account.password})});
 if(login.status!==200)throw Error('TEST_ADMIN_LOGIN_FAILED '+login.status);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const browserPort=9460+process.pid%50;
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
  '--headless','--disable-gpu','--no-first-run','--remote-debugging-port='+browserPort,
  '--user-data-dir=/tmp/aimoc-phase4i-chrome-'+process.pid,'about:blank'],{stdio:'ignore'});
 let tabs=null;
 for(let n=0;n<55;n++){try{tabs=await(await fetch('http://127.0.0.1:'+browserPort+'/json')).json();break}catch{await sleep(160)}}
 if(!tabs)throw Error('CHROME_START_FAILED');
 ws=new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);
 let seq=0;const pending=new Map(),errors=[];
 ws.onmessage=e=>{
  const x=JSON.parse(e.data);
  if(x.id&&pending.has(x.id)){pending.get(x.id)(x);pending.delete(x.id)}
  if(x.method==='Runtime.exceptionThrown')errors.push(x.params.exceptionDetails.exception?.description||JSON.stringify(x.params.exceptionDetails));
 };
 await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
 const send=(method,params={})=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);ws.send(JSON.stringify({id,method,params}))});
 const evaljs=async expression=>{
  const x=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(x.result?.exceptionDetails)throw Error('CDP_JS '+JSON.stringify(x.result.exceptionDetails));
  return x.result?.result?.value;
 };
 await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
 const [name,value]=cookie.split('=');
 await send('Network.setCookie',{name,value,url:base,httpOnly:true});
 await send('Page.navigate',{url:base+'/admin/dispatch/planning'});
 await sleep(1900);
 const headings=await evaljs("JSON.stringify([...document.querySelectorAll('.af-panel h2')].map(x=>x.textContent))");
 if(!headings.includes('Execute Dispatch'))throw Error('STAGING_EXECUTION_FORM_MISSING '+headings);
 const select=async(index,value)=>{
  const code="(()=>{let el=document.querySelectorAll('.af-staging-fields select')["+index+"];el.value="+JSON.stringify(value)+";el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})()";
  const got=await evaljs(code);if(got!==value)throw Error('SELECT_FAILED '+index+':'+got);
  await sleep(110);
 };
 const type=async(index,value)=>{
  const code="(()=>{let el=document.querySelectorAll('.af-staging-fields input')["+index+"];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,"+JSON.stringify(value)+");el.dispatchEvent(new Event('input',{bubbles:true}));return el.value})()";
  const got=await evaljs(code);if(got!==value)throw Error('INPUT_FAILED '+index);
  await sleep(100);
 };
 await select(1,src+'::sku_browser');
 await select(2,'crusher_browser');
 await select(3,'point_browser');
 await type(0,'receiving_qa');
 await type(1,'20.000000');
 await select(4,'truck_browser');
 await select(5,'driver_browser');
 const ready=await evaljs("JSON.stringify({disabled:document.querySelector('.af-staging-primary')?.disabled,selectedDriver:document.querySelectorAll('.af-staging-fields select')[5]?.value,selectedTruck:document.querySelectorAll('.af-staging-fields select')[4]?.value})");
 if(JSON.parse(ready).disabled)throw Error('CREATE_BUTTON_DISABLED '+ready);
 await evaljs("document.querySelector('.af-staging-primary').click()");
 await sleep(1150);
 const created=await evaljs("JSON.stringify({detail:document.querySelector('.af-staging-created')?.innerText||null,error:document.querySelector('.af-staging-form [role=alert]')?.innerText||null})");
 if(!JSON.parse(created).detail)throw Error('CREATE_FAILED '+created);
 await evaljs("document.querySelectorAll('.af-staging-created button')[0]?.click()");
 await sleep(750);
 const afterReserve=await evaljs("JSON.stringify({reserveDisabled:document.querySelectorAll('.af-staging-created button')[0]?.disabled,startDisabled:document.querySelectorAll('.af-staging-created button')[1]?.disabled,error:document.querySelector('.af-staging-form [role=alert]')?.innerText||null})");
 if(!JSON.parse(afterReserve).reserveDisabled||JSON.parse(afterReserve).startDisabled)throw Error('RESERVE_FAILED '+afterReserve);
 await evaljs("document.querySelectorAll('.af-staging-created button')[1]?.click()");
 await sleep(850);
 const rows=(await q('SELECT t.id,t.status,t.driver_id,t.truck_id,d.mode,d.source_stockpile_id FROM aimoc_execution_v1.trips t JOIN aimoc_execution_v1.dispatches d ON d.id=t.dispatch_id')).rows;
 if(rows.length!==1||rows[0].driver_id!=='driver_browser'||rows[0].status!=='START_AUTHORIZED')
  throw Error('PERSISTED_STATE_INCORRECT '+JSON.stringify(rows));
 await mkdir('qa/phase4i/screenshots',{recursive:true});
 const snapshot=await send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
 await writeFile('qa/phase4i/screenshots/staging-dispatch-execution-uat.png',Buffer.from(snapshot.result.data,'base64'));
 if(errors.length)throw Error('BROWSER_RUNTIME_EXCEPTIONS: '+JSON.stringify(errors));
 console.log(JSON.stringify({scope:'IN_MEMORY_SYNTHETIC_BROWSER_UAT',result:'PASS',
  browser_path:'/admin/dispatch/planning',driver:'UAT SYNTHETIC (not production verified)',
  dispatches_created:rows.length,trip_status:rows[0].status,
  truck_id:rows[0].truck_id,driver_id:rows[0].driver_id,
  wim_tare_real:false,errors},null,2));
}finally{
 ws?.close();chrome?.kill();
 if(server)await new Promise(resolve=>server.close(resolve));
 if(vite)await vite.close();
 await execDb.close();await legacy.close();
 await rm(dir,{recursive:true,force:true});
}
