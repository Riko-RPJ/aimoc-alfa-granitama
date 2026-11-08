import {randomUUID,createHash} from 'node:crypto';
import {driverAssignmentQr} from './driver-assignment-qr.mjs';
import {assertSerialDispatchClaims,scheduleAutomaticDispatch,refreshAutomaticDispatchProgress} from './automatic-dispatch.mjs';

export const DRIVER_TWO_SCAN_MODE='TWO_SCAN_PLANNED_DEMO';
const SOURCE='INTEGRATED_DEMO',BASIS='PLANNED_DEMO_DRIVER_CONFIRMATION',EPS=0.00001;
const id=prefix=>`${prefix}-${randomUUID()}`,stamp=()=>new Date().toISOString(),round=value=>Math.round(value*1e6)/1e6;
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const validQuantity=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=1e9;
const set=value=>value!==undefined&&value!==null&&value!==''&&value!==false;
const open=trip=>!['returned','cancelled'].includes(trip.status);
const executing=trip=>open(trip)&&!['queued','waiting_truck'].includes(trip.status);
const fail=(message,code='DRIVER_SCAN_NOT_AVAILABLE',status=409)=>{throw Object.assign(new Error(message),{code,status,name:'DomainError'});};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const fingerprint=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const one=(state,key,value)=>{const rows=(state[key]||[]).filter(row=>row.id===value);if(rows.length!==1)fail('Referensi penugasan tidak valid.','DRIVER_SCAN_BINDING_INVALID');return rows[0];};
const time=value=>{
 if(typeof value!=='string')return false;
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);if(!match)return false;
 const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number),leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 return month>=1&&month<=12&&day>=1&&day<=days[month-1]&&hour<=23&&minute<=59&&second<=59&&Number.isFinite(Date.parse(value));
};
const weights=trip=>Array.isArray(trip.weighingEvents)?trip.weighingEvents:trip.weighingEvents===undefined||trip.weighingEvents===null?[]:null;
const custodyFields=['loadingAt','grossT','grossEventId','grossAt','netT','actualNetT','departedAt','arrivedAt','receivedAt','unloadedAt','receivedBy','receiptCode','returnStartedAt','returnedAt','returnVerifiedBy'];
const hasCustody= (state,trip)=>custodyFields.some(key=>set(trip[key]))||weights(trip)===null||weights(trip).some(event=>!event||event.type!=='TARE')||(state.inventoryLedger||[]).some(event=>event.referenceId===trip.id)||(state.erpOutbox||[]).some(event=>event.entityId===trip.id)||(state.events||[]).some(event=>event.entityId===trip.id&&/^trip\.(loading|gross|depart|arrive|receive|return)/.test(event.type));

function pristine(state,trip){
 return trip.status==='queued'&&!hasCustody(state,trip)&&!set(trip.startedAt)&&!set(trip.tareT)&&!set(trip.tareEventId)&&!set(trip.tareAt)&&!weights(trip).length&&!(state.events||[]).some(event=>event.entityId===trip.id&&/^trip\.(start|tare)/.test(event.type));
}
function queuedPendingTare(state,trip){
 if(trip.status!=='queued'||hasCustody(state,trip)||set(trip.startedAt)||set(trip.tareT)||set(trip.tareEventId)||set(trip.tareAt))return false;
 const readings=weights(trip);if(!readings||readings.length!==1)return false;
 const pending=readings[0];
 return validId(pending.id)&&pending.type==='TARE'&&pending.status==='PENDING'&&pending.source===SOURCE&&validQuantity(pending.weightT)&&validId(pending.actorId)&&time(pending.at);
}
function legacyReady(state,trip){
 if(trip.status!=='ready_to_load'||set(trip.driverScanMode)||!time(trip.startedAt)||!time(trip.qrScannedAt)||!validId(trip.tareEventId)||!validQuantity(trip.tareT)||hasCustody(state,trip))return false;
 const events=weights(trip).filter(event=>event.id===trip.tareEventId&&event.type==='TARE'&&event.status==='ACCEPTED'&&event.source===SOURCE&&event.weightT===trip.tareT&&validId(event.actorId));
 return events.length===1&&weights(trip).length===1;
}
function legacyReceived(state,trip){
 if(!['unloaded','returning'].includes(trip.status)||set(trip.driverScanMode)||!time(trip.startedAt)||!time(trip.qrScannedAt)||!time(trip.receivedAt)||!time(trip.unloadedAt)||!validId(trip.receivedBy)||typeof trip.receiptCode!=='string'||!/^RCV-\d+$/.test(trip.receiptCode)||set(trip.returnedAt)||set(trip.returnVerifiedBy)||trip.status==='returning'&&!time(trip.returnStartedAt))return false;
 const readings=weights(trip);if(!readings||readings.some(event=>!event))return false;
 const tare=readings.filter(event=>event.id===trip.tareEventId&&event.type==='TARE'&&event.status==='ACCEPTED'&&event.source===SOURCE&&event.weightT===trip.tareT&&validId(event.actorId)),gross=readings.filter(event=>event.id===trip.grossEventId&&event.type==='GROSS'&&event.status==='ACCEPTED'&&event.source===SOURCE&&event.weightT===trip.grossT&&event.netT===trip.netT&&validId(event.actorId));
 if(readings.length!==2||tare.length!==1||gross.length!==1||!validQuantity(trip.tareT)||!validQuantity(trip.grossT)||!validQuantity(trip.netT)||Math.abs(trip.grossT-trip.tareT-trip.tonnageT)>EPS||Math.abs(trip.netT-trip.tonnageT)>EPS)return false;
 const ledger=(state.inventoryLedger||[]).filter(event=>event.referenceId===trip.id),outbox=(state.erpOutbox||[]).filter(event=>event.entityId===trip.id);
 const same=(a,b)=>typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<=EPS;
 const departure=ledger.filter(event=>event.type==='transfer_departed'&&event.source===SOURCE&&event.stockpileId===trip.stockpileId&&same(event.volumeM3,-trip.volumeM3)&&same(event.tonnageT,-trip.tonnageT));
 const receipt=ledger.filter(event=>event.type===(trip.transferMode==='LAND'?'stock_transfer_received':'vessel_received')&&event.source===SOURCE&&event.actorId===trip.receivedBy&&event.stockpileId===(trip.transferMode==='LAND'?trip.destinationStockpileId:trip.stockpileId)&&same(event.volumeM3,trip.transferMode==='LAND'?trip.volumeM3:0)&&same(event.tonnageT,trip.tonnageT));
 const erp=type=>outbox.filter(event=>event.type===type&&event.source===SOURCE&&event.system==='oracle_netsuite'&&event.payload?.tripId===trip.id&&event.payload?.requestId===trip.requestId&&event.payload?.dispatchId===trip.dispatchId&&event.payload?.skuId===trip.skuId&&event.payload?.sourceStockpileId===trip.stockpileId&&event.payload?.destinationStockpileId===(trip.destinationStockpileId||null)&&event.payload?.jettyId===trip.jettyId&&event.payload?.vesselId===trip.vesselId&&event.payload?.destinationLocationId===trip.destinationLocationId&&(type!=='stock_transfer_received'||event.payload?.receiptCode===trip.receiptCode)&&same(event.payload?.volumeM3,trip.volumeM3)&&same(event.payload?.tonnageT,trip.tonnageT));
 return ledger.length===2&&departure.length===1&&receipt.length===1&&outbox.length===2&&erp('stock_transfer_departed').length===1&&erp('stock_transfer_received').length===1;
}
function phase(state,trip){
 if(trip.workflow==='QUARRY_CILEGON')return {phase:'QUARRY_WORKFLOW',nextStage:null,origin:'QUARRY_GATE_REQUIRED'};
 if(trip.driverScanMode===DRIVER_TWO_SCAN_MODE){
  if(trip.status==='returned'&&time(trip.driverSecondScannedAt))return {phase:'COMPLETED',nextStage:null,origin:trip.driverScanOrigin||'DRIVER_FIRST_SCAN'};
  const scan1=(state.events||[]).filter(event=>event.type==='trip.driver_scan'&&event.source===SOURCE&&event.entityId===trip.id&&event.expectedStage===1&&event.actorId===trip.assignedDriverUserId&&event.at===trip.driverFirstScannedAt);
  if(trip.status==='ready_to_load'&&time(trip.driverFirstScannedAt)&&time(trip.startedAt)&&time(trip.qrScannedAt)&&trip.driverFirstScannedBy===trip.assignedDriverUserId&&scan1.length===1&&!hasCustody(state,trip))return {phase:'READY_TO_LOAD',nextStage:2,origin:trip.driverScanOrigin||'DRIVER_FIRST_SCAN'};
  return {phase:'LEGACY_WORKFLOW',nextStage:null,origin:'REVIEW_REQUIRED'};
 }
 if(set(trip.driverScanMode))return {phase:'LEGACY_WORKFLOW',nextStage:null,origin:'REVIEW_REQUIRED'};
 if(pristine(state,trip))return {phase:'FIRST_SCAN_READY',nextStage:1,origin:'UNSTARTED_ASSIGNMENT'};
 if(queuedPendingTare(state,trip))return {phase:'FIRST_SCAN_READY',nextStage:1,origin:'QUEUED_PENDING_TARE'};
 if(legacyReady(state,trip))return {phase:'READY_TO_LOAD',nextStage:2,origin:'LEGACY_READY'};
 if(legacyReceived(state,trip))return {phase:'READY_TO_LOAD',nextStage:2,origin:trip.status==='returning'?'LEGACY_RETURNING':'LEGACY_RECEIVED'};
 if(trip.status==='waiting_truck'||!trip.truckId)return {phase:'WAITING_ASSIGNMENT',nextStage:null,origin:'UNASSIGNED'};
 return {phase:'LEGACY_WORKFLOW',nextStage:null,origin:'EXISTING_OPERATIONAL_WORKFLOW'};
}

function assertReady(state,trip,actor,options,stage){
 if(actor?.role!=='driver'||actor.active===false||actor.disabled===true||trip.assignedDriverUserId!==actor.id)fail('Hanya Driver aktif yang ditugaskan dapat mengonfirmasi scan.','DRIVER_SCAN_FORBIDDEN',403);
 if(!(options.drivers||[]).some(user=>user.id===actor.id&&user.role==='driver'&&user.active!==false&&user.disabled!==true))fail('Akun Driver tidak aktif.','DRIVER_SCAN_FORBIDDEN',403);
 const progress=phase(state,trip);
 const returnOnly=['LEGACY_RECEIVED','LEGACY_RETURNING'].includes(progress.origin);
 if(progress.nextStage!==stage)fail('Tahap scan tidak sesuai status ritase.','DRIVER_SCAN_STAGE_CONFLICT');
 if(trip.source!==SOURCE)fail('Scan hanya berlaku pada workflow demo terintegrasi.','SOURCE_MISMATCH');
 assertSerialDispatchClaims(state);
 const claims=state.trips.filter(other=>other.id!==trip.id&&open(other)&&(other.truckId===trip.truckId||other.assignedDriverUserId===trip.assignedDriverUserId));
 if(!Number.isSafeInteger(trip.sequence)||trip.sequence<1||claims.some(other=>!Number.isSafeInteger(other.sequence)||other.sequence<1))fail('Urutan ritase memerlukan pemeriksaan Admin.','DRIVER_SCAN_REVIEW_REQUIRED');
 if(claims.some(other=>executing(other)))fail('Truk atau Driver masih menjalankan ritase lain.','TRUCK_OR_DRIVER_BUSY');
 if(claims.some(other=>other.sequence<trip.sequence))fail('Selesaikan ritase sebelumnya secara serial.','QUEUE_ORDER');
 const truck=one(state,'trucks',trip.truckId),stock=one(state,'stockpiles',trip.stockpileId),product=one(state,'products',trip.skuId),crusher=one(state,'crushers',trip.crusherId);
 if(!truck.active)fail('Truk tidak aktif.','ASSIGNMENT_UNAVAILABLE');
 if(!stock.active||!product.active||!crusher.active||stock.crusherId!==crusher.id||stock.skuId!==product.id)fail('Sumber stockpile atau SKU tidak aktif/sesuai.','INACTIVE_SOURCE');
 if(!validQuantity(trip.tonnageT)||!validQuantity(trip.volumeM3)||!validQuantity(trip.densityTPerM3)||Math.abs(trip.volumeM3*trip.densityTPerM3-trip.tonnageT)>EPS)fail('Kuantitas rencana tidak konsisten.','DRIVER_SCAN_QUANTITY_INVALID');
 if(!validQuantity(truck.payloadLimitT)||!validQuantity(truck.bedM3)||trip.tonnageT>truck.payloadLimitT+EPS||trip.volumeM3>truck.bedM3+EPS)fail('Rencana muatan melebihi kapasitas truk.','TRUCK_CAPACITY');
 if(typeof stock.onHandM3!=='number'||typeof stock.reservedM3!=='number'||!Number.isFinite(stock.onHandM3)||!Number.isFinite(stock.reservedM3)||stock.onHandM3<0||stock.reservedM3<0||!returnOnly&&(stock.onHandM3+EPS<trip.volumeM3||stock.reservedM3+EPS<trip.volumeM3)||stock.reservedM3>stock.onHandM3+EPS)fail('Stok atau reservasi sumber tidak mencukupi.','STOCK_CONFLICT');
 if(!returnOnly&&(round(stock.onHandM3-trip.volumeM3)<0||round(stock.reservedM3-trip.volumeM3)<0))fail('Saldo atau reservasi sumber akan menjadi negatif.','STOCK_CONFLICT');
 let target=null,vessel=null;
 if(trip.transferMode==='LAND'){
  target=one(state,'stockpiles',trip.destinationStockpileId);const area=one(state,'crushers',trip.destinationCrusherId);
  if(!target.active||!area.active||target.crusherId!==area.id||target.skuId!==trip.skuId||trip.destinationId!==area.id||target.id===stock.id||typeof target.onHandM3!=='number'||!Number.isFinite(target.onHandM3)||target.onHandM3<0||!Number.isFinite(target.reservedM3)||target.reservedM3<0||target.reservedM3>target.onHandM3+EPS||target.onHandM3+(returnOnly?0:trip.volumeM3)>1e9)fail('Stockpile penerima tidak valid atau nonaktif.','INACTIVE_DESTINATION');
 }else if(trip.transferMode==='MARINE'){
  vessel=one(state,'vessels',trip.vesselId);const jetty=one(state,'jetties',trip.jettyId);
  if(vessel.active===false||jetty.active===false||vessel.status==='closed'||vessel.jettyId!==jetty.id)fail('Kapal atau jetty tidak tersedia.','INACTIVE_DESTINATION');
  if(stage===2&&!returnOnly&&vessel.status!=='loading')fail('Kapal belum berstatus loading.','VESSEL_NOT_LOADING');
  if(!validQuantity(vessel.payloadLimitT)||!Number.isFinite(vessel.loadedT)||vessel.loadedT<0||!Number.isFinite(vessel.reservedT)||vessel.reservedT<0||!returnOnly&&(vessel.reservedT+EPS<trip.tonnageT||vessel.loadedT+trip.tonnageT>vessel.payloadLimitT+EPS)||vessel.loadedT+vessel.reservedT>vessel.payloadLimitT+EPS)fail('Kapasitas atau reservasi kapal tidak mencukupi.','VESSEL_CAPACITY');
  if(!returnOnly&&(round(vessel.reservedT-trip.tonnageT)<0||round(vessel.loadedT+trip.tonnageT)>round(vessel.payloadLimitT)))fail('Konfirmasi melampaui kapasitas atau reservasi kapal.','VESSEL_CAPACITY');
 }else fail('Moda transfer tidak valid.','TRANSFER_MODE_INVALID');
 return {progress,truck,stock,target,vessel,returnOnly};
}

/** Pure read projection, with no allocation, initialization, or scan side effect. */
export function driverScanProgress(state,trip,actor,options={}){
 const progress=phase(state,trip);let canScan=false,reason=progress.nextStage===null?'DRIVER_SCAN_LEGACY_WORKFLOW':null;
 if(progress.phase==='COMPLETED')reason='COMPLETED';
 else if(progress.phase==='WAITING_ASSIGNMENT')reason='WAITING_FOR_TRUCK';
 else if(progress.nextStage!==null){try{assertReady(state,trip,actor,options,progress.nextStage);canScan=true;}catch(error){reason=error.code||'DRIVER_SCAN_NOT_AVAILABLE';}}
 const receivedLegacy=['LEGACY_RECEIVED','LEGACY_RETURNING'].includes(progress.origin);
 return {mode:trip.driverScanMode||null,...progress,canScan,reason,firstScannedAt:trip.driverFirstScannedAt||null,secondScannedAt:trip.driverSecondScannedAt||null,quantityBasis:receivedLegacy?'EXISTING_DEMO_WEIGHING':'PLANNED_DEMO',measurementPending:!receivedLegacy};
}

function validatePayload(payload){
 const keys=['tripId','qrValue','binding','expectedStage','externalEventId','confirmations'];
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!keys.includes(key))||!validId(payload.tripId)||!validId(payload.externalEventId)||![1,2].includes(payload.expectedStage)||typeof payload.qrValue!=='string'||payload.qrValue.length>5000||!payload.binding||typeof payload.binding!=='object'||Array.isArray(payload.binding))fail('Payload scan wajib memuat referensi, tahap, dan ID event yang valid.','DRIVER_SCAN_PAYLOAD_INVALID',400);
 if(payload.expectedStage===1&&Object.hasOwn(payload,'confirmations'))fail('Scan pertama tidak boleh mengonfirmasi penerimaan/kembali.','DRIVER_SCAN_CONFIRMATION_INVALID',400);
 if(payload.expectedStage===2&&(!payload.confirmations||typeof payload.confirmations!=='object'||Array.isArray(payload.confirmations)||Object.keys(payload.confirmations).sort().join(',')!=='materialReceived,truckReturned'||payload.confirmations.materialReceived!==true||payload.confirmations.truckReturned!==true))fail('Konfirmasikan material diterima dan truk sudah kembali.','DRIVER_SCAN_CONFIRMATION_REQUIRED',400);
}
function movement(state,actor,type,stockpileId,volumeM3,tonnageT,trip,at){
 state.inventoryLedger.push({id:id('led'),at,actorId:actor.id,type,stockpileId,volumeM3:round(volumeM3),tonnageT:round(tonnageT),referenceId:trip.id,source:SOURCE,synthetic:true,quantitySource:BASIS,measurementPending:true,confirmationSource:'DRIVER_TWO_SCAN'});
}
function outbox(state,type,trip,at){
 const location=Object.fromEntries(['destination','destinationLocationId','destinationLocationCode','destinationLocationName','destinationLocationSnapshot','legacyDestinationUnmapped'].filter(key=>trip[key]!==undefined).map(key=>[key,structuredClone(trip[key])]));
 state.erpOutbox.push({id:id('erp'),createdAt:at,type,entityId:trip.id,status:'awaiting_configuration',system:'oracle_netsuite',source:SOURCE,synthetic:true,payload:{tripId:trip.id,tripCode:trip.code,requestId:trip.requestId,dispatchId:trip.dispatchId,skuId:trip.skuId,volumeM3:trip.volumeM3,tonnageT:trip.tonnageT,sourceStockpileId:trip.stockpileId,destinationStockpileId:trip.destinationStockpileId||null,jettyId:trip.jettyId,vesselId:trip.vesselId,receiptCode:trip.receiptCode,quantitySource:BASIS,measurementPending:true,confirmationSource:'DRIVER_TWO_SCAN',...location}});
}

/** Mutates an authorized operation draft only; the caller commits atomically under its row lock. */
export function applyDriverScan(state,payload,actor,options={}){
 validatePayload(payload);
 const trip=one(state,'trips',payload.tripId);
 if(trip.workflow==='QUARRY_CILEGON')fail('Gunakan alur gerbang dan penerimaan jetty Quarry Cilegon.','QUARRY_GATE_REQUIRED');
 if(actor?.role!=='driver'||trip.assignedDriverUserId!==actor.id||actor.active===false||actor.disabled===true||!(options.drivers||[]).some(user=>user.id===actor.id&&user.role==='driver'&&user.active!==false&&user.disabled!==true))fail('Hanya Driver aktif yang ditugaskan dapat mengonfirmasi scan.','DRIVER_SCAN_FORBIDDEN',403);
 const descriptor=driverAssignmentQr(state,actor,{tripId:trip.id,drivers:options.drivers});
 if(![descriptor.qr.value,descriptor.legacyQr?.value].includes(payload.qrValue)||fingerprint(payload.binding)!==fingerprint(descriptor.binding))fail('QR atau penugasan telah berubah. Muat ulang QR ritase.','DRIVER_SCAN_BINDING_INVALID');
 const eventFingerprint=fingerprint({action:'trip.driver_scan',payload:{...payload,externalEventId:undefined}});
 const prior=state.events.find(event=>event.source===SOURCE&&event.externalEventId===payload.externalEventId);
 if(prior){if(prior.type!=='trip.driver_scan'||prior.entityId!==trip.id||prior.actorId!==actor.id||prior.eventFingerprint!==eventFingerprint)fail('ID event scan telah digunakan dengan isi berbeda.','EVENT_CONFLICT');return {...prior.scanResult,replayed:true};}
 const {progress,stock,target,vessel,returnOnly}=assertReady(state,trip,actor,options,payload.expectedStage),at=stamp(),eventId=id('evt');
 if(payload.expectedStage===1){
  Object.assign(trip,{driverScanMode:DRIVER_TWO_SCAN_MODE,driverScanOrigin:progress.origin==='QUEUED_PENDING_TARE'?'QUEUED_PENDING_TARE':'DRIVER_FIRST_SCAN',driverFirstScannedAt:at,driverFirstScannedBy:actor.id,status:'ready_to_load',startedAt:at,readyToLoadAt:at,quantitySource:BASIS,measurementPending:true});
  if(progress.origin==='QUEUED_PENDING_TARE'){
   const pending=weights(trip)[0];pending.status='ACCEPTED';pending.acceptedAt=at;
   Object.assign(trip,{tareT:pending.weightT,tareEventId:pending.id,tareAt:at});
  }
  if(!trip.qrScannedAt)Object.assign(trip,{qrScannedAt:at,qrScannedBy:actor.id,qrSource:'DRIVER_TWO_SCAN_CONFIRMATION',qrEventId:eventId,qrPhysicalVerified:false});
 }else if(returnOnly){
  Object.assign(trip,{driverScanMode:DRIVER_TWO_SCAN_MODE,driverScanOrigin:progress.origin,driverScanAdoptedAt:at,driverSecondScannedAt:at,driverSecondScannedBy:actor.id,status:'returned',returnedAt:at,returnVerifiedBy:actor.id,returnVerificationSource:'DRIVER_CONFIRMED_DEMO',driverConfirmations:{materialReceived:true,truckReturned:true}});
 }else{
  if(progress.origin==='LEGACY_READY')Object.assign(trip,{driverScanMode:DRIVER_TWO_SCAN_MODE,driverScanOrigin:'LEGACY_READY',driverScanAdoptedAt:at});
  const receiptMax=state.trips.reduce((max,row)=>Math.max(max,Number(/^RCV-(\d+)$/.exec(row.receiptCode||'')?.[1]||0)),0);
  if(!Number.isSafeInteger(receiptMax)||receiptMax>=Number.MAX_SAFE_INTEGER)fail('Nomor penerimaan memerlukan pemeriksaan Admin.','DRIVER_SCAN_REVIEW_REQUIRED');
  Object.assign(trip,{driverSecondScannedAt:at,driverSecondScannedBy:actor.id,status:'returned',receivedAt:at,unloadedAt:at,receivedBy:actor.id,receiptCode:`RCV-${String(receiptMax+1).padStart(5,'0')}`,receiptSource:'DRIVER_CONFIRMED_DEMO',returnedAt:at,returnVerifiedBy:actor.id,returnVerificationSource:'DRIVER_CONFIRMED_DEMO',quantitySource:BASIS,measurementPending:true,driverConfirmations:{materialReceived:true,truckReturned:true}});
  stock.onHandM3=round(stock.onHandM3-trip.volumeM3);stock.reservedM3=round(Math.max(0,stock.reservedM3-trip.volumeM3));
  movement(state,actor,'transfer_departed',stock.id,-trip.volumeM3,-trip.tonnageT,trip,at);
  if(target){target.onHandM3=round(target.onHandM3+trip.volumeM3);movement(state,actor,'stock_transfer_received',target.id,trip.volumeM3,trip.tonnageT,trip,at);}
  else{vessel.loadedT=round(vessel.loadedT+trip.tonnageT);vessel.reservedT=round(Math.max(0,vessel.reservedT-trip.tonnageT));movement(state,actor,'vessel_received',stock.id,0,trip.tonnageT,trip,at);}
  outbox(state,'stock_transfer_departed',trip,at);outbox(state,'stock_transfer_received',trip,at);
 }
 const result={entityId:trip.id,tripId:trip.id,source:SOURCE,status:trip.status,displayStatus:trip.status==='returned'?'completed':trip.status,acceptedStage:payload.expectedStage,driverScanMode:DRIVER_TWO_SCAN_MODE};
 state.events.push({id:eventId,at,actorId:actor.id,role:actor.role,type:'trip.driver_scan',entityId:trip.id,externalEventId:payload.externalEventId,eventFingerprint,expectedStage:payload.expectedStage,source:SOURCE,synthetic:true,physicalScanVerified:false,quantitySource:returnOnly?trip.quantitySource||SOURCE:BASIS,measurementPending:!returnOnly,confirmations:payload.confirmations?{...payload.confirmations}:null,scanResult:result});
 if(payload.expectedStage===2)scheduleAutomaticDispatch(state,options,actor);
 refreshAutomaticDispatchProgress(state);
 return result;
}
