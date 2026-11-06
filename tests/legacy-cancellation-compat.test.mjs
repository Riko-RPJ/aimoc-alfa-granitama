import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed,applyAction,publicState} from '../server/domain.mjs';
import {legacyOperationFingerprint,applyLegacyDemoCancellation} from '../server/legacy-demo-reconciliation.mjs';

test('cancelled demo work releases legacy fleet eligibility and remains cancelled after later legacy work',()=>{
 const s=createSeed(),admin={id:'synthetic-admin',role:'admin'};s.trucks=s.trucks.slice(0,1);
 const act=(a,p)=>applyAction(s,a,p,admin);
 const request=()=>act('request.create',{jettyId:'jetty-1',vesselId:'vessel-1',destination:'Synthetic UAT',lines:[{skuId:'split-12',quantity:28,unit:'m3'}]}).entityId;
 const cancelledRequest=request();act('request.plan',{requestId:cancelledRequest});const old=s.trips[0];act('trip.start',{tripId:old.id});
 applyLegacyDemoCancellation(s,{tripIds:[old.id],expectedTripCount:1,expectedRequestId:cancelledRequest,expectedFingerprint:legacyOperationFingerprint(s),batchId:'synthetic-compat',reason:'Cancel unexecuted demo for compatibility test.',confirmedDemoOnly:true,noHardware:true,sidecarsAbsent:true},admin);
 assert.equal(publicState(s,admin).trucks[0].status,'available');
 act('master.truck.save',{id:'truck-1',active:false});act('master.truck.save',{id:'truck-1',active:true});
 assert.throws(()=>act('master.truck.delete',{id:'truck-1'}),e=>e.code==='MASTER_IN_USE');
 const next=request();act('request.plan',{requestId:next});const t=s.trips.find(x=>x.requestId===next);
 for(const action of ['start','depart','arrive','unload','return'])act('trip.'+action,{tripId:t.id,...(action==='depart'?{tareT:20,grossT:62}:{})});
 assert.equal(s.requests.find(x=>x.id===cancelledRequest).status,'cancelled');
 assert.equal(s.dispatches.find(x=>x.requestId===cancelledRequest).status,'cancelled');
 assert.equal(s.trips.find(x=>x.id===old.id).status,'cancelled');
 assert.equal(s.requests.find(x=>x.id===next).status,'completed');
 assert.equal(publicState(s,admin).metrics.openRequests,0);
 assert.equal(publicState(s,admin).trucks[0].status,'available');
});
