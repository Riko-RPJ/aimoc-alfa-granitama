import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedRequestTracks} from '../src/features/quarry-request-demo/recorded-request-tracks.mjs';
import {requestDemoView} from '../src/features/quarry-request-demo/request-demo-view.mjs';

function trip(id,sequence,extra={}){return{id,code:'RIT-'+id,truckId:'truck-1',status:'returned',sequence,crusherId:'crusher-1',loadingAt:'saved',arrivedAt:'saved',receivedAt:'saved',receiptCode:'RCV-'+id,quarryGateEvents:[{id:id+'-entry',purpose:'ENTRY',laneId:sequence===1?'lane-1':'lane-3'},{id:id+'-exit',purpose:'EXIT',laneId:'lane-2'},{id:id+'-return',purpose:'RETURN',laneId:'lane-3'}],...extra};}
test('completed request replay preserves real serial trip evidence and never mutates canonical state',()=>{
 const state={trucks:[{id:'truck-1',code:'DT-1'}],crushers:[{id:'crusher-1'},{id:'crusher-2'}],trips:[trip('second',2),trip('first',1)],vessels:[{loadedT:96}],stockpiles:[{onHandM3:160,reservedM3:32}]},before=structuredClone(state),result=recordedRequestTracks(state);
 assert.deepEqual(state,before);assert.equal(result.tracks.length,1);assert.equal(result.missingRecords,0);assert.equal(result.duration,45.5);
 const points=result.tracks[0].points.filter(point=>point.action);assert.equal(points.length,12);assert.deepEqual(points.map(point=>point.tripCode),Array(6).fill('RIT-first').concat(Array(6).fill('RIT-second')));assert.deepEqual(points.slice(0,6).map(point=>point.action),['ENTRY','trip.loading','EXIT','trip.arrive','trip.receive','RETURN']);assert.equal(points[6].stage,'repeat');assert.equal(points[6].laneId,'lane-3');assert.equal(points[6].y,370);assert.equal(points[10].receiptCode,'RCV-second');assert.equal(result.tracks[0].points.at(-1).stage,'idle');
});
test('saved-record replay never invents missing stages or replays unfinished cargo',()=>{
 const state={trucks:[{id:'truck-1',code:'DT-1'}],crushers:[{id:'crusher-1'}],trips:[trip('incomplete-evidence',1,{loadingAt:null,arrivedAt:null,receivedAt:null,receiptCode:null,quarryGateEvents:[{id:'entry',purpose:'ENTRY',laneId:'lane-1'}]}),trip('still-queued',2,{status:'queued'})]},before=structuredClone(state),result=recordedRequestTracks(state),points=result.tracks[0].points.filter(point=>point.action);
 assert.deepEqual(state,before);assert.equal(result.missingRecords,5);assert.equal(points.length,1);assert.equal(points[0].action,'ENTRY');assert.equal(points[0].tripId,'incomplete-evidence');assert.ok(!points.some(point=>point.tripId==='still-queued'));assert.equal(result.duration,24.5);
});
test('demo selector lists planned dispatches and retains the selected dispatch after completion',()=>{
 const request=(id,status)=>({id,code:'TR-'+id,status,workflow:'QUARRY_CILEGON',lines:[]}),state={requests:[request('open','planned'),request('running','in_progress'),request('done','completed')],dispatches:[{id:'dispatch-open',code:'DSP-OPEN',requestId:'open',status:'planned'},{id:'dispatch-running',code:'DSP-RUNNING',requestId:'running',status:'in_progress'},{id:'dispatch-done',code:'DSP-DONE',requestId:'done',status:'completed'}],trips:[{id:'trip-open',requestId:'open',workflow:'QUARRY_CILEGON',status:'queued'},{id:'trip-running',requestId:'running',workflow:'QUARRY_CILEGON',status:'loading'},{id:'trip-done',requestId:'done',workflow:'QUARRY_CILEGON',status:'returned'}]};
 assert.deepEqual(new Set(requestDemoView(state).requests.map(item=>item.id)),new Set(['done','running','open']));
 const completed=requestDemoView(state,'done');assert.equal(completed.request.id,'done');assert.deepEqual(new Set(completed.requests.map(item=>item.id)),new Set(['done','running','open']));
});
