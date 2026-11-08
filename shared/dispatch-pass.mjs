const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const assigned=trip=>['dispatchId','truckId','assignedDriverUserId'].every(key=>validId(trip?.[key]));

/** Stable display reference only. Authorization and the current trip stay separate. */
export function quarryDispatchPass(trip){
 if(!assigned(trip))return null;
 return {value:JSON.stringify({v:1,type:'AIMOC_QUARRY_DISPATCH_PASS',dispatchId:trip.dispatchId,truckId:trip.truckId,assignedDriverUserId:trip.assignedDriverUserId}),isAuthorization:false,physicalScan:false,scope:'TRUCK_DISPATCH',dispatchId:trip.dispatchId,truckId:trip.truckId,assignedDriverUserId:trip.assignedDriverUserId};
}

export function canonicalDispatchPass(trip){
 if(trip?.workflow==='QUARRY_CILEGON')return quarryDispatchPass(trip);
 if(!assigned(trip)||!validId(trip?.requestId))return null;
 return {value:JSON.stringify({v:1,type:'AIMOC_DISPATCH_PASS',requestId:trip.requestId,dispatchId:trip.dispatchId,truckId:trip.truckId,assignedDriverUserId:trip.assignedDriverUserId}),isAuthorization:false,physicalScan:false,scope:'TRUCK_DISPATCH',requestId:trip.requestId,dispatchId:trip.dispatchId,truckId:trip.truckId,assignedDriverUserId:trip.assignedDriverUserId};
}

/** Reconstruct exact pre-pass bytes for cached scan intents; never parse arbitrary QR. */
export function legacyTripAssignmentQr(trip){
 if(!['requestId','dispatchId','id','truckId'].every(key=>validId(trip?.[key])))return null;
 return {value:JSON.stringify({v:1,type:'AIMOC_ASSIGNMENT_REFERENCE',requestId:trip.requestId,dispatchId:trip.dispatchId,tripId:trip.id,truckId:trip.truckId}),isAuthorization:false,physicalScan:false};
}
