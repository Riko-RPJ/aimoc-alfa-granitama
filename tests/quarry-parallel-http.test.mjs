import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {hash} from '../server/auth.mjs';

const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.000003,`${actual} != ${expected}`);
const errorCode=response=>response.body.error?.code||response.body.error;

test('Alfa stock approval and planning feed four concurrent Cilegon queues; old Jetty receipt and source gate return persist once across real HTTP roles',async t=>{
 const db=await createEmbeddedDatabase();await bootstrap(db);let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await db.close();});
 for(let index=1;index<=4;index++)await db.query('INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)',[randomUUID(),'parallel-driver-'+index,'Synthetic parallel Driver '+index,'unused-synthetic-hash','driver']);
 const actors={};
 for(const user of(await db.query('SELECT id,username,role FROM aimoc_alfa_ops.users')).rows){
  const token=('synthetic-parallel-session-'+user.username).padEnd(64,'x');
  await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic-parallel-csrf',now()+interval '1 hour')",[hash(token),user.id]);
  actors[user.username]={...user,cookie:'alfa_session='+token};
 }
 const stored=async()=>(await db.query('SELECT document,revision,updated_at FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 const initial=await stored();initial.document.trucks=initial.document.trucks.slice(0,4).map(row=>({...row,bedM3:30,payloadLimitT:45}));
 for(const pile of initial.document.stockpiles.filter(row=>row.skuId==='split-12'))pile.onHandM3=0;
 await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(initial.document)]);
 server=http.createServer(createHandler(db));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const call=async(path,method='GET',body,user='admin')=>{
  const response=await fetch(origin+path,{method,headers:{Cookie:actors[user].cookie,...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':'synthetic-parallel-csrf'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{status:response.status,body:await response.json()};
 };
 const send=(action,payload,user='admin',extra={},legacy=false)=>call(legacy?'/api/action':'/api/v1/demo/actions','POST',{action,payload,requestId:randomUUID(),...extra},user);
 const ok=async(action,payload,user='admin',extra={},legacy=false)=>{const result=await send(action,payload,user,extra,legacy);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
 const context=async user=>{const result=await call('/api/v1/demo/context','GET',undefined,user);assert.equal(result.status,200);return result.body;};
 const source=row=>row.crusherId==='crusher-1'?'stock1':'stock2';
 const snapshot=async()=>({operation:await stored(),receipts:(await db.query('SELECT actor_id,request_id,payload_hash,result FROM aimoc_alfa_ops.actions ORDER BY actor_id,request_id')).rows});

 // These are the same endpoints used by Alfa's Ukur stockpile and approval UI.
 for(const crusherId of ['crusher-1','crusher-2']){
  const stock=initial.document.stockpiles.find(row=>row.crusherId===crusherId&&row.skuId==='split-12'),username=crusherId==='crusher-1'?'stock1':'stock2';
  const measured=await ok('measurement.create',{stockpileId:stock.id,method:'manual',quantityValue:600,quantityUnit:'m3',notes:'Synthetic parallel UAT survey'},username,{},true);
  assert.equal((await stored()).document.stockpiles.find(row=>row.id===stock.id).onHandM3,0,'Submitted survey is not inventory until Admin approval');
  const measurementId=measured.result.entityId,before=await snapshot();
  assert.equal((await send('measurement.approve',{measurementId},username,{},true)).status,403);assert.deepEqual(await snapshot(),before);
  await ok('measurement.approve',{measurementId},'admin',{},true);
  assert.equal((await stored()).document.stockpiles.find(row=>row.id===stock.id).onHandM3,600);
 }
 const beforeActivation=await snapshot();
 assert.equal((await send('quarry.config.save',{enabled:true,model:'STATIC_WIM'},'stock1')).status,403);assert.deepEqual(await snapshot(),beforeActivation);
 await ok('quarry.config.save',{enabled:true,model:'STATIC_WIM'});
 const created=await ok('request.create',{transferMode:'MARINE',destinationLocationId:initial.document.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:360,unit:'t'}]});
 const requestId=created.result.requestId,planId=randomUUID(),plans=await Promise.all([send('request.plan',{requestId},'admin',{requestId:planId}),send('request.plan',{requestId},'admin',{requestId:planId})]);
 assert.ok(plans.every(row=>row.status===200));assert.equal(plans.filter(row=>row.body.replayed).length,1);
 const planned=await stored(),trips=planned.document.trips.filter(row=>row.requestId===requestId),queues=planned.document.trucks.map(truck=>trips.filter(row=>row.truckId===truck.id).sort((a,b)=>a.sequence-b.sequence));
 assert.equal(trips.length,8);assert.ok(queues.every(queue=>queue.length===2));assert.deepEqual(queues.map(queue=>queue[0].crusherId),['crusher-1','crusher-2','crusher-1','crusher-2']);
 assert.equal(planned.document.dispatches.find(row=>row.requestId===requestId).sourceAllocationMode,'BALANCED_CRUSHERS');
 near(planned.document.vessels[0].reservedT,360);near(planned.document.stockpiles.reduce((sum,row)=>sum+row.reservedM3,0),240);
 const driverFor=row=>Object.keys(actors).find(username=>actors[username].id===row.assignedDriverUserId);
 const passByTruck=new Map();
 for(const queue of queues){
  const row=queue[0],driver=driverFor(row),assignment=await call('/api/v1/demo/trips/'+row.id+'/assignment-qr','GET',undefined,driver);
  assert.equal(assignment.status,200);assert.equal(assignment.body.trip.driverScan.phase,'QUARRY_WORKFLOW');assert.equal(assignment.body.trip.driverScan.canScan,false);
  const sourceView=await context(source(row));passByTruck.set(row.truckId,sourceView.state.trips.find(item=>item.id===row.id).quarry.dispatchPass.value);
  const otherDriver=Object.keys(actors).find(username=>actors[username].role==='driver'&&username!==driver);
  assert.equal((await call('/api/v1/demo/trips/'+row.id+'/assignment-qr','GET',undefined,otherDriver)).status,404);
 }
 const beforePolling=await snapshot();
 for(const username of ['admin','stock1','stock2','jetty1','jetty2',...Object.keys(actors).filter(username=>actors[username].role==='driver')])await context(username);
 assert.deepEqual(await snapshot(),beforePolling,'Opening either app and polling each role never advances an operation');
 const gatePayload=(row,purpose,extra={})=>({tripId:row.id,truckId:row.truckId,laneId:purpose==='EXIT'?'lane-2':purpose==='RETURN'?'lane-3':'lane-1',direction:purpose==='EXIT'?'OUT':'IN',purpose,qrValue:passByTruck.get(row.truckId),externalEventId:randomUUID(),...extra});

 for(const round of [0,1]){
  const batch=queues.map(queue=>queue[round]),before=await stored(),entries=batch.map(row=>({row,payload:gatePayload(row,'ENTRY',round?{laneId:'lane-3'}:{weightT:15}),requestId:randomUUID()}));
  // Four browsers have the same snapshot. One wins; the other operators refresh
  // before explicitly retrying their unchanged event and request identities.
  const entered=await Promise.all(entries.map(({row,payload,requestId})=>send('quarry.gate.scan',payload,source(row),{requestId,expectedRevision:Number(before.revision)})));
  assert.equal(entered.filter(row=>row.status===200).length,1);assert.ok(entered.filter(row=>row.status!==200).every(row=>row.status===409&&errorCode(row)==='REVISION_CONFLICT'));
  for(const [index,intent]of entries.entries()){
   if(entered[index].status===409)await ok('quarry.gate.scan',intent.payload,source(intent.row),{requestId:intent.requestId,expectedRevision:Number((await stored()).revision)});
  }
  const entryDone=await stored();assert.equal(Number(entryDone.revision),Number(before.revision)+4);
  for(const intent of entries){const replay=await send('quarry.gate.scan',intent.payload,source(intent.row),{requestId:intent.requestId,expectedRevision:Number(before.revision)});assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);}
  assert.deepEqual(await stored(),entryDone,'Retry after a lost/stale response records no second tare or revision');
  assert.equal(entryDone.document.trips.filter(row=>row.requestId===requestId&&row.status==='ready_to_load').length,4);
  const first=batch[0],wrongSource=source(first)==='stock1'?'stock2':'stock1',beforeDenied=await snapshot();
  assert.equal((await send('trip.loading',{tripId:first.id},wrongSource)).status,403);
  assert.equal((await send('trip.loading',{tripId:first.id},driverFor(first))).status,403);
  assert.deepEqual(await snapshot(),beforeDenied);
  await Promise.all(batch.map(row=>ok('trip.loading',{tripId:row.id},source(row))));
  const exits=batch.map(row=>({row,payload:gatePayload(row,'EXIT',{weightT:60}),requestId:randomUUID()}));
  const departures=await Promise.all(exits.flatMap(intent=>[send('quarry.gate.scan',intent.payload,source(intent.row),{requestId:intent.requestId}),send('quarry.gate.scan',intent.payload,source(intent.row),{requestId:intent.requestId})]));
  assert.ok(departures.every(row=>row.status===200));assert.equal(departures.filter(row=>row.body.replayed).length,4);
  const departed=await stored();near(departed.document.vessels[0].loadedT,180*round);near(departed.document.vessels[0].reservedT,360-180*round);
  const sourceStocks=departed.document.stockpiles.filter(row=>row.skuId==='split-12');sourceStocks.forEach(row=>near(row.onHandM3,600-(round+1)*60));
  assert.equal(departed.document.trips.filter(row=>row.requestId===requestId&&row.status==='in_transit').length,4);
  const jettyView=await context('jetty1');assert.ok(batch.every(row=>jettyView.state.trips.find(item=>item.id===row.id).allowedActions.includes('trip.arrive')));
  assert.equal((await context('jetty2')).state.trips.length,0);
  const beforeEarly=await snapshot();
  assert.equal((await send('quarry.gate.scan',gatePayload(first,'RETURN'),source(first))).status,409);assert.deepEqual(await snapshot(),beforeEarly);
  await Promise.all(batch.map(row=>ok('trip.arrive',{tripId:row.id},'jetty1')));
  const receives=batch.map(row=>({row,requestId:randomUUID()})),receipts=await Promise.all(receives.flatMap(({row,requestId})=>[send('trip.receive',{tripId:row.id},'jetty1',{requestId}),send('trip.receive',{tripId:row.id},'jetty1',{requestId})]));
  assert.ok(receipts.every(row=>row.status===200));assert.equal(receipts.filter(row=>row.body.replayed).length,4);
  const received=await stored();near(received.document.vessels[0].loadedT,(round+1)*180);near(received.document.vessels[0].reservedT,180-round*180);
  const returnBefore=structuredClone({stock:received.document.stockpiles,vessels:received.document.vessels,ledger:received.document.inventoryLedger,outbox:received.document.erpOutbox});
  await Promise.all(batch.map(row=>ok('quarry.gate.scan',gatePayload(row,'RETURN'),source(row))));
  const returned=await stored();assert.deepEqual({stock:returned.document.stockpiles,vessels:returned.document.vessels,ledger:returned.document.inventoryLedger,outbox:returned.document.erpOutbox},returnBefore);
 }
 const final=await stored(),finalTrips=final.document.trips.filter(row=>row.requestId===requestId);
 assert.ok(finalTrips.every(row=>row.status==='returned'));assert.equal(new Set(finalTrips.map(row=>row.receiptCode)).size,8);
 for(const row of finalTrips){
  assert.equal(final.document.inventoryLedger.filter(entry=>entry.referenceId===row.id).length,2);assert.equal(final.document.erpOutbox.filter(entry=>entry.entityId===row.id).length,2);
  const driverView=await context(driverFor(row));assert.equal(driverView.state.trips.find(item=>item.id===row.id).status,'returned');
 }
 for(const username of ['admin','stock1','stock2','jetty1']){
  const view=await context(username);assert.ok(view.state.trips.every(row=>row.status==='returned'&&!row.allowedActions.includes('trip.receive')&&row.quarry.allowedPurposes.length===0));
  assert.ok(view.state.fleet.every(row=>row.status==='available'&&!row.dispatchId&&!row.activeTripId&&!row.nextTripId));
 }
 near(final.document.vessels[0].loadedT,360);near(final.document.vessels[0].reservedT,0);near(final.document.stockpiles.reduce((sum,row)=>sum+row.reservedM3,0),0);
 assert.equal(final.document.requests.find(row=>row.id===requestId).status,'completed');
});
