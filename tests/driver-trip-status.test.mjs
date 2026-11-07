import test from 'node:test';
import assert from 'node:assert/strict';
import {driverTripCompletion,filterDriverTrips} from '../src/features/integrated/driver-trip-status.mjs';
import {buildDispatchGroups} from '../src/features/integrated/fleet-dispatch-view.mjs';

test('unfinished is the default and includes each unfinished custody/FSM stage',()=>{
 const statuses=['waiting_truck','queued','start_pending','ready_to_load','loading','weighed','in_transit','arrived','unloaded','returning'];
 const trips=statuses.map(status=>({id:status,status}));
 assert.deepEqual(filterDriverTrips([...trips,{id:'done',status:'returned'},{id:'cancel',status:'cancelled'}]),trips);
 assert.ok(statuses.every(status=>driverTripCompletion({status})==='unfinished'));
});

test('completed includes canonical returns and verified legacy completion only',()=>{
 const trips=[{id:'returned',status:'returned'},{id:'legacy',status:'completed',returnVerifiedBy:'stock-operator'},{id:'unverified',status:'completed'},{id:'bad-marker',status:'completed',returnVerifiedBy:''},{id:'false-display',status:'unloaded',displayStatus:'completed'}];
 assert.deepEqual(filterDriverTrips(trips,'completed').map(trip=>trip.id),['returned','legacy']);
 assert.deepEqual(filterDriverTrips(trips).map(trip=>trip.id),['unverified','bad-marker','false-display']);
});

test('cancelled work is excluded from both buckets and display status cannot override canonical state',()=>{
 const cancelled={id:'cancelled',status:'cancelled',displayStatus:'completed',returnVerifiedBy:'operator'};
 assert.equal(driverTripCompletion(cancelled),'cancelled');
 assert.deepEqual(filterDriverTrips([cancelled]),[]);
 assert.deepEqual(filterDriverTrips([cancelled],'completed'),[]);
 assert.equal(driverTripCompletion({status:'returning',displayStatus:'completed'}),'unfinished');
 assert.equal(driverTripCompletion({status:'returned',displayStatus:'loading'}),'completed');
});

test('unknown and incomplete records remain unfinished rather than silently completed or dropped',()=>{
 const trips=[{id:'unknown',status:'future_status'},{id:'missing'},null];
 assert.deepEqual(filterDriverTrips(trips),trips.slice(0,2));
 assert.deepEqual(filterDriverTrips(trips,'completed'),[]);
 assert.deepEqual(filterDriverTrips(undefined),[]);
 assert.deepEqual(filterDriverTrips(trips,'invalid'),trips.slice(0,2));
});

test('status composes with dispatch and search without mutating snapshots or summary inputs',()=>{
 const trips=[{id:'one',dispatchId:'d1',status:'queued',code:'MATCH-1'},{id:'two',dispatchId:'d1',status:'returned',code:'MATCH-2'},{id:'three',dispatchId:'d2',status:'queued',code:'OTHER'}];
 const before=structuredClone(trips),searched=trips.filter(trip=>trip.code.includes('MATCH'));
 const grouped=buildDispatchGroups(filterDriverTrips(searched),[{id:'d1',code:'DSP-1'},{id:'d2',code:'DSP-2'}],{dispatchId:'d1'});
 assert.deepEqual(grouped.groups.flatMap(group=>group.trips.map(trip=>trip.id)),['one']);
 assert.deepEqual(trips,before);
});

test('polling completion moves a trip from unfinished to completed using the same selected filter',()=>{
 const current=[{id:'trip',status:'returning'}],next=[{id:'trip',status:'returned',displayStatus:'completed',returnVerifiedBy:'driver',driverSecondScannedAt:'2026-11-07T00:30:00Z'}];
 assert.equal(filterDriverTrips(current,'unfinished').length,1);
 assert.equal(filterDriverTrips(next,'unfinished').length,0);
 assert.equal(filterDriverTrips(current,'completed').length,0);
 assert.equal(filterDriverTrips(next,'completed').length,1);
});
