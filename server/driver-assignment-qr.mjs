import {integratedView} from './integrated-demo-domain.mjs';
import {requestDetail} from './request-detail.mjs';
import {effectiveFleetDrivers} from './fleet-simulation.mjs';

const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const fail=(message,code,status)=>{throw Object.assign(new Error(message),{code,status});};
const invalid=()=>fail('Referensi penugasan tidak sesuai data kanonis. Hubungi Admin.','ASSIGNMENT_QR_BINDING_INVALID',409);
const unavailable=()=>fail('QR belum tersedia untuk penugasan truk dan pengemudi ini.','ASSIGNMENT_QR_NOT_AVAILABLE',409);
const one=(state,key,id)=>{
 if(!validId(id))return null;
 const rows=(state[key]||[]).filter(row=>row.id===id);return rows.length===1?rows[0]:null;
};
const header=record=>Object.fromEntries(['id','code','requestId','status','transferMode','destination','destinationLocationId','destinationLocationCode','destinationLocationName'].filter(key=>record[key]!==undefined).map(key=>[key,structuredClone(record[key])]));
const waiting=new Set(['waiting_truck','waiting_driver','waiting_assignment','awaiting_assignment','unassigned']);

/**
 * Assignment-reference display only. Scope precedes binding validation, and the
 * QR descriptor is copied from requestDetail so Admin and Driver see identical
 * QR bytes. This function never allocates, scans, signs in, or moves inventory.
 */
export function driverAssignmentQr(state,actor,{tripId,drivers=[]}={}){
 if(!validId(tripId))fail('ID ritase tidak valid.','INVALID_TRIP_ID',400);
 if(!actor?.id||!['admin','stock','jetty','driver'].includes(actor.role)||actor.active===false)fail('Akun tidak berwenang.','FORBIDDEN',403);
 const catalog=effectiveFleetDrivers(state,drivers);
 const view=integratedView(state,actor,{drivers:catalog});
 const visible=view.trips.find(trip=>trip.id===tripId);
 const trip=one(state,'trips',tripId);
 if(!visible||!trip||trip.source!=='INTEGRATED_DEMO'||actor.role==='driver'&&trip.assignedDriverUserId!==actor.id)fail('Ritase tidak ditemukan.','NOT_FOUND',404);

 const request=one(state,'requests',trip.requestId),dispatch=one(state,'dispatches',trip.dispatchId);
 if(!request||!dispatch||request.source!=='INTEGRATED_DEMO'||dispatch.source!=='INTEGRATED_DEMO'||dispatch.requestId!==request.id||request.dispatchId!==dispatch.id||!Array.isArray(dispatch.tripIds)||dispatch.tripIds.filter(id=>id===trip.id).length!==1)invalid();
 const stock=one(state,'stockpiles',trip.stockpileId),crusher=one(state,'crushers',trip.crusherId),product=one(state,'products',trip.skuId);
 if(!stock||!crusher||!product||stock.crusherId!==crusher.id||stock.skuId!==product.id||!Array.isArray(request.lines)||!request.lines.some(line=>line.skuId===product.id)||!Array.isArray(dispatch.allocations)||!dispatch.allocations.some(allocation=>allocation.stockpileId===stock.id&&allocation.crusherId===crusher.id&&allocation.skuId===product.id))invalid();
 const mode=request.transferMode||'MARINE';
 if(trip.transferMode!==mode||dispatch.transferMode!==mode)invalid();
 if(mode==='MARINE'){
  const jetty=one(state,'jetties',trip.jettyId),vessel=one(state,'vessels',trip.vesselId);
  if(!jetty||!vessel||vessel.jettyId!==jetty.id||request.jettyId!==jetty.id||dispatch.jettyId!==jetty.id||request.vesselId!==vessel.id||dispatch.vesselId!==vessel.id)invalid();
 }else if(mode==='LAND'){
  const receiving=one(state,'stockpiles',trip.destinationStockpileId),receivingCrusher=one(state,'crushers',trip.destinationCrusherId);
  if(!receiving||!receivingCrusher||receiving.skuId!==product.id||receiving.crusherId!==receivingCrusher.id||trip.destinationId!==receivingCrusher.id||request.destinationId!==receivingCrusher.id||dispatch.destinationId!==receivingCrusher.id)invalid();
 }else invalid();

 if(waiting.has(String(trip.status).toLowerCase()))unavailable();
 const truck=one(state,'trucks',trip.truckId);
 if(!truck||!validId(trip.assignedDriverUserId))unavailable();
 const historical=['returned','completed','cancelled'].includes(String(trip.status).toLowerCase());
 const assignedDriver=catalog.find(user=>user.id===trip.assignedDriverUserId&&user.role==='driver'&&user.active!==false&&user.disabled!==true);
 if(!historical&&(!truck.active||!assignedDriver||!stock.active||!crusher.active||!product.active))unavailable();

 const detail=requestDetail(state,actor,{requestId:request.id,drivers:catalog});
 const projected=detail.trips.find(row=>row.id===trip.id),projectedDispatch=detail.dispatches.find(row=>row.id===dispatch.id);
 if(!projected||!projectedDispatch||!projected.qr||projected.qr.isAuthorization!==false||projected.qr.physicalScan!==false)unavailable();
 const binding={requestId:request.id,dispatchId:dispatch.id,tripId:trip.id,truckId:truck.id,sourceStockpileId:stock.id,sourceCrusherId:crusher.id,skuId:product.id,assignedDriverUserId:trip.assignedDriverUserId};
 const tripIds=dispatch.tripIds.filter(id=>state.trips.some(row=>row.id===id&&row.truckId===truck.id&&row.assignedDriverUserId===trip.assignedDriverUserId));
 // Scan details are disclosed only after a matching committed backend event.
 // Timestamp fields alone are insufficient: they can be stale or imported from legacy workflows.
 const verifiedScanEvents=[1,2].map(stage=>(state.events||[]).filter(event=>
  event.type==='trip.driver_scan'&&event.source==='INTEGRATED_DEMO'&&event.entityId===trip.id&&
  event.actorId===trip.assignedDriverUserId&&event.expectedStage===stage&&
  event.at===(stage===1?trip.driverFirstScannedAt:trip.driverSecondScannedAt)&&
  event.physicalScanVerified===false&&event.synthetic===true));
 const scanNumber=verifiedScanEvents[1].length===1?2:verifiedScanEvents[0].length===1?1:0;
 const quantityEvidence=Number.isFinite(trip.actualNetT)&&trip.actualNetT>0&&trip.grossEventId?'VERIFIED_WEIGHING':'PLANNED_DEMO';
 const actualT=quantityEvidence==='VERIFIED_WEIGHING'?trip.actualNetT:null;
 const actualM3=actualT!==null&&Number.isFinite(trip.densityTPerM3)&&trip.densityTPerM3>0?actualT/trip.densityTPerM3:null;
 const loadDetails=scanNumber===0?null:{
  scanNumber,tripNumber:tripIds.indexOf(trip.id)+1,tripCount:tripIds.length,
  truckCode:truck.code,plate:truck.plate,
  driverName:assignedDriver?.displayName||assignedDriver?.name||assignedDriver?.username||projected.assignedDriver?.displayName||projected.assignedDriver?.name||projected.assignedDriver?.username||null,
  materialIndex:product.sizeMm,materialCode:product.code,materialName:product.name,
  stockpileCode:stock.code,crusherCode:crusher.code,
  tareT:Number.isFinite(trip.tareT)?trip.tareT:null,
  plannedTonnageT:trip.tonnageT,plannedVolumeM3:trip.volumeM3,
  actualTonnageT:actualT,actualVolumeM3:actualM3,
  quantityBasis:quantityEvidence
 };
 return {source:'INTEGRATED_DEMO',request:header(detail.request),dispatch:header(projectedDispatch),trip:{...projected,driverScan:visible.driverScan,driverScanMode:visible.driverScanMode||null,displayStatus:visible.displayStatus},qr:projected.qr,qrScope:{dispatchId:dispatch.id,truckId:truck.id,assignedDriverUserId:trip.assignedDriverUserId},binding,loadDetails,historical,canOpenTask:false,canOpenTaskDeprecated:true,qrReferenceOnly:true,scanRecorded:false,authorizationGranted:false};
}
