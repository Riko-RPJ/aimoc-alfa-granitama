import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {hash} from '../server/auth.mjs';
import {createHandler} from '../server/handler.mjs';

const definition=(extra={})=>({transferMode:'MARINE',destinationLocationId:'stockpile-location-crusher-2',jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:30,unit:'t'}],...extra});
const physical=s=>structuredClone(Object.fromEntries(['stockpiles','trucks','vessels','dispatches','trips','inventoryLedger','erpOutbox'].map(key=>[key,s[key]])));

test('persistent HTTP request lifecycle enforces target CAS, replay, role/history guards and serializes edit/cancel versus planning',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'aimoc-request-edit-cancel-')),databasePath=join(directory,'database');
 let db=await createEmbeddedDatabase(databasePath),server;
 t.after(async()=>{
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(db)await db.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep),'Delete only the test-created temporary directory');
  await rm(directory,{recursive:true,force:true});
 });
 await bootstrap(db);
 await db.query("INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role) VALUES('edit-driver','edit-driver','Synthetic Edit Driver','synthetic-unused-login-hash','driver')");
 const actors={};
 for(const user of(await db.query('SELECT id,username,role FROM aimoc_alfa_ops.users')).rows){
  const session=('synthetic-edit-cancel-'+user.username).padEnd(64,'x');
  await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic-edit-csrf',now()+interval '1 hour')",[hash(session),user.id]);
  actors[user.username]={...user,cookie:'alfa_session='+session};
 }
 const start=async()=>{server=http.createServer(createHandler(db));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));};
 await start();
 const call=async(path,method='GET',body,user='admin')=>{
  const origin='http://127.0.0.1:'+server.address().port,response=await fetch(origin+path,{method,headers:{Cookie:actors[user].cookie,...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':'synthetic-edit-csrf'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()};
 };
 const action=(action,payload,extra={},user='admin')=>call('/api/v1/demo/actions','POST',{action,payload,requestId:randomUUID(),...extra},user);
 const ok=async(...args)=>{const response=await action(...args);assert.equal(response.status,200,JSON.stringify(response.body));return response.body;};
 const context=async()=>{const response=await call('/api/v1/demo/context');assert.equal(response.status,200);return response.body;};
 const stored=async()=>(await db.query('SELECT document,revision,updated_at FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 const snapshot=async()=>({operation:await stored(),actions:(await db.query('SELECT actor_id,request_id,payload_hash,result FROM aimoc_alfa_ops.actions ORDER BY actor_id,request_id')).rows});
 const request=async(extra={})=>(await ok('request.create',definition(extra))).result.requestId;
 const edit=(requestId,expectedRequestRevision,extra={})=>({requestId,expectedRequestRevision,...definition(extra)});
 const a=await request(),b=await request(),beforeEdit=await stored(),first=beforeEdit.document.requests.find(row=>row.id===a);
 assert.equal((await context()).state.requests.find(row=>row.id===a).canEdit,true);

 // A request changed elsewhere advances the global document; target-scoped
 // edits must preserve it while accepting an unchanged target's older form.
 await ok('request.update',edit(b,1,{lines:[{skuId:'abu-batu',quantity:12,unit:'m3'}]}));
 const key=randomUUID(),updated=await ok('request.update',edit(a,1,{lines:[{skuId:'basecourse',quantity:20,unit:'m3'}]}),{requestId:key,expectedRevision:Number(beforeEdit.revision)});
 assert.equal(updated.result.requestRevision,2);assert.equal(updated.state.requests.find(row=>row.id===b).lines[0].quantity,12);
 const current=updated.state.requests.find(row=>row.id===a);assert.equal(current.id,a);assert.equal(current.code,first.code);assert.equal(current.createdAt,first.createdAt);assert.equal(current.requestedBy,first.requestedBy);assert.equal(current.lines[0].tonnageT,33);
 assert.deepEqual(physical((await stored()).document),physical(beforeEdit.document));
 const saved=await snapshot(),replay=await action('request.update',edit(a,1,{lines:[{skuId:'basecourse',quantity:20,unit:'m3'}]}),{requestId:key,expectedRevision:Number(beforeEdit.revision)});
 assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.deepEqual(await snapshot(),saved,'Replay creates no extra event, revision or receipt');
 assert.equal((await action('request.update',edit(a,1),{requestId:key})).body.error,'IDEMPOTENCY_CONFLICT');assert.deepEqual(await snapshot(),saved);
 const stale=await action('request.update',edit(a,1),{expectedRevision:updated.revision});assert.equal(stale.status,409);assert.equal(stale.body.error,'REQUEST_REVISION_CONFLICT');assert.deepEqual(await snapshot(),saved);
 for(const expectedRevision of [0,'1',1.5]){const invalid=await action('request.update',edit(a,2),{expectedRevision});assert.equal(invalid.status,400);assert.equal(invalid.body.error,'INVALID_REVISION');}
 const future=await action('request.update',edit(a,2),{expectedRevision:updated.revision+1000});assert.equal(future.status,409);assert.equal(future.body.error,'REVISION_CONFLICT');assert.deepEqual(await snapshot(),saved);
 for(const username of ['stock1','jetty1','edit-driver'])for(const name of ['request.update','request.cancel']){const denied=await action(name,edit(a,2),{},username);assert.equal(denied.status,403);}
 for(const name of ['request.update','request.cancel']){const legacy=await call('/api/action','POST',{action:name,payload:edit(a,2),requestId:randomUUID()});assert.ok([403,409].includes(legacy.status));}
 assert.deepEqual(await snapshot(),saved,'Rejected role, legacy and revision probes are read-only');

 const c=await request(),cancelBefore=physical((await stored()).document),cancelKey=randomUUID();
 const cancelled=await ok('request.cancel',{requestId:c,expectedRequestRevision:1,reason:'Synthetic cancellation'},{requestId:cancelKey});
 assert.equal(cancelled.state.requests.find(row=>row.id===c).status,'cancelled');assert.equal(cancelled.state.requests.find(row=>row.id===c).cancelReason,'Synthetic cancellation');assert.deepEqual(physical((await stored()).document),cancelBefore);
 const cancelSnapshot=await snapshot(),cancelReplay=await action('request.cancel',{requestId:c,expectedRequestRevision:1,reason:'Synthetic cancellation'},{requestId:cancelKey});assert.equal(cancelReplay.status,200);assert.equal(cancelReplay.body.replayed,true);assert.deepEqual(await snapshot(),cancelSnapshot);
 for(const [name,payload] of [['request.plan',{requestId:c}],['request.update',edit(c,2)],['request.cancel',{requestId:c,expectedRequestRevision:2}]]){const denied=await action(name,payload);assert.equal(denied.status,409);assert.equal(denied.body.error,'REQUEST_CANCELLED');}
 assert.deepEqual(await snapshot(),cancelSnapshot);

 // Competing Admin drafts: a single winner even when both omit the optional
 // global revision. The target revision is mandatory and checked under lock.
 const d=await request(),competing=await Promise.all([
  action('request.update',edit(d,1,{lines:[{skuId:'split-12',quantity:15,unit:'t'}]})),
  action('request.update',edit(d,1,{lines:[{skuId:'split-12',quantity:18,unit:'t'}]}))
 ]);
 assert.deepEqual(competing.map(row=>row.status).sort(),[200,409]);assert.equal(competing.find(row=>row.status===409).body.error,'REQUEST_REVISION_CONFLICT');assert.equal((await stored()).document.requests.find(row=>row.id===d).requestRevision,2);

 const e=await request(),editPlan=await Promise.all([
  action('request.update',edit(e,1,{lines:[{skuId:'split-12',quantity:25,unit:'t'}]})),
  action('request.plan',{requestId:e})
 ]);
 assert.equal(editPlan[1].status,200,JSON.stringify(editPlan));assert.ok([200,409].includes(editPlan[0].status));
 const planned=(await stored()).document,plannedRequest=planned.requests.find(row=>row.id===e);
 assert.equal(planned.dispatches.filter(row=>row.requestId===e).length,1);assert.equal(plannedRequest.status,'planned');
 assert.equal(planned.dispatches.find(row=>row.requestId===e).tonnageT,editPlan[0].status===200?25:30,'Planner uses the winning current definition');
 const plannedSnapshot=await snapshot();assert.equal((await action('request.update',edit(e,plannedRequest.requestRevision))).status,409);assert.equal((await action('request.cancel',{requestId:e,expectedRequestRevision:plannedRequest.requestRevision})).status,409);assert.deepEqual(await snapshot(),plannedSnapshot);

 const f=await request(),cancelPlan=await Promise.all([
  action('request.cancel',{requestId:f,expectedRequestRevision:1}),action('request.plan',{requestId:f})
 ]);
 assert.deepEqual(cancelPlan.map(row=>row.status).sort(),[200,409]);
 const afterRace=(await stored()).document,finalRequest=afterRace.requests.find(row=>row.id===f);assert.equal(afterRace.dispatches.filter(row=>row.requestId===f).length,finalRequest.status==='cancelled'?0:1);

 // A paced runner on another request also advances the global revision. An
 // unchanged form stays safe and usable without overwriting runner progress.
 await ok('quarry.config.save',{enabled:true,model:'STATIC_WIM'});
 const runner=await request();await ok('request.plan',{requestId:runner});const formRevision=(await context()).revision;
 await ok('quarry.demo',{requestId:runner,command:'start',tareT:15});const run=(await stored()).document.requests.find(row=>row.id===runner).demoRun;
 await ok('quarry.demo',{requestId:runner,command:'step',runId:run.id,rounds:1});const runnerBefore=structuredClone((await stored()).document.requests.find(row=>row.id===runner));
 await ok('request.update',edit(b,2,{lines:[{skuId:'abu-batu',quantity:14,unit:'m3'}]}),{expectedRevision:formRevision});assert.deepEqual((await stored()).document.requests.find(row=>row.id===runner),runnerBefore);

 // Durable planned history must reject manual status reset, including a
 // cancelled dispatch. These fixture writes emulate corrupted legacy state.
 const corrupted=(await stored()).document,corrupt=corrupted.requests.find(row=>row.id===e);corrupt.status='requested';delete corrupt.plannedAt;delete corrupt.plannedBy;delete corrupt.dispatchId;delete corrupt.planningStatus;
 corrupted.dispatches.filter(row=>row.requestId===e).forEach(row=>row.status='cancelled');await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(corrupted)]);
 const corruptSnapshot=await snapshot();for(const [name,payload] of [['request.update',edit(e,corrupt.requestRevision)],['request.cancel',{requestId:e,expectedRequestRevision:corrupt.requestRevision}],['request.plan',{requestId:e}]]){const denied=await action(name,payload);assert.equal(denied.status,409);assert.equal(denied.body.error,'REQUEST_ALREADY_PLANNED');}assert.deepEqual(await snapshot(),corruptSnapshot);
 const final=await stored();
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;await db.close();db=null;
 db=await createEmbeddedDatabase(databasePath);await start();const reopened=await context();
 assert.equal(reopened.revision,Number(final.revision));assert.equal(reopened.state.requests.find(row=>row.id===a).lines[0].tonnageT,33);assert.equal(reopened.state.requests.find(row=>row.id===c).status,'cancelled');assert.equal(reopened.state.requests.find(row=>row.id===e).canEdit,false);
 assert.deepEqual((await stored()).document,final.document,'Database reopen preserves edits, cancellation, evidence and unrelated runner state');
});
