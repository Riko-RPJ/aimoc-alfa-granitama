import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

// Compile this JSX component in isolation, keeping its real React/UI dependencies.
const compiled=await build({entryPoints:[fileURLToPath(new URL('../src/features/integrated/TripReferenceDetail.jsx',import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'}});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const {selectTripReference,hasAssignmentQr,hasCurrentAssignmentQr,TripReferenceDetail}=module.exports;

function fixture(){
 const trip={id:'trip-1',code:'RIT-00001',requestId:'request-1',dispatchId:'dispatch-1',truckId:'truck-1',truckCode:'DT-001',assignedDriverUserId:'driver-1',assignedDriver:{id:'driver-1',name:'PRIVATE_DRIVER_NAME'},status:'queued',volumeM3:5,tonnageT:7.5};
 trip.qr={value:JSON.stringify({v:1,type:'AIMOC_ASSIGNMENT_REFERENCE',requestId:trip.requestId,dispatchId:trip.dispatchId,tripId:trip.id,truckId:trip.truckId}),isAuthorization:false,physicalScan:false,historical:false};
 return {request:{id:'request-1',code:'TR-00001'},dispatches:[{id:'dispatch-1',code:'DSP-00001',requestId:'request-1'}],trips:[trip]};
}

test('trip reference selection is exact and rejects cross-request, missing and duplicated trip identities',()=>{
 const detail=fixture();
 assert.equal(selectTripReference(detail,'request-1','trip-1').trip.code,'RIT-00001');
 assert.equal(selectTripReference(detail,'request-2','trip-1'),null);
 assert.equal(selectTripReference(detail,'request-1','trip-2'),null);
 detail.trips.push({...detail.trips[0]});assert.equal(selectTripReference(detail,'request-1','trip-1'),null);
});

test('assignment QR must match the current server trip, request, dispatch and allocated truck',()=>{
 const detail=fixture();assert.equal(hasAssignmentQr(selectTripReference(detail,'request-1','trip-1')),true);
 for(const changed of [{truckId:'truck-2'},{dispatchId:'dispatch-2'},{requestId:'request-2'},{tripId:'trip-2'},{type:'AUTHORIZATION'},{v:2}]){
  const copy=structuredClone(detail);copy.trips[0].qr.value=JSON.stringify({...JSON.parse(copy.trips[0].qr.value),...changed});
  assert.equal(hasAssignmentQr(selectTripReference(copy,'request-1','trip-1')),false);
 }
 const missingDispatch=structuredClone(detail);missingDispatch.dispatches=[];assert.equal(hasAssignmentQr(selectTripReference(missingDispatch,'request-1','trip-1')),false);
});

test('waiting and incomplete assignments never display QR; historical reference remains valid for an assigned trip',()=>{
 for(const changed of [{status:'waiting_truck'},{truckId:null},{assignedDriverUserId:null},{assignedDriver:null},{assignedDriver:{id:'other-driver'}},{qr:{value:'not-json',isAuthorization:false,physicalScan:false}}]){
  const detail=fixture();Object.assign(detail.trips[0],changed);assert.equal(hasAssignmentQr(selectTripReference(detail,'request-1','trip-1')),false);
 }
 for(const changed of [{isAuthorization:true},{physicalScan:true}]){
  const detail=fixture();Object.assign(detail.trips[0].qr,changed);assert.equal(hasAssignmentQr(selectTripReference(detail,'request-1','trip-1')),false);
 }
 const historical=fixture();historical.trips[0].status='returned';historical.trips[0].qr.historical=true;
 assert.equal(hasAssignmentQr(selectTripReference(historical,'request-1','trip-1')),true);
});

test('reassignment with mismatching context hides a valid old DTO QR until both snapshots agree',()=>{
 const detail=fixture(),reference=selectTripReference(detail,'request-1','trip-1'),expected=detail.trips[0];
 assert.equal(hasCurrentAssignmentQr(reference,expected),true);
 for(const changed of [{truckId:'truck-2'},{dispatchId:'dispatch-2'},{assignedDriverUserId:'driver-2'},{truckId:null},{status:'waiting_truck'}])assert.equal(hasCurrentAssignmentQr(reference,{...expected,...changed}),false);
});

test('Admin detail renders planned trip quantities and no Driver identity, operational controls or invented initial QR',()=>{
 const trip=fixture().trips[0];
 trip.skuId='split-12';trip.netT=999;
 const html=renderToStaticMarkup(React.createElement(TripReferenceDetail,{trip,L:(_id,en)=>en,source:()=> 'CR-01 / SP-01',destination:()=> 'JTY-01 / BG-001 → Marunda',truck:()=>({code:'DT-001',plate:'QA-001',bedM3:32,payloadLimitT:50}),product:()=>({code:'SPLIT-12',name:'Split 1–2 cm'}),fmt:value=>String(value),onClose:()=>{}}));
 assert.match(html,/Trip planned volume/);assert.match(html,/>5 <span>m³/);assert.match(html,/>7\.5 <span>t/);
 assert.doesNotMatch(html,/PRIVATE_DRIVER_NAME|Driver actions|Source operator|Jetty.*operator|Shared references|Simulate QR|Record simulated|999|>32 <span>|>50 <span>/);
 assert.doesNotMatch(html,/<input|<form|<svg[^>]+role="img"/);
 assert.match(html,/Loading QR from server/);
 assert.match(html,/JTY-01 \/ BG-001 → Marunda/);
 for(const name of ['dispatch','trip','truck','source','destination','sku'])assert.match(html,new RegExp(`data-trip-reference="${name}"`));
});
