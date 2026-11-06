import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {provisionLocalDriverUat} from '../scripts/local-driver-uat.mjs';
import {createIsolatedExecutionSchema} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {createStagingApiHandler} from '../server/v1/staging-http.mjs';
import {extendExecutionPhase4D} from '../server/v1/phase4d-schema.mjs';
import {extendUnifiedOperationalSchema} from '../server/v1/phase4g-schema.mjs';
import {extendPhase4E} from '../server/v1/phase4e-schema.mjs';
import {prepareOpeningBalance,approveOpeningBalance} from '../server/v1/phase4e-inventory-reconciliation.mjs';
import {passwordHash} from '../server/auth.mjs';
import {signWeighbridgePayload} from '../server/v1/phase4b-weighbridge.mjs';
import {analyzeLegacyDatabase} from '../server/v1/migration-preflight.mjs';

const secret='staging-only-secret-long-enough-for-HMAC-check';
const now=Date.now();
const time=offset=>new Date(now+offset).toISOString();
test('Phase 4C: real HTTP UAT across Admin Stockpile Jetty Driver and signed Weighbridge',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'aimoc-phase4c-'));
 const legacyDb=await createEmbeddedDatabase();
 const executionDb=await createEmbeddedDatabase();
 let server;
 try{
  await bootstrap(legacyDb,path.join(directory,'access.json'));
  await provisionLocalDriverUat(legacyDb,{localOnly:true,accessPath:path.join(directory,'driver.json')});
  const people=[
   ...JSON.parse(await readFile(path.join(directory,'access.json'),'utf8')).users,
   ...JSON.parse(await readFile(path.join(directory,'driver.json'),'utf8')).users,
  ];
  // Second Admin is a test-only authority for independent HOLD resolution.
  const secondAdmin={username:'uat-admin-2',password:'UAT-TEMP-SECOND-SUPERVISOR-LOCAL',
    displayName:'QA Second Supervisor',role:'admin'};
  await legacyDb.query("INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role,crusher_ids,jetty_ids) VALUES($1,$2,$3,$4,'admin',ARRAY[]::text[],ARRAY[]::text[])",
    [randomUUID(),secondAdmin.username,secondAdmin.displayName,await passwordHash(secondAdmin.password)]);
  people.push(secondAdmin);
  const userId={};
  for(const p of people){
   const row=(await legacyDb.query('SELECT id FROM aimoc_alfa_ops.users WHERE username=$1',[p.username])).rows[0];
   userId[p.username]=row.id;
  }
  const before=(await legacyDb.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision;
  const preflight=await analyzeLegacyDatabase(legacyDb);
  assert.equal(preflight.production_ready,false);
  assert.ok(preflight.blocking_count>=4);
  await createIsolatedExecutionSchema(executionDb);
  await extendIsolatedExecutionSchema(executionDb);
  await extendExecutionPhase4D(executionDb);
  const q=(sql,args=[])=>executionDb.query(sql,args);
  await q("INSERT INTO aimoc_execution_v1.voyage_capacity(voyage_id,capacity_t,status) VALUES('v1',100,'READY')");
  await q("INSERT INTO aimoc_execution_v1.jetty_windows(id,voyage_id,jetty_id,starts_at,ends_at,status) VALUES('window-1','v1','jetty-1',now()-interval '1 hour',now()+interval '1 day','READY')");
  await q("INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,voyage_id,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t) VALUES('d1','MARINE','PLANNED','v1','crusher-1','jetty-1','sku-1',80)");
  await q("UPDATE aimoc_execution_v1.dispatches SET jetty_window_id='window-1' WHERE id='d1'");
  await q("INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t) VALUES('t1','d1',1,'QUEUED','truck-1','driver-db-1',40),('t2','d1',2,'QUEUED','truck-2','driver-db-2',40)");
  await q("INSERT INTO aimoc_execution_v1.marine_gates(dispatch_id) VALUES('d1')");
  await q("INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t) VALUES('crusher-1','sku-1',0),('jetty-1','sku-1',0)");
  await q("INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES('driver-db-1',$1,'QA Driver 1'),('driver-db-2',$2,'QA Driver 2')",[userId.driver1,userId.driver2]);
  await q("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck-1',45),('truck-2',45)");
  await q("INSERT INTO aimoc_execution_v1.weighbridge_sources(source_system,active,authorized_weighbridge_id) VALUES('WB-QA',true,'WB-1')");
  await q("INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission) VALUES($1,'crusher-1','stockpile.loading.confirm'),($1,'crusher-1','stockpile.departure.confirm'),($1,'crusher-1','return.verify'),($2,'jetty-1','receiving.verify')",[userId.stock1,userId.jetty1]);
  await q("INSERT INTO aimoc_execution_v1.driver_checklist_items(id,label,stage) VALUES('check-1','Inspect tyres','START_AUTHORIZED')");
  await extendUnifiedOperationalSchema(executionDb);
  await extendPhase4E(executionDb);
  await q(`INSERT INTO aimoc_execution_v1.driver_identity_bindings
   (driver_id,user_id,credential_authority,identity_evidence_ref,provisioned_by,verified_by,verified_at,status)
   VALUES('driver-db-1',$1,'idp:qa','evidence:driver-db-1','qa-provisioner','qa-verifier',now(),'ACTIVE'),
    ('driver-db-2',$2,'idp:qa','evidence:driver-db-2','qa-provisioner','qa-verifier',now(),'ACTIVE')`,[userId.driver1,userId.driver2]);
  await q("INSERT INTO aimoc_execution_v1.trip_driver_assignments(assignment_id,trip_id,driver_id,truck_id,assigned_by,status) VALUES('assignment-1','t1','driver-db-1','truck-1','qa-admin','ASSIGNED'),('assignment-2','t2','driver-db-2','truck-2','qa-admin','ASSIGNED')");
  await q("INSERT INTO aimoc_execution_v1.crusher_location_refs(crusher_id,crusher_name,source_stockpile_id,status) VALUES('crusher-1','Crusher 1 QA','crusher-1','ACTIVE')");
  await q("INSERT INTO aimoc_execution_v1.loading_point_refs(loading_point_id,crusher_id,loading_point_name,verification_status) VALUES('loading-1','crusher-1','Loading 1 QA','UNVERIFIED')");
  await q("INSERT INTO aimoc_execution_v1.dispatch_loading_assignments(dispatch_id,crusher_id,loading_point_id,source_stockpile_id,loading_point_version,assigned_by) VALUES('d1','crusher-1','loading-1','crusher-1',1,'qa-admin')");
  await q(`INSERT INTO aimoc_execution_v1.integration_source_config
   (source_system,protocol_version,credential_ref,vendor_contract_ref,proposed_by,approved_by,approved_at,status)
   VALUES('WB-QA','AIMOC_WIM_EVENT_V1','vault:qa-key','contract:qa-wim','qa-provisioner','qa-verifier',now(),'APPROVED')`);
  await q(`INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission)
   VALUES('qa-opening-preparer','crusher-1','stockpile.loading.confirm'),
    ('qa-opening-preparer','jetty-1','stockpile.loading.confirm'),
    ('qa-opening-approver','crusher-1','stockpile.departure.confirm'),
    ('qa-opening-approver','jetty-1','stockpile.departure.confirm')`);
  for(const [locationId,measuredT,ref] of [['crusher-1','100.000000','qa-open-source'],['jetty-1','0.000000','qa-open-jetty']]){
   const opening=await prepareOpeningBalance(executionDb,{actorId:'qa-opening-preparer',locationId,skuId:'sku-1',
    measuredT,measurementRef:ref,measuredAt:time(0),
    evidenceDigest:createHash('sha256').update('isolated phase4c QA opening '+locationId).digest('hex')});
   await approveOpeningBalance(executionDb,{actorId:'qa-opening-approver',reconciliationId:opening.reconciliation_id});
  }
  server=http.createServer(createStagingApiHandler({legacyDb,executionDb,sourceSecrets:{'WB-QA':secret}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const request=async(route,{method='GET',body,cookie,csrf,key,headers={}}={})=>{
   const response=await fetch(origin+route,{method,
    headers:{...(cookie?{Cookie:cookie}:{}),...(method!=='GET'?{Origin:origin,'Content-Type':'application/json'}:{}),
     ...(csrf?{'X-CSRF-Token':csrf}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},
    body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
   return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
  };
  const sessions={};
  for(const account of people){
   const login=await request('/api/login',{method:'POST',body:{username:account.username,password:account.password}});
   assert.equal(login.status,200,'login failed for '+account.username);
   sessions[account.username]={cookie:login.cookie.split(';')[0],csrf:login.data.csrfToken};
  }
  let count=0;
  const command=async(user,route,body={},expected=200)=>{
    count++;
    const result=await request(route,{method:'POST',body,...sessions[user],key:'uat-command-'+count});
    assert.equal(result.status,expected,route+': '+JSON.stringify(result.data));
    return result;
  };
  const weighing=async(type,id,tonnes,offset)=>{
   const e={source_system:'WB-QA',external_event_id:id,event_type:type,
    trip_id:'t1',truck_id:'truck-1',weighbridge_id:'WB-1',occurred_at:time(offset)};
   if(tonnes!==null)e.weight_t=tonnes;
   const raw=JSON.stringify(e),timestamp=time(0);
   const signature=signWeighbridgePayload({timestamp,rawBody:raw,secret});
   return request('/api/v1/integrations/weighbridge/events',{method:'POST',
    body:raw,headers:{'X-AIMOC-Source':'WB-QA','X-AIMOC-Timestamp':timestamp,'X-AIMOC-Signature':signature}});
  };

  await t.test('auth isolation and forbidden actions prior to starting',async()=>{
   const anonymous=await request('/api/v1/trips/t1');assert.equal(anonymous.status,401);
   const driverScope=await request('/api/v1/trips/t1',{...sessions.driver2});
   assert.equal(driverScope.status,403);
   const missingCsrf=await request('/api/v1/dispatches/d1/reserve',{method:'POST',body:{},cookie:sessions.admin.cookie,key:'test-no-csrf'});
   assert.equal(missingCsrf.status,403);
   const stockAsAdmin=await command('stock1','/api/v1/dispatches/d1/reserve',{},403);
   assert.equal(stockAsAdmin.data.error,'FORBIDDEN_SCOPE');
   const unknownCommand=await command('admin','/api/v1/trips/t1/random-action',{},404);
   assert.equal(unknownCommand.status,404);
  });
  await t.test('Admin reserves and starts trip 1 with actual idempotency',async()=>{
   const reserve=await command('admin','/api/v1/dispatches/d1/reserve');
   assert.equal(reserve.data.data.status,'READY');
   const reservedKey='uat-command-'+count;
   const replay=await request('/api/v1/dispatches/d1/reserve',{
     method:'POST',body:{},...sessions.admin,key:reservedKey});
   assert.equal(replay.status,200);
   assert.equal(replay.data.data.replayed,true);
   const conflict=await request('/api/v1/trips/t1/start',{
     method:'POST',body:{},...sessions.admin,key:reservedKey});
   assert.equal(conflict.status,409);
   assert.equal(conflict.data.error,'IDEMPOTENCY_KEY_REUSED');
   const first=await command('admin','/api/v1/trips/t1/start');
   assert.equal(first.data.data.status,'START_AUTHORIZED');
   await command('admin','/api/v1/trips/t2/start',{},409);
   const own=await request('/api/v1/driver/me/active-trip',sessions.driver1);
   assert.equal(own.status,200);
   assert.equal(own.data.data.trip.id,'t1');
   const others=await request('/api/v1/driver/me/active-trip',sessions.driver2);
   assert.equal(others.data.data.trip.id,'t2');
   assert.equal(others.data.data.trip.status,'QUEUED');
  });
  await t.test('HOLD preserves gate and requires independent supervisor recovery via HTTP',async()=>{
   const held=await command('admin','/api/v1/trips/t1/hold',{reason:'Pending independent safety check'});
   assert.equal(held.data.data.sequence_released,false);
   const gateBefore=(await q("SELECT active_trip_id FROM aimoc_execution_v1.marine_gates WHERE dispatch_id='d1'")).rows[0];
   assert.equal(gateBefore.active_trip_id,'t1');
   const self=await command('admin','/api/v1/trips/t1/resolve-hold',{resolution_note:'Safety evidence reviewed'},403);
   assert.equal(self.data.error,'HOLD_SELF_APPROVAL_FORBIDDEN');
   const resolved=await command('uat-admin-2','/api/v1/trips/t1/resolve-hold',{resolution_note:'Independent evidence reviewed and signed'});
   assert.equal(resolved.data.data.status,'START_AUTHORIZED');
   const claim=(await q("SELECT count(*)::int AS n FROM aimoc_execution_v1.resource_claims WHERE released_at IS NULL")).rows[0];
   assert.equal(claim.n,1);
  });
  await t.test('signed QR, tare, and scoped loading before gross',async()=>{
   const unsigned=await request('/api/v1/integrations/weighbridge/events',{method:'POST',body:{bad:true}});
   assert.equal(unsigned.status,401);
   assert.equal((await weighing('QR_SCANNED','qr1',null,0)).status,202);
   assert.equal((await weighing('TARE_RECORDED','tare1','12.000000',1000)).status,202);
   const loadingWrong=await command('jetty1','/api/v1/trips/t1/loading',{},403);
   assert.equal(loadingWrong.data.error,'FORBIDDEN_SCOPE');
   await command('stock1','/api/v1/trips/t1/loading');
   assert.equal((await weighing('GROSS_RECORDED','gross1','52.000000',2000)).status,202);
   const trip=await request('/api/v1/trips/t1',sessions.admin);
   assert.equal(trip.data.data.actual_net_t,'40.000000');
  });
  await t.test('physical departure and scoped receiving leave source stock traceable',async()=>{
   await command('stock1','/api/v1/trips/t1/depart');
   await q("UPDATE aimoc_execution_v1.jetty_windows SET status='ON_HOLD' WHERE id='window-1'");
   const blockedWindow=await command('jetty1','/api/v1/trips/t1/arrive',{},409);
   assert.equal(blockedWindow.data.error,'JETTY_WINDOW_NOT_ACTIVE');
   await q("UPDATE aimoc_execution_v1.jetty_windows SET status='READY' WHERE id='window-1'");
   const source=(await q("SELECT on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id='crusher-1'")).rows[0];
   assert.equal(source.on_hand_t,'60.000000');
   assert.equal(source.reserved_t,'40.000000');
   await command('jetty1','/api/v1/trips/t1/arrive');
   await command('jetty1','/api/v1/trips/t1/receive',{received_t:'15.000000',external_receipt_id:'receipt-1'});
   const partial=await command('jetty1','/api/v1/trips/t1/finalize-unload',{},409);
   assert.equal(partial.data.error,'CARGO_NOT_SETTLED');
   const full=await command('jetty1','/api/v1/trips/t1/receive',{received_t:'25.000000',external_receipt_id:'receipt-2'});
   assert.equal(full.data.data.final,true);
  });
  await t.test('Marine Option B: gate release is independent from Truck 1 return',async()=>{
   const released=await command('jetty1','/api/v1/trips/t1/finalize-unload');
   assert.equal(released.data.data.sequence_released,1);
   const t1=(await q("SELECT released_at FROM aimoc_execution_v1.resource_claims WHERE trip_id='t1'")).rows[0];
   assert.equal(t1.released_at,null);
   const next=await command('admin','/api/v1/trips/t2/start');
   assert.equal(next.data.data.status,'START_AUTHORIZED');
   const denied=await command('driver2','/api/v1/trips/t1/return-start',{},403);
   assert.equal(denied.data.error,'DRIVER_TRIP_FORBIDDEN');
   const checked=await command('driver1','/api/v1/trips/t1/checklist',{item_id:'check-1',status:'DONE'});
   assert.equal(checked.data.data.unloading_verified,false);
   const checklistKey='uat-command-'+count;
   const duplicate=await request('/api/v1/trips/t1/checklist',{
     method:'POST',body:{item_id:'check-1',status:'DONE'},...sessions.driver1,key:checklistKey});
   assert.equal(duplicate.status,200);
   assert.equal(duplicate.data.data.replayed,true);
   const changed=await request('/api/v1/trips/t1/checklist',{
     method:'POST',body:{item_id:'check-1',status:'ISSUE'},...sessions.driver1,key:checklistKey});
   assert.equal(changed.status,409);
   assert.equal(changed.data.error,'IDEMPOTENCY_KEY_REUSED');
   const returning=await command('driver1','/api/v1/trips/t1/return-start');
   assert.equal(returning.data.data.truck_available,false);
   const returningKey='uat-command-'+count;
   const returnRetry=await request('/api/v1/trips/t1/return-start',{
     method:'POST',body:{},...sessions.driver1,key:returningKey});
   assert.equal(returnRetry.status,200);
   assert.equal(returnRetry.data.data.replayed,true);
   await command('stock1','/api/v1/trips/t1/verify-return-evidence',{source_event_id:'return-verified-1',vehicle_ready:true});
   const available=await command('stock1','/api/v1/trips/t1/complete-return');
   assert.equal(available.data.data.resource_claim_released,true);
   const history=await request('/api/v1/driver/me/trips',sessions.driver1);
   assert.equal(history.data.data.items[0].status,'RETURNED_AVAILABLE');
  });
  await t.test('all staging transactions leave legacy application snapshot intact',async()=>{
   const after=(await legacyDb.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision;
   assert.equal(after,before);
   const source=(await q("SELECT on_hand_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id='jetty-1'")).rows[0];
   assert.equal(source.on_hand_t,'40.000000');
   const count=(await q("SELECT count(*)::int AS n FROM aimoc_execution_v1.inventory_journal")).rows[0].n;
   assert.equal(count,3);
  });
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  await executionDb.close();await legacyDb.close();
  await rm(directory,{recursive:true,force:true});
 }
});
