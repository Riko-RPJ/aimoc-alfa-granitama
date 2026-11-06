import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {hash} from '../server/auth.mjs';

async function fixture(t){
 const db=await createEmbeddedDatabase();await bootstrap(db);
 const driverId=randomUUID();
 await db.query("INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role) VALUES($1,'qa-driver','Synthetic QA Driver','not-a-login-credential','driver')",[driverId]);
 const actors={};
 async function session(username,id){
  const token=('location-test-'+username).padEnd(43,'x');
  await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic-csrf',now()+interval '1 hour')",[hash(token),id]);
  actors[username]={id,cookie:'alfa_session='+token,csrf:'synthetic-csrf'};
 }
 for(const row of (await db.query('SELECT id,username FROM aimoc_alfa_ops.users')).rows)await session(row.username,row.id);
 const server=http.createServer(createHandler(db));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await db.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 const call=async(path,method='GET',body,user='admin')=>{
  const actor=actors[user]||{};
  const r=await fetch(origin+path,{method,headers:{...(actor.cookie?{Cookie:actor.cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':actor.csrf||''}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,body:await r.json()};
 };
 const action=(action,payload,user='admin',extra={})=>call('/api/v1/demo/actions','POST',{action,payload,requestId:randomUUID(),...extra},user);
 const ok=async(actionName,payload,user='admin',extra={})=>{const r=await action(actionName,payload,user,extra);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 const state=async()=>(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 return {db,actors,session,call,action,ok,state,driverId};
}

const location=(name,transportModes=['MARINE'])=>({name,address:'Synthetic QA address',transportModes});

test('simplified location API generates unique codes atomically and command retries never allocate twice',async t=>{
 const {actors,call,action,ok,state}=await fixture(t);
 const before=await state();
 for(const actor of ['stock1','jetty1','qa-driver'])assert.equal((await action('master.stockpileLocation.save',location('Forbidden'),actor)).status,403);
 const key=randomUUID(),payload=location('First auto-code');
 const first=await ok('master.stockpileLocation.save',payload,'admin',{requestId:key});
 const created=first.state.stockpileLocations.find(x=>x.id===first.result.locationId);
 assert.match(created.code,/^SPL-\d{6,}$/);assert.equal(created.active,true);
 const retry=await ok('master.stockpileLocation.save',payload,'admin',{requestId:key,expectedRevision:1});
 assert.equal(retry.replayed,true);assert.equal(retry.revision,first.revision);assert.equal(retry.result.locationId,first.result.locationId);
 assert.equal((await action('master.stockpileLocation.save',location('Changed body'),'admin',{requestId:key})).body.error,'IDEMPOTENCY_CONFLICT');
 const concurrent=await Promise.all(['Second auto-code','Third auto-code'].map(name=>ok('master.stockpileLocation.save',location(name))));
 const saved=await state(),ids=[first.result.locationId,...concurrent.map(x=>x.result.locationId)];
 const codes=saved.document.stockpileLocations.filter(x=>ids.includes(x.id)).map(x=>x.code.toUpperCase());
 assert.equal(new Set(codes).size,3);assert.ok(codes.every(code=>/^SPL-\d{6,}$/.test(code)));
 assert.equal(saved.document.crushers.filter(x=>x.production!==false).length,before.document.crushers.length);
 assert.equal(saved.document.stockpiles.length,before.document.stockpiles.length,'MARINE-only choices do not invent receiving stock');
 await ok('master.stockpileLocation.delete',{id:first.result.locationId});
 const later=await ok('master.stockpileLocation.save',location('After deletion'));
 const next=later.state.stockpileLocations.find(x=>x.id===later.result.locationId);
 assert.ok(!codes.includes(next.code.toUpperCase()),'Deleted codes are not reused');
 const unchanged=await state();
 for(const extra of [{code:'MANUAL-OVERRIDE'},{active:false},{receivingCrusherId:'crusher-1'}]){
  assert.equal((await action('master.stockpileLocation.save',{...location('Tampered'),...extra})).status,400);
  assert.deepEqual(await state(),unchanged,'Rejected system fields cannot consume a code or change state');
 }
 assert.ok(actors.admin.id);assert.equal((await call('/api/v1/demo/context','GET',undefined,null)).status,401);
});

test('editing preserves stored code, inactive status and mapping; open work still protects its destination modes',async t=>{
 const {db,ok,action,state}=await fixture(t);
 let row=await state();const original=row.document.stockpileLocations[0];original.active=false;
 await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(row.document)]);
 const edit=await ok('master.stockpileLocation.save',{id:original.id,name:'Renamed inactive destination',address:'Updated QA address',transportModes:original.transportModes});
 const updated=edit.state.stockpileLocations.find(x=>x.id===original.id);
 assert.equal(updated.code,original.code);assert.equal(updated.active,false);assert.equal(updated.receivingCrusherId,original.receivingCrusherId);
 for(const extra of [{code:'CHANGED'},{active:true},{receivingCrusherId:'crusher-2'}])assert.equal((await action('master.stockpileLocation.save',{id:original.id,...location('Tampered edit',original.transportModes),...extra})).status,400);
 const active=edit.state.stockpileLocations.find(x=>x.id!==original.id&&x.active);
 await ok('request.create',{transferMode:'LAND',destinationLocationId:active.id,lines:[{skuId:'split-12',quantity:10,unit:'t'}]});
 const blocked=await action('master.stockpileLocation.save',{id:active.id,...location('Mode cannot strand request',['MARINE'])});
 assert.equal(blocked.status,409);assert.equal(blocked.body.error,'OPEN_LOCATION_REFERENCE');
});

test('new LAND location automatically receives real trip inventory into its own zero-balance logical area',async t=>{
 const {db,call,ok,action,state,session,driverId}=await fixture(t);
 const before=await state();
 const created=await ok('master.stockpileLocation.save',location('New receiving destination',['LAND']));
 const loc=created.state.stockpileLocations.find(x=>x.id===created.result.locationId);
 assert.ok(loc.receivingCrusherId);assert.ok(!before.document.crushers.some(x=>x.id===loc.receivingCrusherId));
 const area=created.state.crushers.find(x=>x.id===loc.receivingCrusherId);
 assert.equal(area.kind,'RECEIVING_AREA');assert.equal(area.production,false);assert.equal(area.active,true);
 assert.equal(created.state.crushers.filter(x=>x.production!==false).length,before.document.crushers.length);
 const receiving=created.state.stockpiles.filter(x=>x.crusherId===area.id);
 assert.deepEqual(receiving.map(x=>x.skuId).sort(),before.document.products.filter(x=>x.active).map(x=>x.id).sort());
 assert.ok(receiving.every(x=>x.onHandM3===0&&x.reservedM3===0&&x.active));
 assert.equal(created.state.stockpiles.reduce((sum,x)=>sum+x.onHandM3,0),before.document.stockpiles.reduce((sum,x)=>sum+x.onHandM3,0));
 const receiver=await call('/api/users','POST',{username:'qa-receiver',displayName:'Synthetic Receiver',role:'stock',password:'Synthetic-Location-Only-42!',crusherIds:[area.id],jettyIds:[]});
 assert.equal(receiver.status,201,JSON.stringify(receiver.body));await session('qa-receiver',receiver.body.user.id);
 const protectedState=await state();
 for(const active of [true,false]){
  await db.query('UPDATE aimoc_alfa_ops.users SET active=$1 WHERE id=$2',[active,receiver.body.user.id]);
  const blocked=await action('master.stockpileLocation.delete',{id:loc.id});
  assert.equal(blocked.status,409,JSON.stringify(blocked.body));assert.equal(blocked.body.error,'LOCATION_OPERATOR_IN_USE');
  assert.deepEqual(await state(),protectedState,'Assigned Stock scope cannot become dangling even when the account is inactive');
 }
 await db.query('UPDATE aimoc_alfa_ops.users SET active=true WHERE id=$1',[receiver.body.user.id]);
 const req=await ok('request.create',{transferMode:'LAND',destinationLocationId:loc.id,lines:[{skuId:'split-12',quantity:10,unit:'t'}]});
 const plan=await ok('request.plan',{requestId:req.result.requestId,assignments:[{truckId:'truck-1',driverUserId:driverId}]});
 const trip=plan.state.trips.find(x=>x.requestId===req.result.requestId);assert.equal(trip.destinationCrusherId,area.id);
 const source=trip.crusherId==='crusher-1'?'stock1':'stock2';
 await ok('trip.qr',{tripId:trip.id});await ok('trip.start',{tripId:trip.id},'qa-driver');await ok('trip.tare',{tripId:trip.id,weightT:20},source);
 await ok('trip.loading',{tripId:trip.id},source);await ok('trip.gross',{tripId:trip.id,weightT:30},source);await ok('trip.depart',{tripId:trip.id},source);
 assert.equal((await action('trip.arrive',{tripId:trip.id},source)).status,403);
 await ok('trip.arrive',{tripId:trip.id},'qa-receiver');await ok('trip.receive',{tripId:trip.id},'qa-receiver');
 await ok('trip.return_start',{tripId:trip.id},'qa-driver');const complete=await ok('trip.return',{tripId:trip.id},source);
 assert.equal(complete.state.requests.find(x=>x.id===req.result.requestId).status,'completed');
  assert.ok(complete.state.stockpiles.every(x=>x.crusherId===trip.crusherId),'Source operator never receives other-area inventory rows');
  const final=await state();
  const target=final.document.stockpiles.find(x=>x.id===trip.destinationStockpileId);assert.equal(target.onHandM3,trip.volumeM3);assert.equal(target.crusherId,area.id);
  assert.deepEqual(final.document.vessels.map(x=>[x.loadedT,x.reservedT]),before.document.vessels.map(x=>[x.loadedT,x.reservedT]));
  assert.ok(Math.abs(final.document.stockpiles.reduce((sum,x)=>sum+x.onHandM3,0)-before.document.stockpiles.reduce((sum,x)=>sum+x.onHandM3,0))<0.00002);
});

test('later SKU is provisioned only by a valid LAND write without inventing source stock or retaining failed drafts',async t=>{
 const {call,ok,action,state,driverId}=await fixture(t);
 const created=await ok('master.stockpileLocation.save',location('Future SKU destination',['LAND']));
 const loc=created.state.stockpileLocations.find(x=>x.id===created.result.locationId);
 const saveSku=async(code)=>{
  const r=await call('/api/action','POST',{action:'master.product.save',payload:{code,name:'Synthetic '+code,sizeMm:'10-20 mm',densityTPerM3:1.5,active:true},requestId:randomUUID()});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result.entityId;
 };
 const skuId=await saveSku('LATER-SKU-VALID'),invalidSkuId=await saveSku('LATER-SKU-REJECTED');
 const before=await state();
 assert.ok(!before.document.stockpiles.some(x=>[skuId,invalidSkuId].includes(x.skuId)),'Adding SKU alone leaves operation inventory unmodified');
 const invalid=await action('request.create',{transferMode:'LAND',destinationLocationId:loc.id,lines:[{skuId:invalidSkuId,quantity:-1,unit:'t'}]});
 assert.equal(invalid.status,400,JSON.stringify(invalid.body));
 assert.deepEqual(await state(),before,'A later-SKU receiving row allocated on an invalid write is rolled back with the whole draft');
 const requested=await ok('request.create',{transferMode:'LAND',destinationLocationId:loc.id,lines:[{skuId,quantity:10,unit:'t'}]});
 const added=requested.state.stockpiles.filter(x=>x.skuId===skuId);
 assert.equal(added.length,1);assert.equal(added[0].crusherId,loc.receivingCrusherId);
 assert.equal(added[0].onHandM3,0);assert.equal(added[0].reservedM3,0);assert.equal(added[0].active,true);
 assert.equal(requested.state.crushers.find(x=>x.id===loc.receivingCrusherId).sourceEligible,false);
 assert.ok(!requested.state.stockpiles.some(x=>x.skuId===invalidSkuId));
 const afterRequest=await state();
 const summary=await call('/api/v1/demo/sku-stock?transferMode=MARINE');assert.equal(summary.status,200);
 const totals=summary.body.items.find(x=>x.skuId===skuId);
 assert.equal(totals.physicalM3,0);assert.equal(totals.sourceEligibleAvailableM3,0);
 assert.deepEqual(await state(),afterRequest,'Reading totals never provisions further receiving rows');
 const rejectedPlan=await action('request.plan',{requestId:requested.result.requestId,assignments:[{truckId:'truck-1',driverUserId:driverId}]});
 assert.equal(rejectedPlan.status,409,JSON.stringify(rejectedPlan.body));assert.equal(rejectedPlan.body.error,'INSUFFICIENT_STOCK');
 assert.deepEqual(await state(),afterRequest,'An empty receiver cannot fabricate dispatch source inventory');
});
