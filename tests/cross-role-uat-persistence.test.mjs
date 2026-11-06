import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {provisionLocalDriverUat} from '../scripts/local-driver-uat.mjs';
import {initUat,saveUatTruckProfile,createUatDispatch,uatContext,advanceUat,processAutomaticTare} from '../server/uat-cross-role.mjs';

test('cross-role UAT persists isolated dispatch, status and events across DB reopen',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'aimoc-uat-persist-'));
 const identity=await createEmbeddedDatabase();
 let uat;
 try{
  await bootstrap(identity,path.join(dir,'access.json'));
  await provisionLocalDriverUat(identity,{localOnly:true,accessPath:path.join(dir,'drivers.json')});
  const users=(await identity.query("SELECT id,username,role,crusher_ids FROM aimoc_alfa_ops.users WHERE username IN ('admin','stock1','driver1')")).rows;
  const admin=users.find(x=>x.username==='admin');
  const stock=users.find(x=>x.username==='stock1');
  const driver=users.find(x=>x.username==='driver1');
  const actor=u=>({id:u.id,username:u.username,role:u.role,crusherIds:u.crusher_ids||[]});
  const location=path.join(dir,'isolated-uat-db');
  uat=await createEmbeddedDatabase(location);
  await initUat(uat);
  await saveUatTruckProfile(uat,{truck_id:'UAT-PERSIST-01',simulated_tare_t:'8.250000',approved_gvw_t:'30.000000',approved_payload_t:'20.000000',revision:1,enabled:true,scenario:'SUCCESS',delay_ms:0,authority:'UAT_SIMULATED_CONFIG'});
  const newJob=await createUatDispatch(uat,identity,{actor:actor(admin),key:'persist-create-1',body:{
   sourceLocation:'crusher-1',destinationLocation:'crusher-2',driverUserId:driver.id,
   truckId:'UAT-PERSIST-01',material:'Batu Split UAT',plannedT:'20.000000'
  }});
  await advanceUat(uat,{actor:actor(admin),key:'persist-start-1',tripId:newJob.id,body:{action:'start'}});
  await advanceUat(uat,{actor:actor(driver),key:'persist-accept-1',tripId:newJob.id,body:{action:'accept'}});
  await uat.close();uat=null;
  uat=await createEmbeddedDatabase(location);
  await initUat(uat);
  const adminRead=await uatContext(uat,identity,actor(admin));
  const stockRead=await uatContext(uat,identity,actor(stock));
  const driverRead=await uatContext(uat,identity,actor(driver));
  assert.equal(adminRead.jobs[0].id,newJob.id);
  assert.equal(stockRead.jobs[0].id,newJob.id);
  assert.equal(driverRead.jobs[0].id,newJob.id);
  assert.equal(driverRead.jobs[0].status,'TARE_SIMULATED');
  assert.equal(driverRead.jobs[0].simulatedTareT,'8.250000');
  assert.equal(driverRead.jobs[0].tareSimulation.status,'TARE_RECEIVED');
  assert.deepEqual(driverRead.jobs[0].loadingCapacity,{gvwAvailableT:'21.750000',loadingLimitT:'20.000000',limitedBy:'PAYLOAD'});
  assert.ok(adminRead.events.filter(x=>x.tripId===newJob.id).length>=7);
  assert.equal(adminRead.productionInventoryAffected,false);
  assert.equal(adminRead.realDeviceEvidence,false);
 }finally{
  if(uat)await uat.close();
  await identity.close();await rm(dir,{recursive:true,force:true});
 }
});

test('automatic Tare failures remain isolated, retry safely, and reject stale assignments',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'aimoc-uat-tare-'));
 const identity=await createEmbeddedDatabase(),uat=await createEmbeddedDatabase();
 try{
  await bootstrap(identity,path.join(dir,'access.json'));
  await provisionLocalDriverUat(identity,{localOnly:true,accessPath:path.join(dir,'drivers.json')});
  await initUat(uat);
  const users=(await identity.query("SELECT id,username,role,crusher_ids FROM aimoc_alfa_ops.users WHERE username IN ('admin','driver1')")).rows;
  const admin=users.find(x=>x.username==='admin'),driver=users.find(x=>x.username==='driver1');
  const actor=u=>({id:u.id,username:u.username,role:u.role,crusherIds:u.crusher_ids||[]});
  const body={sourceLocation:'crusher-1',destinationLocation:'crusher-2',driverUserId:driver.id,truckId:'UAT-RETRY-01',material:'UAT only',plannedT:'10.000000'};
  const assigned=await createUatDispatch(uat,identity,{actor:actor(admin),key:'failure-create-1',body});
  assert.equal(assigned.status,'ASSIGNED');
  assert.equal(assigned.tareStatus,'TARE_FAILED');
  assert.equal((await uat.query('SELECT count(*)::int count FROM uat_tare_jobs WHERE trip_id=$1',[assigned.id])).rows[0].count,1);

  await saveUatTruckProfile(uat,{truck_id:body.truckId,simulated_tare_t:'5.000000',approved_gvw_t:'25.000000',approved_payload_t:'15.000000',revision:2,enabled:true,scenario:'FAILURE',delay_ms:0,authority:'UAT_SIMULATED_CONFIG'});
  const failed=await processAutomaticTare(uat,assigned.id);
  assert.equal(failed.tareStatus,'TARE_FAILED');
  assert.equal((await uat.query('SELECT simulated_tare_t FROM uat_dispatches WHERE id=$1',[assigned.id])).rows[0].simulated_tare_t,null);

  await saveUatTruckProfile(uat,{truck_id:body.truckId,simulated_tare_t:'5.000000',approved_gvw_t:'25.000000',approved_payload_t:'15.000000',revision:2,enabled:true,scenario:'SUCCESS',delay_ms:0,authority:'UAT_SIMULATED_CONFIG'});
  await advanceUat(uat,{actor:actor(admin),key:'failure-start-1',tripId:assigned.id,body:{action:'start'}});
  const received=await advanceUat(uat,{actor:actor(driver),key:'failure-accept-1',tripId:assigned.id,body:{action:'accept'}});
  assert.equal(received.status,'TARE_SIMULATED');
  assert.equal(received.tareStatus,'TARE_RECEIVED');
  assert.equal((await processAutomaticTare(uat,assigned.id)).replayed,true);

  await uat.query("UPDATE uat_tare_jobs SET status='TARE_FAILED',completed_at=NULL WHERE trip_id=$1",[assigned.id]);
  await uat.query("UPDATE uat_dispatches SET truck_id='UAT-REASSIGNED-02' WHERE id=$1",[assigned.id]);
  const stale=await processAutomaticTare(uat,assigned.id);
  assert.equal(stale.tareStatus,'TARE_INVALID');
  assert.equal(stale.errorCode,'STALE_ASSIGNMENT');

  await uat.query("UPDATE uat_dispatches SET status='RETURNED_AVAILABLE' WHERE id=$1",[assigned.id]);
  await saveUatTruckProfile(uat,{truck_id:body.truckId,simulated_tare_t:'5.000000',approved_gvw_t:'25.000000',approved_payload_t:'15.000000',revision:3,enabled:true,scenario:'DELAYED',delay_ms:60000,authority:'UAT_SIMULATED_CONFIG'});
  const delayed=await createUatDispatch(uat,identity,{actor:actor(admin),key:'delayed-create-1',body});
  assert.equal(delayed.tareStatus,'TARE_PENDING');
  await advanceUat(uat,{actor:actor(admin),key:'delayed-start-1',tripId:delayed.id,body:{action:'start'}});
  const waiting=await advanceUat(uat,{actor:actor(driver),key:'delayed-accept-1',tripId:delayed.id,body:{action:'accept'}});
  assert.equal(waiting.status,'DRIVER_ACCEPTED');
  assert.equal((await processAutomaticTare(uat,delayed.id,{now:new Date(Date.now()+120000)})).status,'TARE_SIMULATED');

  await uat.query("UPDATE uat_dispatches SET status='RETURNED_AVAILABLE' WHERE id=$1",[delayed.id]);
  await saveUatTruckProfile(uat,{truck_id:body.truckId,simulated_tare_t:'5.000000',approved_gvw_t:'25.000000',approved_payload_t:'15.000000',revision:4,enabled:true,scenario:'DUPLICATE',delay_ms:0,authority:'UAT_SIMULATED_CONFIG'});
  const duplicate=await createUatDispatch(uat,identity,{actor:actor(admin),key:'duplicate-create-1',body});
  await advanceUat(uat,{actor:actor(admin),key:'duplicate-start-1',tripId:duplicate.id,body:{action:'start'}});
  assert.equal((await advanceUat(uat,{actor:actor(driver),key:'duplicate-accept-1',tripId:duplicate.id,body:{action:'accept'}})).status,'TARE_SIMULATED');
  assert.equal((await uat.query("SELECT count(*)::int count FROM uat_events WHERE dispatch_id=$1 AND action='TARE_AUTO_RECEIVED'",[duplicate.id])).rows[0].count,1);

  await uat.query("UPDATE uat_dispatches SET status='RETURNED_AVAILABLE' WHERE id=$1",[duplicate.id]);
  await saveUatTruckProfile(uat,{truck_id:body.truckId,simulated_tare_t:'5.000000',approved_gvw_t:'25.000000',approved_payload_t:'15.000000',revision:5,enabled:true,scenario:'INVALID',delay_ms:0,authority:'UAT_SIMULATED_CONFIG'});
  const invalid=await createUatDispatch(uat,identity,{actor:actor(admin),key:'invalid-create-1',body});
  assert.equal(invalid.status,'ASSIGNED');
  assert.equal(invalid.tareStatus,'TARE_INVALID');
  assert.equal((await uat.query('SELECT simulated_tare_t FROM uat_dispatches WHERE id=$1',[invalid.id])).rows[0].simulated_tare_t,null);
 }finally{
  await identity.close();await uat.close();await rm(dir,{recursive:true,force:true});
 }
});
