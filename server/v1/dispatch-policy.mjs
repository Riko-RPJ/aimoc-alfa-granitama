/**
 * Executable target-domain policy (side-effect-free).
 *
 * Use from a future PostgreSQL transaction only after dispatch, trip, receipt
 * and exclusive resource rows have been locked. Merely checking this policy
 * in a GET request cannot authorize a command or release a truck.
 */
const BLOCK=(code,message)=>Object.freeze({eligible:false,code,message});
const ALLOW=Object.freeze({eligible:true,code:'ELIGIBLE',message:'Permitted subject to transactional locks'});
const sequenced = t=>Number.isSafeInteger(t?.sequence_no)&&t.sequence_no>0;
const unloadingVerified=t=>
  Boolean(t?.unloaded_verified_at) &&
  Boolean(t?.final_unload_settlement?.verified_at) &&
  t?.final_unload_settlement?.status==='VERIFIED' &&
  t?.final_unload_settlement?.trip_id===t.id;

/**
 * @param {{dispatch: object, currentTrip: object, trips: object[], sequenceGate: object,
 *   resourceReadiness: object, cargoReadiness: object, operationalReadiness: object}} x
 */
export function evaluateMarineTripStart(x={}){
  const {dispatch,currentTrip,sequenceGate,resourceReadiness,cargoReadiness,operationalReadiness}=x;
  const trips=Array.isArray(x.trips)?x.trips:[];
  if(!dispatch||dispatch.mode!=='MARINE'||!dispatch.voyage_id)
    return BLOCK('MARINE_DISPATCH_REQUIRED','Valid marine dispatch and voyage required');
  if(!['READY','ACTIVE'].includes(dispatch.status))return BLOCK('DISPATCH_NOT_READY','Dispatch is not executable');
  if(dispatch.on_hold===true)return BLOCK('DISPATCH_ON_HOLD','Dispatch is on hold');
  if(!currentTrip||currentTrip.dispatch_id!==dispatch.id||!sequenced(currentTrip))
    return BLOCK('INVALID_TRIP_SEQUENCE','Trip must belong to this dispatch');
  if(currentTrip.status!=='QUEUED')return BLOCK('INVALID_TRIP_STATE','Only queued trips may start');
  if(!sequenceGate||sequenceGate.dispatch_id!==dispatch.id)
    return BLOCK('SEQUENCE_GATE_MISSING','Sequence gate record is required');
  if(sequenceGate.active_trip_id)return BLOCK('SEQUENCE_GATE_BUSY','Another pre-unload trip holds the gate');
  if(trips.some(t=>t.dispatch_id===dispatch.id&&t.id!==currentTrip.id&&t.sequence_no===currentTrip.sequence_no))
    return BLOCK('DUPLICATE_SEQUENCE','Trip sequence must be unique');
  const predecessor=trips.find(t=>t.dispatch_id===dispatch.id&&t.sequence_no===currentTrip.sequence_no-1);
  if(currentTrip.sequence_no>1 && !predecessor)
    return BLOCK('PREVIOUS_TRIP_MISSING','Prior trip not found; no implicit sequence skip');
  if(currentTrip.sequence_no===1 && sequenceGate.last_released_sequence_no!==0)
    return BLOCK('SEQUENCE_OUT_OF_SYNC','Initial sequence requires fresh gate');
  if(currentTrip.sequence_no>1){
    if(!unloadingVerified(predecessor))
      return BLOCK('PREVIOUS_TRIP_NOT_UNLOADED','Prior trip lacks independently verified final unloading');
    if(predecessor?.hold?.blocking)
      return BLOCK('PREVIOUS_TRIP_ON_HOLD','Prior trip has unresolved blocking exception');
    if(sequenceGate.last_released_sequence_no!==predecessor.sequence_no)
      return BLOCK('SEQUENCE_OUT_OF_SYNC','Persisted gate has not released previous sequence');
  }
  if(!resourceReadiness?.truckAvailable)return BLOCK('TRUCK_BUSY','Truck unavailable or occupied');
  if(!resourceReadiness?.driverAvailable)return BLOCK('DRIVER_BUSY','Driver unavailable or occupied');
  if(!cargoReadiness?.reservationActive)return BLOCK('STOCK_NOT_RESERVED','Stock reservation is missing');
  if(!operationalReadiness?.valid)return BLOCK('OPERATIONAL_NOT_READY','Blocking operational checks');
  return ALLOW;
}

/** Check independent settlement (not a Driver's self-report). */
export function evaluateMarineUnloadRelease({trip,receipt,settlement,receiverAuthorized,blockingException}={}){
  if(!trip||trip.status!=='ARRIVED')return BLOCK('TRIP_NOT_ARRIVED','Trip must arrive first');
  if(!receipt||receipt.trip_id!==trip.id||receipt.status!=='VERIFIED')
    return BLOCK('RECEIPT_NOT_VERIFIED','Verified receipt required');
  if(!receiverAuthorized)return BLOCK('RECEIVER_NOT_AUTHORIZED','Independent receiving authority required');
  if(!settlement||settlement.trip_id!==trip.id||settlement.status!=='VERIFIED'||!settlement.verified_at)
    return BLOCK('UNLOAD_NOT_FINAL','Final unload settlement required');
  if(blockingException)return BLOCK('UNLOAD_ON_HOLD','Blocking discrepancy requires resolution');
  return ALLOW;
}

/** Driver checklist/unloading must not release truck occupancy. */
export function evaluateTruckReturnRelease({trip,verification,resourceClaim,vehicleReady}={}){
  if(!trip||!['RETURNING','UNLOADED_VERIFIED'].includes(trip.status))
    return BLOCK('TRIP_NOT_RETURNING','Cargo must have been unloaded');
  if(!trip.unloaded_verified_at)return BLOCK('UNLOAD_NOT_VERIFIED','Unloading proof required');
  if(!verification||verification.trip_id!==trip.id||!verification.verified_at||verification.status!=='VERIFIED')
    return BLOCK('RETURN_NOT_VERIFIED','Independent return proof required');
  if(!resourceClaim||resourceClaim.trip_id!==trip.id)return BLOCK('CLAIM_NOT_FOUND','Resource claim mismatch');
  if(!vehicleReady)return BLOCK('VEHICLE_NOT_READY','Vehicle cannot be reused');
  return ALLOW;
}

/**
 * Land delivery batches do not use the marine sequence gate.
 * Separate truck/driver resources may execute physical trips concurrently.
 */
export function evaluateLandTripStart({dispatch,trip,resourceReadiness,cargoReadiness,operationalReadiness}={}){
  if(!dispatch||dispatch.mode!=='LAND'||dispatch.voyage_id!==null)
    return BLOCK('LAND_DISPATCH_REQUIRED','Land dispatch must have no voyage');
  if(!['READY','ACTIVE'].includes(dispatch.status))
    return BLOCK('DISPATCH_NOT_READY','Dispatch not executable');
  if(!trip||trip.dispatch_id!==dispatch.id||trip.status!=='QUEUED')
    return BLOCK('INVALID_TRIP_STATE','Only queued trips from this batch can start');
  if(!resourceReadiness?.truckAvailable)return BLOCK('TRUCK_BUSY','Truck already occupied');
  if(!resourceReadiness?.driverAvailable)return BLOCK('DRIVER_BUSY','Driver already occupied');
  if(!cargoReadiness?.reservationActive)return BLOCK('STOCK_NOT_RESERVED','Stock reservation required');
  if(!operationalReadiness?.valid)return BLOCK('OPERATIONAL_NOT_READY','Pre-start checks failed');
  return ALLOW;
}
