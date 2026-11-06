import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {provisionLocalDriverUat} from '../scripts/local-driver-uat.mjs';
import {createIsolatedExecutionSchema} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {extendExecutionPhase4D} from '../server/v1/phase4d-schema.mjs';
import {extendUnifiedOperationalSchema} from '../server/v1/phase4g-schema.mjs';
import {extendPhase4E} from '../server/v1/phase4e-schema.mjs';
import {prepareOpeningBalance,approveOpeningBalance} from '../server/v1/phase4e-inventory-reconciliation.mjs';
import {createStagingApiHandler} from '../server/v1/staging-http.mjs';
import {signWeighbridgePayload} from '../server/v1/phase4b-weighbridge.mjs';

const deviceKey='QA-only-disposable-synthetic-HMAC-secret-01234';
const tick=Date.now(),iso=n=>new Date(tick+n).toISOString();

test('Phase 4H: Admin creates actual staging dispatch, Stockpile accepts verified pickup, Driver sees shared trip',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'aimoc-phase4h-'));
 const legacyDb=await createEmbeddedDatabase();
 const executionDb=await createEmbeddedDatabase();
 let server;
 try{
  await bootstrap(legacyDb,path.join(dir,'access.json'));
  await provisionLocalDriverUat(legacyDb,{localOnly:true,accessPath:path.join(dir,'driver-access.json')});
  const accounts=[...JSON.parse(await readFile(path.join(dir,'access.json'),'utf8')).users,
   ...JSON.parse(await readFile(path.join(dir,'driver-access.json'),'utf8')).users];
  const source=(await legacyDb.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
  const first=source.document.crushers[0].id;
  const receivingJetty=source.document.jetties[0].id;
  const driverId=(await legacyDb.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='driver1'")).rows[0].id;
  const secondDriverId=(await legacyDb.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='driver2'")).rows[0].id;
  await createIsolatedExecutionSchema(executionDb);
  await extendIsolatedExecutionSchema(executionDb);
  await extendExecutionPhase4D(executionDb);
  await extendUnifiedOperationalSchema(executionDb);
  await extendPhase4E(executionDb);
  const q=(sql,args=[])=>executionDb.query(sql,args);
  await q('INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t) VALUES($1,$2,0)',[first,'sku-h']);
  await q("INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES('driver-h',$1,'Synthetic Driver'),('driver-h2',$2,'Synthetic Driver 2')",[driverId,secondDriverId]);
  await q(`INSERT INTO aimoc_execution_v1.driver_identity_bindings
   (driver_id,user_id,credential_authority,identity_evidence_ref,provisioned_by,verified_by,verified_at,status)
   VALUES('driver-h',$1,'idp:qa','evidence:driver-h','qa-provisioner','qa-verifier',now(),'ACTIVE'),
    ('driver-h2',$2,'idp:qa','evidence:driver-h2','qa-provisioner','qa-verifier',now(),'ACTIVE')`,[driverId,secondDriverId]);
  await q("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck-h',45)");
  await q("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck-h2',35)");
  await q("INSERT INTO aimoc_execution_v1.voyage_capacity(voyage_id,capacity_t,status) VALUES('voyage-h',100,'READY')");
  await q(`INSERT INTO aimoc_execution_v1.jetty_windows
   (id,voyage_id,jetty_id,starts_at,ends_at,status)
   VALUES('window-h','voyage-h',$1,now()-interval '1 hour',now()+interval '4 hours','READY')`,[receivingJetty]);

  await q('INSERT INTO aimoc_execution_v1.crusher_location_refs(crusher_id,crusher_name,source_stockpile_id,status) VALUES($1,$2,$3,$4)',
   ['crusher-h','Synthetic Crusher',first,'ACTIVE']);
  await q("INSERT INTO aimoc_execution_v1.loading_point_refs(loading_point_id,crusher_id,loading_point_name,verification_status) VALUES('loading-h','crusher-h','Synthetic Loading Point','UNVERIFIED')");
  const stockpileUserId=(await legacyDb.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='stock1'")).rows[0].id;
  const adminUserId=(await legacyDb.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='admin'")).rows[0].id;
  await q("INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission) VALUES($1,$2,'stockpile.loading.confirm'),($1,$2,'stockpile.departure.confirm')",
   [stockpileUserId,first]);
  await q("INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission) VALUES($1,$2,'stockpile.departure.confirm')",
   [adminUserId,first]);
  const opening=await prepareOpeningBalance(executionDb,{actorId:stockpileUserId,locationId:first,skuId:'sku-h',
   measuredT:'100.000000',measurementRef:'qa-opening-h',measuredAt:iso(-10000),
   evidenceDigest:createHash('sha256').update('isolated phase4h QA opening evidence').digest('hex')});
  await approveOpeningBalance(executionDb,{actorId:adminUserId,reconciliationId:opening.reconciliation_id});
  await q("INSERT INTO aimoc_execution_v1.weighbridge_sources(source_system,active,authorized_weighbridge_id) VALUES('WB-H',true,'WB-1')");
  await q(`INSERT INTO aimoc_execution_v1.integration_source_config
   (source_system,protocol_version,credential_ref,vendor_contract_ref,proposed_by,approved_by,approved_at,status)
   VALUES('WB-H','AIMOC_WIM_EVENT_V1','vault:qa-key','contract:qa-wim','qa-provisioner','qa-verifier',now(),'APPROVED')`);

  server=http.createServer(createStagingApiHandler({legacyDb,executionDb,sourceSecrets:{'WB-H':deviceKey}}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const request=async(route,{method='GET',cookie,csrf,key,body,headers={}}={})=>{
   const res=await fetch(origin+route,{method,headers:{
    ...(cookie?{Cookie:cookie}:{}),
    ...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),
    ...(csrf?{'X-CSRF-Token':csrf}:{}),...(key?{'Idempotency-Key':key}:{}),...headers
   },body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
   return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')};
  };
  const sessions={};
  for(const name of ['admin','stock1','stock2','jetty1','driver1','driver2']){
   const user=accounts.find(x=>x.username===name);
   const login=await request('/api/login',{method:'POST',body:{username:name,password:user.password}});
   assert.equal(login.status,200,name);
   sessions[name]={cookie:login.cookie.split(';')[0],csrf:login.data.csrfToken};
  }
  let count=0;
  const command=(role,route,body={},key)=>request(route,{method:'POST',body,...sessions[role],
   key:key||'phase4h-uat-'+(++count)});
  const dto={dispatch_id:'dispatch-h',mode:'LAND',source_stockpile_id:first,
   destination_location_id:'destination-h',sku_id:'sku-h',planned_quantity_t:'40.000000',
   crusher_id:'crusher-h',loading_point_id:'loading-h',
   trips:[{trip_id:'trip-h',assignment_id:'assignment-h',sequence_no:1,
    driver_id:'driver-h',truck_id:'truck-h',planned_quantity_t:'40.000000'}]};
  const event=async(type,externalId,weight,offset,truckId='truck-h')=>{
   const body={source_system:'WB-H',external_event_id:externalId,event_type:type,
    trip_id:'trip-h',truck_id:truckId,weighbridge_id:'WB-1',occurred_at:iso(offset)};
   if(weight!==null)body.weight_t=weight;
   const raw=JSON.stringify(body),timestamp=iso(0);
   return request('/api/v1/integrations/weighbridge/events',{method:'POST',body:raw,
    headers:{'X-AIMOC-Source':'WB-H','X-AIMOC-Timestamp':timestamp,
     'X-AIMOC-Signature':signWeighbridgePayload({timestamp,rawBody:raw,secret:deviceKey})}});
  };
  await t.test('planning options return only approved inventory and independently verified Driver',async()=>{
   const forbidden=await request('/api/v1/dispatch/planning-options',sessions.stock1);
   assert.equal(forbidden.status,403);
   const catalog=await request('/api/v1/dispatch/planning-options',sessions.admin);
   assert.equal(catalog.status,200,JSON.stringify(catalog.data));
   assert.equal(catalog.data.data_status,'READY');
   assert.ok(catalog.data.data.accounts.some(x=>x.location_id===first&&x.sku_id==='sku-h'));
   assert.deepEqual(catalog.data.data.drivers.map(x=>x.driver_id).sort(),['driver-h','driver-h2']);
   assert.ok(catalog.data.data.trucks.some(x=>x.truck_id==='truck-h'));
   assert.equal(catalog.data.data.requirements.legacy_request_crosswalk_approved,false);
   assert.equal(catalog.data.data.requirements.operational_wim_connected,false);
  });
  await t.test('malformed dispatch and unauthorized creation cannot affect DB',async()=>{
   assert.equal((await command('stock1','/api/v1/dispatches',dto)).status,403);
   const mismatch={...dto,planned_quantity_t:'40.000001'};
   const bad=await command('admin','/api/v1/dispatches',mismatch);
   assert.equal(bad.status,400);assert.equal(bad.data.error,'TRIP_QUANTITY_MISMATCH');
   const incomplete=await command('admin','/api/v1/dispatches',{...dto,
    loading_point_id:'wrong-point'});
   assert.equal(incomplete.status,409);assert.equal(incomplete.data.error,'LOADING_POINT_CRUSHER_MISMATCH');
   assert.equal((await q('SELECT count(*)::int AS n FROM aimoc_execution_v1.dispatches')).rows[0].n,0);
  });
  await t.test('atomic dispatch creation with stable IDs, idempotency, no reservation yet',async()=>{
   const r=await command('admin','/api/v1/dispatches',dto,'create-phase4h-1');
   assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.data.status,'PLANNED');
   assert.equal(r.data.data.inventory_reserved,false);
   const dup=await command('admin','/api/v1/dispatches',dto,'create-phase4h-1');
   assert.equal(dup.status,200);assert.equal(dup.data.data.replayed,true);
   const conflict=await command('admin','/api/v1/dispatches',{...dto,destination_location_id:'another-destination'},'create-phase4h-1');
   assert.equal(conflict.status,409);assert.equal(conflict.data.error,'IDEMPOTENCY_KEY_REUSED');
   const countRows=(await q("SELECT (SELECT count(*) FROM aimoc_execution_v1.dispatches)::int AS dispatches,(SELECT count(*) FROM aimoc_execution_v1.trips)::int AS trips,(SELECT count(*) FROM aimoc_execution_v1.trip_driver_assignments)::int AS assignments")).rows[0];
   assert.deepEqual(countRows,{dispatches:1,trips:1,assignments:1});
   const postCreateCatalog=await request('/api/v1/dispatch/planning-options',sessions.admin);
   assert.equal(postCreateCatalog.status,200);
   assert.equal(postCreateCatalog.data.data.trucks.find(x=>x.truck_id==='truck-h').queued_trips,1);
   assert.equal(postCreateCatalog.data.data.drivers.find(x=>x.driver_id==='driver-h').queued_trips,1);
   const doubleAssign={...dto,dispatch_id:'dispatch-retry',trips:[
    {...dto.trips[0],trip_id:'trip-retry',assignment_id:'assignment-retry',driver_id:'driver-h2'}]};
   const queued=await command('admin','/api/v1/dispatches',doubleAssign,'create-future-truck-uat');
   assert.equal(queued.status,200,JSON.stringify(queued.data));assert.equal(queued.data.data.status,'PLANNED');
   assert.equal((await q("SELECT status FROM aimoc_execution_v1.trips WHERE id='trip-retry'")).rows[0].status,'QUEUED');
   assert.equal((await q('SELECT count(*)::int AS n FROM aimoc_execution_v1.resource_claims')).rows[0].n,0);

  });
  await t.test('Admin explicitly binds a verified Driver before the first WIM event',async()=>{
   const drivers=await request('/api/v1/drivers/assignable',sessions.admin);
   assert.equal(drivers.status,200);assert.ok(drivers.data.data.items.some(x=>x.driver_id==='driver-h2'));
   const assigned=await command('admin','/api/v1/trips/trip-h/assign-driver',{
    assignment_id:'assignment-h2',driver_id:'driver-h2'
   });
   assert.equal(assigned.status,200,JSON.stringify(assigned.data));
   assert.equal(assigned.data.data.driver_id,'driver-h2');
   const beforeTare=await request('/api/v1/driver/me/active-trip',sessions.driver2);
   assert.equal(beforeTare.status,200);
   assert.equal(beforeTare.data.data.trip.trip_id,'trip-h');
   assert.equal(beforeTare.data.data.trip.status,'QUEUED');
   assert.equal(beforeTare.data.data.trip.assignment_id,'assignment-h2');
   assert.equal(beforeTare.data.data.trip.tare_status,'TARE_PENDING');
   assert.equal((await request('/api/v1/driver/me/active-trip',sessions.driver1)).data.data_status,'NO_ASSIGNMENT');
   assert.equal((await request('/api/v1/trips/trip-h',sessions.driver1)).status,403);
  });
  await t.test('scoped source pickup queue shows queued trip; reservation and start then TARE gate',async()=>{
   const queue=await request('/api/v1/stockpile/me/pickups',sessions.stock1);
   assert.equal(queue.status,200);assert.equal(queue.data.data.items[0].trip_id,'trip-h');
   assert.equal(queue.data.data.items[0].crusher_destination.loading_point.id,'loading-h');
   assert.equal((await request('/api/v1/stockpile/me/pickups',sessions.driver1)).status,403);
   assert.equal((await request('/api/v1/stockpile/me/pickups',sessions.stock2)).data.data_status,'EMPTY');
   const before=await command('stock1','/api/v1/trips/trip-h/accept-pickup');
   assert.equal(before.status,409);assert.equal(before.data.error,'TARE_NOT_CONFIRMED');
   const reserve=await command('admin','/api/v1/dispatches/dispatch-h/reserve');
   assert.equal(reserve.status,200,JSON.stringify(reserve.data));
   const start=await command('admin','/api/v1/trips/trip-h/start');
   assert.equal(start.status,200,JSON.stringify(start.data));
   const still=await command('stock1','/api/v1/trips/trip-h/accept-pickup');
   assert.equal(still.status,409);assert.equal(still.data.error,'TARE_NOT_CONFIRMED');
   const wrongTruckTare=await event('TARE_RECORDED','tare-wrong-truck','5.000000',500,'truck-other');
   assert.equal(wrongTruckTare.status,422);
   assert.equal(wrongTruckTare.data.data.status,'REJECTED');
   assert.equal((await request('/api/v1/driver/me/active-trip',sessions.driver2)).data.data.trip.tare_status,'TARE_INVALID');
   const qr=await event('QR_SCANNED','qr-h',null,0);assert.equal(qr.status,202,JSON.stringify(qr.data));
   const tare=await event('TARE_RECORDED','tare-h','12.000000',1000);assert.equal(tare.status,202,JSON.stringify(tare.data));
   const [adminTare,stockTare,driverTare]=await Promise.all([
    request('/api/v1/trips/trip-h',sessions.admin),
    request('/api/v1/stockpile/me/pickups',sessions.stock1),
    request('/api/v1/driver/me/active-trip',sessions.driver2)
   ]);
   assert.equal(adminTare.data.data.tare_status,'TARE_RECEIVED');
   assert.equal(stockTare.data.data.items[0].tare_status,'TARE_RECEIVED');
   assert.equal(driverTare.data.data.trip.tare_status,'TARE_RECEIVED');
   const inventoryAfterTare=(await q("SELECT on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id='sku-h'",[first])).rows[0];
   assert.deepEqual(inventoryAfterTare,{on_hand_t:'100.000000',reserved_t:'40.000000'});
   const denied=await command('stock2','/api/v1/trips/trip-h/accept-pickup');
   assert.equal(denied.status,403);
   const accepted=await command('stock1','/api/v1/trips/trip-h/accept-pickup',{},'pickup-h-1');
   assert.equal(accepted.status,200,JSON.stringify(accepted.data));
   assert.equal(accepted.data.data.status,'LOADING');
   const replay=await command('stock1','/api/v1/trips/trip-h/accept-pickup',{},'pickup-h-1');
   assert.equal(replay.status,200);assert.equal(replay.data.data.replayed,true);
   const gross=await event('GROSS_RECORDED','gross-h','52.000000',2000);
   assert.equal(gross.status,202);
  });
  await t.test('Admin monitoring, Stockpile queue, Driver active trip share persisted ID graph',async()=>{
   const [list,trips,stock,driver]=await Promise.all([
    request('/api/v1/dispatches',sessions.admin),
    request('/api/v1/trips',sessions.admin),
    request('/api/v1/stockpile/me/pickups',sessions.stock1),
    request('/api/v1/driver/me/active-trip',sessions.driver2)
   ]);
   for(const r of [list,trips,stock,driver])assert.equal(r.status,200,JSON.stringify(r.data));
   const projections=[list.data.data.items[0].trips[0],trips.data.data.items[0],
    stock.data.data.items[0],driver.data.data.trip];
   for(const row of projections){
    assert.equal(row.dispatch_id,'dispatch-h');assert.equal(row.trip_id,'trip-h');
    assert.equal(row.assignment_id,'assignment-h2');assert.equal(row.driver_id,'driver-h2');
    assert.equal(row.truck_id,'truck-h');assert.equal(row.actual_net_t,'40.000000');
    assert.equal(row.crusher_destination.loading_point.id,'loading-h');
    assert.equal(row.crusher_destination.latitude,null);
    assert.equal(row.contract_integrity.navigation_enabled,false);
   }
   assert.equal(projections[3].inventory.on_hand_t,null);
   assert.equal(projections[3].inventory.trip_reserved_t,'40.000000');
   assert.equal((await request('/api/v1/trips',sessions.driver2)).status,403);
   assert.equal((await request('/api/v1/trips',sessions.stock2)).data.data_status,'EMPTY');
   assert.equal((await request('/api/v1/driver/me/active-trip',sessions.driver1)).data.data_status,'NO_ASSIGNMENT');
   const pickup=await command('stock1','/api/v1/trips/trip-h/depart');
   assert.equal(pickup.status,200);
   assert.equal((await q("SELECT on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id='sku-h'",[first])).rows[0].on_hand_t,'60.000000');
   assert.equal((await legacyDb.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision,source.revision);
  });
  await t.test('MARINE execution requires matching READY voyage/window and eligible distinct truck/Driver',async()=>{
   const marine={dispatch_id:'dispatch-marine-h',mode:'MARINE',source_stockpile_id:first,
    destination_location_id:receivingJetty,sku_id:'sku-h',planned_quantity_t:'30.000000',
    crusher_id:'crusher-h',loading_point_id:'loading-h',voyage_id:'voyage-h',jetty_window_id:'window-h',
    trips:[{trip_id:'trip-marine-h',assignment_id:'assignment-marine-h',
     sequence_no:1,driver_id:'driver-h',truck_id:'truck-h2',planned_quantity_t:'30.000000'}]};
   const wrong=await command('admin','/api/v1/dispatches',{...marine,destination_location_id:'jetty-wrong'});
   assert.equal(wrong.status,409);assert.equal(wrong.data.error,'MARINE_SLOT_NOT_READY');
   const ok=await command('admin','/api/v1/dispatches',marine);
   assert.equal(ok.status,200,JSON.stringify(ok.data));
   assert.equal(ok.data.data.mode,'MARINE');
   const ready=await command('admin','/api/v1/dispatches/dispatch-marine-h/reserve',{});
   assert.equal(ready.status,200,JSON.stringify(ready.data));
   const detail=await request('/api/v1/dispatches/dispatch-marine-h/operational-context',sessions.admin);
   assert.equal(detail.status,200);
   assert.equal(detail.data.data.trips[0].truck_id,'truck-h2');
   assert.equal(detail.data.data.trips[0].driver_id,'driver-h');
   assert.equal(detail.data.data.trips[0].assignment_status,'ASSIGNED');
   assert.equal(detail.data.data.trips[0].tare_status,'TARE_PENDING');
   const jettyQueue=await request('/api/v1/trips',sessions.jetty1);
   assert.equal(jettyQueue.status,200,JSON.stringify(jettyQueue.data));
   assert.deepEqual(jettyQueue.data.data.items.map(x=>x.trip_id),['trip-marine-h']);
   assert.equal((await request('/api/v1/trips',sessions.stock2)).data.data_status,'EMPTY');
  });
 }finally{
  if(server)await new Promise(r=>server.close(r));
  await executionDb.close();await legacyDb.close();await rm(dir,{recursive:true,force:true});
 }
});
