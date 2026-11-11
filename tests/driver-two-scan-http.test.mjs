import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,business,trip} from './driver-two-scan-http-fixture.mjs';

const noPhysicalWeights=t=>{assert.deepEqual(t.weighingEvents,[]);for(const key of ['tareT','grossT','netT','actualNetT','actualVolumeM3','tareEventId','grossEventId'])assert.equal(Object.hasOwn(t,key),false,'No fabricated physical field '+key);};
const inventory=document=>({stockpiles:document.stockpiles,vessels:document.vessels,ledger:document.inventoryLedger,erp:document.erpOutbox});
const reject=async(response,label)=>{assert.ok([400,403,404,409].includes(response.status),label+': '+JSON.stringify(response.body));};

test('real HTTP two-scan serial flow commits planned receipt and verified return exactly once under retries/concurrency',async t=>{
 const f=await fixture(t),first=f.tripsA[0],second=f.tripsA[1],initial=await f.state(),wire=await f.assignment(first.id),laterWire=await f.assignment(second.id);
 assert.equal(f.tripsA.length,2);assert.ok(initial.document.trips.some(x=>x.requestId===f.requestB&&x.status==='waiting_truck'));
 for(let i=0;i<3;i++){await f.assignment(first.id);const r=await f.call('/api/v1/demo/context','GET',undefined,'qa-driver-a');assert.equal(r.status,200);}
 assert.deepEqual(await f.state(),initial,'GET/open/poll never writes an event or advances a stage');
 const outOfOrder=await f.action('trip.driver_scan',f.payload(second.id,1,laterWire),'qa-driver-a');await reject(outOfOrder,'Later serial trip cannot scan before current return');assert.deepEqual(await f.state(),initial);
 const p1=f.payload(first.id,1,wire),request1=randomUUID();
 const firstScan=await f.action('trip.driver_scan',p1,'qa-driver-a',{requestId:request1,expectedRevision:Number(initial.revision)});assert.equal(firstScan.status,200,JSON.stringify(firstScan.body));
 let after=await f.state();assert.equal(trip(after.document,first.id).status,'ready_to_load');assert.equal(trip(after.document,second.id).status,'queued');noPhysicalWeights(trip(after.document,first.id));assert.deepEqual(inventory(after.document),inventory(initial.document),'Scan1 cannot move stock, reserve a vessel receipt or post ERP');
 const retry=await f.action('trip.driver_scan',p1,'qa-driver-a',{requestId:request1,expectedRevision:Number(initial.revision)});assert.equal(retry.status,200);assert.equal(retry.body.replayed,true);assert.deepEqual(await f.state(),after,'Lost response retry uses the same request receipt before stale revision checks');
 const sameIntent=await f.action('trip.driver_scan',p1,'qa-driver-a');assert.equal(sameIntent.status,200);assert.ok(sameIntent.body.result?.replayed||sameIntent.body.replayed);assert.deepEqual(await f.state(),after,'A stable external intent replay changes neither operation revision nor timestamp');
 const otherFirstIntent=await f.action('trip.driver_scan',f.payload(first.id,1,wire),'qa-driver-a');await reject(otherFirstIntent,'A second Scan1 intent never becomes Scan2');
 after=await f.state();const stage2=f.payload(first.id,2,wire);
 await reject(await f.action('trip.driver_scan',{...stage2,confirmations:{materialReceived:true,truckReturned:false}},'qa-driver-a'),'Both receipt and return must be explicitly confirmed');assert.deepEqual(await f.state(),after);
 await reject(await f.action('trip.driver_scan',stage2,'qa-driver-b'),'Other Driver cannot finish this trip');assert.deepEqual(await f.state(),after);
 await reject(await f.action('trip.driver_scan',stage2,'admin'),'Admin cannot impersonate Driver intent');assert.deepEqual(await f.state(),after);
 const key2=randomUUID(),duplicates=await Promise.all([f.action('trip.driver_scan',stage2,'qa-driver-a',{requestId:key2}),f.action('trip.driver_scan',stage2,'qa-driver-a',{requestId:key2})]);assert.ok(duplicates.every(x=>x.status===200));assert.equal(duplicates.filter(x=>x.body.replayed).length,1);
 after=await f.state();const completed=trip(after.document,first.id);assert.equal(completed.status,'returned');assert.ok(completed.receivedAt&&completed.returnedAt&&completed.receiptCode);assert.equal(completed.returnVerifiedBy,f.driverAId);noPhysicalWeights(completed);
 const sourceBefore=initial.document.stockpiles.find(x=>x.id===first.stockpileId),sourceAfter=after.document.stockpiles.find(x=>x.id===first.stockpileId);assert.ok(Math.abs(sourceBefore.onHandM3-sourceAfter.onHandM3-first.volumeM3)<0.000002);assert.ok(Math.abs(sourceBefore.reservedM3-sourceAfter.reservedM3-first.volumeM3)<0.000002);
 const vesselBefore=initial.document.vessels.find(x=>x.id===first.vesselId),vesselAfter=after.document.vessels.find(x=>x.id===first.vesselId);assert.equal(vesselAfter.loadedT-vesselBefore.loadedT,first.tonnageT);assert.equal(vesselBefore.reservedT-vesselAfter.reservedT,first.tonnageT);
 assert.equal(after.document.inventoryLedger.filter(x=>x.referenceId===first.id).length,2);assert.equal(after.document.erpOutbox.filter(x=>x.entityId===first.id).length,2);
 assert.equal(completed.quantitySource,'PLANNED_DEMO_DRIVER_CONFIRMATION');assert.equal(completed.measurementPending,true);
 for(const entry of after.document.inventoryLedger.filter(x=>x.referenceId===first.id)){assert.equal(entry.quantitySource,'PLANNED_DEMO_DRIVER_CONFIRMATION');assert.equal(entry.measurementPending,true);}
 for(const entry of after.document.erpOutbox.filter(x=>x.entityId===first.id)){assert.equal(entry.status,'awaiting_configuration');assert.equal(entry.payload.quantitySource,'PLANNED_DEMO_DRIVER_CONFIRMATION');assert.equal(entry.payload.measurementPending,true);}
 assert.ok(after.document.trips.some(x=>x.requestId===f.requestB&&x.status==='waiting_truck'),'Truck stays bound to the current dispatch until all serial work returns');
 const finishedSnapshot=business(after.document);const replayEvent=await f.action('trip.driver_scan',stage2,'qa-driver-a');assert.equal(replayEvent.status,200);assert.deepEqual(business((await f.state()).document),finishedSnapshot);
 await reject(await f.action('trip.driver_scan',f.payload(first.id,2,wire),'qa-driver-a'),'A new Scan2 cannot repeat a finished receipt');
 const secondWire=await f.assignment(second.id);await f.ok('trip.driver_scan',f.payload(second.id,1,secondWire),'qa-driver-a');await f.ok('trip.driver_scan',f.payload(second.id,2,secondWire),'qa-driver-a');
 after=await f.state();assert.equal(after.document.requests.find(x=>x.id===f.requestA).status,'completed');const waiting=after.document.trips.find(x=>x.requestId===f.requestB);assert.equal(waiting.status,'queued');assert.equal(waiting.assignedDriverUserId,f.driverAId);
 const counters=(await f.call('/api/v1/demo/context','GET',undefined,'qa-driver-a')).body.state.driverDailySummary;assert.equal(counters.completedTrips,2);assert.equal(counters.unfinishedTrips,1);assert.equal(counters.includeCarryover,true);
 const waitingWire=await f.assignment(waiting.id);await f.ok('trip.driver_scan',f.payload(waiting.id,1,waitingWire),'qa-driver-a');await f.ok('trip.driver_scan',f.payload(waiting.id,2,waitingWire),'qa-driver-a');
 const final=await f.state();assert.ok(final.document.trips.every(x=>x.status==='returned'));assert.equal(final.document.erpOutbox.length,6);assert.equal(final.document.inventoryLedger.length,6);assert.equal(final.document.vessels.find(x=>x.id==='vessel-1').reservedT,0);
});

test('legacy ready adoption is explicit Scan2 only and preserves prior QR, start and accepted tare evidence',async t=>{
 const f=await fixture(t,{quantity:10,secondRequest:false}),first=f.tripsA[0],source=first.crusherId==='crusher-1'?'stock1':'stock2';
 await f.ok('trip.qr',{tripId:first.id});await f.ok('trip.tare',{tripId:first.id,weightT:20},source);await f.ok('trip.start',{tripId:first.id},'qa-driver-a');
 const before=await f.state(),legacy=trip(before.document,first.id);assert.equal(legacy.status,'ready_to_load');assert.equal(legacy.weighingEvents.length,1);
 const evidence=Object.fromEntries(Object.entries(legacy).filter(([key])=>/^(tare|qr|startedAt|weighingEvents)/.test(key)));
 const wire=await f.assignment(first.id);await f.assignment(first.id);assert.deepEqual(await f.state(),before,'Legacy READY GET does not initialize or write a new first scan');
 await reject(await f.action('trip.driver_scan',f.payload(first.id,1,wire),'qa-driver-a'),'Legacy READY cannot be downgraded to a fabricated Scan1');assert.deepEqual(await f.state(),before);
 const p=f.payload(first.id,2,wire);await f.ok('trip.driver_scan',p,'qa-driver-a');const after=await f.state(),done=trip(after.document,first.id);assert.equal(done.status,'returned');
 assert.equal(done.driverScanOrigin,'LEGACY_READY');assert.equal(Object.hasOwn(done,'driverFirstScannedAt'),false,'Legacy adoption never invents a first Driver scan');
 assert.deepEqual(Object.fromEntries(Object.entries(done).filter(([key])=>/^(tare|qr|startedAt|weighingEvents)/.test(key))),evidence,'Accepted tare, original start and QR remain exact');
 for(const key of ['grossT','grossEventId','netT','actualNetT','actualVolumeM3'])assert.equal(Object.hasOwn(done,key),false,'Legacy adoption cannot invent '+key);
 assert.equal(after.document.inventoryLedger.filter(x=>x.referenceId===first.id).length,2);assert.equal(after.document.erpOutbox.filter(x=>x.entityId===first.id).length,2);
 const replay=await f.action('trip.driver_scan',p,'qa-driver-a');assert.equal(replay.status,200);assert.deepEqual(business((await f.state()).document),business(after.document));
});

test('LAND receipt conserves stock and invalid destination or reservation failures roll the complete Scan2 draft back',async t=>{
 const f=await fixture(t,{mode:'LAND',quantity:10,secondRequest:false}),first=f.tripsA[0],wire=await f.assignment(first.id);await f.ok('trip.driver_scan',f.payload(first.id,1,wire),'qa-driver-a');
 const ready=await f.state(),p=f.payload(first.id,2,wire),requestId=randomUUID();
 const invalid=structuredClone(ready.document);invalid.stockpiles.find(x=>x.id===first.destinationStockpileId).active=false;await f.db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(invalid)]);const beforeBad=await f.state();
 await reject(await f.action('trip.driver_scan',p,'qa-driver-a',{requestId}),'Inactive LAND receiver blocks the entire completion');assert.deepEqual(await f.state(),beforeBad);
 const noReserve=structuredClone(ready.document);noReserve.stockpiles.find(x=>x.id===first.stockpileId).reservedM3=0;await f.db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(noReserve)]);const beforeReserve=await f.state();
 await reject(await f.action('trip.driver_scan',p,'qa-driver-a',{requestId}),'Missing source reservation blocks the entire completion');assert.deepEqual(await f.state(),beforeReserve);
 const tinyDeficit=structuredClone(ready.document),tinyStock=tinyDeficit.stockpiles.find(x=>x.id===first.stockpileId);tinyStock.onHandM3=first.volumeM3-0.000001;tinyStock.reservedM3=first.volumeM3;
 await f.db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(tinyDeficit)]);const beforeTiny=await f.state();
 await reject(await f.action('trip.driver_scan',p,'qa-driver-a',{requestId}),'Even a deficit below comparison tolerance cannot create negative rounded stock');assert.deepEqual(await f.state(),beforeTiny);
 await f.db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(ready.document)]);await f.ok('trip.driver_scan',p,'qa-driver-a',{requestId});const after=await f.state();
 const total=document=>document.stockpiles.reduce((sum,x)=>sum+x.onHandM3,0);assert.ok(Math.abs(total(after.document)-total(ready.document))<0.000002);assert.equal(after.document.stockpiles.find(x=>x.id===first.destinationStockpileId).onHandM3,first.volumeM3);assert.deepEqual(after.document.vessels,ready.document.vessels);assert.equal(trip(after.document,first.id).status,'returned');noPhysicalWeights(trip(after.document,first.id));
});

test('LAND tablet serial Scan 2 keeps the planned SKU after rejected relabel and books stock once per trip',async t=>{
 const f=await fixture(t,{mode:'LAND',quantity:80,secondRequest:false});
 const [first,second]=f.tripsA;
 assert.equal(f.tripsA.length,2);
 assert.ok(f.tripsA.every(ritase=>ritase.skuId==='split-12'&&ritase.tonnageT===40&&
   ritase.truckId===first.truckId&&ritase.stockpileId===first.stockpileId&&ritase.destinationStockpileId===first.destinationStockpileId));
 const sourceId=first.stockpileId,targetId=first.destinationStockpileId;
 const bin=(document,id)=>document.stockpiles.find(row=>row.id===id);
 const initial=await f.state();
 assert.equal(bin(initial.document,targetId).managedBy,'STOCKPILE_LOCATION');
 assert.equal(bin(initial.document,targetId).reservedM3,0,'Receiving stock must be protected even without its own reservation');

 const legacy=(action,payload,user='admin')=>f.call('/api/action','POST',{action,payload,requestId:randomUUID()},user);
 const survey=(stockpileId,skuId=first.skuId)=>({stockpileId,skuId,method:'manual',quantityValue:15,quantityUnit:'m3'});
 const wire=await f.assignment(first.id);
 await f.ok('trip.driver_scan',f.payload(first.id,1,wire),'qa-driver-a');
 assert.deepEqual(inventory((await f.state()).document),inventory(initial.document));

 const created=await legacy('measurement.create',survey(targetId));
 assert.equal(created.status,200,JSON.stringify(created.body));
 const staleId=created.body.result.entityId;
 // A prior tablet build permitted a pending survey to carry a SKU different from the receiving bin.
 const withStaleSurvey=(await f.state()).document;
 withStaleSurvey.measurements.find(row=>row.id===staleId).skuId='abu-batu';
 await f.db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(withStaleSurvey)]);
 const beforeRejected=await f.state();
 const staleApproval=await legacy('measurement.approve',{measurementId:staleId});
 assert.equal(staleApproval.status,409,staleApproval.body.error);
 assert.equal(staleApproval.body.error,'STALE_MEASUREMENT');
 for(const stockpileId of [sourceId,targetId]){
  const relabel=await legacy('master.stockpile.save',{id:stockpileId,skuId:'abu-batu'});
  assert.equal(relabel.status,409,JSON.stringify(relabel.body));
  assert.equal(relabel.body.error,'ACTIVE_INTEGRATED_ASSIGNMENT');
  const wrongSku=await legacy('measurement.create',survey(stockpileId,'abu-batu'));
  assert.equal(wrongSku.status,409,JSON.stringify(wrongSku.body));
  assert.equal(wrongSku.body.error,'ACTIVE_INTEGRATED_ASSIGNMENT');
 }
 assert.deepEqual(await f.state(),beforeRejected,'Rejected SKU changes leave operation revision, stock and ERP untouched');

 const sameSku=await legacy('measurement.create',survey(targetId));
 assert.equal(sameSku.status,200,JSON.stringify(sameSku.body));
 const surveyId=sameSku.body.result.entityId;
 const approved=await legacy('measurement.approve',{measurementId:surveyId});
 assert.equal(approved.status,200,JSON.stringify(approved.body));
 const ready=await f.state();
 assert.equal(bin(ready.document,targetId).onHandM3,15);
 assert.equal(bin(ready.document,targetId).skuId,first.skuId);
 assert.equal(ready.document.erpOutbox.find(row=>row.entityId===surveyId).payload.skuId,first.skuId);
 const currentWire=await f.assignment(first.id);
 assert.deepEqual(currentWire.binding,wire.binding);
 assert.equal(currentWire.qr.value,wire.qr.value);
 assert.equal(currentWire.trip.driverScan.nextStage,2);
 assert.equal(currentWire.trip.driverScan.canScan,true);

 // A bin already relabelled by an old release needs physical stock reconciliation.
 // Scan 2 must never post the planned material into that different-SKU bin.
 const oldRelabel=structuredClone(ready.document);
 bin(oldRelabel,targetId).skuId='abu-batu';
 await f.db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(oldRelabel)]);
 const wrongLabelSurvey=await legacy('measurement.create',survey(targetId,'abu-batu'));
 assert.equal(wrongLabelSurvey.status,200,JSON.stringify(wrongLabelSurvey.body));
 const oldRelabelSnapshot=await f.state();
 const heldApproval=await legacy('measurement.approve',{measurementId:wrongLabelSurvey.body.result.entityId});
 assert.equal(heldApproval.status,409,heldApproval.body.error);
 assert.equal(heldApproval.body.error,'ACTIVE_INTEGRATED_ASSIGNMENT');
 const mismatchedQr=await f.call('/api/v1/demo/trips/'+first.id+'/assignment-qr','GET',undefined,'qa-driver-a');
 assert.equal(mismatchedQr.status,409);
 assert.equal(mismatchedQr.body.error,'ASSIGNMENT_QR_BINDING_INVALID');
 const blocked=await f.action('trip.driver_scan',f.payload(first.id,2,wire),'qa-driver-a');
 assert.equal(blocked.status,409);
 assert.equal(blocked.body.error,'ASSIGNMENT_QR_BINDING_INVALID');
 assert.deepEqual(await f.state(),oldRelabelSnapshot);
 await f.db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(ready.document)]);

 const complete=async(ritase,descriptor)=>{
  const scan2=f.payload(ritase.id,2,descriptor),requestId=randomUUID();
  const completed=await f.ok('trip.driver_scan',scan2,'qa-driver-a',{requestId});
  assert.equal(completed.result.status,'returned');
  const snapshot=await f.state();
  const replay=await f.ok('trip.driver_scan',scan2,'qa-driver-a',{requestId});
  assert.equal(replay.replayed,true);
  assert.deepEqual(await f.state(),snapshot,'A retried Scan 2 cannot duplicate the receipt or stock movement');
  return snapshot.document;
 };
 const interim=await complete(first,wire);
 assert.equal(trip(interim,first.id).status,'returned');
 assert.equal(trip(interim,second.id).status,'queued');
 assert.equal(bin(interim,sourceId).reservedM3,second.volumeM3);
 assert.equal(bin(interim,targetId).onHandM3,Number((15+first.volumeM3).toFixed(6)));
 const next=await f.assignment(second.id);
 assert.equal(next.qr.value,wire.qr.value);
 assert.equal(next.binding.tripId,second.id);
 assert.equal(next.trip.driverScan.nextStage,1);
 await f.ok('trip.driver_scan',f.payload(second.id,1,next),'qa-driver-a');
 const final=await complete(second,next);
 assert.equal(final.requests.find(row=>row.id===f.requestA).status,'completed');
 assert.deepEqual(final.vessels,ready.document.vessels);
 const moved=first.volumeM3+second.volumeM3;
 assert.equal(bin(final,sourceId).skuId,first.skuId);
 assert.equal(bin(final,sourceId).reservedM3,0);
 assert.equal(bin(final,sourceId).onHandM3,Number((bin(ready.document,sourceId).onHandM3-moved).toFixed(6)));
 assert.equal(bin(final,targetId).skuId,first.skuId);
 assert.equal(bin(final,targetId).onHandM3,Number((15+moved).toFixed(6)));
 for(const ritase of f.tripsA){
  const events=final.inventoryLedger.filter(row=>row.referenceId===ritase.id);
  assert.deepEqual(events.map(row=>[row.type,row.stockpileId,row.volumeM3,row.tonnageT]),[
   ['transfer_departed',sourceId,-ritase.volumeM3,-ritase.tonnageT],
   ['stock_transfer_received',targetId,ritase.volumeM3,ritase.tonnageT],
  ]);
  const outbox=final.erpOutbox.filter(row=>row.entityId===ritase.id);
  assert.deepEqual(outbox.map(row=>row.type),['stock_transfer_departed','stock_transfer_received']);
  assert.ok(outbox.every(row=>row.payload.skuId===ritase.skuId&&row.payload.sourceStockpileId===sourceId&&
    row.payload.destinationStockpileId===targetId&&row.payload.volumeM3===ritase.volumeM3&&row.payload.tonnageT===ritase.tonnageT));
 }
 assert.equal(final.measurements.find(row=>row.id===staleId).status,'pending');
 assert.equal(final.erpOutbox.some(row=>row.entityId===staleId),false);
});

for(const stage of ['unloaded','returning'])test('legacy '+stage+' Scan2 verifies return only, preserving all accepted weighing and custody bytes',async t=>{
 const f=await fixture(t,{quantity:10,secondRequest:false}),first=f.tripsA[0],source=first.crusherId==='crusher-1'?'stock1':'stock2';
 await f.ok('trip.qr',{tripId:first.id});await f.ok('trip.tare',{tripId:first.id,weightT:20},source);await f.ok('trip.start',{tripId:first.id},'qa-driver-a');await f.ok('trip.loading',{tripId:first.id},source);await f.ok('trip.gross',{tripId:first.id,weightT:30},source);await f.ok('trip.depart',{tripId:first.id},source);await f.ok('trip.arrive',{tripId:first.id},'jetty1');await f.ok('trip.receive',{tripId:first.id},'jetty1');
 if(stage==='returning')await f.ok('trip.return_start',{tripId:first.id},'qa-driver-a');
 const before=await f.state(),legacy=trip(before.document,first.id),weights=Object.fromEntries(Object.entries(legacy).filter(([key])=>/^(tare|gross|netT|actual|qr|startedAt|weighingEvents|received|receipt|unloaded|departed|arrived|returnStartedAt)/.test(key)));
 assert.equal(legacy.status,stage);assert.equal(before.document.stockpiles.find(x=>x.id===first.stockpileId).reservedM3,0,'Already departed cargo no longer has a source reservation');
 const wire=await f.assignment(first.id);await f.assignment(first.id);assert.deepEqual(await f.state(),before,'GET cannot adopt an existing received trip or schedule the next one');
 assert.equal(wire.trip.driverScan.nextStage,2);assert.equal(wire.trip.driverScan.canScan,true);
 for(const corrupt of [
  document=>{document.inventoryLedger=document.inventoryLedger.filter(x=>x.referenceId!==first.id||x.type!=='vessel_received');},
  document=>{document.erpOutbox.find(x=>x.entityId===first.id&&x.type==='stock_transfer_received').payload.vesselId='vessel-2';},
  document=>{document.erpOutbox.find(x=>x.entityId===first.id&&x.type==='stock_transfer_received').payload.sourceStockpileId='wrong-source-stockpile';},
  document=>{document.erpOutbox.find(x=>x.entityId===first.id&&x.type==='stock_transfer_received').payload.receiptCode='RCV-99999';}
 ]){
  const bad=structuredClone(before.document);corrupt(bad);await f.db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(bad)]);const original=await f.state();
  const blocked=await f.assignment(first.id);assert.equal(blocked.trip.driverScan.canScan,false,'Missing or mismatched custody proof cannot be adopted');
  await reject(await f.action('trip.driver_scan',f.payload(first.id,2,wire),'qa-driver-a'),'Mismatched legacy custody proof blocks return adoption');assert.deepEqual(await f.state(),original);
 }
 await f.db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(before.document)]);
 const p=f.payload(first.id,2,wire);await f.ok('trip.driver_scan',p,'qa-driver-a');const after=await f.state(),done=trip(after.document,first.id);
 assert.equal(done.status,'returned');assert.ok(done.returnedAt);assert.equal(done.returnVerifiedBy,f.driverAId);assert.equal(Object.hasOwn(done,'driverFirstScannedAt'),false);
 assert.deepEqual(Object.fromEntries(Object.entries(done).filter(([key])=>/^(tare|gross|netT|actual|qr|startedAt|weighingEvents|received|receipt|unloaded|departed|arrived|returnStartedAt)/.test(key))),weights,'Return-only compatibility preserves original evidence and receipt');
 assert.deepEqual(inventory(after.document),inventory(before.document),'No second departure, stock receipt, vessel loading, ledger or ERP entry is created');
 const added=after.document.events.slice(before.document.events.length);assert.equal(added.filter(x=>x.type==='trip.driver_scan').length,1);assert.ok(added.filter(x=>x.type==='trip.driver_scan').every(x=>x.expectedStage===2));
 const again=await f.action('trip.driver_scan',p,'qa-driver-a');assert.equal(again.status,200);assert.deepEqual(business((await f.state()).document),business(after.document));
});

test('queued legacy pending tare joins explicit Scan1 without recreating its reading; Scan2 still has no invented gross',async t=>{
 const f=await fixture(t,{quantity:10,secondRequest:false}),first=f.tripsA[0],source=first.crusherId==='crusher-1'?'stock1':'stock2';
 await f.ok('trip.tare',{tripId:first.id,weightT:20},source);const pending=await f.state(),original=trip(pending.document,first.id).weighingEvents[0];assert.equal(original.status,'PENDING');
 const wire=await f.assignment(first.id);assert.equal(wire.trip.driverScan.nextStage,1);assert.equal(wire.trip.driverScan.canScan,true);await f.assignment(first.id);assert.deepEqual(await f.state(),pending,'GET cannot accept a pending weigh reading');
 const p1=f.payload(first.id,1,wire);await f.ok('trip.driver_scan',p1,'qa-driver-a');const ready=await f.state(),recorded=trip(ready.document,first.id),accepted=recorded.weighingEvents[0];assert.equal(recorded.status,'ready_to_load');assert.equal(recorded.weighingEvents.length,1);assert.equal(accepted.status,'ACCEPTED');assert.ok(accepted.acceptedAt);
 for(const [key,value]of Object.entries(original))if(key!=='status')assert.deepEqual(accepted[key],value,'Original reading '+key+' is preserved');assert.equal(recorded.tareT,20);assert.equal(recorded.tareEventId,original.id);
 const weights=structuredClone(recorded.weighingEvents);await f.ok('trip.driver_scan',f.payload(first.id,2,wire),'qa-driver-a');const done=trip((await f.state()).document,first.id);assert.equal(done.status,'returned');assert.deepEqual(done.weighingEvents,weights);
 for(const key of ['grossT','grossEventId','netT','actualNetT'])assert.equal(Object.hasOwn(done,key),false);
});
