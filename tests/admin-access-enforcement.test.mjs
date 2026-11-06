import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {hash} from '../server/auth.mjs';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {authorizeLegacyAction,permissionsForRole,TARGET_ADMIN_CAPABILITIES} from '../server/role-permissions.mjs';
import {legacyPageFromPath,legacyPathForPage,legacyNavigationByRole} from '../src/app/navigation.js';

test('Admin role permission catalog is explicit and target-only features remain disabled',()=>{
 assert.equal(authorizeLegacyAction('admin','request.plan').allowed,true);
 assert.equal(authorizeLegacyAction('admin','measurement.create').allowed,true);
 assert.equal(authorizeLegacyAction('admin','measurement.approve').allowed,true);
 assert.equal(authorizeLegacyAction('stock','measurement.create').allowed,true);
 assert.equal(authorizeLegacyAction('admin','master.truck.save').allowed,true);
 assert.equal(authorizeLegacyAction('admin','master.truck.delete').allowed,true);
 assert.equal(authorizeLegacyAction('stock','master.truck.delete').allowed,false);
 assert.equal(authorizeLegacyAction('admin','trip.depart').allowed,true);
 assert.equal(authorizeLegacyAction('admin','trip.unload').allowed,false);
 assert.equal(authorizeLegacyAction('stock','trip.depart').allowed,false);
 assert.equal(authorizeLegacyAction('stock','request.plan').allowed,false);
 assert.equal(authorizeLegacyAction('stock','request.create').allowed,false);
 assert.equal(authorizeLegacyAction('stock','master.product.save').allowed,false);
 assert.equal(authorizeLegacyAction('jetty','trip.unload').allowed,true);
 assert.equal(authorizeLegacyAction('driver','request.create').allowed,false);
 assert.equal(authorizeLegacyAction('admin','driver.assign').allowed,false);
 assert.equal(authorizeLegacyAction('admin','weighbridge.override').allowed,false);
 assert.ok(TARGET_ADMIN_CAPABILITIES.some(x=>x.id==='reconciliation'&&x.state==='NOT_INTEGRATED'));
 assert.equal(legacyPageFromPath('admin','/admin/access-control'),'access');
 assert.equal(legacyPathForPage('admin','access'),'/admin/access-control');
 assert.ok(!legacyNavigationByRole.stock.includes('access'));
 assert.ok(!permissionsForRole('stock').some(x=>x.startsWith('transfer.')||x.startsWith('dispatch.')));
 assert.ok(permissionsForRole('stock').includes('stockpile.pickups.loading.confirm'));
});
test('real backend capabilities endpoint matches role and rejects forbidden state mutations',async()=>{
 const db=await createEmbeddedDatabase();
 let server;
 try{
  await bootstrap(db);
  const rows=(await db.query('SELECT id,username,role FROM aimoc_alfa_ops.users WHERE active=true')).rows;
  // Use direct seeded login credential from isolated bootstrap? No credentials need
  // be read: build test sessions with explicit short-lived CSRF tokens.
  for(const row of rows){
   await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'csrf-test',now()+interval '1 hour')",[hash(row.username.padEnd(43,'x')),row.id]);
  }
  server=http.createServer(createHandler(db));
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const origin='http://127.0.0.1:'+server.address().port;
  const response=async(role,method,path,body)=>{
   const cookie='alfa_session='+role.padEnd(43,'x');
   const res=await fetch(origin+path,{method,headers:{
    Cookie:cookie,...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':'csrf-test'}:{})},
    ...(method==='POST'?{body:JSON.stringify(body)}:{})});
   return {status:res.status,data:await res.json()};
  };
  for(const row of rows){
   const result=await response(row.username,'GET','/api/capabilities');
   assert.equal(result.status,200);
   assert.equal(result.data.role,row.role);
   assert.deepEqual(result.data.permissions,permissionsForRole(row.role));
   assert.equal(result.data.targetWritesEnabled,false);
  }
  const stock1=rows.find(x=>x.username==='stock1');
  const admin=rows.find(x=>x.role==='admin');
  const jetty1=rows.find(x=>x.username==='jetty1');
  const stockState=await response(stock1.username,'GET','/api/state');
  assert.equal(stockState.status,200);
  assert.ok(stockState.data.state.stockpiles.every(x=>x.crusherId==='crusher-1'));
  assert.deepEqual(stockState.data.state.requests,[]);
  assert.deepEqual(stockState.data.state.dispatches,[]);
  assert.deepEqual(stockState.data.state.trucks,[]);
  const crossRead=await response(stock1.username,'GET','/api/v1/inventory?stockpile_id=stock-2-1');
  assert.deepEqual(crossRead.data.data.items,[]);
  assert.equal((await response(stock1.username,'GET','/api/v1/transfer-requests')).status,403);
  assert.equal((await response(stock1.username,'GET','/api/v1/dispatches')).status,403);
  const adminSurvey=await response(admin.username,'POST','/api/action',{requestId:'admin-survey-measurement',action:'measurement.create',payload:{stockpileId:'stock-1-1',method:'manual',quantityValue:750,quantityUnit:'t'}});
  assert.equal(adminSurvey.status,200);
  const adminMeasurement=adminSurvey.data.state.measurements.find(m=>m.id===adminSurvey.data.result.entityId);
  assert.equal(adminMeasurement.quantityValue,750);
  assert.equal(adminMeasurement.quantityUnit,'t');
  assert.equal(adminMeasurement.volumeM3,500);
  const beforeDenied=Number((await db.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision);
  for(const action of ['request.create','request.plan','master.product.save']){
   const denied=await response(stock1.username,'POST','/api/action',{requestId:'deny-'+action.replaceAll('.','-'),action,payload:{role:'admin',crusherIds:['crusher-2']}});
   assert.equal(denied.status,403,action);
  }
  assert.equal(Number((await db.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision),beforeDenied);
  const crossWrite=await response(stock1.username,'POST','/api/action',{requestId:'cross-location-measurement',action:'measurement.create',payload:{stockpileId:'stock-2-1',method:'manual',volumeM3:700}});
  assert.equal(crossWrite.status,403);
  const allowed=await response(stock1.username,'POST','/api/action',{requestId:'own-location-measurement',action:'measurement.create',payload:{stockpileId:'stock-1-1',method:'manual',volumeM3:700}});
  assert.equal(allowed.status,200);
  assert.ok(allowed.data.state.measurements.every(x=>x.crusherId==='crusher-1'));
  const operation=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
  operation.crushers.find(x=>x.id==='crusher-2').active=false;
  await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(operation)]);
  const request=await response(jetty1.username,'POST','/api/action',{requestId:'pickup-request',action:'request.create',payload:{jettyId:'jetty-1',vesselId:'vessel-1',destinationLocationId:'stockpile-location-crusher-2',destination:'Untrusted description ignored',lines:[{skuId:'split-12',quantity:28,unit:'m3'}]}});
  assert.equal(request.status,200);
  const plan=await response(admin.username,'POST','/api/action',{requestId:'pickup-plan',action:'request.plan',payload:{requestId:request.data.result.entityId}});
  assert.equal(plan.status,200);
  const assigned=await response(stock1.username,'GET','/api/state');
  assert.ok(assigned.data.state.trips.length>0);
  assert.ok(assigned.data.state.trips.every(x=>x.crusherId==='crusher-1'));
  assert.ok(assigned.data.state.trucks.every(x=>assigned.data.state.trips.some(t=>t.truckId===x.id)));
  const pickup=assigned.data.state.trips[0];
  const started=await response(stock1.username,'POST','/api/action',{requestId:'pickup-start',action:'trip.start',payload:{tripId:pickup.id}});
  assert.equal(started.status,200);
  assert.equal(started.data.state.trips.find(x=>x.id===pickup.id).status,'loading');
  assert.equal((await response(stock1.username,'POST','/api/action',{requestId:'pickup-depart-without-trusted-evidence',action:'trip.depart',payload:{tripId:pickup.id}})).status,403);
  assert.ok(admin);
  const rejected=await response(admin.username,'POST','/api/action',
   {requestId:'not-authorized-action',action:'trip.unload',payload:{tripId:'nonexistent'}});
  assert.equal(rejected.status,403);
  assert.equal(rejected.data.error,'PERMISSION_DENIED');
  const forbidden=await response(admin.username,'POST','/api/action',
   {requestId:'not-integrated-action',action:'weighbridge.override',payload:{}});
  assert.equal(forbidden.status,403);
  const revision=Number((await db.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision);
  assert.equal(revision,beforeDenied+4);
 }finally{
  if(server)await new Promise(ok=>server.close(ok));
  await db.close();
 }
});
