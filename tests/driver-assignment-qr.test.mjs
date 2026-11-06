import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction} from '../server/integrated-demo-domain.mjs';
import {requestDetail} from '../server/request-detail.mjs';
import {driverAssignmentQr} from '../server/driver-assignment-qr.mjs';

const admin={id:'qr-admin',role:'admin',active:true};
const driver1={id:'qr-driver-1',username:'qr.driver1',displayName:'Driver One',role:'driver',active:true,password_hash:'PRIVATE_TEST_HASH'};
const driver2={id:'qr-driver-2',username:'qr.driver2',displayName:'Other Driver Name',role:'driver',active:true};
const drivers=[driver1,driver2];
const checksum=state=>createHash('sha256').update(JSON.stringify(state)).digest('hex');

function fixture({singleTruck=false}={}){
 const state=createSeed(),catalog=singleTruck?[driver1]:drivers;
 state.trucks=state.trucks.slice(0,singleTruck?1:2).map(truck=>({...truck,bedM3:30,payloadLimitT:40}));
 const act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,{drivers:catalog});
 const create=(quantity,skuId='split-12',jettyId='jetty-1',vesselId='vessel-1')=>{
  const requestId=act('request.create',{transferMode:'MARINE',destinationLocationId:state.stockpileLocations[0].id,jettyId,vesselId,lines:[{skuId,quantity,unit:'t'}]}).requestId;
  return act('request.plan',{requestId});
 };
 const a=create(singleTruck?120:80),b=singleTruck?null:create(20,'split-23','jetty-2','vessel-3');
 const target=state.trips.find(trip=>trip.requestId===a.requestId&&trip.assignedDriverUserId===driver1.id);
 state.requests.find(request=>request.id===a.requestId).erpSecret='PRIVATE_ERP_SECRET';
 state.erpOutbox.push({id:'private-outbox',payload:{password:'PRIVATE_OUTBOX_PAYLOAD'}});
 return {state,catalog,act,a,b,target};
}

test('Driver and Admin use bit-identical canonical QR bytes and expose only the selected binding',()=>{
 const{state,target,a}=fixture(),before=checksum(state);
 const canonical=requestDetail(state,admin,{requestId:a.requestId,drivers}).trips.find(trip=>trip.id===target.id);
 const adminDto=driverAssignmentQr(state,admin,{tripId:target.id,drivers});
 const driverDto=driverAssignmentQr(state,driver1,{tripId:target.id,drivers});
 assert.equal(driverDto.qr.value,canonical.qr.value);assert.equal(driverDto.qr.value,adminDto.qr.value);
 assert.deepEqual(JSON.parse(driverDto.qr.value),{v:1,type:'AIMOC_ASSIGNMENT_REFERENCE',requestId:target.requestId,dispatchId:target.dispatchId,tripId:target.id,truckId:target.truckId});
 assert.deepEqual(driverDto.binding,{requestId:target.requestId,dispatchId:target.dispatchId,tripId:target.id,truckId:target.truckId,sourceStockpileId:target.stockpileId,sourceCrusherId:target.crusherId,skuId:target.skuId,assignedDriverUserId:driver1.id});
 assert.equal(driverDto.qrReferenceOnly,true);assert.equal(driverDto.scanRecorded,false);assert.equal(driverDto.authorizationGranted,false);
 assert.equal(driverDto.qr.isAuthorization,false);assert.equal(driverDto.qr.physicalScan,false);assert.equal(driverDto.canOpenTask,false);assert.equal(driverDto.canOpenTaskDeprecated,true);
 assert.equal(driverDto.trip.id,target.id);assert.equal('trips' in driverDto,false);assert.equal('lines' in driverDto.request,false);assert.equal('summary' in driverDto.dispatch,false);
 const json=JSON.stringify(driverDto);
 for(const privateValue of ['PRIVATE_TEST_HASH','PRIVATE_ERP_SECRET','PRIVATE_OUTBOX_PAYLOAD',driver2.id,driver2.username,driver2.displayName])assert.ok(!json.includes(privateValue));
 assert.equal(checksum(state),before);
});

test('foreign Driver, reassigned ownership and out-of-scope operator fail closed',()=>{
 const{state,target}=fixture();
 assert.throws(()=>driverAssignmentQr(state,driver2,{tripId:target.id,drivers}),error=>error.status===404);
 assert.throws(()=>driverAssignmentQr(state,{id:'jetty2',role:'jetty',jettyIds:['jetty-2']},{tripId:target.id,drivers}),error=>error.status===404);
 const sourceOperator={id:'own-stock',role:'stock',crusherIds:[target.crusherId]};
 assert.equal(driverAssignmentQr(state,sourceOperator,{tripId:target.id,drivers}).trip.id,target.id);
 const changed=structuredClone(state);changed.trips.find(trip=>trip.id===target.id).assignedDriverUserId=driver2.id;
 const before=checksum(changed);
 assert.throws(()=>driverAssignmentQr(changed,driver1,{tripId:target.id,drivers}),error=>error.status===404);
 assert.equal(checksum(changed),before);
 assert.throws(()=>driverAssignmentQr(state,{...driver1,active:false},{tripId:target.id,drivers}),error=>error.status===403);
 for(const id of [undefined,'','bad/id','x'.repeat(101)])assert.throws(()=>driverAssignmentQr(state,driver1,{tripId:id,drivers}),error=>error.status===400);
});

test('request, dispatch, source stockpile/crusher, SKU and target inconsistencies reject QR without mutation',()=>{
 for(const corrupt of [
  (state,target,b)=>{target.requestId=b.requestId;},
  (state,target,b)=>{target.dispatchId=b.dispatchIds[0];},
  (state,target)=>{state.requests.find(request=>request.id===target.requestId).dispatchId='dispatch-wrong';},
  (state,target)=>{state.dispatches.find(dispatch=>dispatch.id===target.dispatchId).tripIds=[];},
  (state,target)=>{target.stockpileId='stock-2-1';},
  (state,target)=>{target.crusherId=target.crusherId==='crusher-1'?'crusher-2':'crusher-1';},
  (state,target)=>{target.skuId='basecourse';},
  (state,target)=>{state.requests.find(request=>request.id===target.requestId).lines=[{skuId:'basecourse'}];},
  (state,target)=>{state.dispatches.find(dispatch=>dispatch.id===target.dispatchId).allocations=[];},
  (state,target)=>{target.vesselId='vessel-2';},
 ]){
  const{state,target,b}=fixture();corrupt(state,state.trips.find(trip=>trip.id===target.id),b);
  const before=checksum(state);
  assert.throws(()=>driverAssignmentQr(state,driver1,{tripId:target.id,drivers}),error=>error.status===409&&error.code==='ASSIGNMENT_QR_BINDING_INVALID');
  assert.equal(checksum(state),before);
 }
});

test('waiting cargo, missing truck and inactive current Driver do not produce an operational QR',()=>{
 const{state,target,b}=fixture();
 const waiting=state.trips.find(trip=>trip.requestId===b.requestId);
 assert.equal(waiting.status,'waiting_truck');
 assert.throws(()=>driverAssignmentQr(state,admin,{tripId:waiting.id,drivers}),error=>error.code==='ASSIGNMENT_QR_NOT_AVAILABLE');
 assert.throws(()=>driverAssignmentQr(state,driver1,{tripId:waiting.id,drivers}),error=>error.status===404);
 const noTruck=structuredClone(state);noTruck.trips.find(trip=>trip.id===target.id).truckId=null;
 assert.throws(()=>driverAssignmentQr(noTruck,driver1,{tripId:target.id,drivers}),error=>error.code==='ASSIGNMENT_QR_NOT_AVAILABLE');
 assert.throws(()=>driverAssignmentQr(state,driver1,{tripId:target.id,drivers:[{...driver1,active:false},driver2]}),error=>error.code==='ASSIGNMENT_QR_NOT_AVAILABLE');
});

test('future serial task QR never bypasses queue order or creates a scan marker',()=>{
 const{state,a,act,catalog}=fixture({singleTruck:true});
 const tasks=state.trips.filter(trip=>trip.requestId===a.requestId).sort((x,y)=>x.sequence-y.sequence),last=tasks.at(-1);
 const before=structuredClone(state),fingerprint=checksum(state);
 const dto=driverAssignmentQr(state,driver1,{tripId:last.id,drivers:catalog});
 assert.equal(dto.canOpenTask,false);assert.equal(dto.canOpenTaskDeprecated,true);assert.equal(dto.scanRecorded,false);
 assert.ok(dto.qr.value);assert.equal(last.qrScannedAt,undefined);
 assert.deepEqual(state,before);assert.equal(checksum(state),fingerprint);
 assert.throws(()=>act('trip.start',{tripId:last.id},driver1),error=>error.code==='QUEUE_ORDER');
 assert.deepEqual(state,before);
});

test('completed history retains its QR reference, disables operational handoff and survives inactive masters',()=>{
 const{state,target,act}=fixture();const tripId=target.id;
 act('trip.qr',{tripId});act('trip.tare',{tripId,weightT:15});act('trip.start',{tripId},driver1);act('trip.loading',{tripId});act('trip.gross',{tripId,weightT:55});
 for(const action of ['depart','arrive','receive'])act('trip.'+action,{tripId});
 act('trip.return_start',{tripId},driver1);act('trip.return',{tripId});
 state.trucks.find(truck=>truck.id===target.truckId).active=false;
 const before=checksum(state),dto=driverAssignmentQr(state,driver1,{tripId,drivers:[]});
 assert.equal(dto.historical,true);assert.equal(dto.qr.historical,true);assert.equal(dto.canOpenTask,false);
 assert.equal(dto.qr.isAuthorization,false);assert.equal(dto.scanRecorded,false);
 assert.equal(checksum(state),before);
 const cancelled=structuredClone(state);cancelled.trips.find(trip=>trip.id===tripId).status='cancelled';
 assert.equal(driverAssignmentQr(cancelled,driver1,{tripId,drivers:[]}).historical,true);
});

test('LAND uses the same Admin QR format and verifies its receiving stockpile binding',()=>{
 const state=createSeed();state.trucks=state.trucks.slice(0,1);
 const act=(action,payload)=>applyIntegratedAction(state,action,payload,admin,{drivers:[driver1]});
 const requestId=act('request.create',{transferMode:'LAND',destinationLocationId:state.stockpileLocations[0].id,lines:[{skuId:'split-12',quantity:10,unit:'t'}]}).requestId;
 act('request.plan',{requestId});
 const target=state.trips.find(trip=>trip.requestId===requestId),before=checksum(state);
 const dto=driverAssignmentQr(state,driver1,{tripId:target.id,drivers:[driver1]});
 assert.equal(dto.qr.value,requestDetail(state,admin,{requestId,drivers:[driver1]}).trips[0].qr.value);
 assert.equal(dto.request.transferMode,'LAND');assert.equal(checksum(state),before);
 const corrupt=structuredClone(state);corrupt.trips[0].destinationCrusherId=target.crusherId;
 assert.throws(()=>driverAssignmentQr(corrupt,driver1,{tripId:target.id,drivers:[driver1]}),error=>error.code==='ASSIGNMENT_QR_BINDING_INVALID');
});
