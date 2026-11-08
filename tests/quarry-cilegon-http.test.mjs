import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {hash} from '../server/auth.mjs';

test('Cilegon real HTTP persists one canonical measurement, receipt and return across roles, revisions and concurrent retries',async t=>{
 const db=await createEmbeddedDatabase();await bootstrap(db);let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await db.close();});
 const driverId=randomUUID();await db.query("INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role) VALUES($1,'cilegon-driver','Synthetic Cilegon Driver','unused-synthetic-hash','driver')",[driverId]);
 const actors={};
 for(const user of(await db.query('SELECT id,username,role FROM aimoc_alfa_ops.users')).rows){
  const session=('synthetic-cilegon-'+user.username).padEnd(43,'x');
  await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic-cilegon-csrf',now()+interval '1 hour')",[hash(session),user.id]);
  actors[user.username]={id:user.id,role:user.role,cookie:'alfa_session='+session};
 }
 const state=async()=>(await db.query('SELECT document,revision,updated_at FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 const initial=await state();initial.document.trucks=initial.document.trucks.slice(0,1).map(truck=>({...truck,bedM3:30,payloadLimitT:40}));
 initial.document.products.find(product=>product.id==='split-12').densityTPerM3=2;
 for(const pile of initial.document.stockpiles.filter(pile=>pile.skuId==='split-12'))pile.onHandM3=pile.crusherId==='crusher-1'?1000:0;
 await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(initial.document)]);
 server=http.createServer(createHandler(db));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const call=async(path,method='GET',body,user='admin',headers={})=>{
  const response=await fetch(origin+path,{method,headers:{...(actors[user]?{Cookie:actors[user].cookie}:{}),...(method!=='GET'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':'synthetic-cilegon-csrf'}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{status:response.status,body:await response.json(),headers:response.headers};
 };
 const action=(action,payload,user='admin',extra={},headers={})=>call('/api/v1/demo/actions','POST',{action,payload,requestId:randomUUID(),...extra},user,headers);
 const ok=async(name,payload,user='admin',extra={})=>{const response=await action(name,payload,user,extra);assert.equal(response.status,200,JSON.stringify(response.body));return response.body;};
 const code=response=>response.body.error?.code||response.body.error;
 const rawTrip=async id=>(await state()).document.trips.find(trip=>trip.id===id);
 const snapshot=async()=>({operation:await state(),actions:(await db.query('SELECT actor_id,request_id,payload_hash,result FROM aimoc_alfa_ops.actions ORDER BY actor_id,request_id')).rows});
 const beforeDenied=await snapshot();
 assert.equal((await call('/api/v1/demo/context','GET',undefined,'anonymous')).status,401);
 assert.equal((await action('quarry.config.save',{model:'STATIC_WIM'},'stock1')).status,403);
 assert.equal((await action('quarry.config.save',{model:'STATIC_WIM'},'admin',{}, {'X-CSRF-Token':''})).status,403);
 assert.equal((await action('quarry.config.save',{model:'STATIC_WIM'},'admin',{}, {Origin:'http://foreign.invalid'})).status,403);
 assert.deepEqual(await snapshot(),beforeDenied,'Denied HTTP requests cannot write a document, revision or receipt');
 const created=await ok('quarry.request.create',{transferMode:'MARINE',destinationLocationId:initial.document.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:40,unit:'t'}]});
 const requestId=created.result.requestId;await ok('quarry.dispatch.plan',{requestId});
 const planned=await state(),trip=planned.document.trips.find(trip=>trip.requestId===requestId),tripId=trip.id;
 const assignment=await call('/api/v1/demo/trips/'+tripId+'/assignment-qr','GET',undefined,'cilegon-driver');
 assert.equal(assignment.status,200);assert.equal(assignment.body.binding.truckId,trip.truckId);
 const entry={tripId,truckId:trip.truckId,laneId:'lane-1',direction:'IN',purpose:'ENTRY',qrValue:assignment.body.qr.value,weightT:15,externalEventId:randomUUID()};
 const beforeRead=await snapshot();
 for(const username of ['admin','stock1','jetty1','cilegon-driver']){
  const context=await call('/api/v1/demo/context','GET',undefined,username);assert.equal(context.status,200);assert.match(context.headers.get('cache-control'),/no-store/);
  assert.ok(context.body.state.trips.some(row=>row.id===tripId));
  assert.doesNotMatch(JSON.stringify(context.body),/password_hash|csrf_token|sessionToken/);
 }
 assert.deepEqual(await snapshot(),beforeRead,'Cross-role context and QR polling are read-only');
 const stale=await action('quarry.gate.scan',entry,'admin',{expectedRevision:Number(planned.revision)-1});
 assert.equal(stale.status,409);assert.equal(code(stale),'REVISION_CONFLICT');assert.deepEqual(await snapshot(),beforeRead);
 const requestKey=randomUUID(),concurrent=await Promise.all([action('quarry.gate.scan',entry,'admin',{requestId:requestKey,expectedRevision:Number(planned.revision)}),action('quarry.gate.scan',entry,'admin',{requestId:requestKey,expectedRevision:Number(planned.revision)})]);
 assert.ok(concurrent.every(response=>response.status===200),JSON.stringify(concurrent));assert.equal(concurrent.filter(response=>response.body.replayed).length,1);
 const entered=await state();assert.equal(Number(entered.revision),Number(planned.revision)+1);assert.equal((await rawTrip(tripId)).weighingEvents.filter(event=>event.type==='TARE').length,1);
 const replay=await action('quarry.gate.scan',entry);assert.equal(replay.status,200);assert.ok(replay.body.replayed||replay.body.result?.replayed);assert.deepEqual(await state(),entered,'Event replay must not bump the canonical revision or timestamp');
 const collision=await action('quarry.gate.scan',{...entry,weightT:16},'admin',{requestId:requestKey});assert.equal(collision.status,409);assert.equal(code(collision),'IDEMPOTENCY_CONFLICT');assert.deepEqual(await state(),entered);
 const shortcut=await action('trip.driver_scan',{tripId,expectedStage:2,externalEventId:randomUUID(),qrValue:assignment.body.qr.value,binding:assignment.body.binding,confirmations:{materialReceived:true,truckReturned:true}},'cilegon-driver');
 assert.equal(shortcut.status,409);assert.deepEqual(await state(),entered,'Driver Scan2 cannot skip actual Cilegon gate and jetty steps');
 await ok('trip.loading',{tripId},'stock1');
 const exit={...entry,laneId:'lane-2',direction:'OUT',purpose:'EXIT',weightT:55,externalEventId:randomUUID()};
 await ok('quarry.gate.scan',exit,'stock1');const departed=await state();
 assert.equal((await rawTrip(tripId)).netT,40);assert.equal(departed.document.inventoryLedger.filter(row=>row.referenceId===tripId).length,1);
 assert.equal(departed.document.vessels[0].loadedT,0);const exitReplay=await action('quarry.gate.scan',exit,'stock1');assert.equal(exitReplay.status,200);assert.deepEqual(await state(),departed);
 await ok('trip.arrive',{tripId},'jetty1');
 const beforeReceive=await state(),receiveKey=randomUUID(),received=await Promise.all([action('trip.receive',{tripId},'jetty1',{requestId:receiveKey}),action('trip.receive',{tripId},'jetty1',{requestId:receiveKey})]);
 assert.ok(received.every(response=>response.status===200),JSON.stringify(received));assert.equal(received.filter(response=>response.body.replayed).length,1);
 const receipt=await state();assert.equal(Number(receipt.revision),Number(beforeReceive.revision)+1);assert.equal(receipt.document.vessels[0].loadedT,40);assert.equal(receipt.document.vessels[0].reservedT,0);
 assert.equal(receipt.document.inventoryLedger.filter(row=>row.referenceId===tripId).length,2);assert.equal(receipt.document.erpOutbox.filter(row=>row.entityId===tripId).length,2);
 assert.ok(receipt.document.erpOutbox.every(row=>row.status==='awaiting_configuration'&&row.synthetic===true),'Demo receipts never claim an ERP business post');
 const returned=await ok('quarry.gate.scan',{...entry,laneId:'lane-3',purpose:'RETURN',externalEventId:randomUUID(),weightT:undefined},'stock1');
 assert.equal(returned.state.trips.find(row=>row.id===tripId).status,'returned');
 for(const username of ['admin','stock1','jetty1','cilegon-driver']){
  const context=await call('/api/v1/demo/context','GET',undefined,username),viewTrip=context.body.state.trips.find(row=>row.id===tripId);
  assert.equal(viewTrip.status,'returned');assert.equal(viewTrip.netT,40);assert.equal(viewTrip.requestId,requestId);assert.equal(viewTrip.dispatchId,trip.dispatchId);
 }
 const final=await state();assert.deepEqual(final.document.stockpiles,receipt.document.stockpiles);assert.deepEqual(final.document.vessels,receipt.document.vessels);
});
