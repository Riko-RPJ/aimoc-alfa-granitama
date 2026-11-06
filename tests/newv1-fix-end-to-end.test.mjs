import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {passwordHash} from '../server/auth.mjs';
import {createIsolatedExecutionSchema} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {extendExecutionPhase4D} from '../server/v1/phase4d-schema.mjs';
import {extendUnifiedOperationalSchema} from '../server/v1/phase4g-schema.mjs';
import {extendPhase4E} from '../server/v1/phase4e-schema.mjs';
import {prepareOpeningBalance,approveOpeningBalance} from '../server/v1/phase4e-inventory-reconciliation.mjs';
import {createStagingApiHandler} from '../server/v1/staging-http.mjs';
import {signWeighbridgePayload,ingestSignedWeighbridgeEvent} from '../server/v1/phase4b-weighbridge.mjs';
import {getDriverActiveTrip} from '../server/v1/phase4b-driver.mjs';
import {proposeDriverBinding,verifyDriverBinding} from '../server/v1/phase4e-driver-identity.mjs';

// Disposable in-memory fixtures only. Approvals below are not field evidence.
async function fixture(){
 const legacy=await createEmbeddedDatabase(),db=await createEmbeddedDatabase();
 const q=(sql,args=[])=>db.query(sql,args);
 await bootstrap(legacy);
 const password='Synthetic-regression-fixture-password-42!';
 await legacy.query('UPDATE aimoc_alfa_ops.users SET password_hash=$1',[await passwordHash(password)]);
 const users=(await legacy.query('SELECT id,username FROM aimoc_alfa_ops.users')).rows;
 const uid=name=>users.find(u=>u.username===name).id;
 await createIsolatedExecutionSchema(db);await extendIsolatedExecutionSchema(db);
 await extendExecutionPhase4D(db);await extendUnifiedOperationalSchema(db);await extendPhase4E(db);
 await q("INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t) VALUES('crusher-1','test-sku',0),('jetty-1','test-sku',0)");
 await q(`INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission)
  VALUES($1,'crusher-1','stockpile.loading.confirm'),($1,'crusher-1','stockpile.departure.confirm'),
  ($1,'crusher-1','return.verify'),($2,'crusher-1','stockpile.departure.confirm'),($3,'jetty-1','receiving.verify')`,
  [uid('stock1'),uid('admin'),uid('jetty1')]);
 const opening=await prepareOpeningBalance(db,{actorId:uid('stock1'),locationId:'crusher-1',skuId:'test-sku',
  measuredT:'1000.000000',measurementRef:'synthetic-opening',measuredAt:new Date(Date.now()-60000).toISOString(),
  evidenceDigest:createHash('sha256').update('isolated synthetic opening fixture').digest('hex')});
 await approveOpeningBalance(db,{actorId:uid('admin'),reconciliationId:opening.reconciliation_id});
 for(const n of [1,2]){
  await q('INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES($1,$2,$3)',
   ['driver-'+n,'synthetic-user-'+n,'Synthetic Driver '+n]);
  await proposeDriverBinding(db,{actorId:'identity-proposer',driverId:'driver-'+n,userId:'synthetic-user-'+n,
   credentialAuthority:'idp:synthetic-fixture',identityEvidenceRef:'evidence:synthetic-driver-'+n});
  await verifyDriverBinding(db,{actorId:'identity-reviewer',driverId:'driver-'+n,verifiedIdentityRef:'evidence:synthetic-driver-'+n});
 }
 await q("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck-1',40),('truck-2',40)");
 await q("INSERT INTO aimoc_execution_v1.crusher_location_refs(crusher_id,crusher_name,source_stockpile_id,status) VALUES('crusher-ref','Synthetic Crusher','crusher-1','ACTIVE')");
 await q("INSERT INTO aimoc_execution_v1.loading_point_refs(loading_point_id,crusher_id,loading_point_name,verification_status) VALUES('loading-ref','crusher-ref','Synthetic Loading Point','UNVERIFIED')");
 await q("INSERT INTO aimoc_execution_v1.weighbridge_sources(source_system,active,authorized_weighbridge_id) VALUES('WB-FIXTURE',true,'WB-UNIT')");
 await q(`INSERT INTO aimoc_execution_v1.integration_source_config
  (source_system,protocol_version,credential_ref,vendor_contract_ref,proposed_by,approved_by,approved_at,status)
  VALUES('WB-FIXTURE','AIMOC_WIM_EVENT_V1','vault:disposable-test','contract:synthetic-test','fixture-proposer','fixture-reviewer',now(),'APPROVED')`);
 await q("INSERT INTO aimoc_execution_v1.voyage_capacity(voyage_id,capacity_t,status) VALUES('voyage-test',500,'READY')");
 await q(`INSERT INTO aimoc_execution_v1.jetty_windows(id,voyage_id,jetty_id,starts_at,ends_at,status)
  VALUES('window-test','voyage-test','jetty-1',now()-interval '1 hour',now()+interval '4 hours','READY')`);
 const secret='Disposable-synthetic-WB-test-secret-0123456789';
 const server=http.createServer(createStagingApiHandler({legacyDb:legacy,executionDb:db,sourceSecrets:{'WB-FIXTURE':secret}}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const sessions={};
 async function request(route,{method='GET',session,body,headers={}}={}){
  const response=await fetch(origin+route,{method,headers:{...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),
   ...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...headers},
   body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
 }
 for(const username of ['admin','stock1','jetty1']){
  const login=await request('/api/login',{method:'POST',body:{username,password}});
  assert.equal(login.status,200);sessions[username]={cookie:login.cookie.split(';')[0],csrf:login.data.csrfToken};
 }
 let commandNo=0,eventNo=0;
 const command=(actor,route,body={},key)=>request(route,{method:'POST',session:sessions[actor],body,
  headers:{'Idempotency-Key':key||'fix-command-'+(++commandNo)}});
 const ok=async promise=>{const response=await promise;assert.equal(response.status,200,JSON.stringify(response.data));return response.data.data;};
 const occurrence=Date.now()-120000,payloads=new Map();
 function signedEvent(trip,type,weight){
  const externalId=trip+'-'+type;
  if(!payloads.has(externalId))payloads.set(externalId,JSON.stringify({source_system:'WB-FIXTURE',external_event_id:externalId,
   event_type:type,trip_id:trip,truck_id:'truck-1',weighbridge_id:'WB-UNIT',
   occurred_at:new Date(occurrence+(++eventNo)*1000).toISOString(),...(weight===undefined?{}:{weight_t:weight})}));
  const rawBody=payloads.get(externalId),timestamp=new Date().toISOString();
  return {sourceSystem:'WB-FIXTURE',timestamp,rawBody,signature:signWeighbridgePayload({timestamp,rawBody,secret}),
   sourceSecrets:{'WB-FIXTURE':secret}};
 }
 const wb=async(trip,type,weight)=>{
  const signed=signedEvent(trip,type,weight);
  const response=await request('/api/v1/integrations/weighbridge/events',{method:'POST',body:signed.rawBody,
   headers:{'X-AIMOC-Source':signed.sourceSystem,'X-AIMOC-Timestamp':signed.timestamp,'X-AIMOC-Signature':signed.signature}});
  assert.equal(response.status,202,JSON.stringify(response.data));return response.data.data;
 };
 const dto=(prefix,mode='LAND',quantities=['40.000000','40.000000'],driver='driver-1')=>({
  dispatch_id:prefix,mode,source_stockpile_id:'crusher-1',destination_location_id:'jetty-1',sku_id:'test-sku',
  planned_quantity_t:quantities.reduce((n,x)=>n+Number(x),0).toFixed(6),crusher_id:'crusher-ref',loading_point_id:'loading-ref',
  ...(mode==='MARINE'?{voyage_id:'voyage-test',jetty_window_id:'window-test'}:{}),
  trips:quantities.map((quantity,i)=>({trip_id:prefix+'-trip-'+(i+1),assignment_id:prefix+'-assignment-'+(i+1),
   sequence_no:i+1,driver_id:driver,truck_id:'truck-1',planned_quantity_t:quantity}))
 });
 async function plan(body){await ok(command('admin','/api/v1/dispatches',body));await ok(command('admin','/api/v1/dispatches/'+body.dispatch_id+'/reserve'));}
 async function ship(trip,quantity='40.000000'){
  assert.equal((await wb(trip,'QR_SCANNED')).status,'ACCEPTED');
  assert.equal((await wb(trip,'TARE_RECORDED','20.000000')).status,'ACCEPTED');
  await ok(command('stock1','/api/v1/trips/'+trip+'/accept-pickup'));
  assert.equal((await wb(trip,'GROSS_RECORDED',(Number(quantity)+20).toFixed(6))).status,'ACCEPTED');
  await ok(command('stock1','/api/v1/trips/'+trip+'/depart'));
  await ok(command('jetty1','/api/v1/trips/'+trip+'/arrive'));
 }
 async function receive(trip,quantity='40.000000',mode='LAND'){
  await ok(command('jetty1','/api/v1/trips/'+trip+'/receive',{received_t:quantity,external_receipt_id:trip+'-receipt'},trip+'-receipt-key'));
  if(mode==='MARINE')await ok(command('jetty1','/api/v1/trips/'+trip+'/finalize-unload'));
 }
 async function returned(trip){
  await ok(command('stock1','/api/v1/trips/'+trip+'/verify-return-evidence',{source_event_id:trip+'-return',vehicle_ready:true}));
  return ok(command('stock1','/api/v1/trips/'+trip+'/complete-return',{},trip+'-return-key'));
 }
 const status=async id=>(await q('SELECT status FROM aimoc_execution_v1.dispatches WHERE id=$1',[id])).rows[0].status;
 return {db,q,legacy,command,request,sessions,ok,wb,signedEvent,dto,plan,ship,receive,returned,status,
  close:async()=>{await new Promise(resolve=>server.close(resolve));await db.close();await legacy.close();}};
}

test('V1 fixed HTTP workflow: scarce fleet queues, early weighing recovery, conserved inventory and dispatch closure',async t=>{
 const f=await fixture();const {q,command,ok,wb,dto,plan,ship,receive,returned,status}=f;
 try{
  await t.test('80t LAND request queues two serial 40t trips for one truck/Driver, with valid stable IDs and payload cap',async()=>{
   const invalid=dto('over-cap','LAND',['41.000000']);
   const rejected=await command('admin','/api/v1/dispatches',invalid);
   assert.equal(rejected.status,409);assert.equal(rejected.data.error,'TRUCK_PAYLOAD_EXCEEDED');
   const duplicate=dto('duplicate-ids');duplicate.trips[1].trip_id=duplicate.trips[0].trip_id;
   assert.equal((await command('admin','/api/v1/dispatches',duplicate)).data.error,'DUPLICATE_ASSIGNMENT');
   await plan(dto('land-serial'));
   const driver=await getDriverActiveTrip(f.db,{actor:{id:'synthetic-user-1',role:'DRIVER'}});
   assert.equal(driver.trip.id,'land-serial-trip-1');
   const outOfOrder=await command('admin','/api/v1/trips/land-serial-trip-2/start');
   assert.equal(outOfOrder.data.error,'FLEET_QUEUE_NOT_READY');
   const options=await f.request('/api/v1/dispatch/planning-options',{session:f.sessions.admin});
   const vehicle=options.data.data.trucks.find(x=>x.truck_id==='truck-1');
   assert.equal(vehicle.queued_trips,2);assert.equal(vehicle.available_now,true);
  });
  await t.test('pre-start signed QR/TARE and pre-loading gross reconcile automatically; retries retain evidence identity',async()=>{
   const trip='land-serial-trip-1';
   const qr=await wb(trip,'QR_SCANNED');assert.equal(qr.status,'PENDING');
   assert.equal((await wb(trip,'TARE_RECORDED','20.000000')).status,'PENDING');
   assert.equal((await ok(command('admin','/api/v1/trips/'+trip+'/start'))).status,'TARE_CONFIRMED');
   const retry=await wb(trip,'QR_SCANNED');assert.equal(retry.status,'ACCEPTED');assert.equal(retry.event_id,qr.event_id);assert.equal(retry.replayed,true);
   assert.equal((await wb(trip,'GROSS_RECORDED','60.000000')).status,'PENDING');
   assert.equal((await ok(command('stock1','/api/v1/trips/'+trip+'/accept-pickup'))).status,'GROSS_CONFIRMED');
   assert.equal((await wb(trip,'GROSS_RECORDED','60.000000')).status,'ACCEPTED');
   assert.equal((await q('SELECT count(*)::int AS n FROM aimoc_execution_v1.weighbridge_inbox WHERE trip_id=$1',[trip])).rows[0].n,3);
   await ok(command('stock1','/api/v1/trips/'+trip+'/depart'));
   await ok(command('jetty1','/api/v1/trips/'+trip+'/arrive'));
   await receive(trip);
   assert.equal(await status('land-serial'),'ACTIVE');
   assert.equal((await command('admin','/api/v1/trips/land-serial-trip-2/start')).data.error,'FLEET_QUEUE_NOT_READY');
   await returned(trip);
   assert.equal((await getDriverActiveTrip(f.db,{actor:{id:'synthetic-user-1',role:'DRIVER'}})).trip.id,'land-serial-trip-2');
  });
  await t.test('final LAND receiving marks delivery complete, final verified return closes; retries never add stock twice',async()=>{
   const trip='land-serial-trip-2';await ok(command('admin','/api/v1/trips/'+trip+'/start'));
   await ship(trip);await receive(trip);
   assert.equal(await status('land-serial'),'DELIVERY_COMPLETED');
   const receiptRetry=await ok(command('jetty1','/api/v1/trips/'+trip+'/receive',
    {received_t:'40.000000',external_receipt_id:trip+'-receipt'},trip+'-receipt-key'));
   assert.equal(receiptRetry.replayed,true);
   assert.equal((await returned(trip)).dispatch_status,'CLOSED');
   assert.equal((await ok(command('stock1','/api/v1/trips/'+trip+'/complete-return',{},trip+'-return-key'))).replayed,true);
   assert.equal(await status('land-serial'),'CLOSED');
   const balances=(await q("SELECT location_id,on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts ORDER BY location_id")).rows;
   assert.deepEqual(balances,[{location_id:'crusher-1',on_hand_t:'920.000000',reserved_t:'0.000000'},
    {location_id:'jetty-1',on_hand_t:'80.000000',reserved_t:'0.000000'}]);
   assert.equal((await q("SELECT count(*)::int AS n FROM aimoc_execution_v1.integration_outbox WHERE aggregate_id='land-serial' AND event_type='DISPATCH_CLOSED'")).rows[0].n,1);
  });
  await t.test('MARINE keeps Option B and one claim until return; another dispatch/Driver using the same truck waits in FIFO',async()=>{
   await plan(dto('marine-serial','MARINE'));
   await ok(command('admin','/api/v1/trips/marine-serial-trip-1/start'));
   await plan(dto('future-land','LAND',['20.000000'],'driver-2'));
   assert.equal((await command('admin','/api/v1/trips/future-land-trip-1/start')).data.error,'FLEET_QUEUE_NOT_READY');
   assert.equal((await command('admin','/api/v1/trips/marine-serial-trip-2/start')).data.error,'SEQUENCE_GATE_BUSY');
   await ship('marine-serial-trip-1');await receive('marine-serial-trip-1','40.000000','MARINE');
   assert.equal((await command('admin','/api/v1/trips/marine-serial-trip-2/start')).data.error,'FLEET_QUEUE_NOT_READY');
   assert.equal((await q('SELECT count(*)::int AS n FROM aimoc_execution_v1.resource_claims WHERE released_at IS NULL')).rows[0].n,1);
   await returned('marine-serial-trip-1');
   assert.equal((await command('admin','/api/v1/trips/future-land-trip-1/start')).data.error,'FLEET_QUEUE_NOT_READY');
   await ok(command('admin','/api/v1/trips/marine-serial-trip-2/start'));
   await ship('marine-serial-trip-2');await receive('marine-serial-trip-2','40.000000','MARINE');
   assert.equal(await status('marine-serial'),'DELIVERY_COMPLETED');
   await returned('marine-serial-trip-2');assert.equal(await status('marine-serial'),'CLOSED');
   await ok(command('admin','/api/v1/trips/future-land-trip-1/start'));
   assert.equal((await q('SELECT count(*)::int AS n FROM aimoc_execution_v1.resource_claims WHERE released_at IS NULL')).rows[0].n,1);
   await ship('future-land-trip-1','20.000000');await receive('future-land-trip-1','20.000000');await returned('future-land-trip-1');
  });
  await t.test('underloaded but fully received/returned trip cannot falsely fulfill dispatch planned tonnes',async()=>{
   await plan(dto('shortfall','LAND',['40.000000']));await ok(command('admin','/api/v1/trips/shortfall-trip-1/start'));
   await ship('shortfall-trip-1','39.000000');await receive('shortfall-trip-1','39.000000');await returned('shortfall-trip-1');
   assert.equal(await status('shortfall'),'ACTIVE');
   assert.equal((await q("SELECT count(*)::int AS n FROM aimoc_execution_v1.integration_outbox WHERE aggregate_id='shortfall' AND event_type IN ('DISPATCH_CLOSED','DISPATCH_DELIVERY_COMPLETED')")).rows[0].n,0);
   assert.equal((await q('SELECT count(*)::int AS n FROM aimoc_execution_v1.resource_claims WHERE released_at IS NULL')).rows[0].n,0);
  });
 }finally{await f.close();}
});

test('pending identity never counts as approval; independent verification and identical retry recheck pending signed events',async()=>{
 const f=await fixture();
 try{
  await f.q("INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES('pending-driver','pending-user','Synthetic Pending Driver')");
  await proposeDriverBinding(f.db,{actorId:'identity-proposer',driverId:'pending-driver',userId:'pending-user',
   credentialAuthority:'idp:synthetic-fixture',identityEvidenceRef:'evidence:pending-driver'});
  const rejected=await f.command('admin','/api/v1/dispatches',f.dto('not-approved','LAND',['20.000000'],'pending-driver'));
  assert.equal(rejected.data.error,'PENDING_DRIVER_VERIFICATION');
  // An isolated preexisting assignment exercises recovery, without bypassing any API admission gate.
  await f.q(`INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t)
    VALUES('pending-fixture','LAND','ACTIVE','crusher-1','jetty-1','test-sku',20)`);
  await f.q(`INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t)
    VALUES('pending-trip','pending-fixture',1,'START_AUTHORIZED','truck-1','pending-driver',20)`);
  await f.q(`INSERT INTO aimoc_execution_v1.trip_driver_assignments(assignment_id,trip_id,driver_id,truck_id,assigned_by,status)
    VALUES('pending-assignment','pending-trip','pending-driver','truck-1','synthetic-fixture','ASSIGNED')`);
  const qr=await f.wb('pending-trip','QR_SCANNED');assert.equal(qr.status,'PENDING');
  await assert.rejects(()=>verifyDriverBinding(f.db,{actorId:'identity-proposer',driverId:'pending-driver',verifiedIdentityRef:'evidence:pending-driver'}),
   e=>e.code==='DRIVER_SELF_APPROVAL_FORBIDDEN');
  await verifyDriverBinding(f.db,{actorId:'identity-reviewer',driverId:'pending-driver',verifiedIdentityRef:'evidence:pending-driver'});
  const accepted=await f.wb('pending-trip','QR_SCANNED');assert.equal(accepted.status,'ACCEPTED');assert.equal(accepted.event_id,qr.event_id);
  assert.equal((await f.q("SELECT qr_event_id FROM aimoc_execution_v1.trips WHERE id='pending-trip'")).rows[0].qr_event_id,qr.event_id);
  // A signed TARE delivered before QR must be reconsidered when QR arrives or is retried.
  await f.q(`INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t)
    VALUES('retry-trip','pending-fixture',2,'START_AUTHORIZED','truck-1','pending-driver',20)`);
  await f.q(`INSERT INTO aimoc_execution_v1.trip_driver_assignments(assignment_id,trip_id,driver_id,truck_id,assigned_by,status)
    VALUES('retry-assignment','retry-trip','pending-driver','truck-1','synthetic-fixture','ASSIGNED')`);
  // Only synthetic fixture state is seeded. No caller creates/approves operational evidence.
  const signed=f.signedEvent('retry-trip','QR_SCANNED');
  const qrPayload=JSON.parse(signed.rawBody),tarePayload={...qrPayload,event_type:'TARE_RECORDED',external_event_id:'retry-tare',
   weight_t:'20.000000',occurred_at:new Date(Date.parse(qrPayload.occurred_at)+1000).toISOString()};
  const rawBody=JSON.stringify(tarePayload);
  const tareSigned={...signed,rawBody,signature:signWeighbridgePayload({timestamp:signed.timestamp,rawBody,secret:signed.sourceSecrets['WB-FIXTURE']})};
  const pending=await ingestSignedWeighbridgeEvent(f.db,tareSigned);assert.equal(pending.status,'PENDING');
  await f.wb('retry-trip','QR_SCANNED');
  const retry=await ingestSignedWeighbridgeEvent(f.db,tareSigned);assert.equal(retry.status,'ACCEPTED');assert.equal(retry.replayed,true);
  assert.equal(retry.event_id,pending.event_id);
 }finally{await f.close();}
});

test('opt-in normalized staging delegates authenticated demo routes to the canonical application handler',async()=>{
 const f=await fixture();
 try{
  assert.equal((await f.request('/api/v1/demo/context')).status,401);
  const before=await f.request('/api/v1/demo/context',{session:f.sessions.admin});
  assert.equal(before.status,200);assert.equal(before.data.source,'INTEGRATED_DEMO');
  const body={requestId:'demo-delegation-create',expectedRevision:before.data.revision,action:'request.create',
   payload:{transferMode:'MARINE',destinationLocationId:'stockpile-location-crusher-2',jettyId:'jetty-1',vesselId:'vessel-1',destination:'Synthetic destination',
    lines:[{skuId:'split-12',quantity:40,unit:'t'}]}};
  const rejected=await f.request('/api/v1/demo/actions',{method:'POST',session:{cookie:f.sessions.admin.cookie},body});
  assert.equal(rejected.status,403);assert.equal(rejected.data.error,'CSRF_REJECTED');
  const created=await f.command('admin','/api/v1/demo/actions',body);
  assert.equal(created.status,200,JSON.stringify(created.data));assert.equal(created.data.source,'INTEGRATED_DEMO');
  assert.equal(created.data.revision,before.data.revision+1);
  assert.ok(created.data.state.requests.some(r=>r.id===created.data.result.requestId&&r.synthetic===true));
  const canonical=(await f.legacy.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
  assert.ok(canonical.requests.some(r=>r.id===created.data.result.requestId));
  assert.equal((await f.q('SELECT count(*)::int AS n FROM aimoc_execution_v1.dispatches')).rows[0].n,0);
  const normalized=await f.request('/api/v1/trips',{session:f.sessions.admin});
  assert.equal(normalized.status,200);assert.equal(normalized.data.source,'V1_STAGING');
  assert.deepEqual(normalized.data.data.items,[]);
 }finally{await f.close();}
});
