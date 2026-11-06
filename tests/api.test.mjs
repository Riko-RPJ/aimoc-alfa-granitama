import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {passwordHash} from '../server/auth.mjs';

test('authenticated multioperator API preserves shared operational state',async t=>{
 const db=await createEmbeddedDatabase();await bootstrap(db);
 const password='Synthetic-Test-Only-42!';
 await db.query('UPDATE aimoc_alfa_ops.users SET password_hash=$1',[await passwordHash(password)]);
 const server=http.createServer(createHandler(db));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 async function call(route,method='GET',body,auth={},extra={}){
  const res=await fetch(base+route,{method,headers:{...(method!=='GET'?{'Content-Type':'application/json',Origin:base}:{}),...(auth.cookie?{Cookie:auth.cookie}:{}),...(auth.csrf?{'X-CSRF-Token':auth.csrf}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,body:(res.headers.get('content-type')||'').includes('application/json')?await res.json():Buffer.from(await res.arrayBuffer()),cookie:res.headers.get('set-cookie'),headers:res.headers};
 }
 const login=async username=>{const r=await call('/api/login','POST',{username,password});assert.equal(r.status,200);return {cookie:r.cookie.split(';')[0],csrf:r.body.csrfToken};};
 const action=(action,payload,auth,requestId=randomUUID(),extra={})=>call('/api/action','POST',{action,payload,requestId,...extra},auth);
 try{
  await t.test('requires identity, secure cookie flags, origin and CSRF',async()=>{
   assert.equal((await call('/api/state')).status,401);
   assert.equal((await call('/api/login','POST',{username:'admin',password:'wrong'})).status,401);
   const a=await login('admin');
   const me=await call('/api/me','GET',undefined,a);assert.equal(me.body.user.role,'admin');assert.ok(me.body.csrfToken);
   const raw=await call('/api/login','POST',{username:'admin',password});assert.match(raw.cookie,/HttpOnly/);assert.match(raw.cookie,/SameSite=Strict/);
   assert.equal((await action('request.plan',{requestId:'none'},{cookie:a.cookie})).status,403);
   assert.equal((await call('/api/logout','POST',{},a,{Origin:'https://other.example'})).status,403);
  });
  const admin=await login('admin'),stock=await login('stock1'),jetty=await login('jetty1'),otherJetty=await login('jetty2');
  let trip,request,revision;
  await t.test('jetty request becomes shared reserved stock and serial fleet queue',async()=>{
   const created=await action('request.create',{jettyId:'jetty-1',vesselId:'vessel-1',destination:'Marunda',lines:[{skuId:'split-12',quantity:500,unit:'m3'}]},jetty);assert.equal(created.status,200);request=created.body.result.entityId;
   const planned=await action('request.plan',{requestId:request},admin);assert.equal(planned.status,200);assert.ok(planned.body.state.trips.length>12);assert.equal(planned.body.state.vessels[0].reservedT,750);
   assert.equal(planned.body.state.metrics.reservedM3,500);assert.equal(planned.body.state.trips.filter(t=>t.status==='queued').length,planned.body.state.trips.length);revision=planned.body.revision;
   trip=planned.body.state.trips.find(t=>t.crusherId==='crusher-2');
   const wrongScope=await action('trip.start',{tripId:trip.id},stock);assert.equal(wrongScope.status,403);
   const other=await call('/api/state','GET',undefined,otherJetty);assert.equal(other.body.state.trips.length,0);assert.equal(other.body.state.vessels.length,1);
  });
  await t.test('HTTP retries idempotent and conflicting retries rejected',async()=>{
   const id=randomUUID();const first=await action('trip.start',{tripId:trip.id},admin,id);assert.equal(first.status,200);
   const again=await action('trip.start',{tripId:trip.id},admin,id);assert.equal(again.status,200);assert.equal(again.body.replayed,true);assert.equal(again.body.revision,first.body.revision);
   const wrong=await action('trip.return',{tripId:trip.id},admin,id);assert.equal(wrong.status,409);
   assert.equal((await action('trip.depart',{tripId:trip.id},admin,randomUUID(),{expectedRevision:revision})).body.error,'REVISION_CONFLICT');
  });
  await t.test('concurrent calls load one trip exactly once; arrival does not count as loaded',async()=>{
   const [a,b]=await Promise.all([action('trip.depart',{tripId:trip.id},admin),action('trip.depart',{tripId:trip.id},admin)]);assert.deepEqual([a.status,b.status].sort(),[200,409]);
   const before=await call('/api/state','GET',undefined,jetty);assert.equal(before.body.state.metrics.inTransitM3,trip.volumeM3);assert.equal(before.body.state.vessels[0].loadedT,0);
   assert.equal((await action('trip.arrive',{tripId:trip.id,vesselId:'vessel-2'},jetty)).status,409);
   assert.equal((await action('trip.arrive',{tripId:trip.id},jetty)).status,200);
   assert.equal((await call('/api/state','GET',undefined,jetty)).body.state.vessels[0].loadedT,0);
   const unloaded=await action('trip.unload',{tripId:trip.id},jetty);assert.equal(unloaded.status,200);assert.equal(unloaded.body.state.vessels[0].loadedT,trip.tonnageT);assert.equal(unloaded.body.state.trucks.find(x=>x.id===trip.truckId).status,'busy');
   assert.equal((await action('trip.unload',{tripId:trip.id},jetty)).status,409);
   const returned=await action('trip.return',{tripId:trip.id},admin);
   assert.equal(returned.status,200);
   // A returned trip releases its active claim; queued work on the same truck
   // still reserves it. Do not misreport an assigned truck as available.
   const returnedTruck=returned.body.state.trucks.find(x=>x.id===trip.truckId);
   assert.equal(returnedTruck.status,returnedTruck.queuedTrips>0?'allocated':'available');
   assert.equal(returned.body.state.erpOutbox.length,2);assert.ok(returned.body.state.erpOutbox.every(x=>x.status==='awaiting_configuration'));
  });
  await t.test('persists evidence, enforces provenance, camera alone never changes stock',async()=>{
   const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2+1sAAAAASUVORK5CYII=';
   const file=await call('/api/evidence','POST',{dataUrl:image,name:'survey.png'},stock);assert.equal(file.status,201);
   const before=await call('/api/state','GET',undefined,admin);
   const measure=await action('measurement.create',{stockpileId:'stock-1-1',skuId:'abu-batu',method:'camera_pending',evidenceId:file.body.id},stock);assert.equal(measure.status,200);
   const m=measure.body.state.measurements[0];assert.equal(m.volumeM3,null);assert.equal(m.evidenceId,file.body.id);
   assert.equal((await action('measurement.approve',{measurementId:m.id},admin)).status,409);
   const after=await call('/api/state','GET',undefined,admin);assert.equal(after.body.state.metrics.onHandM3,before.body.state.metrics.onHandM3);
   assert.equal((await call('/api/evidence/'+file.body.id,'GET',undefined,admin)).status,200);
   const forbiddenAdminUpload=await call('/api/evidence','POST',{dataUrl:'data:image/png;base64,iVBORw0KGgo='},admin);
   assert.equal(forbiddenAdminUpload.status,403,'Admin must not upload stockpile measurement photos');

   assert.equal((await call('/api/evidence/'+file.body.id,'GET',undefined,otherJetty)).status,403);
   assert.equal((await action('measurement.create',{stockpileId:'stock-1-1',method:'camera_pending',evidenceId:'fake-evidence'},stock)).status,403);
  });
  await t.test('only admin manages scoped users and passwords are never returned',async()=>{
   assert.equal((await call('/api/users','GET',undefined,stock)).status,403);
   const created=await call('/api/users','POST',{username:'operator-new',displayName:'New',role:'stock',crusherIds:['crusher-1'],password},admin);assert.equal(created.status,201);assert.equal(created.body.user.password,undefined);assert.equal(created.body.user.password_hash,undefined);
   assert.equal((await call('/api/users','POST',{username:'bad',displayName:'Bad',role:'stock',password},admin)).status,400);
   const result=await call('/api/logout','POST',{},stock);assert.equal(result.status,200);assert.equal((await call('/api/me','GET',undefined,stock)).status,401);
  });
 }finally{await new Promise(r=>server.close(r));await db.close();}
});
