import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {provisionLocalDriverUat} from '../scripts/local-driver-uat.mjs';
import {createHandler} from '../server/handler.mjs';
import {installLocalCrusherLocationMaster,validateCrusherLocation,listCrusherLoadingPoints} from '../server/crusher-location-master.mjs';
import {createDriverDemoAdapter,normalizeDriverTrip} from '../src/services/driver-workspace-adapter.js';

test('crusher master validates identity and never infers verified location',()=>{
 const good={crusher_id:'crusher-1',zone:'Zona UAT',loading_point_id:'LP-01',loading_point_name:'Test Point',
  latitude:null,longitude:null};
 assert.deepEqual(validateCrusherLocation(good,['crusher-1']).latitude,null);
 assert.throws(()=>validateCrusherLocation({...good,crusher_id:'nonexistent'},['crusher-1']),e=>e.code==='UNKNOWN_CRUSHER');
 assert.throws(()=>validateCrusherLocation({...good,latitude:-6.1},['crusher-1']),e=>e.code==='COORDINATES_INCOMPLETE');
 assert.throws(()=>validateCrusherLocation({...good,latitude:-99,longitude:106},['crusher-1']),e=>e.code==='COORDINATES_INVALID');
 const derived=normalizeDriverTrip({trip_id:'trip-1',crusher_destination:{
   crusher_id:'CR-01',loading_point:{id:'LP-01',name:'Point'},latitude:-6.1,longitude:106,
   location_status:'PENDING_REVIEW'}});
 assert.equal(derived.crusherDestination.verified,false);
 const noAssignment=normalizeDriverTrip({trip_id:'trip-2'});
 assert.equal(noAssignment.crusherDestination,null);
});
test('local master Admin-only API, no unauthorized access or fabricated coordinates',async()=>{
 const db=await createEmbeddedDatabase();
 const dir=await mkdtemp(path.join(os.tmpdir(),'crusher-location-'));
 let server;
 try{
  await bootstrap(db,path.join(dir,'access.json'));
  await provisionLocalDriverUat(db,{localOnly:true,accessPath:path.join(dir,'driver.json')});
  await installLocalCrusherLocationMaster(db);
  const {rows}=await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1');
  const crusher=rows[0].document.crushers[0];
  const ids=(await db.query('SELECT username,password_hash FROM aimoc_alfa_ops.users')).rows;
  const {readFile}=await import('node:fs/promises');
  const accounts=[...JSON.parse(await readFile(path.join(dir,'access.json'),'utf8')).users,
   ...JSON.parse(await readFile(path.join(dir,'driver.json'),'utf8')).users];
  server=http.createServer(createHandler(db));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const send=async(route,{method='GET',body,cookie,csrf}={})=>{
   const res=await fetch(base+route,{method,headers:{
    ...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:base,'Content-Type':'application/json'}:{}),
    ...(csrf?{'X-CSRF-Token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')};
  };
  const sessions={};
  for(const a of accounts){
   const out=await send('/api/login',{method:'POST',body:{username:a.username,password:a.password}});
   assert.equal(out.status,200);
   sessions[a.username]={cookie:out.cookie.split(';')[0],csrf:out.data.csrfToken};
  }
  const draft={crusher_id:crusher.id,zone:'Zona UAT',loading_point_id:'LP-UAT-01',
   loading_point_name:'Loading Point QA',latitude:null,longitude:null,
   access_notes:'UAT only',evidence_ref:''};
  assert.equal((await send('/api/crusher-loading-points',{...sessions.stock1})).status,403);
  assert.equal((await send('/api/crusher-loading-points',{...sessions.driver1})).status,403);
  assert.equal((await send('/api/crusher-loading-points',{method:'POST',body:draft,...sessions.stock1})).status,403);
  assert.equal((await send('/api/crusher-loading-points',{method:'POST',body:draft,cookie:sessions.admin.cookie})).status,403);
  const created=await send('/api/crusher-loading-points',{method:'POST',body:draft,...sessions.admin});
  assert.equal(created.status,200,JSON.stringify(created.data));
  assert.equal(created.data.item.verification_status,'UNVERIFIED');
  assert.equal(created.data.item.latitude,null);
  const update=await send('/api/crusher-loading-points',{method:'POST',body:{...draft,latitude:-6.1,longitude:106.1},...sessions.admin});
  assert.equal(update.status,200);
  assert.equal(update.data.item.verification_status,'UNVERIFIED');
  const fetched=await send('/api/crusher-loading-points',{...sessions.admin});
  assert.equal(fetched.data.items.length,1);
  assert.equal(fetched.data.items[0].verification_status,'UNVERIFIED');
  assert.equal((await db.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision,1);
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  await db.close();await rm(dir,{recursive:true,force:true});
 }
});
test('Driver UAT crusher is assigned by trip, not a selectable destination or real road map',async()=>{
 const adapter=createDriverDemoAdapter();
 const active=await adapter.getActiveTrip();
 assert.equal(active.trip.crusherDestination.crusherId,'CR-UAT-02');
 assert.equal(active.trip.crusherDestination.latitude,null);
 assert.equal(active.trip.crusherDestination.verified,false);
 assert.equal(Object.hasOwn(adapter,'changeDestination'),false);
});
