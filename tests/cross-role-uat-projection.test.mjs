import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {installLocalTruckQrUat} from '../server/truck-qr-uat.mjs';
import {hash,passwordHash} from '../server/auth.mjs';
import {applyAction,publicState} from '../server/domain.mjs';

test('shared UAT progress read model follows one trip and respects Admin/Stockpile/Jetty scopes',async()=>{
 const db=await createEmbeddedDatabase();
 await bootstrap(db);
 const state=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
 const request=applyAction(state,'request.create',{jettyId:'jetty-1',vesselId:'vessel-1',
  destination:'Marunda UAT',lines:[{skuId:'split-12',quantity:28,unit:'m3'}]},
 {id:'audit-jetty',role:'jetty',jettyIds:['jetty-1']});
 applyAction(state,'request.plan',{requestId:request.entityId},{id:'audit-admin',role:'admin'});
 await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb',[JSON.stringify(state)]);
 const old=process.env.AIMOC_LOCAL_TRUCK_CODE_UAT;
 process.env.AIMOC_LOCAL_TRUCK_CODE_UAT='1';
 await installLocalTruckQrUat(db);
 const password='CrossRoleUatSafePassphrase2026';
 await db.query('UPDATE aimoc_alfa_ops.users SET password_hash=$1',[await passwordHash(password)]);
 const server=http.createServer(createHandler(db));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const call=async(path,{method='GET',body,session}={})=>{
  const r=await fetch(base+path,{method,headers:{...(method==='POST'?{Origin:base,'Content-Type':'application/json'}:{}),
   ...(session?{Cookie:session}:{} )},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')};
 };
 const login=async username=>{
  const r=await call('/api/login',{method:'POST',body:{username,password}});
  assert.equal(r.status,200,username);
  return r.cookie.split(';')[0];
 };
 try{
  const [admin,stock1,stock2,jetty1,jetty2]=await Promise.all(['admin','stock1','stock2','jetty1','jetty2'].map(login));
  const trip=state.trips[0],truck=state.trucks.find(t=>t.id===trip.truckId);
  const accessToken='cross-role-uat-truck-token';
  assert.equal(trip.crusherId,'crusher-2');
  assert.equal((await call('/api/uat/truck-task-status')).status,401);
  const get=async(session)=>call('/api/uat/truck-task-status',{session});
  assert.equal((await get(stock1)).body.items.length,0);
  assert.equal((await get(jetty2)).body.items.length,0);
  assert.equal((await get(stock2)).body.items.length,1);
  assert.equal((await get(jetty1)).body.items.length,1);
  assert.equal((await get(admin)).body.items.length,1);
  assert.equal((await get(admin)).body.items[0].task_uat_status,'QR_PENDING');
  await db.query("INSERT INTO aimoc_alfa_ops.truck_qr_uat_events(trip_id,truck_id,actor_id,source,access_token_hash) VALUES($1,$2,'audit-admin','ADMIN_SIMULATED_QR_UAT',$3)",[trip.id,truck.id,hash(accessToken)]);
  for(const cookie of [admin,stock2,jetty1]){
   const r=await get(cookie);
   assert.equal(r.body.items[0].qr_uat_scanned,true);
   assert.equal(r.body.items[0].task_uat_status,'WAITING');
   assert.equal(r.body.items[0].legacy_status,'queued');
   assert.equal(r.body.operational_status_unchanged,true);
  }
  const write=async action=>{
   const r=await call('/api/driver/truck-task-action',{method:'POST',body:{truckCode:truck.code,tripId:trip.id,action}});
   assert.equal(r.status,200,JSON.stringify(r.body));
  };
  await write('START');
  for(const cookie of [admin,stock2,jetty1]){
   const r=await get(cookie);
   assert.equal(r.body.items[0].task_uat_status,'IN_PROGRESS');
   assert.equal(r.body.items[0].legacy_status,'queued');
  }
  await write('COMPLETE');
  for(const cookie of [admin,stock2,jetty1]){
   const r=await get(cookie);
   assert.equal(r.body.items[0].task_uat_status,'COMPLETED');
   assert.equal(r.body.items[0].legacy_status,'queued');
  }
  assert.equal((await get(stock1)).body.items.length,0);
  assert.equal((await get(jetty2)).body.items.length,0);
  const end=(await db.query('SELECT revision,document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
  assert.equal(end.document.trips[0].status,'queued');
  assert.equal(end.document.inventoryLedger.length,0);
  assert.equal(end.document.erpOutbox.length,0);
 }finally{
  await new Promise(r=>server.close(r));
  await db.close();
  if(old===undefined)delete process.env.AIMOC_LOCAL_TRUCK_CODE_UAT;
  else process.env.AIMOC_LOCAL_TRUCK_CODE_UAT=old;
 }
});
