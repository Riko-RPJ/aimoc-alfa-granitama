import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {provisionLocalDriverUat} from '../scripts/local-driver-uat.mjs';
import {createCrossRoleUatHandler} from '../server/uat-cross-role-http.mjs';
import {initUat,saveUatTruckProfile} from '../server/uat-cross-role.mjs';

test('cross-role UAT real HTTP: Admin to Stockpile to Driver, back to receiving and verified return',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'aimoc-cross-role-'));
 const legacy=await createEmbeddedDatabase(),uat=await createEmbeddedDatabase();
 let server;
 try{
  await bootstrap(legacy,path.join(dir,'accounts.json'));
  await provisionLocalDriverUat(legacy,{localOnly:true,accessPath:path.join(dir,'drivers.json')});
  await initUat(uat);
  for(const truck_id of ['UAT-TRUCK-01','UAT-TRUCK-02'])await saveUatTruckProfile(uat,{
   truck_id,simulated_tare_t:'12.000000',approved_gvw_t:'60.000000',approved_payload_t:'45.000000',
   revision:1,enabled:true,scenario:'SUCCESS',delay_ms:0,authority:'UAT_SIMULATED_CONFIG'
  });
  const before=(await legacy.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision;
  server=http.createServer(createCrossRoleUatHandler({identityDb:legacy,uatDb:uat}));
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const origin='http://127.0.0.1:'+server.address().port;
  const send=async(route,{method='GET',cookie,csrf,key,body,headers={}}={})=>{
   const response=await fetch(origin+route,{method,headers:{
    ...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),
    ...(csrf?{'X-CSRF-Token':csrf}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},
    body:body===undefined?undefined:JSON.stringify(body)});
   return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
  };
  const accounts=[...JSON.parse(await readFile(path.join(dir,'accounts.json'),'utf8')).users,
   ...JSON.parse(await readFile(path.join(dir,'drivers.json'),'utf8')).users];
  const sessions={};
  for(const a of accounts){
   const res=await send('/api/login',{method:'POST',body:{username:a.username,password:a.password}});
   assert.equal(res.status,200,'login '+a.username);
   sessions[a.username]={cookie:res.cookie.split(';')[0],csrf:res.data.csrfToken};
  }
  const drivers=(await send('/api/uat/context',sessions.admin)).data.drivers;
  assert.equal(drivers.length,2);
  const driver1=drivers.find(x=>x.username==='driver1');
  let counter=0;
  const make=async(who,route,body,status=200,key)=>{
   const out=await send(route,{method:'POST',body,...sessions[who],key:key||'uat-request-'+(++counter)});
   assert.equal(out.status,status,route+': '+JSON.stringify(out.data));
   return out.data;
  };
  await t.test('creation requires Admin; location and resource claims enforced',async()=>{
   const body={sourceLocation:'crusher-1',destinationLocation:'crusher-2',driverUserId:driver1.id,
    truckId:'UAT-TRUCK-01',material:'Batu Split UAT',plannedT:'40.000000'};
   await make('stock1','/api/uat/dispatches',body,403);
   const first=await make('admin','/api/uat/dispatches',body);
   assert.equal(first.status,'ASSIGNED');
   const retry=await make('admin','/api/uat/dispatches',body,200,'uat-request-'+counter);
   assert.equal(retry.replayed,true);
   await make('admin','/api/uat/dispatches',body,409);
   const other=await make('admin','/api/uat/dispatches',{...body,driverUserId:drivers.find(x=>x.username==='driver2').id},409);
   // Another truck and distinct driver may run concurrently in same UAT environment.
   const parallel=await make('admin','/api/uat/dispatches',{...body,truckId:'UAT-TRUCK-02',driverUserId:drivers.find(x=>x.username==='driver2').id});
   assert.equal(parallel.status,'ASSIGNED');
  });
  const state=await send('/api/uat/context',sessions.admin);
  const trip=state.data.jobs.find(x=>x.driverUserId===driver1.id).id;
  const route='/api/uat/trips/'+trip+'/actions';
  const progress=async(who,action,extra={})=>make(who,route,{action,...extra});
  await t.test('Admin authorizes and Driver sees only own assignment',async()=>{
   assert.equal((await send('/api/uat/context',sessions.driver1)).data.jobs.length,1);
   assert.equal((await send('/api/uat/context',sessions.driver2)).data.jobs.length,1);
   await make('driver2',route,{action:'accept'},404);
   await progress('admin','start');
   const driver=await progress('driver1','accept');
   assert.equal(driver.status,'TARE_SIMULATED');
   assert.equal(driver.tareStatus,'TARE_RECEIVED');
   const check=await progress('driver1','checklist',{note:'Tyre and cabin checked in UAT'});
   assert.equal(check.checklist,true);
   const job=(await send('/api/uat/context',sessions.driver1)).data.jobs[0];
   assert.equal(job.status,'TARE_SIMULATED');
   assert.equal(job.tareSimulation.status,'TARE_RECEIVED');
   assert.deepEqual(job.loadingCapacity,{gvwAvailableT:'48.000000',loadingLimitT:'40.000000',limitedBy:'REMAINING_PLANNED'});
  });
  await t.test('Stockpile cannot fake tare; Admin simulator and origin-scoped pickup',async()=>{
   await make('stock1',route,{action:'tare',simulatedT:'12.000000'},403);
   await make('admin',route,{action:'gross',simulatedT:'52.000000'},409);
   await make('stock2',route,{action:'loading'},403);
   await progress('stock1','loading');
   await make('admin',route,{action:'gross',simulatedT:'100.000000'},409);
   await progress('admin','gross',{simulatedT:'52.000000'});
   await make('stock2',route,{action:'depart'},403);
   assert.equal((await progress('stock1','depart')).status,'IN_TRANSIT');
   assert.equal((await send('/api/uat/context',sessions.admin)).data.jobs.find(x=>x.id===trip).simulatedNetT,'40.000000');
  });
  await t.test('destination receives, Driver reports return, origin independently verifies',async()=>{
   await make('stock1',route,{action:'arrive'},403);
   await progress('stock2','arrive');
   await make('driver1',route,{action:'receive'},403);
   assert.equal((await progress('stock2','receive')).status,'RECEIVED');
   await make('stock1',route,{action:'verify_return'},409);
   assert.equal((await progress('driver1','return_start')).status,'RETURNING');
   await make('stock2',route,{action:'verify_return'},403);
   assert.equal((await progress('stock1','verify_return')).status,'RETURNED_AVAILABLE');
   const admin=(await send('/api/uat/context',sessions.admin)).data;
   const driver=(await send('/api/uat/context',sessions.driver1)).data;
   const stock=(await send('/api/uat/context',sessions.stock1)).data;
   assert.equal(admin.jobs.find(x=>x.id===trip).status,driver.jobs[0].status);
   assert.equal(stock.jobs.find(x=>x.id===trip).status,'RETURNED_AVAILABLE');
   assert.ok(admin.events.filter(e=>e.tripId===trip).length>=12);
   assert.ok(admin.events.every(e=>e.source==='UAT_SIMULATED'));
   assert.equal(admin.productionInventoryAffected,false);
   assert.equal(admin.realDeviceEvidence,false);
  });
  await t.test('legacy DB untouched, access denied to Jetty and unauthenticated requests',async()=>{
   const after=(await legacy.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision;
   assert.equal(after,before);
   assert.equal((await send('/api/uat/context')).status,401);
   assert.equal((await send('/api/uat/context',sessions.jetty1)).status,403);
   const req=await send('/api/uat/dispatches',{method:'POST',body:{},cookie:sessions.admin.cookie,key:'nosafe-csrf'});
   assert.equal(req.status,403);
  });
 }finally{
  if(server)await new Promise(ok=>server.close(ok));
  await legacy.close();await uat.close();await rm(dir,{recursive:true,force:true});
 }
});
