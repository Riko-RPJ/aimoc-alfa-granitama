import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction,integratedView} from '../server/integrated-demo-domain.mjs';
import {driverAssignmentQr} from '../server/driver-assignment-qr.mjs';

const admin={id:'two-scan-admin',role:'admin'},driver={id:'two-scan-driver',username:'a-driver',role:'driver',active:true},otherDriver={id:'two-scan-other-driver',username:'b-driver',role:'driver',active:true};
const sourceActor=trip=>({id:'stock-'+trip.crusherId,role:'stock',crusherIds:[trip.crusherId]});
const receiverActor=trip=>trip.transferMode==='LAND'?{id:'receiver',role:'stock',crusherIds:[trip.destinationCrusherId]}:{id:'jetty',role:'jetty',jettyIds:[trip.jettyId]};
const sum=rows=>rows.reduce((n,row)=>n+row.onHandM3,0),near=(a,b)=>assert.ok(Math.abs(a-b)<0.00002,`${a} differs from ${b}`);
function fixture(mode='LAND',quantity=10){
 const state=createSeed();state.trucks=state.trucks.slice(0,1).map(truck=>({...truck,bedM3:30,payloadLimitT:40}));
 const options={drivers:[driver,otherDriver]},act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,options);
 const request=()=>act('request.create',{transferMode:mode,destinationLocationId:'stockpile-location-crusher-2',...(mode==='MARINE'?{jettyId:'jetty-1',vesselId:'vessel-1'}:{}),lines:[{skuId:'split-12',quantity,unit:'t'}]}).requestId;
 const requestId=request();act('request.plan',{requestId});
 const first=state.trips.find(trip=>trip.requestId===requestId),lookup=tripId=>state.trips.find(trip=>trip.id===tripId);
 const payload=(tripId,expectedStage,eventId=randomUUID())=>{const dto=driverAssignmentQr(state,driver,{tripId,drivers:options.drivers});return {tripId,expectedStage,externalEventId:eventId,qrValue:dto.qr.value,binding:dto.binding,...(expectedStage===2?{confirmations:{materialReceived:true,truckReturned:true}}:{})};};
 const scan=(tripId,stage)=>act('trip.driver_scan',payload(tripId,stage),driver);
 const legacyReady=tripId=>{const t=lookup(tripId),stock=sourceActor(t);act('trip.qr',{tripId});act('trip.tare',{tripId,weightT:20},stock);act('trip.start',{tripId},driver);};
 const legacyReceive=tripId=>{legacyReady(tripId);const t=lookup(tripId),stock=sourceActor(t);act('trip.loading',{tripId},stock);act('trip.gross',{tripId,weightT:20+t.tonnageT},stock);act('trip.depart',{tripId},stock);act('trip.arrive',{tripId},receiverActor(t));act('trip.receive',{tripId},receiverActor(t));};
 return {state,options,act,first,requestId,request,lookup,payload,scan,legacyReady,legacyReceive};
}

for(const mode of ['LAND','MARINE'])test(`${mode}: Scan1 records a sensible dummy TARE without inventing gross or net`,()=>{
 const f=fixture(mode),{state,first}=f,before=structuredClone(state),originalVolume=sum(state.stockpiles);
 const read=driverAssignmentQr(state,driver,{tripId:first.id,drivers:f.options.drivers});assert.equal(read.trip.driverScan.nextStage,1);assert.equal(read.trip.driverScan.canScan,true);assert.equal(read.canOpenTask,false);assert.deepEqual(state,before);
 const stage1=f.payload(first.id,1);f.act('trip.driver_scan',stage1,driver);
 let t=f.lookup(first.id);assert.equal(t.status,'ready_to_load');assert.equal(t.driverScanMode,'TWO_SCAN_PLANNED_DEMO');assert.equal(t.startedAt,t.driverFirstScannedAt);assert.equal(t.qrPhysicalVerified,false);assert.equal(t.tareT,18);assert.equal(t.weighingEvents.length,1);assert.deepEqual(t.weighingEvents[0],{id:t.tareEventId,type:'TARE',weightT:18,status:'ACCEPTED',at:t.tareAt,acceptedAt:t.tareAt,actorId:driver.id,source:'INTEGRATED_DEMO',synthetic:true,physicalMeasurementVerified:false,measurementKind:'DUMMY_TARE_AFTER_DRIVER_SCAN'});
 assert.deepEqual(state.inventoryLedger,before.inventoryLedger);assert.deepEqual(state.erpOutbox,before.erpOutbox);assert.deepEqual(state.stockpiles,before.stockpiles);
 const stage2=f.payload(first.id,2),result=f.act('trip.driver_scan',stage2,driver);t=f.lookup(first.id);
 assert.equal(t.status,'returned');assert.equal(result.displayStatus,'completed');assert.equal(t.returnVerifiedBy,driver.id);assert.ok(t.receiptCode);assert.ok(t.driverSecondScannedAt);
 for(const key of ['grossT','netT','grossEventId'])assert.equal(Object.hasOwn(t,key),false);
 assert.equal(t.tareT,18);assert.equal(t.weighingEvents.length,1);assert.equal(state.requests.find(r=>r.id===f.requestId).status,'completed');
 const entries=state.erpOutbox.filter(row=>row.entityId===t.id);assert.equal(entries.length,2);assert.ok(entries.every(row=>row.payload.quantitySource==='PLANNED_DEMO_DRIVER_CONFIRMATION'&&row.payload.measurementPending===true&&row.status==='awaiting_configuration'));
 assert.equal(state.inventoryLedger.filter(row=>row.referenceId===t.id).length,2);
 const sourceBefore=before.stockpiles.find(s=>s.id===t.stockpileId),sourceAfter=state.stockpiles.find(s=>s.id===t.stockpileId);near(sourceAfter.onHandM3,sourceBefore.onHandM3-t.volumeM3);near(sourceAfter.reservedM3,0);
 if(mode==='LAND'){near(sum(state.stockpiles),originalVolume);near(state.stockpiles.find(s=>s.id===t.destinationStockpileId).onHandM3,before.stockpiles.find(s=>s.id===t.destinationStockpileId).onHandM3+t.volumeM3);assert.deepEqual(state.vessels,before.vessels);}
 else{near(sum(state.stockpiles),originalVolume-t.volumeM3);const vessel=state.vessels.find(v=>v.id===t.vesselId);near(vessel.loadedT,before.vessels.find(v=>v.id===t.vesselId).loadedT+t.tonnageT);near(vessel.reservedT,0);}
 const custody=structuredClone({stockpiles:state.stockpiles,vessels:state.vessels,ledger:state.inventoryLedger,erp:state.erpOutbox,events:state.events});
 assert.equal(f.act('trip.driver_scan',stage2,driver).replayed,true);assert.equal(f.act('trip.driver_scan',stage1,driver).replayed,true);
 assert.deepEqual({stockpiles:state.stockpiles,vessels:state.vessels,ledger:state.inventoryLedger,erp:state.erpOutbox,events:state.events},custody);
 const view=integratedView(state,driver,f.options);assert.equal(view.trips[0].displayStatus,'completed');assert.equal(view.driverDailySummary.completedTrips,1);
});

test('explicit stage and stable event prevent double scan1 becoming scan2; ownership and exact binding remain mandatory',()=>{
 const f=fixture(),p=f.payload(f.first.id,1),before=structuredClone(f.state);
 for(const [actor,payload,code] of [[admin,p,'DRIVER_SCAN_FORBIDDEN'],[otherDriver,p,'DRIVER_SCAN_FORBIDDEN'],[driver,{...p,binding:{...p.binding,truckId:'changed'}},'DRIVER_SCAN_BINDING_INVALID'],[driver,{...p,qrValue:p.qrValue+' '},'DRIVER_SCAN_BINDING_INVALID'],[driver,{...p,expectedStage:undefined},'DRIVER_SCAN_PAYLOAD_INVALID'],[driver,{...p,expectedStage:2,confirmations:{materialReceived:true,truckReturned:true}},'DRIVER_SCAN_STAGE_CONFLICT']]){
  assert.throws(()=>f.act('trip.driver_scan',payload,actor),error=>error.code===code);assert.deepEqual(f.state,before);
 }
 f.act('trip.driver_scan',p,driver);const started=structuredClone(f.state);
 assert.throws(()=>f.act('trip.driver_scan',{...p,externalEventId:randomUUID()},driver),error=>error.code==='DRIVER_SCAN_STAGE_CONFLICT');assert.deepEqual(f.state,started);
 assert.throws(()=>f.act('trip.driver_scan',{...f.payload(f.first.id,2),externalEventId:p.externalEventId},driver),error=>error.code==='EVENT_CONFLICT');assert.deepEqual(f.state,started);
 for(const confirmations of [undefined,{materialReceived:true,truckReturned:false},{materialReceived:true,truckReturned:true,extra:true}])assert.throws(()=>f.act('trip.driver_scan',{...f.payload(f.first.id,2),confirmations},driver),error=>error.code==='DRIVER_SCAN_CONFIRMATION_REQUIRED');
});

test('stage2 failures are atomic for stock, reservations and vessel capacity, including sub-epsilon negative balances',()=>{
 for(const change of ['stock','stock-small','reservation','vessel','vessel-small']){
  const f=fixture('MARINE');f.scan(f.first.id,1);const t=f.lookup(f.first.id),stock=f.state.stockpiles.find(row=>row.id===t.stockpileId),vessel=f.state.vessels.find(row=>row.id===t.vesselId),p=f.payload(t.id,2);
  if(change==='stock')stock.onHandM3=0;if(change==='stock-small'){stock.onHandM3=t.volumeM3-0.000001;stock.reservedM3=stock.onHandM3;}if(change==='reservation')stock.reservedM3=0;
  if(change==='vessel')vessel.payloadLimitT=vessel.loadedT+t.tonnageT-1;if(change==='vessel-small')vessel.reservedT=t.tonnageT-0.000001;
  const before=structuredClone(f.state);assert.throws(()=>f.act('trip.driver_scan',p,driver),error=>['STOCK_CONFLICT','VESSEL_CAPACITY'].includes(error.code));assert.deepEqual(f.state,before);
 }
});

test('serial dispatch claims stay exclusive until every queued trip returns, then waiting dispatch becomes available',()=>{
 const f=fixture('MARINE',80),serial=f.state.trips.filter(row=>row.requestId===f.requestId).sort((a,b)=>a.sequence-b.sequence);
 assert.equal(serial.length,2);const nextRequest=f.request();f.act('request.plan',{requestId:nextRequest});const waiting=f.state.trips.find(row=>row.requestId===nextRequest);assert.equal(waiting.status,'waiting_truck');
 assert.throws(()=>f.scan(serial[1].id,1),error=>error.code==='QUEUE_ORDER');
 f.scan(serial[0].id,1);assert.throws(()=>f.scan(serial[1].id,1),error=>error.code==='TRUCK_OR_DRIVER_BUSY');f.scan(serial[0].id,2);
 assert.equal(f.lookup(waiting.id).status,'waiting_truck');assert.equal(integratedView(f.state,driver,f.options).fleet[0].status,'busy');
 assert.equal(f.lookup(serial[1].id).status,'ready_to_load');assert.equal(f.lookup(serial[1].id).driverScanOrigin,'DISPATCH_CONTINUATION');assert.equal(driverAssignmentQr(f.state,driver,{tripId:serial[1].id,drivers:f.options.drivers}).loadDetails.scanNumber,1);
 f.scan(serial[1].id,2);assert.equal(f.lookup(waiting.id).status,'queued');assert.equal(f.lookup(waiting.id).assignedDriverUserId,driver.id);
});

test('one entry scan continuously activates every later trip for the same truck and dispatch',()=>{
 const f=fixture('MARINE',80),serial=f.state.trips.filter(row=>row.requestId===f.requestId).sort((a,b)=>a.sequence-b.sequence);
 f.scan(serial[0].id,1);f.scan(serial[0].id,2);
 const next=f.lookup(serial[1].id),descriptor=driverAssignmentQr(f.state,driver,{tripId:next.id,drivers:f.options.drivers});
 assert.equal(next.status,'ready_to_load');assert.equal(next.driverScanOrigin,'DISPATCH_CONTINUATION');assert.equal(next.tareT,18);assert.equal(next.weighingEvents[0].measurementKind,'DUMMY_TARE_DISPATCH_REUSE');assert.equal(descriptor.loadDetails.tripNumber,2);assert.equal(descriptor.loadDetails.tripCount,2);assert.equal(descriptor.trip.driverScan.nextStage,2);
 assert.throws(()=>f.scan(next.id,1),error=>error.code==='DRIVER_SCAN_STAGE_CONFLICT');
});

test('new scan mode blocks all old operational commands while untouched legacy workflows retain their behavior',()=>{
 const f=fixture();f.scan(f.first.id,1);
 for(const [action,actor] of [['trip.qr',admin],['trip.tare',sourceActor(f.first)],['trip.loading',sourceActor(f.first)],['trip.gross',sourceActor(f.first)],['trip.depart',sourceActor(f.first)],['trip.start',driver],['trip.return_start',driver]]){
  const before=structuredClone(f.state);assert.throws(()=>f.act(action,{tripId:f.first.id,weightT:30},actor),error=>error.code==='DRIVER_TWO_SCAN_REQUIRED');assert.deepEqual(f.state,before);
 }
 const untouched=fixture();untouched.legacyReady(untouched.first.id);assert.equal(untouched.lookup(untouched.first.id).status,'ready_to_load');assert.equal(untouched.lookup(untouched.first.id).driverScanMode,undefined);
 untouched.act('trip.loading',{tripId:untouched.first.id},sourceActor(untouched.first));assert.equal(untouched.lookup(untouched.first.id).status,'loading');
});

test('legacy READY adoption preserves actual first-stage evidence and never manufactures a Driver scan1 or gross/net',()=>{
 const f=fixture();f.legacyReady(f.first.id);const before=structuredClone(f.lookup(f.first.id)),descriptor=driverAssignmentQr(f.state,driver,{tripId:f.first.id,drivers:f.options.drivers});
 assert.equal(descriptor.trip.driverScan.origin,'LEGACY_READY');assert.equal(descriptor.trip.driverScan.nextStage,2);assert.equal(descriptor.trip.driverScan.firstScannedAt,null);
 f.scan(f.first.id,2);const t=f.lookup(f.first.id);assert.equal(t.driverScanOrigin,'LEGACY_READY');assert.deepEqual(t.weighingEvents,before.weighingEvents);assert.equal(t.startedAt,before.startedAt);assert.equal(t.qrScannedAt,before.qrScannedAt);assert.equal(t.tareT,before.tareT);assert.equal(t.tareEventId,before.tareEventId);
 assert.equal(t.driverFirstScannedAt,undefined);assert.equal(t.grossT,undefined);assert.equal(t.netT,undefined);assert.equal(f.state.events.filter(e=>e.type==='trip.driver_scan').length,1);assert.equal(f.state.erpOutbox.filter(e=>e.entityId===t.id).length,2);
 const invalid=fixture();invalid.legacyReady(invalid.first.id);invalid.lookup(invalid.first.id).startedAt='2026-02-30T00:00:00Z';const snapshot=structuredClone(invalid.state);
 assert.throws(()=>invalid.scan(invalid.first.id,2),error=>error.code==='DRIVER_SCAN_STAGE_CONFLICT');assert.deepEqual(invalid.state,snapshot);
});

for(const returning of [false,true])test(`legacy ${returning?'RETURNING':'RECEIVED'} adoption verifies return only and preserves already-booked custody`,()=>{
 const f=fixture('MARINE');f.legacyReceive(f.first.id);if(returning)f.act('trip.return_start',{tripId:f.first.id},driver);
 const t=f.lookup(f.first.id),before=structuredClone({stockpiles:f.state.stockpiles,vessels:f.state.vessels,ledger:f.state.inventoryLedger,erp:f.state.erpOutbox,weighing:t.weighingEvents,receipt:t.receiptCode,receivedAt:t.receivedAt,startedAt:t.startedAt});
 const descriptor=driverAssignmentQr(f.state,driver,{tripId:t.id,drivers:f.options.drivers});assert.equal(descriptor.trip.driverScan.origin,returning?'LEGACY_RETURNING':'LEGACY_RECEIVED');assert.equal(descriptor.trip.driverScan.canScan,true);assert.equal(descriptor.trip.driverScan.measurementPending,false);
 f.scan(t.id,2);const returned=f.lookup(t.id);assert.equal(returned.status,'returned');assert.equal(returned.driverFirstScannedAt,undefined);
 assert.deepEqual({stockpiles:f.state.stockpiles,vessels:f.state.vessels,ledger:f.state.inventoryLedger,erp:f.state.erpOutbox,weighing:returned.weighingEvents,receipt:returned.receiptCode,receivedAt:returned.receivedAt,startedAt:returned.startedAt},before);
});

test('legacy intermediate or unproven receipt is not auto-adopted or repaired',()=>{
 const f=fixture();f.legacyReceive(f.first.id);f.state.erpOutbox.pop();const before=structuredClone(f.state);
 assert.throws(()=>f.scan(f.first.id,2),error=>error.code==='DRIVER_SCAN_STAGE_CONFLICT');assert.deepEqual(f.state,before);
 const pending=fixture();pending.legacyReady(pending.first.id);pending.act('trip.loading',{tripId:pending.first.id},sourceActor(pending.first));const snapshot=structuredClone(pending.state);
 assert.throws(()=>pending.scan(pending.first.id,2),error=>error.code==='DRIVER_SCAN_STAGE_CONFLICT');assert.deepEqual(pending.state,snapshot);
});

test('queued early TARE remains its original reading when actual Driver scan1 accepts it, then scan2 completes the plan',()=>{
 const f=fixture(),tripId=f.first.id;f.act('trip.tare',{tripId,weightT:20},sourceActor(f.first));const pending=structuredClone(f.lookup(tripId).weighingEvents[0]);
 assert.equal(pending.status,'PENDING');const descriptor=driverAssignmentQr(f.state,driver,{tripId,drivers:f.options.drivers});assert.equal(descriptor.trip.driverScan.nextStage,1);assert.equal(descriptor.trip.driverScan.origin,'QUEUED_PENDING_TARE');
 f.scan(tripId,1);const ready=f.lookup(tripId),accepted=ready.weighingEvents[0];assert.equal(accepted.status,'ACCEPTED');assert.equal(accepted.id,pending.id);assert.equal(accepted.weightT,pending.weightT);assert.equal(accepted.actorId,pending.actorId);assert.equal(accepted.at,pending.at);assert.equal(ready.tareT,20);assert.equal(ready.tareEventId,pending.id);assert.equal(ready.startedAt,ready.driverFirstScannedAt);
 f.scan(tripId,2);const completed=f.lookup(tripId);assert.equal(completed.status,'returned');assert.equal(completed.weighingEvents.length,1);assert.equal(completed.grossT,undefined);assert.equal(completed.netT,undefined);assert.equal(completed.quantitySource,'PLANNED_DEMO_DRIVER_CONFIRMATION');
 const bad=fixture();bad.act('trip.tare',{tripId:bad.first.id,weightT:20},sourceActor(bad.first));bad.lookup(bad.first.id).weighingEvents.push({...bad.lookup(bad.first.id).weighingEvents[0],id:'duplicate-pending'});const before=structuredClone(bad.state);
 assert.throws(()=>bad.scan(bad.first.id,1),error=>error.code==='DRIVER_SCAN_STAGE_CONFLICT');assert.deepEqual(bad.state,before);
});
