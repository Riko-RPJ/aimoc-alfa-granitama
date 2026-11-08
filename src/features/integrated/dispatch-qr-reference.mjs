const fields=Object.freeze({AIMOC_ASSIGNMENT_REFERENCE:['v','type','requestId','dispatchId','tripId','truckId'],AIMOC_DISPATCH_PASS:['v','type','requestId','dispatchId','truckId','assignedDriverUserId'],AIMOC_QUARRY_DISPATCH_PASS:['v','type','dispatchId','truckId','assignedDriverUserId']});
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
export function parseAssignmentReference(value){
 if(typeof value!=='string')return null;let reference;try{reference=JSON.parse(value);}catch{return null;}
 if(!reference||Array.isArray(reference)||typeof reference!=='object'||typeof reference.type!=='string'||!Object.hasOwn(fields,reference.type))return null;
 const keys=fields[reference.type];return Object.keys(reference).length===keys.length&&keys.every(key=>Object.hasOwn(reference,key))&&reference.v===1&&keys.slice(2).every(key=>identifier(reference[key]))?reference:null;
}
export function assignmentReferenceMatchesTrip(value,trip){
 const reference=parseAssignmentReference(value);if(!reference||!trip)return false;
 const keys=reference.type==='AIMOC_ASSIGNMENT_REFERENCE'?['requestId','dispatchId','tripId','truckId']:reference.type==='AIMOC_DISPATCH_PASS'?['requestId','dispatchId','truckId','assignedDriverUserId']:['dispatchId','truckId','assignedDriverUserId'];
 return keys.every(key=>reference[key]===(key==='tripId'?trip.id||trip.tripId:trip[key]));
}
