import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {hash} from '../server/auth.mjs';

test('authenticated survey quantities persist original units, canonical stock and immutable conversion snapshot',async t=>{
 const db=await createEmbeddedDatabase();await bootstrap(db);
 const actors={};
 for(const u of (await db.query('SELECT * FROM aimoc_alfa_ops.users')).rows){
  const token=u.username.padEnd(43,'z');await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'csrf-units',now()+interval '1 hour')",[hash(token),u.id]);
  actors[u.username]={cookie:'alfa_session='+token,csrf:'csrf-units'};
 }
 const server=http.createServer(createHandler(db));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await db.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 const call=async(path,method='GET',body,actor='admin')=>{
  const a=actors[actor]||{},r=await fetch(origin+path,{method,headers:{...(a.cookie?{Cookie:a.cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':a.csrf||''}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')};
 };
 const action=(action,payload,actor='admin',extra={})=>call('/api/action','POST',{action,payload,requestId:randomUUID(),...extra},actor);
 const doc=async()=>(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 const pileId='stock-1-3',payload={stockpileId:pileId,skuId:'split-12',method:'manual',quantityValue:150,quantityUnit:'t',notes:'Synthetic calibrated field survey'};
 const before=await doc(),key=randomUUID();
 const created=await action('measurement.create',payload,'admin',{requestId:key,expectedRevision:Number(before.revision)});assert.equal(created.status,200,JSON.stringify(created.body));
 const id=created.body.result.entityId,stored=(await doc()).document.measurements.find(m=>m.id===id);
 assert.deepEqual({quantityValue:stored.quantityValue,quantityUnit:stored.quantityUnit,volumeM3:stored.volumeM3,tonnageT:stored.tonnageT,density:stored.densityTPerM3Snapshot},{quantityValue:150,quantityUnit:'t',volumeM3:100,tonnageT:150,density:1.5});
 assert.equal((await doc()).document.stockpiles.find(p=>p.id===pileId).onHandM3,before.document.stockpiles.find(p=>p.id===pileId).onHandM3);
 const replay=await action('measurement.create',payload,'admin',{requestId:key,expectedRevision:Number(before.revision)});assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.body.result.entityId,id);
 assert.equal((await action('measurement.create',{...payload,quantityValue:151},'admin',{requestId:key})).status,409);
 assert.equal((await doc()).document.measurements.filter(m=>m.id===id).length,1);

 const deniedBefore=await doc();
 for(const [actor,attempt] of [['stock2',payload],['jetty1',payload],['admin',{...payload,volumeM3:999}],['admin',{...payload,densityTPerM3Snapshot:1}],['admin',{...payload,tonnageT:999}],['admin',{...payload,quantityUnit:'kg'}]]){
  const r=await action('measurement.create',attempt,actor);assert.ok([400,403].includes(r.status),JSON.stringify(r.body));
 }
 assert.deepEqual(await doc(),deniedBefore,'Rejected requests must not persist partial state or advance revision');
 assert.equal((await action('measurement.approve',{measurementId:id},'stock1')).status,403);
 const change=await action('master.product.save',{id:'split-12',densityTPerM3:2});assert.equal(change.status,200,JSON.stringify(change.body));
 const approved=await action('measurement.approve',{measurementId:id});assert.equal(approved.status,200,JSON.stringify(approved.body));
 const persisted=(await doc()).document,record=persisted.measurements.find(m=>m.id===id);
 assert.equal(record.status,'approved');assert.equal(record.quantityValue,150);assert.equal(record.quantityUnit,'t');assert.equal(record.densityTPerM3Snapshot,1.5);assert.equal(record.volumeM3,100);
 assert.equal(persisted.stockpiles.find(p=>p.id===pileId).onHandM3,100);
 const intent=persisted.erpOutbox.find(e=>e.entityId===id).payload;assert.equal(intent.quantityValue,150);assert.equal(intent.quantityUnit,'t');assert.equal(intent.volumeM3,100);assert.equal(intent.densityTPerM3Snapshot,1.5);
 const afterApproval=await doc();assert.equal((await action('measurement.approve',{measurementId:id})).status,409);assert.deepEqual(await doc(),afterApproval);
 const stockCreated=await action('measurement.create',{...payload,quantityValue:120,quantityUnit:'m3'},'stock1');assert.equal(stockCreated.status,200,JSON.stringify(stockCreated.body));
 const stockMeasure=(await doc()).document.measurements.find(m=>m.id===stockCreated.body.result.entityId);assert.equal(stockMeasure.quantityValue,120);assert.equal(stockMeasure.quantityUnit,'m3');assert.equal(stockMeasure.tonnageT,240);assert.equal(stockMeasure.densityTPerM3Snapshot,2);
 const stockView=await call('/api/v1/demo/context','GET',undefined,'stock1');assert.ok(stockView.body.state.measurements.every(m=>m.crusherId==='crusher-1'));
 assert.equal((await call('/api/v1/demo/context','GET',undefined,'jetty1')).body.state.measurements.length,0);
 const legacy=await action('measurement.create',{stockpileId:pileId,method:'manual',volumeM3:80},'stock1');assert.equal(legacy.status,200);assert.equal(legacy.body.state.measurements.find(m=>m.id===legacy.body.result.entityId).quantityUnit,'m3');
});
