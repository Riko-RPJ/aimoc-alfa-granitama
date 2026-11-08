import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction,integratedView} from '../server/integrated-demo-domain.mjs';
import {driverAssignmentQr} from '../server/driver-assignment-qr.mjs';
import {requestDetail} from '../server/request-detail.mjs';
import {applyQuarryRequestDemo} from '../server/quarry-request-demo.mjs';
import {buildAssignmentQr} from '../src/features/integrated/assignment-qr.mjs';

const admin={id:'stable-pass-admin',role:'admin'},driver={id:'stable-pass-driver-1',username:'a-driver',role:'driver',active:true},other={id:'stable-pass-driver-2',username:'b-driver',role:'driver',active:true};
const legacy=trip=>JSON.stringify({v:1,type:'AIMOC_ASSIGNMENT_REFERENCE',requestId:trip.requestId,dispatchId:trip.dispatchId,tripId:trip.id,truckId:trip.truckId});
const near=(a,b)=>assert.ok(Math.abs(a-b)<0.000003,`${a} differs from ${b}`);
function fixture(mode='MARINE',{quarry=false,quantity=96,simulation=false}={}){
 const state=createSeed(),options={drivers:[driver,other]};state.trucks=state.trucks.slice(0,simulation?12:1).map(truck=>({...truck,bedM3:32,payloadLimitT:48}));state.stockpiles.forEach(row=>row.onHandM3=0);
 const first=state.stockpiles.find(row=>row.crusherId==='crusher-1'&&row.skuId==='split-35'),second=state.stockpiles.find(row=>row.crusherId==='crusher-2'&&row.skuId==='split-35');first.onHandM3=32;if(mode==='LAND')state.stockpiles.push({...first,id:'stable-pass-extra-sp35',code:'QA-SP35-2',onHandM3:32,reservedM3:0});else second.onHandM3=32;if(simulation)first.onHandM3=1000;
 const act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,options);if(quarry)act('quarry.config.save',{enabled:true,model:'STATIC_WIM'});if(simulation)act('fleet.simulation.configure',{totalTrucks:12,enabled:true});
 const requestId=act('request.create',{transferMode:mode,destinationLocationId:'stockpile-location-crusher-2',...(mode==='MARINE'?{jettyId:'jetty-1',vesselId:'vessel-1'}:{}),lines:[{skuId:'split-35',quantity,unit:'t'}]}).requestId;act('request.plan',{requestId});
 const trips=()=>state.trips.filter(row=>row.requestId===requestId).sort((a,b)=>a.sequence-b.sequence),dto=(tripId,actor=driver)=>driverAssignmentQr(state,actor,{tripId,drivers:options.drivers});
 const payload=(tripId,stage,qrValue=dto(tripId).qr.value,eventId=randomUUID())=>({tripId,expectedStage:stage,externalEventId:eventId,qrValue,binding:dto(tripId).binding,...(stage===2?{confirmations:{materialReceived:true,truckReturned:true}}:{})});
 return{state,options,act,requestId,trips,dto,payload};
}

for(const mode of ['LAND','MARINE'])test(`${mode}: two source bins and serial trips share one Driver/Admin pass and SVG while exact trip bindings advance`,()=>{
 const f=fixture(mode),trips=f.trips();assert.equal(trips.length,2);assert.equal(new Set(trips.map(row=>row.stockpileId)).size,2);const before=structuredClone(f.state),passes=[];
 for(const trip of trips){const own=f.dto(trip.id),adminDto=f.dto(trip.id,admin),detail=requestDetail(f.state,admin,{requestId:f.requestId,drivers:f.options.drivers}).trips.find(row=>row.id===trip.id);passes.push(own.qr.value);assert.equal(own.qr.value,adminDto.qr.value);assert.equal(own.qr.value,detail.qr.value);assert.equal(own.dispatchPass.value,own.qr.value);assert.equal(own.trip.dispatchPass.value,own.qr.value);assert.equal(own.legacyQr.value,legacy(trip));assert.equal(own.trip.legacyQr.value,legacy(trip));assert.deepEqual(own.binding,{requestId:trip.requestId,dispatchId:trip.dispatchId,tripId:trip.id,truckId:trip.truckId,sourceStockpileId:trip.stockpileId,sourceCrusherId:trip.crusherId,skuId:trip.skuId,assignedDriverUserId:driver.id});}
 assert.deepEqual(f.state,before);assert.equal(passes[0],passes[1]);assert.deepEqual(JSON.parse(passes[0]),{v:1,type:'AIMOC_DISPATCH_PASS',requestId:f.requestId,dispatchId:trips[0].dispatchId,truckId:trips[0].truckId,assignedDriverUserId:driver.id});const rendered=buildAssignmentQr(passes[0]);assert.equal(rendered.ok,true);assert.equal(rendered.path,buildAssignmentQr(passes[1]).path);
 for(const trip of trips){f.act('trip.driver_scan',f.payload(trip.id,1),driver);assert.equal(f.dto(trip.id).qr.value,passes[0]);f.act('trip.driver_scan',f.payload(trip.id,2),driver);assert.equal(f.dto(trip.id).qr.value,passes[0]);assert.equal(f.dto(trip.id).historical,true);assert.equal(f.state.inventoryLedger.filter(row=>row.referenceId===trip.id).length,2);assert.equal(f.state.erpOutbox.filter(row=>row.entityId===trip.id).length,2);}
 assert.equal(f.state.requests.find(row=>row.id===f.requestId).status,'completed');assert.ok(f.trips().every(row=>row.status==='returned'));if(mode==='MARINE')near(f.state.vessels[0].loadedT,96);assert.equal(integratedView(f.state,driver,f.options).driverDailySummary.completedTrips,2);
});

test('stable pass cannot bypass serial stage, full source/SKU/trip binding or actor ownership; rejected scans are atomic',()=>{
 const f=fixture(),[first,second]=f.trips(),before=structuredClone(f.state),p=f.payload(first.id,1);
 for(const [actor,payload]of [[driver,f.payload(second.id,1)],[other,p],[admin,p],[driver,{...p,binding:{...p.binding,tripId:second.id}}],[driver,{...p,binding:{...p.binding,sourceStockpileId:second.stockpileId}}],[driver,{...p,binding:{...p.binding,skuId:'split-12'}}],[driver,{...p,qrValue:JSON.stringify({...JSON.parse(p.qrValue),assignedDriverUserId:other.id})}],[driver,{...p,qrValue:p.qrValue+' '}],[driver,{...p,expectedStage:2,confirmations:{materialReceived:true,truckReturned:true}}]]){assert.throws(()=>f.act('trip.driver_scan',payload,actor));assert.deepEqual(f.state,before);}
 f.act('trip.driver_scan',p,driver);const ready=structuredClone(f.state);assert.throws(()=>f.act('trip.driver_scan',{...p,externalEventId:randomUUID()},driver),error=>error.code==='DRIVER_SCAN_STAGE_CONFLICT');assert.deepEqual(f.state,ready);assert.throws(()=>f.act('trip.driver_scan',f.payload(second.id,1),driver),error=>error.code==='TRUCK_OR_DRIVER_BUSY');assert.deepEqual(f.state,ready);
});

test('exact cached legacy QR and old intent fingerprint replay without duplicate movement; changing QR under the same event conflicts',()=>{
 const f=fixture(),[first,second]=f.trips(),cached=f.payload(first.id,1,legacy(first)),initial=structuredClone(f.state);f.act('trip.driver_scan',cached,driver);const after=structuredClone(f.state);assert.equal(f.act('trip.driver_scan',cached,driver).replayed,true);assert.deepEqual(f.state,after);
 assert.throws(()=>f.act('trip.driver_scan',{...cached,qrValue:f.dto(first.id).qr.value},driver),error=>error.code==='EVENT_CONFLICT');assert.deepEqual(f.state,after);const cachedFinish=f.payload(first.id,2,legacy(first));f.act('trip.driver_scan',cachedFinish,driver);const finished=structuredClone(f.state);assert.equal(f.act('trip.driver_scan',cached,driver).replayed,true);assert.equal(f.act('trip.driver_scan',cachedFinish,driver).replayed,true);assert.deepEqual(f.state,finished);assert.equal(f.state.inventoryLedger.length-initial.inventoryLedger.length,2);assert.equal(f.state.erpOutbox.length-initial.erpOutbox.length,2);
 const wrong=f.payload(second.id,1,legacy(first)),beforeWrong=structuredClone(f.state);assert.throws(()=>f.act('trip.driver_scan',wrong,driver),error=>error.code==='DRIVER_SCAN_BINDING_INVALID');assert.deepEqual(f.state,beforeWrong);f.act('trip.driver_scan',f.payload(second.id,1,legacy(second)),driver);f.act('trip.driver_scan',f.payload(second.id,2),driver);assert.ok(f.trips().every(row=>row.status==='returned'));near(f.state.vessels[0].loadedT,96);
});

test('Quarry primary QR keeps the existing gate pass across two source trips and only canonical gates advance it',()=>{
 const f=fixture('MARINE',{quarry:true}),trips=f.trips(),passes=trips.map(trip=>f.dto(trip.id).qr.value);assert.equal(trips.length,2);assert.equal(passes[0],passes[1]);const parsed=JSON.parse(passes[0]);assert.deepEqual(parsed,{v:1,type:'AIMOC_QUARRY_DISPATCH_PASS',dispatchId:trips[0].dispatchId,truckId:trips[0].truckId,assignedDriverUserId:driver.id});assert.equal(integratedView(f.state,admin,f.options).trips.find(row=>row.id===trips[0].id).quarry.dispatchPass.value,passes[0]);assert.equal(buildAssignmentQr(passes[0]).ok,true);
 const before=structuredClone(f.state);assert.throws(()=>f.act('trip.driver_scan',f.payload(trips[0].id,1),driver),error=>error.code==='QUARRY_GATE_REQUIRED');assert.deepEqual(f.state,before);applyQuarryRequestDemo(f.state,{requestId:f.requestId,command:'start',tareT:15},admin,f.options);let n=0;while(f.state.requests.find(row=>row.id===f.requestId).demoRun.status!=='completed'&&n++<8){applyQuarryRequestDemo(f.state,{requestId:f.requestId,command:'step',runId:f.state.requests.find(row=>row.id===f.requestId).demoRun.id,rounds:8},admin,f.options);for(const trip of f.trips())assert.equal(f.dto(trip.id,admin).qr.value,passes[0]);}assert.ok(f.trips().every(row=>row.status==='returned'));near(f.state.vessels[0].loadedT,96);
});

test('virtual Driver has Admin-visible stable Quarry pass without becoming a login or a real Driver projection',()=>{
 const f=fixture('MARINE',{quarry:true,quantity:480,simulation:true}),virtual=f.trips().filter(row=>row.assignedDriverSynthetic);assert.ok(virtual.length>0);for(const trip of virtual){const dto=f.dto(trip.id,admin);assert.equal(JSON.parse(dto.qr.value).assignedDriverUserId,trip.assignedDriverUserId);assert.equal(dto.dispatchPass.value,dto.qr.value);assert.equal(buildAssignmentQr(dto.qr.value).ok,true);assert.throws(()=>f.dto(trip.id,driver),error=>error.status===404);}const view=integratedView(f.state,admin,f.options);assert.equal(view.drivers.length,2);assert.ok(!view.drivers.some(row=>row.synthetic));
});

test('generic pass renderer changes only with request/dispatch/truck/Driver and strictly rejects extra or malformed fields',()=>{
 const base={v:1,type:'AIMOC_DISPATCH_PASS',requestId:'request-a',dispatchId:'dispatch-a',truckId:'truck-a',assignedDriverUserId:'driver-a'},value=JSON.stringify(base),qr=buildAssignmentQr(value);assert.equal(qr.ok,true);assert.equal(qr.quietZone,4);assert.equal(qr.errorCorrection,'M');assert.equal(buildAssignmentQr(value).path,qr.path);for(const key of ['requestId','dispatchId','truckId','assignedDriverUserId'])assert.notEqual(buildAssignmentQr(JSON.stringify({...base,[key]:'another-id'})).path,qr.path);
 for(const change of [{v:2},{tripId:'trip-a'},{stockpileId:'stock-a'},{token:'private'},{password:'private'},{type:['AIMOC_DISPATCH_PASS']},{truckId:'https://invalid.example'},{assignedDriverUserId:null},{requestId:''}])assert.equal(buildAssignmentQr(JSON.stringify({...base,...change})).ok,false);assert.equal(buildAssignmentQr(JSON.stringify({...base,assignedDriverUserId:undefined})).ok,false);
});
