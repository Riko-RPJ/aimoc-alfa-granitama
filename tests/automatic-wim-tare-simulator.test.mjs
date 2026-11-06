import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutomaticTareEvent} from '../server/uat-wim-tare-simulator.mjs';

const assignment={
 assignmentId:'uat-assignment-1',assignmentRevision:1,tripId:'uat-trip-1',
 truckId:'UAT-TRUCK-01',assignedAt:'2026-11-06T00:00:00.000Z'
};
const profile={
 truck_id:'UAT-TRUCK-01',simulated_tare_t:'12',approved_gvw_t:'60.000000',
 approved_payload_t:'40.000000',revision:3,enabled:true,scenario:'SUCCESS',delay_ms:0,
 authority:'UAT_SIMULATED_CONFIG'
};
const generate=(overrides={})=>createAutomaticTareEvent({
 assignment,profile:{...profile,...overrides},attempt:1,requestedAt:'2026-11-06T00:00:01.000Z'
});

test('SUCCESS creates one deterministic, canonical, unverified UAT event',()=>{
 const first=generate(),second=generate();
 assert.deepEqual(first,second);
 assert.equal(first.kind,'EVENT');
 assert.equal(first.deliveries.length,1);
 assert.match(first.event.externalEventId,/^uat-tare-[a-f0-9]{64}$/);
 assert.deepEqual(first.event,{
  externalEventId:first.event.externalEventId,eventType:'TARE_RECORDED',tripId:'uat-trip-1',
  truckId:'UAT-TRUCK-01',assignmentRevision:1,profileRevision:3,weightT:'12.000000',
  occurredAt:'2026-11-06T00:00:00.000Z',source:'UAT_SIMULATED',verified:false
 });
});

test('DELAYED emits no event before its configured time and keeps event identity across retries',()=>{
 const delayedProfile={...profile,scenario:'DELAYED',delay_ms:5000};
 const early=createAutomaticTareEvent({assignment,profile:delayedProfile,attempt:1,requestedAt:'2026-11-06T00:00:04.999Z'});
 assert.deepEqual(early,{
  kind:'DELAYED',source:'UAT_SIMULATED',correlationId:'auto-tare:uat-trip-1:1',attempt:1,
  retryable:true,availableAt:'2026-11-06T00:00:05.000Z'
 });
 assert.equal('event' in early,false);
 const due=createAutomaticTareEvent({assignment,profile:delayedProfile,attempt:2,requestedAt:'2026-11-06T00:00:05.000Z'});
 const later=createAutomaticTareEvent({assignment,profile:delayedProfile,attempt:3,requestedAt:'2026-11-06T00:01:00.000Z'});
 assert.equal(due.kind,'EVENT');
 assert.equal(due.event.externalEventId,later.event.externalEventId);
 assert.deepEqual(due.event,later.event);
 assert.equal(due.event.occurredAt,'2026-11-06T00:00:05.000Z');
});

test('DUPLICATE yields two identical deliveries with one event identity',()=>{
 const result=generate({scenario:'DUPLICATE'});
 assert.equal(result.kind,'EVENT');
 assert.equal(result.deliveries.length,2);
 assert.deepEqual(result.deliveries[0],result.deliveries[1]);
 assert.notEqual(result.deliveries[0],result.deliveries[1]);
});

test('INVALID and FAILURE are deterministic outcomes without event or weight',()=>{
 const invalid=generate({scenario:'INVALID'}),failure=generate({scenario:'FAILURE'});
 assert.deepEqual(invalid,generate({scenario:'INVALID'}));
 assert.deepEqual(failure,generate({scenario:'FAILURE'}));
 assert.equal(invalid.kind,'INVALID');
 assert.equal(invalid.retryable,false);
 assert.equal(failure.kind,'FAILURE');
 assert.equal(failure.retryable,true);
 for(const outcome of [invalid,failure]){
  assert.equal('event' in outcome,false);
  assert.equal('weightT' in outcome,false);
 }
});

test('requires a valid explicit profile for the assigned UAT truck',()=>{
 assert.throws(()=>createAutomaticTareEvent({assignment,attempt:1,requestedAt:assignment.assignedAt}),
  error=>error.code==='UAT_TARE_PROFILE_MISSING');
 for(const override of [
  {truck_id:'UAT-TRUCK-02'},{enabled:false},{authority:'PRODUCTION'},{scenario:undefined},
  {simulated_tare_t:'0'},{simulated_tare_t:'12.0000001'},{approved_gvw_t:null},
  {approved_payload_t:'Infinity'},{delay_ms:-1}
 ]) assert.throws(()=>generate(override),error=>error.code==='UAT_TARE_PROFILE_INVALID');
 assert.throws(()=>createAutomaticTareEvent({
  assignment:{...assignment,truckId:'TRUCK-01'},profile:{...profile,truck_id:'TRUCK-01'},
  attempt:1,requestedAt:assignment.assignedAt
 }),error=>error.code==='UAT_TARE_PROFILE_INVALID');
});

test('validates correlation inputs and does not default attempt or timestamps',()=>{
 assert.throws(()=>createAutomaticTareEvent({assignment,profile,requestedAt:assignment.assignedAt}),
  error=>error.code==='UAT_TARE_PROFILE_INVALID');
 assert.throws(()=>createAutomaticTareEvent({assignment:{...assignment,assignmentRevision:0},profile,attempt:1,requestedAt:assignment.assignedAt}),
  error=>error.code==='UAT_TARE_PROFILE_INVALID');
 assert.throws(()=>createAutomaticTareEvent({assignment,profile,attempt:1,requestedAt:'not-a-time'}),
  error=>error.code==='UAT_TARE_PROFILE_INVALID');
});
