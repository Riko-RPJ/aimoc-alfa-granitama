import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {installLocalTruckQrUat} from '../server/truck-qr-uat.mjs';
import {applyAction} from '../server/domain.mjs';
import {hash} from '../server/auth.mjs';

test('truck code QR UAT unlocks tasks and enforces serialized start and completion without operational mutations',async()=>{
 const db=await createEmbeddedDatabase();
 await bootstrap(db);
 const admin={id:'qa-admin',role:'admin',name:'QA Admin'};
 const row=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 const state=row.document;
 const request=applyAction(state,'request.create',{jettyId:'jetty-1',vesselId:'vessel-1',destination:'UAT',
  lines:[{skuId:'split-12',quantity:28,unit:'m3'}]},admin);
 applyAction(state,'request.plan',{requestId:request.entityId},admin);
 // Two genuine test-trip records on one truck, without production evidence.
 const firstTrip=state.trips[0];
 const nextTrip={...firstTrip,id:'qa-trip-serial-2',code:'RIT-UAT-SECOND',sequence:firstTrip.sequence+1};
 state.trips.push(nextTrip);
 state.dispatches[0].tripIds.push(nextTrip.id);
 await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(state)]);
 const old=process.env.AIMOC_LOCAL_TRUCK_CODE_UAT;
 process.env.AIMOC_LOCAL_TRUCK_CODE_UAT='1';
 await installLocalTruckQrUat(db);
 const server=http.createServer(createHandler(db));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const accessToken='test-truck-access-token';
 const call=async(code,route='/api/driver/truck-tasks')=>{
  const res=await fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({truckCode:code})});
  return {status:res.status,payload:await res.json()};
 };
 try{
  const truck=state.trucks.find(t=>state.trips.some(x=>x.truckId===t.id));
  const awaiting=await call(truck.code);
  assert.equal(awaiting.status,403);
  await db.query(`INSERT INTO aimoc_alfa_ops.truck_qr_uat_events
   (trip_id,truck_id,actor_id,source,access_token_hash)
   VALUES($1,$2,'test-admin','ADMIN_SIMULATED_QR_UAT',$3)`,[state.trips[0].id,truck.id,hash(accessToken)]);
  const valid=await call(truck.code);
  assert.equal(valid.status,200,JSON.stringify(valid.payload));
  assert.equal(valid.payload.source,'LOCAL_UAT_LEGACY');
  assert.equal(valid.payload.access,'TRUCK_CODE_UAT_SIMULATION_ONLY');
  assert.equal(valid.payload.qr_scan,'PHYSICAL_NOT_VERIFIED');
  assert.equal(valid.payload.trips.length,2,'One truck QR opens both queued tasks');
  assert.equal(valid.payload.trips[0].uatCanStart,true);
  assert.equal(valid.payload.trips[1].uatCanStart,false);
  assert.ok(valid.payload.trips.every(x=>x.truckCode===truck.code));
  assert.equal(valid.payload.trips[0].requestCode,state.requests[0].code);
  assert.equal(valid.payload.trips[0].dispatchCode,state.dispatches[0].code);
  assert.equal(valid.payload.trips[0].status,'queued');
  assert.equal(valid.payload.trips[0].qrAccess.source,'ADMIN_SIMULATED_QR_UAT');
  assert.equal(valid.payload.trips[0].qrAccess.physicalScanVerified,false);
  assert.equal(valid.payload.truck.availability,'ALLOCATED');
  const progress=async(tripId,action,code=truck.code)=>{
    const res=await fetch(base+'/api/driver/truck-task-action',{
      method:'POST',headers:{Origin:base,'Content-Type':'application/json'},
      body:JSON.stringify({truckCode:code,tripId,action})});
    return {status:res.status,body:await res.json()};
  };
  const wrong=await progress(firstTrip.id,'START','DT-012');
  assert.equal(wrong.status,403,'Other truck cannot control these tasks');
  const [earlyA,earlyB]=await Promise.all([
    progress(nextTrip.id,'START'),progress(nextTrip.id,'START')
  ]);
  assert.deepEqual([earlyA.status,earlyB.status],[409,409]);
  const start=await progress(firstTrip.id,'START');
  assert.equal(start.status,200,JSON.stringify(start.body));
  assert.equal(start.body.status,'IN_PROGRESS');
  assert.equal(start.body.physicalTripStatusChanged,false);
  assert.equal((await progress(nextTrip.id,'START')).status,409,'Second trip cannot start early');
  const current=await call(truck.code);
  assert.equal(current.payload.trips[0].uatCanComplete,true);
  assert.equal(current.payload.trips[1].uatCanStart,false);
  assert.equal((await progress(firstTrip.id,'START')).body.replayed,true);
  const finish=await progress(firstTrip.id,'COMPLETE');
  assert.equal(finish.status,200);
  assert.equal(finish.body.status,'COMPLETED');
  assert.equal((await progress(firstTrip.id,'COMPLETE')).body.replayed,true);
  const afterFirst=await call(truck.code);
  assert.equal(afterFirst.payload.trips[0].uatTaskStatus,'COMPLETED');
  assert.equal(afterFirst.payload.trips[1].uatCanStart,true);
  assert.equal((await progress(nextTrip.id,'COMPLETE')).status,409);
  const secondStart=await progress(nextTrip.id,'START');
  assert.equal(secondStart.status,200);
  const secondFinish=await progress(nextTrip.id,'COMPLETE');
  assert.equal(secondFinish.status,200);
  const afterBoth=await call(truck.code);
  assert.equal(afterBoth.payload.trips.filter(t=>t.uatTaskStatus==='COMPLETED').length,2);
  assert.equal(afterBoth.payload.trips.filter(t=>t.uatCanStart).length,0);
  assert.equal(afterBoth.payload.truck.availability,'DEMO_AVAILABLE');
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM aimoc_alfa_ops.truck_task_uat_progress')).rows[0].n,2);

  const other=await call('DT-012');
  assert.equal(other.status,403);
  assert.equal((await call('UNKNOWN')).status,400);
  assert.equal((await call('DT-999')).status,404);
  const canModify=await fetch(base+'/api/action',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({action:'trip.start',tripId:state.trips[0].id})});
  assert.equal(canModify.status,401);
  const after=(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
  assert.equal(after.document.trips[0].status,'queued');
  const get=await fetch(base+'/api/driver/truck-tasks');
  assert.equal(get.status,405);
 }finally{
  await new Promise(r=>server.close(r));
  await db.close();
  if(old===undefined)delete process.env.AIMOC_LOCAL_TRUCK_CODE_UAT;else process.env.AIMOC_LOCAL_TRUCK_CODE_UAT=old;
 }
});
