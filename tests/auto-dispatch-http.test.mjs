import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {hash} from '../server/auth.mjs';

const terminal=t=>['returned','cancelled'].includes(t.status);
const assigned=s=>s.trips.filter(t=>!terminal(t)&&t.truckId);
const waiting=s=>s.trips.filter(t=>t.status==='waiting_truck');
const amount=(rows,key)=>rows.reduce((sum,row)=>sum+Number(row[key]||0),0);
const close=(a,b)=>Math.abs(a-b)<0.00002;

async function fixture(t,{drivers=2}={}){
 const db=await createEmbeddedDatabase();
 await bootstrap(db);
 const s=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
 s.products.find(x=>x.id==='split-12').densityTPerM3=2;
 s.trucks=s.trucks.slice(0,2);
 Object.assign(s.trucks[0],{bedM3:10,payloadLimitT:10}); // Payload is limiting.
 Object.assign(s.trucks[1],{bedM3:10,payloadLimitT:30}); // Volume is limiting: 20t.
 for(const stock of s.stockpiles.filter(x=>x.skuId==='split-12')){
  stock.active=stock.id==='stock-2-3';
  if(stock.active)stock.onHandM3=100;
 }
 await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(s)]);
 const actors={};
 const sessionFor=async(row)=>{
  const token=(row.username+'-'+randomUUID()).padEnd(60,'x');
  await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'csrf-auto-test',now()+interval '1 hour')",[hash(token),row.id]);
  actors[row.username]={id:row.id,role:row.role,cookie:'alfa_session='+token,csrf:'csrf-auto-test'};
 };
 for(const row of (await db.query('SELECT id,username,role FROM aimoc_alfa_ops.users')).rows)await sessionFor(row);
 const addDriver=async(number)=>{
  const row={id:'synthetic-auto-driver-'+number,username:'driver'+number,role:'driver'};
  await db.query("INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,'synthetic-no-password-login','driver')",[row.id,row.username,'Synthetic automatic Driver '+number]);
  await sessionFor(row);return row;
 };
 for(let i=1;i<=drivers;i++)await addDriver(i);
 const server=http.createServer(createHandler(db));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 const call=async(path,method='GET',body,user='admin')=>{
  const actor=typeof user==='string'?actors[user]:user||{};
  const r=await fetch(origin+path,{method,headers:{...(actor?.cookie?{Cookie:actor.cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':actor?.csrf||''}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,body:await r.json()};
 };
 const action=(name,payload,user='admin',extra={})=>call('/api/v1/demo/actions','POST',{action:name,payload,requestId:randomUUID(),...extra},user);
 const ok=async(name,payload,user='admin',extra={})=>{const r=await action(name,payload,user,extra);assert.equal(r.status,200,name+': '+JSON.stringify(r.body));return r.body;};
 const context=async(user='admin')=>{const r=await call('/api/v1/demo/context','GET',undefined,user);assert.equal(r.status,200);return r.body;};
 const request=async(quantity)=>{
  const r=await ok('request.create',{transferMode:'MARINE',destinationLocationId:'stockpile-location-crusher-2',jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity,unit:'t'}]});
  return r.result.requestId;
 };
 const unique=(state)=>{
  const active=assigned(state);
  for(const field of ['truckId','assignedDriverUserId'])for(const value of new Set(active.map(t=>t[field]))){
   const tasks=active.filter(t=>t[field]===value);
   assert.equal(new Set(tasks.map(t=>t.dispatchId)).size,1,'A truck/Driver may claim only one unfinished dispatch');
   assert.equal(new Set(tasks.map(t=>field==='truckId'?t.assignedDriverUserId:t.truckId)).size,1,'Serial dispatch retains one truck/Driver pair');
   assert.ok(tasks.filter(t=>t.startedAt||!['queued','waiting_truck'].includes(t.status)).length<=1,'A resource cannot execute simultaneous trips');
  }
  for(const trip of active){
   const truck=state.trucks.find(x=>x.id===trip.truckId);
   assert.ok(trip.assignedDriverUserId,'Assigned task has an automatically selected Driver');
   assert.ok(trip.tonnageT<=truck.payloadLimitT+0.00001);
   assert.ok(trip.volumeM3<=truck.bedM3+0.00001);
   assert.ok(close(trip.tonnageT,trip.volumeM3*2));
  }
  for(const trip of waiting(state)){assert.equal(trip.truckId,null);assert.equal(trip.assignedDriverUserId,null);}
 };
 const finish=async(trip,{beforeReturn,returnKey}={})=>{
  const driver=Object.keys(actors).find(name=>actors[name].id===trip.assignedDriverUserId);assert.ok(driver);
  if(!trip.qrScannedAt)await ok('trip.qr',{tripId:trip.id});
  if(!trip.weighingEvents?.some(e=>e.type==='TARE'))await ok('trip.tare',{tripId:trip.id,weightT:5},'stock2');
  await ok('trip.start',{tripId:trip.id},driver);
  await ok('trip.loading',{tripId:trip.id},'stock2');
  await ok('trip.gross',{tripId:trip.id,weightT:5+trip.tonnageT},'stock2');
  await ok('trip.depart',{tripId:trip.id},'stock2');
  await ok('trip.arrive',{tripId:trip.id},'jetty1');
  await ok('trip.receive',{tripId:trip.id},'jetty1');
  await ok('trip.return_start',{tripId:trip.id},driver);
  if(beforeReturn)await beforeReturn((await context()).state);
  return ok('trip.return',{tripId:trip.id},'stock2',returnKey?{requestId:returnKey}:{});
 };
 return {db,actors,call,action,ok,context,request,unique,finish,addDriver};
}

test('automatic HTTP planning shares SKU stock across dispatches and reuses unique trucks only after verified return',async t=>{
 const {actors,action,ok,context,request,unique,finish}=await fixture(t);
 const first=await request(60);
 const a=await ok('request.plan',{requestId:first});
 unique(a.state);assert.equal(new Set(assigned(a.state).map(x=>x.truckId)).size,2);assert.equal(assigned(a.state).length,a.state.trips.length);
 assert.equal(waiting(a.state).length,0);assert.ok(close(amount(a.state.trips,'tonnageT'),60));
 assert.ok(a.state.trucks.every(x=>x.status==='allocated'));
 const second=await request(40),b=await ok('request.plan',{requestId:second});
 unique(b.state);assert.equal(assigned(b.state).length,assigned(a.state).length);assert.ok(waiting(b.state).some(x=>x.requestId===second));
 assert.ok(assigned(b.state).every(x=>x.requestId===first),'The second dispatch cannot claim either allocated truck');
 assert.equal(b.state.stockpiles.find(x=>x.id==='stock-2-3').reservedM3,50);assert.equal(b.state.vessels[0].reservedT,100);
 assert.equal(new Set(b.state.trips.map(x=>x.stockpileId)).size,1,'Multiple trucks/dispatches can use one stockpile');
 assert.equal(b.state.trips[0].stockpileId,'stock-2-3');
 const blocked=waiting(b.state)[0],denied=await action('trip.start',{tripId:blocked.id},'driver1');
 assert.ok([403,409].includes(denied.status));
 assert.equal((await action('trip.start',{tripId:assigned(b.state)[0].id},'admin')).status,403);
 assert.equal((await action('trip.tare',{tripId:assigned(b.state)[0].id,weightT:5},'stock1')).status,403);
 assert.equal((await context('driver1')).state.trips.some(x=>x.status==='waiting_truck'),false,'Unassigned cargo is not a Driver task');
 let current=b.state,completed=0;
 while(current.trips.some(x=>!terminal(x))){
  assert.ok(completed<20,'Scheduler must make progress without a new Admin plan');
  const task=assigned(current).sort((x,y)=>x.sequence-y.sequence)[0];assert.ok(task);
  const beforeWaiting=waiting(current).sort((x,y)=>(x.queueSequence??x.sequence)-(y.queueSequence??y.sequence)||x.sequence-y.sequence)[0];
  const ownRemaining=assigned(current).filter(x=>x.id!==task.id&&x.truckId===task.truckId&&x.dispatchId===task.dispatchId);
  const oldAssigned=assigned(current).map(x=>x.id).sort();
  const outcome=await finish(task,{beforeReturn:async state=>{
   unique(state);assert.deepEqual(assigned(state).map(x=>x.id).sort(),oldAssigned,'Receipt and return-start cannot release the truck');
  }});
  current=(await context()).state;unique(current);completed++;
  const replacement=assigned(current).find(x=>x.truckId===task.truckId);
  if(ownRemaining.length){assert.ok(replacement);assert.equal(replacement.dispatchId,task.dispatchId,'Own serial queue keeps its dispatch claim');}
  else if(beforeWaiting){assert.ok(replacement,'Own final verified return automatically allocates pending work');assert.equal(replacement.requestId,beforeWaiting.requestId,'Oldest pending request gets the freed resource');}
  assert.equal(outcome.result.status,'returned');
 }
 assert.ok(completed>=4);assert.ok(current.requests.every(x=>x.status==='completed'));assert.ok(current.dispatches.every(x=>x.status==='completed'));
 assert.equal(current.vessels[0].loadedT,100);assert.equal(current.vessels[0].reservedT,0);
 assert.equal(current.stockpiles.find(x=>x.id==='stock-2-3').onHandM3,50);assert.equal(current.stockpiles.find(x=>x.id==='stock-2-3').reservedM3,0);
 assert.ok(current.trucks.every(x=>x.status==='available'));assert.equal(current.erpOutbox.length,completed*2);assert.equal(current.inventoryLedger.length,completed*2);
 assert.ok(current.trips.every(x=>actors.driver1.id===x.assignedDriverUserId||actors.driver2.id===x.assignedDriverUserId));
});

test('automatic HTTP scheduling rejects manual assignments and prevents concurrent reservation/vehicle duplication',async t=>{
 const {db,call,action,ok,context,request,unique}=await fixture(t);
 assert.equal((await call('/api/v1/demo/context','GET',undefined,{})).status,401);
 const a=await request(60),b=await request(40);
 const forbidden=await action('request.plan',{requestId:a,assignments:[]});assert.equal(forbidden.status,400);assert.equal(forbidden.body.error,'MANUAL_ASSIGNMENT_NOT_ALLOWED');
 assert.equal((await action('request.plan',{requestId:a},'stock2')).status,403);
 const revision=(await context()).revision;
 const plans=await Promise.all([a,b].map(requestId=>action('request.plan',{requestId},'admin',{expectedRevision:revision})));
 assert.deepEqual(plans.map(x=>x.status).sort(),[200,409]);assert.equal(plans.find(x=>x.status===409).body.error,'REVISION_CONFLICT');
 const next=await context(),pending=next.state.requests.find(x=>x.status==='requested'),command={requestId:randomUUID(),expectedRevision:next.revision};
 const replay=await Promise.all([action('request.plan',{requestId:pending.id},'admin',command),action('request.plan',{requestId:pending.id},'admin',command)]);
 assert.ok(replay.every(x=>x.status===200));assert.equal(replay.filter(x=>x.body.replayed).length,1);
 const all=(await context()).state;unique(all);assert.equal(new Set(assigned(all).map(t=>t.truckId)).size,2);assert.equal(new Set(assigned(all).map(t=>t.dispatchId)).size,1,'Concurrent plans never share a resource across dispatch claims');assert.equal(all.stockpiles.find(x=>x.id==='stock-2-3').reservedM3,50);assert.equal(all.vessels[0].reservedT,100);
 const tooMuch=await request(101),before=(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 const rejected=await action('request.plan',{requestId:tooMuch});assert.equal(rejected.status,409);assert.equal(rejected.body.error,'INSUFFICIENT_STOCK');
 assert.deepEqual((await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0],before);
});

test('HTTP serial claim remains allocated across pre-scans and intermediate returns, then hands off once at own final return',async t=>{
 const {actors,action,ok,context,request,unique,finish}=await fixture(t,{drivers:1});
 const a=await request(50),planned=await ok('request.plan',{requestId:a});
 const serial=planned.state.trips.filter(t=>t.requestId===a).sort((x,y)=>x.sequence-y.sequence);
 assert.deepEqual(serial.map(t=>t.tonnageT),[20,20,10]);assert.equal(new Set(serial.map(t=>t.truckId)).size,1);
 const truckId=serial[0].truckId,dispatchId=serial[0].dispatchId;
 assert.equal(planned.state.trucks.find(t=>t.id===truckId).status,'allocated');
 assert.equal(planned.state.trucks.find(t=>t.id===truckId).serialTripsRemaining,3);
 const b=await request(10),blocked=await ok('request.plan',{requestId:b});
 assert.ok(blocked.state.trips.filter(t=>t.requestId===b).every(t=>t.status==='waiting_truck'&&!t.truckId&&!t.assignedDriverUserId));
 const reserved=amount(blocked.state.stockpiles,'reservedM3');assert.equal(reserved,30);assert.equal(blocked.state.vessels[0].reservedT,60);
 const early=await action('trip.start',{tripId:serial[1].id},'driver1');assert.equal(early.status,409);assert.equal(early.body.error,'QUEUE_ORDER');
 await ok('trip.qr',{tripId:serial[1].id});await ok('trip.tare',{tripId:serial[1].id,weightT:5},'stock2');
 const prescanned=(await context()).state;unique(prescanned);
 const allocated=prescanned.trucks.find(t=>t.id===truckId);assert.equal(allocated.status,'allocated');assert.equal(allocated.activeTripId,null);assert.equal(allocated.dispatchId,dispatchId);
 assert.equal(amount(prescanned.stockpiles,'reservedM3'),reserved);assert.equal(prescanned.inventoryLedger.length,0);assert.equal(prescanned.erpOutbox.length,0);
 const hidden=(await context('jetty2')).state.trucks.find(t=>t.id===truckId);
 assert.equal(hidden.status,'allocated');assert.equal(hidden.dispatchId,null);assert.deepEqual(hidden.dispatchIds,[]);assert.equal(hidden.nextTripId,null);
 assert.ok((await context('driver1')).state.trips.every(t=>t.assignedDriverUserId===actors.driver1.id&&t.requestId===a));
 const finalReturnKey=randomUUID();
 for(const [index,original]of serial.entries()){
  const current=(await context()).state.trips.find(t=>t.id===original.id);
  await finish(current,{returnKey:index===serial.length-1?finalReturnKey:undefined,beforeReturn:async state=>{
   const fleet=state.trucks.find(t=>t.id===truckId);assert.equal(fleet.status,'busy');assert.equal(fleet.dispatchId,dispatchId);
   assert.ok(state.trips.filter(t=>t.requestId===b).every(t=>!t.truckId));
  }});
  const after=(await context()).state;unique(after);
  if(index<serial.length-1){assert.equal(after.trucks.find(t=>t.id===truckId).status,'allocated');assert.equal(after.trucks.find(t=>t.id===truckId).dispatchId,dispatchId);assert.ok(after.trips.filter(t=>t.requestId===b).every(t=>!t.truckId));}
 }
 const handed=(await context()).state,next=handed.trips.find(t=>t.requestId===b&&t.truckId);
 assert.ok(next);assert.equal(next.truckId,truckId);assert.notEqual(next.dispatchId,dispatchId);assert.equal(handed.requests.find(r=>r.id===a).status,'completed');
 const beforeRetry={trips:handed.trips.length,ledger:handed.inventoryLedger.length,outbox:handed.erpOutbox.length};
 const replay=await action('trip.return',{tripId:serial.at(-1).id},'stock2',{requestId:finalReturnKey});assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
 assert.equal(replay.body.state.erpOutbox.length,0,'A Stockpile retry response still hides Admin-only ERP data');
 const afterRetry=(await context()).state;
 assert.deepEqual({trips:afterRetry.trips.length,ledger:afterRetry.inventoryLedger.length,outbox:afterRetry.erpOutbox.length},beforeRetry);
 await finish(next);
 const final=(await context()).state;unique(final);assert.ok(final.trucks.every(t=>t.status==='available'&&t.serialTripsRemaining===0&&t.dispatchId===null&&t.bindingStatus==='NONE'));
 assert.equal(final.vessels[0].loadedT,60);assert.equal(final.vessels[0].reservedT,0);assert.equal(amount(final.stockpiles,'reservedM3'),0);
 assert.equal(final.stockpiles.find(t=>t.id==='stock-2-3').onHandM3,70);assert.equal(final.erpOutbox.length,8);assert.equal(final.inventoryLedger.length,8);
});

test('automatic HTTP plan can reserve waiting cargo without Drivers and allocates immediately when Admin creates a Driver',async t=>{
 const {call,request,ok,context,unique}=await fixture(t,{drivers:0});
 const first=await request(30),plan=await ok('request.plan',{requestId:first});
 assert.equal(assigned(plan.state).length,0);assert.ok(waiting(plan.state).length>0);assert.equal(amount(waiting(plan.state),'tonnageT'),30);
 assert.equal(plan.state.stockpiles.find(x=>x.id==='stock-2-3').reservedM3,15);
 const created=await call('/api/users','POST',{username:'new-auto-driver',displayName:'Synthetic new automatic Driver',role:'driver',password:'Synthetic-Auto-Driver-Test-42!'});
 assert.equal(created.status,201,JSON.stringify(created.body));
 const immediate=(await context()).state;unique(immediate);
 assert.equal(assigned(immediate).length,2,'Creating an available Driver preassigns both capacity-limited serial trips');
 assert.ok(assigned(immediate).every(t=>t.requestId===first));assert.equal(new Set(assigned(immediate).map(t=>t.truckId)).size,1);
 const immediateDispatch=immediate.dispatches.find(x=>x.requestId===first);
 assert.equal(immediateDispatch.pendingTrips,immediate.trips.filter(x=>x.dispatchId===immediateDispatch.id&&!terminal(x)).length,'Automatic split refreshes dispatch counts immediately');
 assert.equal(immediate.requests.find(x=>x.id===first).pendingTrips,immediateDispatch.pendingTrips,'Request counts reflect automatic split immediately');
 const second=await request(10),scheduled=await ok('request.plan',{requestId:second});
 unique(scheduled.state);assert.equal(assigned(scheduled.state).length,2);assert.ok(assigned(scheduled.state).every(t=>t.requestId===first));
 assert.ok(waiting(scheduled.state).some(x=>x.requestId===second));
 assert.equal((await context()).state.vessels[0].reservedT,40);
});

test('enabling a truck through the Admin master API automatically wakes pending cargo without replanning',async t=>{
 const {db,call,request,ok,context,unique}=await fixture(t,{drivers:1});
 const raw=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
 for(const truck of raw.trucks)truck.active=false;
 await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(raw)]);
 const requestId=await request(30),planned=await ok('request.plan',{requestId});
 assert.equal(assigned(planned.state).length,0);assert.ok(waiting(planned.state).length>0);
 const activated=await call('/api/action','POST',{action:'master.truck.save',payload:{id:'truck-1',active:true},requestId:randomUUID()});
 assert.equal(activated.status,200,JSON.stringify(activated.body));
 const current=(await context()).state;unique(current);
 assert.equal(assigned(current).length,3);assert.ok(assigned(current).every(t=>t.requestId===requestId&&t.truckId==='truck-1'));assert.equal(amount(assigned(current),'tonnageT'),30);
 assert.equal(current.stockpiles.find(x=>x.id==='stock-2-3').reservedM3,15);
});

test('automatic cutover marker blocks only the old planner and keeps global migration audit private',async t=>{
 const {db,call,ok,context}=await fixture(t);
 const raw=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
 const marker={version:1,detachedTripIds:['synthetic-hidden-trip-id'],actorId:'synthetic-admin',beforeSha256:'synthetic-private-fingerprint'};
 raw.automaticDispatchUpgrade=marker;
 await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(raw)]);
 const created=await call('/api/action','POST',{action:'request.create',payload:{transferMode:'MARINE',destinationLocationId:'stockpile-location-crusher-2',jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:20,unit:'t'}]},requestId:randomUUID()});
 assert.equal(created.status,200,JSON.stringify(created.body));
 const before=(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 const oldPlan=await call('/api/action','POST',{action:'request.plan',payload:{requestId:created.body.result.entityId},requestId:randomUUID()});
 assert.equal(oldPlan.status,409);assert.equal(oldPlan.body.error,'AUTOMATIC_DISPATCH_REQUIRED');
 assert.deepEqual((await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0],before);
 const displayEdit=await call('/api/action','POST',{action:'master.truck.save',payload:{id:'truck-1',plate:'SYNTHETIC DISPLAY EDIT'},requestId:randomUUID()});
 assert.equal(displayEdit.status,200,'Compatibility master maintenance remains available');
 const measurement=await call('/api/action','POST',{action:'measurement.create',payload:{stockpileId:'stock-2-3',method:'manual',volumeM3:100},requestId:randomUUID()},'stock2');
 assert.equal(measurement.status,200,JSON.stringify(measurement.body));
 assert.equal(measurement.body.state.automaticDispatchUpgrade,undefined,'Legacy mutation responses do not expose global migration IDs');
 const stockRead=await call('/api/state','GET',undefined,'stock2'),jettyRead=await call('/api/state','GET',undefined,'jetty1');
 assert.equal(stockRead.status,200);assert.equal(jettyRead.status,200);
 assert.equal(stockRead.body.state.automaticDispatchUpgrade,undefined);assert.equal(jettyRead.body.state.automaticDispatchUpgrade,undefined);
 assert.equal((await context('stock2')).state.automaticDispatchUpgrade,undefined);
 assert.deepEqual((await context()).state.automaticDispatchUpgrade,marker,'Admin migration audit remains intact');
 const automatic=await ok('request.create',{transferMode:'MARINE',destinationLocationId:'stockpile-location-crusher-2',jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:20,unit:'t'}]});
 const planned=await ok('request.plan',{requestId:automatic.result.requestId});
 assert.ok(assigned(planned.state).length>0,'The current automatic planner remains available');
});
