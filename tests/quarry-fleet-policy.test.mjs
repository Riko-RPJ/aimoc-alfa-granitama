import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction,integratedView} from '../server/integrated-demo-domain.mjs';
import {applyQuarryRequestDemo} from '../server/quarry-request-demo.mjs';

const admin={id:'fleet-policy-admin',role:'admin'};
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.000003,`${actual} != ${expected}`);
function fixture({active=12,inactive=0,driverCount=active,sources=2,quarry=true}={}){
 const state=createSeed(),prototype=state.trucks[0],drivers=Array.from({length:driverCount},(_,i)=>({id:'fleet-policy-driver-'+i,username:'normal-'+String(i).padStart(3,'0'),role:'driver',active:true})),options={drivers};
 state.trucks=Array.from({length:active+inactive},(_,i)=>({...prototype,id:'fleet-policy-truck-'+i,code:'DT-QA-'+String(i).padStart(3,'0'),active:i<active,bedM3:32,payloadLimitT:48}));
 state.stockpiles.forEach(row=>row.onHandM3=row.skuId==='split-35'&&(sources===2||row.crusherId==='crusher-1')?10000:0);
 const act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,options);if(quarry)act('quarry.config.save',{enabled:true,model:'STATIC_WIM'});
 const plan=(tonnes=6000,extra={})=>{const requestId=act('request.create',{transferMode:'MARINE',destinationLocationId:state.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-35',quantity:tonnes,unit:'t'}],...extra}).requestId;act('request.plan',{requestId});return requestId;};
 const trips=id=>state.trips.filter(row=>row.requestId===id),pairs=id=>new Set(trips(id).map(row=>row.truckId).filter(Boolean)),reject=fn=>{const before=structuredClone(state);assert.throws(fn);assert.deepEqual(state,before,'Rejected fleet configuration must be atomic');};return{state,drivers,options,act,plan,trips,pairs,reject};
}

test('new Cilegon dispatch quota uses ceil5percent of TOTAL active fleet with minimum5, bounded by fleet size',()=>{
 for(const [active,expected]of [[2,2],[4,4],[12,5],[100,5],[101,6],[300,15]]){
  const f=fixture({active,inactive:active===100?200:0}),id=f.plan();assert.equal(f.pairs(id).size,expected,`active fleet ${active}`);
  assert.equal(new Set(f.trips(id).map(row=>row.assignedDriverUserId)).size,expected);
  near(f.trips(id).reduce((sum,row)=>sum+row.tonnageT,0),6000);near(f.trips(id).reduce((sum,row)=>sum+row.volumeM3,0),4000);
  assert.ok(f.trips(id).every(row=>row.status==='queued'&&row.truckId&&row.assignedDriverUserId));
  const first=[...f.pairs(id)].map(truckId=>f.trips(id).filter(row=>row.truckId===truckId).sort((a,b)=>a.sequence-b.sequence)[0]);if(expected>=2)assert.equal(new Set(first.map(row=>row.crusherId)).size,2,'First parallel assignments cover both crushers');
  for(const truckId of f.pairs(id))assert.ok(f.trips(id).filter(row=>row.truckId===truckId).length>1,'Large demand remains serial within each truck');
 }
});

test('quota is bounded by idle fleet rather than recalculated as a percentage of idle fleet',()=>{
 const f=fixture({active:300});for(let i=0;i<293;i++)f.state.trips.push({id:'held-trip-'+i,requestId:'held-request-'+i,dispatchId:'held-dispatch-'+i,truckId:f.state.trucks[i].id,assignedDriverUserId:'held-driver-'+i,status:'queued',sequence:i+1,source:'LEGACY'});
 const held=structuredClone(f.state.trips),id=f.plan();assert.equal(f.pairs(id).size,7,'300 active yields quota15; only7 idle trucks may be claimed');assert.deepEqual(f.state.trips.filter(row=>row.source==='LEGACY'),held);
 assert.ok([...f.pairs(id)].every(truckId=>!held.some(row=>row.truckId===truckId)));
});

test('minimum5 does not invent extra trips or Drivers when demand or real catalog is smaller',()=>{
 for(const [active,drivers,tonnes,expected]of [[12,12,240,5],[12,12,96,2],[300,300,48,1],[12,2,6000,2]]){
  const f=fixture({active,driverCount:drivers,sources:1}),id=f.plan(tonnes);assert.equal(f.pairs(id).size,expected);near(f.trips(id).reduce((sum,row)=>sum+row.tonnageT,0),tonnes);
  assert.equal(f.trips(id).length,Math.ceil(tonnes/48));assert.equal(new Set(f.trips(id).map(row=>row.assignedDriverUserId)).size,expected);
 }
});

test('quota5 with two real and three simulated Drivers consumes combined insufficient donors of the same SKU exactly once',()=>{
 const f=fixture({active:12,driverCount:2}),donors=f.state.stockpiles.filter(row=>row.skuId==='split-35');assert.equal(donors.length,2);assert.equal(new Set(donors.map(row=>row.crusherId)).size,2);
 f.state.stockpiles.forEach(row=>row.onHandM3=row.skuId==='split-35'?160:10000);const unrelated=structuredClone(f.state.stockpiles.filter(row=>row.skuId!=='split-35'));
 f.act('fleet.simulation.configure',{totalTrucks:12,enabled:true});const id=f.plan(480),trips=f.trips(id),policy=f.state.dispatches.find(row=>row.requestId===id).allocationPolicy;
 assert.equal(policy.baseQuota,5);assert.equal(f.pairs(id).size,5);assert.equal(trips.length,10);assert.equal(new Set(trips.map(row=>row.assignedDriverUserId)).size,5);assert.equal(new Set(trips.filter(row=>row.assignedDriverSynthetic).map(row=>row.assignedDriverUserId)).size,3);
 assert.ok(trips.every(row=>row.skuId==='split-35'&&donors.some(donor=>donor.id===row.stockpileId)));for(const original of donors){const donor=f.state.stockpiles.find(row=>row.id===original.id);near(donor.reservedM3,160);assert.ok(donor.onHandM3*1.5<480,'Each donor alone is insufficient');}
 const heads=[...f.pairs(id)].map(truckId=>trips.filter(row=>row.truckId===truckId).sort((a,b)=>a.sequence-b.sequence)[0]);assert.equal(new Set(heads.map(row=>row.crusherId)).size,2);near(f.state.vessels[0].reservedT,480);near(trips.reduce((sum,row)=>sum+row.tonnageT,0),480);near(trips.reduce((sum,row)=>sum+row.volumeM3,0),320);
 applyQuarryRequestDemo(f.state,{requestId:id,command:'start',tareT:15},admin,f.options);let rounds=0;while(f.state.requests.find(row=>row.id===id).demoRun.status!=='completed'&&rounds++<20){const run=f.state.requests.find(row=>row.id===id).demoRun;applyQuarryRequestDemo(f.state,{requestId:id,command:'step',runId:run.id,rounds:8},admin,f.options);}
 const request=f.state.requests.find(row=>row.id===id);assert.equal(request.status,'completed');near(request.deliveredT,480);assert.ok(f.trips(id).every(row=>row.status==='returned'&&row.receiptCode));for(const original of donors){const donor=f.state.stockpiles.find(row=>row.id===original.id);near(donor.onHandM3,0);near(donor.reservedM3,0);}near(f.state.vessels[0].loadedT,480);near(f.state.vessels[0].reservedT,0);assert.deepEqual(f.state.stockpiles.filter(row=>row.skuId!=='split-35'),unrelated);assert.equal(f.drivers.length,2);
 for(const trip of f.trips(id)){assert.equal(f.state.inventoryLedger.filter(row=>row.referenceId===trip.id).length,2);assert.equal(f.state.erpOutbox.filter(row=>row.entityId===trip.id).length,2);}const view=integratedView(f.state,admin,f.options);assert.equal(view.fleet.filter(row=>row.status==='available').length,12);assert.equal(view.drivers.length,2);
});

test('fleet policy does not retrofit existing legacy dispatches',()=>{
 const f=fixture({active:12,quarry:false}),id=f.plan();assert.equal(f.pairs(id).size,12,'Existing Alfa legacy allocation remains unchanged');const before=structuredClone(f.trips(id));f.act('quarry.config.save',{enabled:true,model:'STATIC_WIM'});assert.deepEqual(f.trips(id),before);
 const view=integratedView(f.state,admin,f.options);assert.equal(view.fleet.filter(row=>row.status==='allocated').length,12);
});

test('simulation adds and reactivates only marked masters while preserving real catalog and existing125-trip claims',()=>{
 const f=fixture({active:12,driverCount:2,sources:1}),oldId=f.plan(),oldTrips=structuredClone(f.trips(oldId)),manual=structuredClone(f.state.trucks),real=structuredClone(f.drivers),operational=structuredClone({requests:f.state.requests,dispatches:f.state.dispatches,stock:f.state.stockpiles,vessels:f.state.vessels});
 assert.equal(oldTrips.length,125);assert.equal(f.pairs(oldId).size,2);f.act('fleet.simulation.configure',{totalTrucks:300,enabled:true});assert.equal(f.state.trucks.filter(row=>row.active).length,300);
 assert.deepEqual(f.state.trucks.filter(row=>manual.some(original=>original.id===row.id)),manual);assert.deepEqual(f.drivers,real);assert.deepEqual(f.trips(oldId),oldTrips);assert.deepEqual({requests:f.state.requests,dispatches:f.state.dispatches,stock:f.state.stockpiles,vessels:f.state.vessels},operational,'Configuration must not silently reallocate an old queue');
 const next=f.plan(480);assert.equal(f.pairs(next).size,10,'Large active fleet quota is bounded by ten actual loads');assert.ok([...f.pairs(next)].every(id=>!f.pairs(oldId).has(id)));
 assert.ok(f.trips(next).every(row=>!real.some(driver=>driver.id===row.assignedDriverUserId)),'Both real Drivers remain held by their original request');
 const policy=f.state.dispatches.find(row=>row.requestId===next).allocationPolicy;assert.equal(policy.totalActiveFleet,300);assert.equal(policy.baseQuota,15);assert.equal(policy.simulatedDrivers,true);
});

test('new simulation prefers free real Drivers, fills quota without logins and survives disabling while existing virtual trips finish',()=>{
 const f=fixture({active:12,driverCount:2}),realIds=new Set(f.drivers.map(row=>row.id));f.act('fleet.simulation.configure',{totalTrucks:12,enabled:true});const id=f.plan(480),trips=f.trips(id);assert.equal(f.pairs(id).size,5);assert.equal(new Set(trips.filter(row=>realIds.has(row.assignedDriverUserId)).map(row=>row.assignedDriverUserId)).size,2);
 assert.equal(new Set(trips.filter(row=>!realIds.has(row.assignedDriverUserId)).map(row=>row.assignedDriverUserId)).size,3);const view=integratedView(f.state,admin,f.options);assert.equal(view.drivers.length,2,'Virtual workers must not appear as login accounts');assert.ok(view.trips.filter(row=>row.requestId===id).some(row=>row.quarry.allowedPurposes.includes('ENTRY')));
 applyQuarryRequestDemo(f.state,{requestId:id,command:'start'},admin,f.options);const runId=f.state.requests.find(row=>row.id===id).demoRun.id;applyQuarryRequestDemo(f.state,{requestId:id,command:'step',runId,rounds:1},admin,f.options);assert.equal(f.trips(id).filter(row=>row.status==='ready_to_load').length,5);
 f.act('fleet.simulation.configure',{totalTrucks:12,enabled:false});const waiting=f.plan(96);assert.ok(f.trips(waiting).every(row=>!row.truckId),'No new virtual allocation is admitted after disable');
 let count=0;while(f.state.requests.find(row=>row.id===id).demoRun.status!=='completed'){applyQuarryRequestDemo(f.state,{requestId:id,command:'step',runId,rounds:8},admin,f.options);assert.ok(++count<20);}
 assert.ok(f.trips(id).every(row=>row.status==='returned'&&row.receiptCode));near(f.state.requests.find(row=>row.id===id).deliveredT,480);assert.ok(f.trips(waiting).every(row=>!row.assignedDriverUserId||realIds.has(row.assignedDriverUserId)),'Waiting work can use newly released real Drivers only');
 for(const row of f.trips(id)){assert.equal(f.state.inventoryLedger.filter(entry=>entry.referenceId===row.id).length,2);assert.equal(f.state.erpOutbox.filter(entry=>entry.entityId===row.id).length,2);}
});

test('fleet configuration is Admin-only and bounded; shrink never removes claimed simulated trucks',()=>{
 const f=fixture({active:12,driverCount:2}),stock={id:'fleet-policy-stock',role:'stock',crusherIds:['crusher-1']};for(const payload of [{totalTrucks:11},{totalTrucks:301},{totalTrucks:12.5},{totalTrucks:'12'},{totalTrucks:12,enabled:'yes'},{totalTrucks:12,extra:true}])f.reject(()=>f.act('fleet.simulation.configure',payload));f.reject(()=>f.act('fleet.simulation.configure',{totalTrucks:22},stock));
 const manual=structuredClone(f.state.trucks);f.act('fleet.simulation.configure',{totalTrucks:300});const allIds=f.state.trucks.map(row=>row.id).sort();f.act('fleet.simulation.configure',{totalTrucks:12});assert.equal(f.state.trucks.filter(row=>row.active).length,12);assert.deepEqual(f.state.trucks.filter(row=>manual.some(original=>original.id===row.id)),manual);f.act('fleet.simulation.configure',{totalTrucks:300});assert.deepEqual(f.state.trucks.map(row=>row.id).sort(),allIds,'Reactivation must reuse marked simulated IDs');
 f.plan();f.reject(()=>f.act('fleet.simulation.configure',{totalTrucks:12}));
});
