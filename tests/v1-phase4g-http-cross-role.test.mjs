import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {provisionLocalDriverUat} from '../scripts/local-driver-uat.mjs';
import {createIsolatedExecutionSchema} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {extendUnifiedOperationalSchema} from '../server/v1/phase4g-schema.mjs';
import {extendPhase4E} from '../server/v1/phase4e-schema.mjs';
import {prepareOpeningBalance,approveOpeningBalance} from '../server/v1/phase4e-inventory-reconciliation.mjs';
import {createStagingApiHandler} from '../server/v1/staging-http.mjs';

test('Phase 4G HTTP: Admin -> Inventory -> Stockpile -> Driver receive same persisted unified IDs',async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'aimoc-unified-uat-'));
 const legacyDb=await createEmbeddedDatabase();
 const executionDb=await createEmbeddedDatabase();
 let server;
 try{
  await bootstrap(legacyDb,path.join(folder,'access.json'));
  await provisionLocalDriverUat(legacyDb,{localOnly:true,accessPath:path.join(folder,'driver.json')});
  const accounts=[
   ...JSON.parse(await readFile(path.join(folder,'access.json'),'utf8')).users,
   ...JSON.parse(await readFile(path.join(folder,'driver.json'),'utf8')).users
  ];
  const legacyState=(await legacyDb.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
  const sourceId=legacyState.document.crushers[0].id;
  const driverUser=(await legacyDb.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='driver1'")).rows[0].id;
  await createIsolatedExecutionSchema(executionDb);
  await extendIsolatedExecutionSchema(executionDb);
  await extendUnifiedOperationalSchema(executionDb);
  await extendPhase4E(executionDb);
  const q=(sql,values=[])=>executionDb.query(sql,values);
  await q('INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t) VALUES($1,$2,0)',[sourceId,'sku-uat']);
  await q('INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES($1,$2,$3)',['driver-uat',driverUser,'QA Driver']);
  await q(`INSERT INTO aimoc_execution_v1.driver_identity_bindings
   (driver_id,user_id,credential_authority,identity_evidence_ref,provisioned_by,verified_by,verified_at,status)
   VALUES('driver-uat',$1,'idp:qa','evidence:driver-uat','qa-provisioner','qa-verifier',now(),'ACTIVE')`,[driverUser]);
  await q("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck-uat',50)");
  await q("INSERT INTO aimoc_execution_v1.crusher_location_refs(crusher_id,crusher_name,source_stockpile_id,zone,status) VALUES('crusher-uat','Crusher UAT',$1,'Zona UAT','ACTIVE')",[sourceId]);
  await q("INSERT INTO aimoc_execution_v1.loading_point_refs(loading_point_id,crusher_id,loading_point_name,verification_status) VALUES('point-uat','crusher-uat','Loading Point UAT','UNVERIFIED')");
  await q("INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t) VALUES('dispatch-uat','LAND','PLANNED',$1,'customer-uat','sku-uat',40)",[sourceId]);
  await q("INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t) VALUES('trip-uat','dispatch-uat',1,'QUEUED','truck-uat','driver-uat',40)");
  const stockpileUser=(await legacyDb.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='stock1'")).rows[0].id;
  const adminUser=(await legacyDb.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='admin'")).rows[0].id;
  await q("INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission) VALUES($1,$2,'stockpile.loading.confirm'),($1,$2,'stockpile.departure.confirm'),($3,$2,'stockpile.departure.confirm')",
   [stockpileUser,sourceId,adminUser]);
  const opening=await prepareOpeningBalance(executionDb,{actorId:stockpileUser,locationId:sourceId,skuId:'sku-uat',
   measuredT:'100.000000',measurementRef:'qa-opening-uat',measuredAt:new Date().toISOString(),
   evidenceDigest:createHash('sha256').update('isolated phase4g QA opening evidence').digest('hex')});
  await approveOpeningBalance(executionDb,{actorId:adminUser,reconciliationId:opening.reconciliation_id});

  server=http.createServer(createStagingApiHandler({legacyDb,executionDb}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const call=async(route,{method='GET',cookie,csrf,key,body}={})=>{
   const response=await fetch(origin+route,{method,headers:{
     ...(cookie?{Cookie:cookie}:{}),
     ...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),
     ...(csrf?{'X-CSRF-Token':csrf}:{}),
     ...(key?{'Idempotency-Key':key}:{})
    },body:body===undefined?undefined:JSON.stringify(body)});
   return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
  };
  const sessions={};
  for(const name of ['admin','stock1','stock2','driver1','driver2']){
   const a=accounts.find(x=>x.username===name);
   const result=await call('/api/login',{method:'POST',body:{username:name,password:a.password}});
   assert.equal(result.status,200,name);
   sessions[name]={cookie:result.cookie.split(';')[0],csrf:result.data.csrfToken};
  }
  let k=0;
  const post=(name,route,body)=>call(route,{...sessions[name],method:'POST',key:'cross-uat-key-'+(++k),body});
  const assignLocation=await post('admin','/api/v1/dispatches/dispatch-uat/assign-loading-point',{
   crusher_id:'crusher-uat',loading_point_id:'point-uat'
  });
  assert.equal(assignLocation.status,200);
  const assignDriver=await post('admin','/api/v1/trips/trip-uat/assign-driver',{assignment_id:'assignment-uat',driver_id:'driver-uat'});
  assert.equal(assignDriver.status,200);
  const reserve=await post('admin','/api/v1/dispatches/dispatch-uat/reserve',{});
  assert.equal(reserve.status,200,JSON.stringify(reserve.data));
  const start=await post('admin','/api/v1/trips/trip-uat/start',{});
  assert.equal(start.status,200,JSON.stringify(start.data));
  const ownerContext=await call('/api/v1/dispatches/dispatch-uat/operational-context',sessions.admin);
  const stockContext=await call('/api/v1/dispatches/dispatch-uat/operational-context',sessions.stock1);
  const driverTrip=await call('/api/v1/driver/me/active-trip',sessions.driver1);
  const driverDetail=await call('/api/v1/trips/trip-uat',sessions.driver1);
  assert.equal(ownerContext.status,200);
  assert.equal(stockContext.status,200);
  assert.equal(driverTrip.status,200);
  assert.equal(driverDetail.status,200);
  const entities=[ownerContext.data.data.trips[0],stockContext.data.data.trips[0],
   driverTrip.data.data.trip,driverDetail.data.data];
  for(const dto of entities){
   assert.equal(dto.dispatch_id,'dispatch-uat');
   assert.equal(dto.trip_id,'trip-uat');
   assert.equal(dto.assignment_id,'assignment-uat');
   assert.equal(dto.driver_id,'driver-uat');
   assert.equal(dto.truck_id,'truck-uat');
   assert.equal(dto.source_stockpile_id,sourceId);
   assert.equal(dto.inventory.reserved_t,entities.indexOf(dto)<2?'40.000000':null);
   assert.equal(dto.inventory.trip_reserved_t,'40.000000');

   assert.equal(dto.crusher_destination.crusher_id,'crusher-uat');
   assert.equal(dto.crusher_destination.loading_point.id,'point-uat');
   assert.equal(dto.crusher_destination.latitude,null);
   assert.equal(dto.contract_integrity.navigation_enabled,false);
  }
  assert.equal((await call('/api/v1/dispatches/dispatch-uat/operational-context',sessions.stock2)).status,403);
  assert.equal((await call('/api/v1/trips/trip-uat',sessions.driver2)).status,403);
  assert.equal((await call('/api/v1/dispatches/dispatch-uat/operational-context',sessions.driver1)).status,403);
  assert.equal((await legacyDb.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision,legacyState.revision);
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  await executionDb.close();await legacyDb.close();
  await rm(folder,{recursive:true,force:true});
 }
});
