const waiting=new Set(['waiting_truck','waiting_driver','waiting_assignment','awaiting_assignment','unassigned']);
const terminal=new Set(['returned','completed','cancelled']);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const same=(left,right,keys)=>keys.every(key=>left?.[key]===right?.[key]);

/** Accept only the exact server-issued reference for this driver's current row. */
export function selectDriverAssignmentQr(data,expectedTrip,driverUserId){
 const trip=data?.trip,binding=data?.binding,qr=data?.qr;
 if(data?.source!=='INTEGRATED_DEMO'||data.qrReferenceOnly!==true||data.scanRecorded!==false||data.authorizationGranted!==false||!id(driverUserId)||!trip||!binding||!qr||waiting.has(trip.status)||waiting.has(expectedTrip?.status))return null;
 const expected={requestId:expectedTrip?.requestId,dispatchId:expectedTrip?.dispatchId,tripId:expectedTrip?.id,truckId:expectedTrip?.truckId,assignedDriverUserId:expectedTrip?.assignedDriverUserId};
 if(!Object.values(expected).every(id)||expected.assignedDriverUserId!==driverUserId||!same(binding,expected,Object.keys(expected)))return null;
 if(trip.id!==binding.tripId||trip.requestId!==binding.requestId||trip.dispatchId!==binding.dispatchId||trip.truckId!==binding.truckId||trip.assignedDriverUserId!==driverUserId||trip.assignedDriver?.id!==driverUserId||data.request?.id!==binding.requestId||data.dispatch?.id!==binding.dispatchId||data.dispatch?.requestId!==binding.requestId)return null;
 if(!id(binding.sourceStockpileId)||!id(binding.sourceCrusherId)||!id(binding.skuId)||binding.skuId!==trip.skuId)return null;
 const rowSource={sourceStockpileId:expectedTrip.sourceStockpileId||expectedTrip.stockpileId,sourceCrusherId:expectedTrip.sourceCrusherId||expectedTrip.crusherId,skuId:expectedTrip.skuId};
 if(Object.entries(rowSource).some(([key,value])=>value!=null&&binding[key]!==value)||trip.sourceStockpileId&&binding.sourceStockpileId!==trip.sourceStockpileId||trip.sourceCrusherId&&binding.sourceCrusherId!==trip.sourceCrusherId)return null;
 if(typeof qr.value!=='string'||qr.value!==trip.qr?.value||qr.isAuthorization!==false||qr.physicalScan!==false||trip.qr?.isAuthorization!==false||trip.qr?.physicalScan!==false)return null;
 try{const reference=JSON.parse(qr.value),keys=['v','type','requestId','dispatchId','tripId','truckId'];if(!reference||Object.keys(reference).length!==keys.length||!keys.every(key=>Object.hasOwn(reference,key))||reference.v!==1||reference.type!=='AIMOC_ASSIGNMENT_REFERENCE'||!same(reference,binding,['requestId','dispatchId','tripId','truckId']))return null;}catch{return null;}
 const historical=data.historical===true||qr.historical===true||terminal.has(trip.status);
 return {trip,request:data.request,dispatch:data.dispatch,binding,qr,historical,driverScan:trip.driverScan||null};
}

/** The server supplies scan eligibility; displaying a QR alone grants no action. */
export function driverScanStage(assignment){
 const scan=assignment?.driverScan;
 if(assignment?.historical||scan?.canScan!==true)return null;
 if(scan.nextStage===1&&scan.phase==='FIRST_SCAN_READY')return 1;
 if(scan.nextStage===2&&scan.phase==='READY_TO_LOAD')return 2;
 return null;
}

/** Freeze one explicit intent for stable retry, including receipt/return on scan 2. */
export function buildDriverScanIntent(assignment,expectedStage,externalEventId){
 if(driverScanStage(assignment)!==expectedStage||!id(externalEventId)||typeof assignment?.qr?.value!=='string')return null;
 const binding=assignment.binding;
 if(!binding||!['requestId','dispatchId','tripId','truckId','assignedDriverUserId','sourceStockpileId','sourceCrusherId','skuId'].every(key=>id(binding[key])))return null;
 return {tripId:binding.tripId,qrValue:assignment.qr.value,binding:{...binding},expectedStage,externalEventId,...(expectedStage===2?{confirmations:{materialReceived:true,truckReturned:true}}:{})};
}

export function driverAssignmentIdentity(trip,driverUserId){
 return [driverUserId,trip?.requestId,trip?.dispatchId,trip?.id,trip?.truckId,trip?.assignedDriverUserId,trip?.sourceStockpileId||trip?.stockpileId,trip?.sourceCrusherId||trip?.crusherId,trip?.skuId].map(value=>String(value||'')).join(':');
}
