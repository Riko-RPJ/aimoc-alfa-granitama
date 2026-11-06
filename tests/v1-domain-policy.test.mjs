import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMarineTripStart,evaluateMarineUnloadRelease,evaluateTruckReturnRelease} from '../server/v1/dispatch-policy.mjs';

const initial=()=>{
  const dispatch={id:'dispatch-a',mode:'MARINE',voyage_id:'voyage-1',status:'ACTIVE'};
  const trips=[
    {id:'trip-1',dispatch_id:dispatch.id,sequence_no:1,status:'UNLOADED_VERIFIED',
      unloaded_verified_at:'2026-11-06T04:00:00Z',
      final_unload_settlement:{trip_id:'trip-1',status:'VERIFIED',verified_at:'2026-11-06T04:00:00Z'}},
    {id:'trip-2',dispatch_id:dispatch.id,sequence_no:2,status:'QUEUED'},
  ];
  return {dispatch,trips,currentTrip:trips[1],sequenceGate:{dispatch_id:dispatch.id,active_trip_id:null,last_released_sequence_no:1},
    resourceReadiness:{truckAvailable:true,driverAvailable:true},
    cargoReadiness:{reservationActive:true},operationalReadiness:{valid:true}};
};
test('Marine Option B permits next trip while predecessor truck is still returning',()=>{
  const a=initial();a.trips[0].status='RETURNING';a.trips[0].truck_resource_claim_active=true;
  assert.equal(evaluateMarineTripStart(a).code,'ELIGIBLE');
});
test('cannot start before final verified unloading',()=>{
  const a=initial();a.trips[0].final_unload_settlement.status='PENDING';
  assert.equal(evaluateMarineTripStart(a).code,'PREVIOUS_TRIP_NOT_UNLOADED');
});
test('HOLD keeps persistent sequence gate and blocks next trip',()=>{
  const a=initial();a.sequenceGate.active_trip_id='trip-1';a.trips[0].status='ON_HOLD';
  assert.equal(evaluateMarineTripStart(a).code,'SEQUENCE_GATE_BUSY');
});
test('resolved unload without independently authorized receiver cannot release gate',()=>{
  const a=initial();
  const x=evaluateMarineUnloadRelease({trip:{id:'trip-1',status:'ARRIVED'},receipt:{trip_id:'trip-1',status:'VERIFIED'},
    settlement:{trip_id:'trip-1',status:'VERIFIED',verified_at:'now'},receiverAuthorized:false});
  assert.equal(x.code,'RECEIVER_NOT_AUTHORIZED');
});
test('partial receipt does not open marine sequence',()=>{
  const x=evaluateMarineUnloadRelease({trip:{id:'trip-1',status:'ARRIVED'},receipt:{trip_id:'trip-1',status:'VERIFIED'},
    settlement:{trip_id:'trip-1',status:'PENDING'},receiverAuthorized:true});
  assert.equal(x.code,'UNLOAD_NOT_FINAL');
});
test('truck remains BUSY until independently verified return',()=>{
  const a={trip:{id:'trip-1',status:'RETURNING',unloaded_verified_at:'now'},
    resourceClaim:{trip_id:'trip-1'},vehicleReady:true};
  assert.equal(evaluateTruckReturnRelease(a).code,'RETURN_NOT_VERIFIED');
  a.verification={trip_id:'trip-1',status:'VERIFIED',verified_at:'now'};
  assert.equal(evaluateTruckReturnRelease(a).code,'ELIGIBLE');
});
test('same truck cannot be used again if occupied, even if gate released',()=>{
  const a=initial();a.resourceReadiness.truckAvailable=false;
  assert.equal(evaluateMarineTripStart(a).code,'TRUCK_BUSY');
});
test('trip must belong to same dispatch and sequence cannot skip missing predecessor',()=>{
  const a=initial();a.currentTrip.dispatch_id='another';
  assert.equal(evaluateMarineTripStart(a).code,'INVALID_TRIP_SEQUENCE');
  const b=initial();b.trips=[b.currentTrip];
  assert.equal(evaluateMarineTripStart(b).code,'PREVIOUS_TRIP_MISSING');
});
test('mode, voyage, reservations and blocking readiness matter',()=>{
  const a=initial();a.dispatch.mode='LAND';
  assert.equal(evaluateMarineTripStart(a).code,'MARINE_DISPATCH_REQUIRED');
  const b=initial();b.cargoReadiness.reservationActive=false;
  assert.equal(evaluateMarineTripStart(b).code,'STOCK_NOT_RESERVED');
  const c=initial();c.operationalReadiness.valid=false;
  assert.equal(evaluateMarineTripStart(c).code,'OPERATIONAL_NOT_READY');
});
test('Land dispatch allows parallel trips with distinct trucks and drivers, no vessel',async()=>{
  const {evaluateLandTripStart}=await import('../server/v1/dispatch-policy.mjs');
  const d={id:'land-1',mode:'LAND',voyage_id:null,status:'ACTIVE'};
  const a={dispatch:d,trip:{id:'l1',dispatch_id:d.id,status:'QUEUED'},
    resourceReadiness:{truckAvailable:true,driverAvailable:true},cargoReadiness:{reservationActive:true},
    operationalReadiness:{valid:true}};
  assert.equal(evaluateLandTripStart(a).code,'ELIGIBLE');
  assert.equal(evaluateLandTripStart({...a,trip:{id:'l2',dispatch_id:d.id,status:'QUEUED'}}).code,'ELIGIBLE');
  assert.equal(evaluateLandTripStart({...a,resourceReadiness:{truckAvailable:false,driverAvailable:true}}).code,'TRUCK_BUSY');
});
