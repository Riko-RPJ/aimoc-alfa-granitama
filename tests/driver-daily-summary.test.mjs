import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeDriverDailyTrips} from '../server/driver-daily-summary.mjs';
import {integratedView} from '../server/integrated-demo-domain.mjs';
import {createSeed} from '../server/seed.mjs';

const driver={id:'synthetic-driver-one',role:'driver',active:true};
const NOW='2026-11-07T02:30:00.000Z',START='2026-11-06T17:00:00.000Z',END='2026-11-07T17:00:00.000Z';
const YESTERDAY='2026-11-06T16:59:59.999Z',TODAY='2026-11-06T17:00:00.000Z',TOMORROW='2026-11-07T17:00:00.000Z';
const trip=(id,extra={})=>({id,source:'INTEGRATED_DEMO',assignedDriverUserId:driver.id,status:'queued',assignedAt:TODAY,createdAt:YESTERDAY,...extra});
const summarize=(trips,options={})=>summarizeDriverDailyTrips({trips},driver,{now:NOW,...options});

test('server WIB calendar day rolls exactly at 17:00 UTC with explicit inclusive/exclusive bounds',()=>{
 const previous=summarize([],{now:YESTERDAY}),today=summarize([],{now:()=>new Date(START)});
 assert.equal(previous.localDate,'2026-11-06');assert.equal(previous.periodEnd,START);
 assert.equal(today.localDate,'2026-11-07');assert.equal(today.timeZone,'Asia/Jakarta');assert.equal(today.periodStart,START);assert.equal(today.periodEnd,END);
 assert.equal(today.definition.interval,'START_INCLUSIVE_END_EXCLUSIVE');
 assert.equal(summarize([],{now:new Date(END)}).localDate,'2026-11-08');
 const exact=summarize([trip('at-start'),trip('before-start',{assignedAt:YESTERDAY}),trip('at-end',{assignedAt:END})]);
 assert.equal(exact.unfinishedTrips,1);assert.equal(exact.completedTrips,0);assert.equal(exact.status,'READY');
});

test('strict unfinished count uses assignment OR start today and never silently includes carryover or future days',()=>{
 const rows=[trip('assigned-today'),trip('started-today',{assignedAt:YESTERDAY,startedAt:TODAY}),trip('legacy-created-today',{assignedAt:null,createdAt:TODAY}),trip('carryover',{assignedAt:YESTERDAY,createdAt:TODAY}),trip('tomorrow',{assignedAt:TOMORROW}),trip('unloaded',{status:'unloaded',unloadedAt:TODAY}),trip('returning',{status:'returning',returnStartedAt:TODAY}),trip('cancelled',{status:'cancelled'}),trip('returned',{status:'returned',returnedAt:TODAY})];
 const value=summarize(rows);
 assert.equal(value.unfinishedTrips,5);assert.equal(value.completedTrips,1);assert.equal(value.includeCarryover,false);
 assert.equal(value.definition.unfinished,'ASSIGNED_OR_STARTED_TODAY');assert.equal(value.definition.legacyFallback,'CREATED_AT_IF_NO_ASSIGNMENT_OR_START_TIMESTAMP');
 const carryover=summarize(rows,{includeCarryover:true});assert.equal(carryover.unfinishedTrips,6);assert.equal(carryover.completedTrips,1);
});

test('completion counts verified return today regardless of earlier start and excludes unloading or cancellations',()=>{
 const value=summarize([
  trip('returned-today',{status:'returned',assignedAt:YESTERDAY,startedAt:YESTERDAY,returnedAt:TODAY}),
  trip('returned-yesterday',{status:'returned',returnedAt:YESTERDAY}),trip('returned-tomorrow',{status:'returned',returnedAt:TOMORROW}),
  trip('completed-compatible',{status:'completed',completedAt:'2026-11-07T00:00:00+07:00',returnVerifiedBy:'synthetic-stock-verifier'}),
  trip('unload-is-not-completion',{status:'unloaded',receivedAt:TODAY,unloadedAt:TODAY,completedAt:TODAY}),
  trip('cancelled-not-completed',{status:'cancelled',returnedAt:TODAY,completedAt:TODAY})
 ]);
 assert.equal(value.completedTrips,2);assert.equal(value.unfinishedTrips,1);assert.equal(value.status,'READY');
 const incomplete=summarize([trip('not-return-verified',{status:'completed',completedAt:TODAY})]);
 assert.equal(incomplete.completedTrips,null);assert.equal(incomplete.availability.completedTrips,false);assert.equal(incomplete.unclassifiedTrips.completed,1);
});

test('malformed or absent timestamps do not fall back over invalid evidence or fabricate date membership',()=>{
 for(const broken of [trip('invalid-assignment',{assignedAt:'not-a-date',createdAt:TODAY}),trip('invalid-start',{assignedAt:null,startedAt:'2026-11-07 00:00:00',createdAt:TODAY}),trip('missing-legacy-dates',{assignedAt:null,createdAt:null}),trip('impossible-date',{assignedAt:'2026-02-30T00:00:00Z',createdAt:TODAY}),trip('empty-assignment',{assignedAt:'',createdAt:TODAY})]){
  const result=summarize([broken]);assert.equal(result.unfinishedTrips,null);assert.equal(result.completedTrips,0);assert.equal(result.status,'PARTIAL');assert.equal(result.availability.unfinishedTrips,false);
 }
 // A valid OR branch proves today's membership even if the other event needs repair.
 assert.equal(summarize([trip('valid-start',{assignedAt:'invalid',startedAt:TODAY})]).unfinishedTrips,1);
 for(const broken of [trip('missing-return',{status:'returned'}),trip('invalid-return',{status:'returned',returnedAt:'2026-11-07'}),trip('no-return-fallback',{status:'returned',returnedAt:'invalid',completedAt:TODAY})]){
  const result=summarize([broken]);assert.equal(result.completedTrips,null);assert.equal(result.unfinishedTrips,0);assert.equal(result.availability.completedTrips,false);
 }
});

test('only this Driver integrated trip scope influences counts or availability; no identity details are returned',()=>{
 const otherId='PRIVATE_OTHER_DRIVER',privateTrip='PRIVATE_OTHER_TRIP';
 const rows=[trip('own-today'),trip(privateTrip,{assignedDriverUserId:otherId,assignedAt:'invalid'}),trip('other-source',{source:'LEGACY_DEMO',assignedAt:'invalid'}),trip('unassigned',{assignedDriverUserId:null,assignedAt:'invalid'})];
 const result=summarize(rows);assert.equal(result.unfinishedTrips,1);assert.equal(result.completedTrips,0);assert.equal(result.status,'READY');
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_OTHER_DRIVER|PRIVATE_OTHER_TRIP|own-today|synthetic-driver-one/);
 for(const actor of [{id:'admin',role:'admin'},{id:'stock',role:'stock'},null,{...driver,active:false}])assert.throws(()=>summarizeDriverDailyTrips({trips:rows},actor,{now:NOW}),error=>error.code==='FORBIDDEN');
});

test('read projection generates the daily summary only for Driver and never mutates canonical state or leaks persisted summaries',()=>{
 const state=createSeed();state.driverDailySummary={privateDriver:'MUST_NOT_LEAK',unfinishedTrips:999};
 state.trips=[trip('own',{truckId:null,volumeM3:5,tonnageT:7.5}),trip('own-carryover',{assignedAt:YESTERDAY,status:'returning',truckId:null,volumeM3:4,tonnageT:6}),trip('own-returned-today',{assignedAt:YESTERDAY,status:'returned',returnedAt:TODAY,truckId:null,volumeM3:3,tonnageT:4.5}),trip('own-returned-yesterday',{status:'returned',returnedAt:YESTERDAY,truckId:null,volumeM3:2,tonnageT:3}),trip('other',{assignedDriverUserId:'other-driver',assignedAt:'invalid',truckId:null,volumeM3:8,tonnageT:12})];
 const before=structuredClone(state),options={now:NOW,drivers:[driver]};
 const view=integratedView(state,driver,options);assert.equal(view.driverDailySummary.unfinishedTrips,2);assert.equal(view.driverDailySummary.completedTrips,1);assert.equal(view.driverDailySummary.localDate,'2026-11-07');assert.equal(view.driverDailySummary.includeCarryover,true);assert.equal(view.driverDailySummary.definition.unfinished,'OPEN_ASSIGNED_OR_STARTED_BEFORE_END');
 for(const actor of [{id:'admin',role:'admin'},{id:'stock',role:'stock',crusherIds:['crusher-1']},{id:'jetty',role:'jetty',jettyIds:['jetty-1']}])assert.equal(Object.hasOwn(integratedView(state,actor,options),'driverDailySummary'),false);
 assert.deepEqual(state,before);
});

test('invalid server time and ambiguous identities fail safely rather than inventing a daily total',()=>{
 for(const now of ['bad',new Date(NaN),Number.MAX_VALUE])assert.throws(()=>summarize([],{now}),error=>error.code==='DRIVER_DAILY_SUMMARY_TIME_INVALID');
 const result=summarize([trip('duplicate'),trip('duplicate')]);assert.equal(result.unfinishedTrips,null);assert.equal(result.completedTrips,null);assert.equal(result.status,'PARTIAL');
});
