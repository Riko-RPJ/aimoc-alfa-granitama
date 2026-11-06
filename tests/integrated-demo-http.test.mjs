import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {hash} from '../server/auth.mjs';

async function fixture(t){
  const db=await createEmbeddedDatabase();
  await bootstrap(db);
  const state=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
  state.trucks=state.trucks.slice(0,1);
  Object.assign(state.trucks[0],{bedM3:30,payloadLimitT:40});
  state.vessels[0].status='waiting';
  await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(state)]);
  const actors={};
  for(const u of (await db.query('SELECT * FROM aimoc_alfa_ops.users')).rows){
    const session=u.username.padEnd(43,'x');
    await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'csrf-test',now()+interval '1 hour')",[hash(session),u.id]);
    actors[u.username]={cookie:'alfa_session='+session,csrf:'csrf-test',id:u.id};
  }
  const server=http.createServer(createHandler(db));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));await db.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(path,method='GET',body,actor)=>{
    const a=actors[actor]||actor||{};
    const res=await fetch(base+path,{method,headers:{...(method!=='GET'?{Origin:base,'Content-Type':'application/json','X-CSRF-Token':a.csrf||''}:{}),...(a.cookie?{Cookie:a.cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')};
  };
  const action=(name,payload,actor='admin',extra={})=>call('/api/v1/demo/actions','POST',{action:name,payload,requestId:randomUUID(),...extra},actor);
  const ok=async(name,payload,actor='admin',extra={})=>{const r=await action(name,payload,actor,extra);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const context=async(actor='admin')=>{const r=await call('/api/v1/demo/context','GET',undefined,actor);assert.equal(r.status,200);return r.body;};
  // Driver creation uses the same Admin API and schema used outside local UAT.
  const password='Synthetic-Driver-Test-Only-42!';
  const created=await call('/api/users','POST',{username:'integrated-driver',displayName:'Synthetic Driver',role:'driver',password},'admin');
  assert.equal(created.status,201,JSON.stringify(created.body));
  assert.equal('password_hash' in created.body.user,false);
  const login=await call('/api/login','POST',{username:'integrated-driver',password});
  assert.equal(login.status,200);
  actors.driver={cookie:login.cookie.split(';')[0],csrf:login.body.csrfToken,id:login.body.user.id};
  return {db,state,actors,call,action,ok,context};
}

test('normal authenticated handler integrates an 80t marine request over two serial 40t trips',async t=>{
  const {db,state,actors,call,action,ok,context}=await fixture(t);
  assert.equal((await call('/api/v1/demo/context')).status,401);
  assert.equal((await call('/api/v1/demo/actions','POST',{}, {cookie:actors.admin.cookie})).status,403);
  const created=await ok('request.create',{transferMode:'MARINE',jettyId:'jetty-1',vesselId:'vessel-1',destination:'Marunda',lines:[{skuId:'split-12',quantity:80,unit:'t'}]});
  const requestId=created.result.requestId,requestKey=randomUUID();
  const planned=await ok('request.plan',{requestId,assignments:[{truckId:state.trucks[0].id,driverUserId:actors.driver.id}]},'admin',{requestId:requestKey,expectedRevision:created.revision});
  const replay=await ok('request.plan',{requestId,assignments:[{truckId:state.trucks[0].id,driverUserId:actors.driver.id}]},'admin',{requestId:requestKey,expectedRevision:created.revision});
  assert.equal(replay.replayed,true);assert.equal(replay.revision,planned.revision);
  assert.equal((await action('request.plan',{requestId},'admin',{requestId:requestKey})).body.error,'IDEMPOTENCY_CONFLICT');
  assert.equal((await action('request.create',{},'admin',{expectedRevision:created.revision})).body.error,'REVISION_CONFLICT');
  const trips=planned.state.trips;
  assert.equal(trips.length,2);assert.equal(new Set(trips.map(x=>x.dispatchId)).size,1);
  assert.ok(trips.every(x=>x.source==='INTEGRATED_DEMO'&&x.assignedDriverUserId===actors.driver.id&&x.tonnageT===40));
  assert.equal((await context('driver')).state.trips.length,2);
  assert.equal((await context('jetty2')).state.trips.length,0);
  assert.equal((await context('stock1')).drivers.length,0);
  const originalStock=new Map(planned.state.stockpiles.map(x=>[x.id,x.onHandM3]));
  for(const [i,trip] of trips.entries()){
    const source=trip.crusherId==='crusher-1'?'stock1':'stock2';
    const wrongSource=source==='stock1'?'stock2':'stock1';
    assert.equal((await action('trip.tare',{tripId:trip.id,weightT:25},wrongSource)).status,403);
    assert.equal((await action('trip.start',{tripId:trip.id},'admin')).status,403);
    // Valid QR and tare deliberately arrive before Driver start. They join
    // automatically once authorized; no manual inbox reconciliation is called.
    await ok('trip.qr',{tripId:trip.id,externalEventId:'qr-'+i});
    const tare=await ok('trip.tare',{tripId:trip.id,weightT:25,externalEventId:'tare-'+i},source);
    assert.equal(tare.state.trips.find(x=>x.id===trip.id).status,'queued');
    assert.equal((await action('trip.depart',{tripId:trip.id},source)).status,409);
    const started=await ok('trip.start',{tripId:trip.id},'driver');
    assert.equal(started.state.trips.find(x=>x.id===trip.id).status,'ready_to_load');
    if(i===0){
      assert.equal((await action('trip.start',{tripId:trips[1].id},'driver')).status,409);
      const masterBypass=await call('/api/action','POST',{action:'master.truck.save',payload:{id:trip.truckId,active:false},requestId:randomUUID()},'admin');
      assert.equal(masterBypass.status,409);assert.equal(masterBypass.body.error,'ACTIVE_INTEGRATED_ASSIGNMENT');
      const bypass=await call('/api/action','POST',{action:'trip.depart',payload:{tripId:trip.id,tareT:25,grossT:65},requestId:randomUUID()},'admin');
      assert.equal(bypass.status,409);assert.equal(bypass.body.error,'INTEGRATED_WORKFLOW_REQUIRED');
      const openVessel=await call('/api/action','POST',{action:'master.vessel.save',payload:{id:'vessel-1',status:'loading'},requestId:randomUUID()},'admin');
      assert.equal(openVessel.status,200,JSON.stringify(openVessel.body));
      const global=await context(wrongSource);
      assert.equal(global.state.trucks.find(x=>x.id===trip.truckId).status,'busy');
      assert.equal(global.state.trucks.find(x=>x.id===trip.truckId).activeTripId,null);
    }
    await ok('trip.loading',{tripId:trip.id},source);
    assert.equal((await action('trip.depart',{tripId:trip.id},source)).status,409);
    assert.equal((await action('trip.gross',{tripId:trip.id,weightT:66},source)).body.error,'WEIGHT_RECONCILIATION');
    await ok('trip.gross',{tripId:trip.id,weightT:65,externalEventId:'gross-'+i},source);
    const departed=await ok('trip.depart',{tripId:trip.id,externalEventId:'depart-'+i},source);
    const replayedEvent=await ok('trip.depart',{tripId:trip.id,externalEventId:'depart-'+i},source);
    assert.equal(replayedEvent.result.replayed,true);
    assert.equal(replayedEvent.state.inventoryLedger.length,departed.state.inventoryLedger.length);
    assert.equal((await action('trip.receive',{tripId:trip.id},'jetty1')).status,409);
    assert.equal((await action('trip.arrive',{tripId:trip.id},'jetty2')).status,403);
    await ok('trip.arrive',{tripId:trip.id},'jetty1');
    assert.equal((await action('trip.receive',{tripId:trip.id,vesselId:'vessel-2'},'jetty1')).body.error,'DESTINATION_MISMATCH');
    const received=await ok('trip.receive',{tripId:trip.id,externalEventId:'receipt-'+i},'jetty1');
    assert.equal(received.state.vessels.find(x=>x.id==='vessel-1').loadedT,(i+1)*40);
    assert.equal((await action('trip.receive',{tripId:trip.id},'jetty1')).status,409);
    if(i===0)assert.equal((await action('trip.start',{tripId:trips[1].id},'driver')).status,409);
    assert.equal((await action('trip.return',{tripId:trip.id},source)).status,409);
    await ok('trip.return_start',{tripId:trip.id},'driver');
    await ok('trip.return',{tripId:trip.id},source);
  }
  const final=await context();
  assert.equal(final.state.requests.find(x=>x.id===requestId).status,'completed');
  assert.equal(final.state.dispatches[0].status,'completed');
  assert.equal(final.state.requests[0].remainingT,0);
  assert.equal(final.state.vessels[0].reservedT,0);assert.equal(final.state.vessels[0].loadedT,80);
  assert.equal(final.state.trucks[0].status,'available');
  assert.equal(final.state.erpOutbox.length,4);assert.equal(final.state.inventoryLedger.length,4);
  assert.ok(final.state.erpOutbox.every(x=>x.status==='awaiting_configuration'&&x.synthetic));
  for(const pile of final.state.stockpiles){
    const sent=trips.filter(x=>x.stockpileId===pile.id).reduce((sum,x)=>sum+x.volumeM3,0);
    assert.ok(Math.abs(pile.onHandM3-(originalStock.get(pile.id)-sent))<0.00001);
    assert.equal(pile.reservedM3,0);
  }
  const raw=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
  assert.deepEqual(raw.trips.map(x=>x.id),trips.map(x=>x.id));assert.ok(raw.trips.every(x=>x.status==='returned'));
  assert.equal((await call('/api/state','GET',undefined,'admin')).body.state.trips.length,2);
  assert.equal((await context('driver')).state.erpOutbox.length,0);
});

test('LAND multiSKU receipts update destination inventory without vessel effects',async t=>{
  const {state,actors,action,ok,context}=await fixture(t);
  const before=await context();
  const created=await ok('request.create',{transferMode:'LAND',destinationId:'crusher-2',destination:'Stockpile Marunda DEMO',lines:[{skuId:'split-12',quantity:12,unit:'m3'},{skuId:'basecourse',quantity:11,unit:'t'}]});
  const planned=await ok('request.plan',{requestId:created.result.requestId,assignments:[{truckId:state.trucks[0].id,driverUserId:actors.driver.id}]});
  assert.equal(planned.state.trips.length,2);
  for(const trip of planned.state.trips){
    assert.equal(trip.crusherId,'crusher-1');assert.equal(trip.destinationCrusherId,'crusher-2');
    await ok('trip.qr',{tripId:trip.id});
    await ok('trip.start',{tripId:trip.id},'driver');
    await ok('trip.tare',{tripId:trip.id,weightT:20},'stock1');
    await ok('trip.loading',{tripId:trip.id},'stock1');
    await ok('trip.gross',{tripId:trip.id,weightT:20+trip.tonnageT},'stock1');
    await ok('trip.depart',{tripId:trip.id},'stock1');
    assert.equal((await action('trip.arrive',{tripId:trip.id},'stock1')).status,403);
    await ok('trip.arrive',{tripId:trip.id},'stock2');
    await ok('trip.receive',{tripId:trip.id},'stock2');
    await ok('trip.return_start',{tripId:trip.id},'driver');
    await ok('trip.return',{tripId:trip.id},'stock1');
  }
  const final=await context();
  assert.equal(final.state.requests[0].status,'completed');assert.equal(final.state.requests[0].deliveredT,29);
  assert.deepEqual(final.state.vessels.map(v=>[v.loadedT,v.reservedT]),before.state.vessels.map(v=>[v.loadedT,v.reservedT]));
  for(const trip of planned.state.trips){
    const target=final.state.stockpiles.find(x=>x.id===trip.destinationStockpileId),source=final.state.stockpiles.find(x=>x.id===trip.stockpileId);
    assert.ok(Math.abs(target.onHandM3-before.state.stockpiles.find(x=>x.id===target.id).onHandM3-trip.volumeM3)<0.00001);
    assert.ok(Math.abs(source.onHandM3-before.state.stockpiles.find(x=>x.id===source.id).onHandM3+trip.volumeM3)<0.00001);
  }
});

test('concurrent HTTP plans serialize revisions and identical retries reserve once',async t=>{
  const {state,actors,action,ok,context}=await fixture(t);
  const ids=[];
  for(let i=0;i<2;i++)ids.push((await ok('request.create',{transferMode:'MARINE',jettyId:'jetty-1',vesselId:'vessel-1',destination:'Concurrent demo',lines:[{skuId:'split-12',quantity:40,unit:'t'}]})).result.requestId);
  const revision=(await context()).revision;
  const payload=requestId=>({requestId,assignments:[{truckId:state.trucks[0].id,driverUserId:actors.driver.id}]});
  const results=await Promise.all(ids.map(id=>action('request.plan',payload(id),'admin',{expectedRevision:revision})));
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  assert.equal(results.find(x=>x.status===409).body.error,'REVISION_CONFLICT');
  const current=await context(),pending=current.state.requests.find(x=>x.status==='requested');
  assert.equal(current.state.vessels[0].reservedT,40);assert.equal(current.state.trips.length,1);
  const requestId=randomUUID(),command={requestId,expectedRevision:current.revision};
  const retries=await Promise.all([action('request.plan',payload(pending.id),'admin',command),action('request.plan',payload(pending.id),'admin',command)]);
  assert.ok(retries.every(x=>x.status===200));assert.equal(retries.filter(x=>x.body.replayed).length,1);
  const planned=await context();
  assert.equal(planned.state.vessels[0].reservedT,80);assert.equal(planned.state.trips.length,2);
  const starts=await Promise.all(planned.state.trips.map(x=>action('trip.start',{tripId:x.id},'driver')));
  assert.deepEqual(starts.map(x=>x.status).sort(),[200,409]);
  const live=(await context()).state.trips.filter(x=>x.status!=='queued');
  assert.equal(live.length,1);
});
