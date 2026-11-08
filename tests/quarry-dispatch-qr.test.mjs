import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildAssignmentQr} from '../src/features/integrated/assignment-qr.mjs';

const pass=overrides=>JSON.stringify({v:1,type:'AIMOC_QUARRY_DISPATCH_PASS',dispatchId:'dispatch-demo',truckId:'truck-demo',assignedDriverUserId:'driver-demo',...overrides});
test('dispatch pass QR encodes deterministically and changes with truck, Driver or dispatch identity',()=>{
 const qr=buildAssignmentQr(pass());assert.equal(qr.ok,true);assert.deepEqual(buildAssignmentQr(pass()).matrix,qr.matrix);
 for(const key of ['dispatchId','truckId','assignedDriverUserId'])assert.notDeepEqual(buildAssignmentQr(pass({[key]:'another-identity'})).matrix,qr.matrix);
 assert.equal(qr.quietZone,4);assert.equal(qr.errorCorrection,'M');
});
test('dispatch pass rejects credentials, arbitrary types, URLs, missing fields and extra trip-specific fields',()=>{
 for(const value of [pass({token:'not-a-reference'}),pass({password:'not-a-reference'}),pass({type:'__proto__'}),pass({v:2}),pass({tripId:'trip-demo'}),pass({truckId:'https://example.invalid'}),pass({assignedDriverUserId:null}),pass({dispatchId:'x'.repeat(101)}),JSON.stringify({v:1,type:'AIMOC_QUARRY_DISPATCH_PASS',truckId:'truck-demo',assignedDriverUserId:'driver-demo'})])assert.equal(buildAssignmentQr(value).ok,false);
});
test('actual domain replay uses one renderable dispatch pass per truck across both serial trips',()=>{
 const replay=JSON.parse(fs.readFileSync(new URL('../public/quarry-flow-replay.json',import.meta.url),'utf8'));
 const state=replay.frames.at(-1).state,paths=[];
 for(const truck of state.trucks){
  const trips=state.trips.filter(trip=>trip.truckId===truck.id);assert.equal(trips.length,2);
  const first=trips[0].quarry.dispatchPass.value,second=trips[1].quarry.dispatchPass.value;
  assert.equal(first,second);const qr=buildAssignmentQr(first);assert.equal(qr.ok,true);assert.deepEqual(qr.matrix,buildAssignmentQr(second).matrix);paths.push(qr.path);
 }
 assert.equal(new Set(paths).size,4);
});
test('dispatch pass rejects non-string types without coercion or exceptions',()=>{
 for(const type of [['AIMOC_QUARRY_DISPATCH_PASS'],{toString:1,valueOf:2},null,1,true])assert.deepEqual(buildAssignmentQr(pass({type})),{ok:false,reason:'INVALID'});
});
