import {randomUUID,createHash} from 'node:crypto';
import {DomainError} from './domain.mjs';
import {assertSerialDispatchClaims} from './automatic-dispatch.mjs';
import {quarryDispatchPass,legacyTripAssignmentQr} from '../shared/dispatch-pass.mjs';
export {quarryDispatchPass} from '../shared/dispatch-pass.mjs';

export const QUARRY_CILEGON_WORKFLOW='QUARRY_CILEGON';
const SOURCE='INTEGRATED_DEMO',EPS=0.00001;
const models={WIM_WIM:['WIM','WIM'],STATIC_WIM:['STATIC','WIM'],STATIC_STATIC:['STATIC','STATIC']};
const directions=['IN','OUT','BIDIRECTIONAL'];
const stamp=()=>new Date().toISOString(),id=prefix=>`${prefix}-${randomUUID()}`;
const fail=(message,code='QUARRY_VALIDATION',status=409)=>{throw new DomainError(message,code,status);};
const list=x=>Array.isArray(x)?x:[];
const one=(s,key,value)=>{const rows=list(s[key]).filter(x=>x.id===value);if(rows.length!==1)fail('Referensi operasi quarry tidak valid.','QUARRY_BINDING_INVALID');return rows[0];};
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1e9;
const near=(a,b)=>typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=EPS;
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
const fingerprint=x=>createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
export const isQuarryCilegon=x=>x?.workflow===QUARRY_CILEGON_WORKFLOW;

/** Default projection is read-only: opening the app never initializes data. */
export function quarryCilegonConfig(state){
  if(state.quarryCilegon)return structuredClone(state.quarryCilegon);
  return {workflow:QUARRY_CILEGON_WORKFLOW,version:1,enabled:false,defaultWorkflow:null,model:'WIM_WIM',synthetic:true,lanes:[
    {id:'lane-1',name:'Jalur 1',mode:'WIM',direction:'BIDIRECTIONAL',active:true},
    {id:'lane-2',name:'Jalur 2',mode:'WIM',direction:'BIDIRECTIONAL',active:true},
    {id:'lane-3',name:'Jalur 3 · QR',mode:'QR_ONLY',direction:'BIDIRECTIONAL',active:true}
  ]};
}

function sourceScope(actor,trip){
  if(actor?.role==='admin')return;
  if(actor?.role!=='stock'||!list(actor.crusherIds).includes(trip.crusherId))fail('Akun tidak ditugaskan pada gerbang quarry ini.','FORBIDDEN',403);
}
function record(state,actor,type,entityId,extra={}){
  const event={id:id('evt'),at:stamp(),actorId:actor.id,role:actor.role,type,entityId,source:SOURCE,synthetic:true,...extra};
  state.events.push(event);return event;
}
function assignment(state,trip,drivers){
  if(!isQuarryCilegon(trip)||trip.source!==SOURCE||trip.transferMode!=='MARINE')fail('Ritase bukan alur Quarry Cilegon.','QUARRY_WORKFLOW_REQUIRED');
  const request=one(state,'requests',trip.requestId),dispatch=one(state,'dispatches',trip.dispatchId),truck=one(state,'trucks',trip.truckId);
  if(!isQuarryCilegon(request)||!isQuarryCilegon(dispatch)||request.source!==SOURCE||dispatch.source!==SOURCE||dispatch.requestId!==request.id||request.dispatchId!==dispatch.id||list(dispatch.tripIds).filter(value=>value===trip.id).length!==1)fail('Dispatch quarry tidak sesuai.','QUARRY_BINDING_INVALID');
  if(!truck.active||!list(drivers).some(d=>d.id===trip.assignedDriverUserId&&d.role==='driver'&&d.active!==false&&d.disabled!==true))fail('Truk atau pengemudi tidak tersedia.','ASSIGNMENT_UNAVAILABLE');
  const stock=one(state,'stockpiles',trip.stockpileId),area=one(state,'crushers',trip.crusherId),product=one(state,'products',trip.skuId);
  if(!stock.active||!area.active||!product.active||stock.crusherId!==area.id||stock.skuId!==product.id||!list(request.lines).some(l=>l.skuId===product.id)||!list(dispatch.allocations).some(a=>a.stockpileId===stock.id&&a.crusherId===area.id&&a.skuId===product.id))fail('Sumber atau SKU quarry tidak sesuai.','QUARRY_BINDING_INVALID');
  if(request.jettyId!==trip.jettyId||dispatch.jettyId!==trip.jettyId||request.vesselId!==trip.vesselId||dispatch.vesselId!==trip.vesselId)fail('Tujuan kapal tidak sesuai dispatch.','QUARRY_BINDING_INVALID');
  return {request,dispatch,truck,stock};
}
const expectedQr=trip=>legacyTripAssignmentQr(trip)?.value;

/** A return QR cannot provide this proof: only destination receive creates it. */
export function quarryHasJettyReceipt(state,trip){
  if(!isQuarryCilegon(trip)||trip.transferMode!=='MARINE'||!trip.receivedAt||!trip.unloadedAt||!trip.receivedBy||!/^RCV-\d+$/.test(trip.receiptCode||''))return false;
  const accepted=list(state.events).filter(e=>e.entityId===trip.id&&e.type==='trip.receive'&&e.source===SOURCE&&e.actorId===trip.receivedBy&&['admin','jetty'].includes(e.role));
  const ledger=list(state.inventoryLedger).filter(e=>e.referenceId===trip.id&&e.type==='vessel_received'&&e.source===SOURCE&&e.actorId===trip.receivedBy&&e.stockpileId===trip.stockpileId&&near(e.tonnageT,trip.tonnageT)&&near(e.volumeM3,0));
  const outbox=list(state.erpOutbox).filter(e=>e.entityId===trip.id&&e.type==='stock_transfer_received'&&e.source===SOURCE&&e.payload?.tripId===trip.id&&e.payload?.dispatchId===trip.dispatchId&&e.payload?.vesselId===trip.vesselId&&e.payload?.receiptCode===trip.receiptCode&&near(e.payload?.tonnageT,trip.tonnageT));
  return accepted.length===1&&ledger.length===1&&outbox.length===1;
}

function measuredTare(state,trip,seen=new Set()){
  if(seen.has(trip.id)||!positive(trip.tareT)||!validId(trip.tareEventId))return null;
  seen.add(trip.id);
  const readings=list(trip.weighingEvents).filter(e=>e.id===trip.tareEventId&&e.type==='TARE'&&e.status==='ACCEPTED'&&e.source===SOURCE&&near(e.weightT,trip.tareT));
  if(readings.length!==1)return null;
  const reading=readings[0];
  if(reading.measurementKind==='DISPATCH_TARE_REUSE'){
    const original=list(state.trips).find(t=>t.id===reading.sourceTripId&&t.truckId===trip.truckId&&t.dispatchId===trip.dispatchId&&t.sequence<trip.sequence);
    if(!original||original.tareEventId!==reading.sourceTareEventId||!near(original.tareT,reading.weightT)||!quarryHasJettyReceipt(state,original)||original.status!=='returned'||!original.returnVerifiedBy)return null;
    return measuredTare(state,original,seen);
  }
  const gate=list(trip.quarryGateEvents).filter(e=>e.purpose==='ENTRY'&&e.tareEventId===reading.id&&e.truckId===trip.truckId&&['WIM','STATIC'].includes(e.laneSnapshot?.mode)&&near(e.weightT,reading.weightT));
  return gate.length===1?{tripId:trip.id,eventId:reading.id,weightT:reading.weightT}:null;
}

export function quarryReusableTare(state,trip){
  const previous=list(state.trips).filter(t=>t.id!==trip.id&&isQuarryCilegon(t)&&t.truckId===trip.truckId&&t.dispatchId===trip.dispatchId&&t.sequence<trip.sequence).sort((a,b)=>b.sequence-a.sequence)[0];
  if(!previous||previous.status!=='returned'||!previous.returnedAt||!previous.returnVerifiedBy||!quarryHasJettyReceipt(state,previous))return null;
  const verifiedReturn=list(state.events).filter(e=>e.type==='trip.return'&&e.entityId===previous.id&&e.actorId===previous.returnVerifiedBy&&['admin','stock'].includes(e.role));
  const tare=measuredTare(state,previous);
  return verifiedReturn.length===1&&tare?{...tare,previousTripId:previous.id,previousTareEventId:previous.tareEventId}:null;
}

/** A detached ERP snapshot, taken only after the exit evidence is in the draft. */
export function quarryErpFields(trip){
  if(!isQuarryCilegon(trip))return {};
  const gateEvidence=purpose=>{
    const gates=list(trip.quarryGateEvents).filter(gate=>gate.purpose===purpose);
    if(gates.length!==1)fail('Bukti gerbang quarry belum lengkap untuk korelasi ERP.','QUARRY_ERP_EVIDENCE_REQUIRED');
    const gate=gates[0];
    return {gateEventId:gate.id,configVersion:gate.configVersion,laneId:gate.laneId,direction:gate.direction,mode:gate.laneSnapshot.mode,laneSnapshot:structuredClone(gate.laneSnapshot)};
  };
  const reading=list(trip.weighingEvents).find(event=>event.id===trip.tareEventId),reused=reading?.measurementKind==='DISPATCH_TARE_REUSE';
  return {workflow:QUARRY_CILEGON_WORKFLOW,quantitySource:'SCALE_SIMULATION',physicalMeasurementVerified:false,truckId:trip.truckId,tareT:trip.tareT,grossT:trip.grossT,netT:trip.netT,densityTPerM3:trip.densityTPerM3,
    quarryEvidence:{entry:gateEvidence('ENTRY'),exit:gateEvidence('EXIT'),tare:{tareEventId:trip.tareEventId,measurementKind:reading?.measurementKind||'SCALE_SIMULATION',reused,sourceTripId:reused?reading.sourceTripId:trip.id,sourceTareEventId:reused?reading.sourceTareEventId:trip.tareEventId,originalTripId:reused?reading.originalTareTripId:trip.id,originalEventId:reused?reading.originalTareEventId:trip.tareEventId}}};
}

function serialReady(state,trip){
  assertSerialDispatchClaims(state);
  if(!Number.isSafeInteger(trip.sequence)||trip.sequence<1)fail('Urutan ritase quarry tidak valid.','QUEUE_ORDER');
  const blockers=list(state.trips).filter(other=>other.id!==trip.id&&!['returned','cancelled'].includes(other.status)&&(other.truckId===trip.truckId||other.assignedDriverUserId===trip.assignedDriverUserId));
  if(blockers.some(other=>!['queued','waiting_truck'].includes(other.status)))fail('Truk atau pengemudi masih menjalankan ritase lain.','TRUCK_OR_DRIVER_BUSY');
  if(blockers.some(other=>other.sequence<trip.sequence))fail('Selesaikan ritase sebelumnya secara serial.','QUEUE_ORDER');
}

function purposeGuard(state,trip,purpose,actor,options){
  sourceScope(actor,trip);assignment(state,trip,options.drivers);
  if(purpose==='ENTRY'){
    if(!['queued','start_pending'].includes(trip.status))fail('Ritase belum dapat masuk quarry.','INVALID_TRANSITION');
    if(list(trip.quarryGateEvents).some(e=>e.purpose==='ENTRY')||trip.tareEventId||list(trip.weighingEvents).length)fail('Bukti masuk sudah tercatat.','ALREADY_RECORDED');
    serialReady(state,trip);
  }else if(purpose==='EXIT'){
    if(trip.status!=='loading')fail('Selesaikan masuk dan mulai pemuatan sebelum timbang keluar.','INVALID_TRANSITION');
    if(!measuredTare(state,trip))fail('Tare sah wajib tersedia.','TARE_REQUIRED');
  }else if(purpose==='RETURN'){
    if(!['unloaded','returning'].includes(trip.status)||!quarryHasJettyReceipt(state,trip))fail('Penerimaan jetty wajib dikonfirmasi sebelum kembali.','JETTY_RECEIPT_REQUIRED');
  }else fail('Tujuan scan gerbang tidak valid.','QUARRY_SCAN_INVALID',400);
}

function saveConfig(state,payload,actor){
  if(actor.role!=='admin')fail('Konfigurasi gerbang memerlukan Admin.','FORBIDDEN',403);
  if(!Object.hasOwn(models,payload.model))fail('Model gerbang tidak valid.','QUARRY_CONFIG_INVALID',400);
  if(payload.enabled!==undefined&&typeof payload.enabled!=='boolean'||payload.defaultWorkflow!==undefined&&![null,QUARRY_CILEGON_WORKFLOW].includes(payload.defaultWorkflow))fail('Aktivasi alur quarry tidak valid.','QUARRY_CONFIG_INVALID',400);
  const previous=quarryCilegonConfig(state),changes=payload.lanes===undefined?[]:payload.lanes;
  if(!Array.isArray(changes)||changes.length>3||new Set(changes.map(x=>x?.id)).size!==changes.length)fail('Konfigurasi jalur tidak valid.','QUARRY_CONFIG_INVALID',400);
  if(changes.some(x=>!x||!['lane-1','lane-2','lane-3'].includes(x.id)||x.direction!==undefined&&!directions.includes(x.direction)||x.active!==undefined&&typeof x.active!=='boolean'||x.mode!==undefined))fail('Mode jalur mengikuti model; arah dan status harus valid.','QUARRY_CONFIG_INVALID',400);
  const lanes=previous.lanes.map((lane,index)=>{const change=changes.find(x=>x.id===lane.id);return {...lane,mode:index===2?'QR_ONLY':models[payload.model][index],...(change?.direction!==undefined?{direction:change.direction}:{}),...(change?.active!==undefined?{active:change.active}:{})};});
  if(!lanes.slice(0,2).some(l=>l.active))fail('Sedikitnya satu jalur timbang wajib aktif.','QUARRY_CONFIG_INVALID',400);
  if(list(state.trips).some(t=>isQuarryCilegon(t)&&t.quarryScanInProgress))fail('Selesaikan scan yang sedang berjalan sebelum mengubah jalur.','QUARRY_LANE_IN_FLIGHT');
  const enabled=payload.enabled??previous.enabled;
  const config={workflow:QUARRY_CILEGON_WORKFLOW,version:previous.version+1,enabled,defaultWorkflow:enabled?(payload.defaultWorkflow??previous.defaultWorkflow??QUARRY_CILEGON_WORKFLOW):null,model:payload.model,lanes,synthetic:true,updatedAt:stamp(),updatedBy:actor.id};
  state.quarryCilegon=config;record(state,actor,'quarry.config.saved',QUARRY_CILEGON_WORKFLOW,{configVersion:config.version,model:config.model});
  return {entityId:QUARRY_CILEGON_WORKFLOW,source:SOURCE,quarryCilegon:structuredClone(config)};
}

/** Called only inside the existing operation draft/transaction. */
export function applyQuarryCilegonAction(state,action,payload,actor,options,hooks){
  if(action==='quarry.config.save')return saveConfig(state,payload,actor);
  if(action==='quarry.request.create'){
    if(payload.transferMode&&payload.transferMode!=='MARINE')fail('Quarry Cilegon memerlukan tujuan jetty dan tongkang.','QUARRY_MARINE_REQUIRED',400);
    const result=hooks.createRequest({...payload,transferMode:'MARINE'}),request=one(state,'requests',result.entityId);
    request.workflow=QUARRY_CILEGON_WORKFLOW;
    return {...result,workflow:QUARRY_CILEGON_WORKFLOW};
  }
  if(action==='quarry.dispatch.plan'){
    const request=one(state,'requests',payload.requestId);
    if(!isQuarryCilegon(request))fail('Permintaan bukan Quarry Cilegon.','QUARRY_WORKFLOW_REQUIRED');
    const result=hooks.planRequest(payload);
    for(const d of state.dispatches.filter(x=>x.requestId===request.id))d.workflow=QUARRY_CILEGON_WORKFLOW;
    for(const t of state.trips.filter(x=>x.requestId===request.id))t.workflow=QUARRY_CILEGON_WORKFLOW;
    return {...result,workflow:QUARRY_CILEGON_WORKFLOW};
  }
  if(action!=='quarry.gate.scan')fail('Aksi quarry tidak tersedia.','ACTION_NOT_FOUND',404);
  const trip=one(state,'trips',payload.tripId);
  sourceScope(actor,trip);
  if(!validId(payload.externalEventId)||!validId(payload.truckId)||!['ENTRY','EXIT','RETURN'].includes(payload.purpose)||!['IN','OUT'].includes(payload.direction)||typeof payload.qrValue!=='string')fail('Identitas, tujuan, arah, dan QR scan wajib valid.','QUARRY_SCAN_INVALID',400);
  const digest=fingerprint({action,payload:{...payload,externalEventId:undefined}}),prior=list(state.events).find(e=>e.externalEventId===payload.externalEventId&&e.source===SOURCE);
  if(prior){
    if(prior.type!=='quarry.gate.scan'||prior.entityId!==trip.id||prior.actorId!==actor.id||prior.eventFingerprint!==digest)fail('ID event scan digunakan dengan isi berbeda.','EVENT_CONFLICT');
    return {...prior.scanResult,replayed:true};
  }
  purposeGuard(state,trip,payload.purpose,actor,options);
  if(payload.truckId!==trip.truckId||![expectedQr(trip),quarryDispatchPass(trip)?.value].includes(payload.qrValue))fail('QR atau truk tidak sesuai ritase dispatch.','QUARRY_QR_MISMATCH');
  const config=quarryCilegonConfig(state),lane=config.lanes.find(l=>l.id===payload.laneId);
  if(!lane||!lane.active||!['BIDIRECTIONAL',payload.direction].includes(lane.direction))fail('Jalur tidak aktif atau arah tidak sesuai.','QUARRY_LANE_UNAVAILABLE');
  if(payload.direction!==(payload.purpose==='EXIT'?'OUT':'IN'))fail('Arah scan tidak sesuai tindakan ritase.','QUARRY_DIRECTION_MISMATCH');
  if(lane.mode==='QR_ONLY'&&payload.weightT!==undefined)fail('Jalur QR tidak merekam bobot.','QUARRY_QR_WEIGHT_FORBIDDEN',400);
  const gate={id:id('gate'),at:stamp(),purpose:payload.purpose,direction:payload.direction,laneId:lane.id,laneSnapshot:structuredClone(lane),configVersion:config.version,truckId:trip.truckId,tripId:trip.id,dispatchId:trip.dispatchId,actorId:actor.id,synthetic:true,physicalVerified:false,externalEventId:payload.externalEventId};
  const move=(action,p={})=>hooks.moveTrip(action,{tripId:trip.id,...p},{...options,quarryGateAuthorized:true});
  if(payload.purpose==='ENTRY'){
    const reuse=lane.mode==='QR_ONLY'?quarryReusableTare(state,trip):null;
    if(lane.mode==='QR_ONLY'&&!reuse)fail('Timbang tare pertama atau konfirmasi jetty/kembali sebelumnya belum sah.','QUARRY_TARE_REUSE_UNAVAILABLE');
    if(lane.mode!=='QR_ONLY'&&!positive(payload.weightT))fail('Bobot tare wajib berasal dari jalur timbang.','TARE_REQUIRED');
    move('qr');
    if(trip.status==='queued')move('start');
    if(reuse){
      const reading={id:id('weigh'),type:'TARE',weightT:reuse.weightT,status:'ACCEPTED',at:gate.at,acceptedAt:gate.at,actorId:actor.id,source:SOURCE,synthetic:true,measurementKind:'DISPATCH_TARE_REUSE',sourceTripId:reuse.previousTripId,sourceTareEventId:reuse.previousTareEventId,originalTareTripId:reuse.tripId,originalTareEventId:reuse.eventId};
      trip.weighingEvents.push(reading);Object.assign(trip,{tareT:reading.weightT,tareEventId:reading.id,tareAt:gate.at,status:'ready_to_load',readyToLoadAt:gate.at});
      Object.assign(gate,{tareEventId:reading.id,tareReusedFromTripId:reuse.previousTripId,tareSourceEventId:reuse.eventId,quantitySource:'DISPATCH_TARE_REUSE'});
    }else{
      move('tare',{weightT:payload.weightT});
      const reading=trip.weighingEvents.find(e=>e.id===trip.tareEventId);
      Object.assign(reading,{measurementKind:'SCALE_SIMULATION',laneSnapshot:structuredClone(lane),configVersion:config.version});
      Object.assign(gate,{weightT:trip.tareT,tareEventId:trip.tareEventId,quantitySource:'SCALE_SIMULATION'});
    }
  }else if(payload.purpose==='EXIT'){
    if(lane.mode==='QR_ONLY')fail('Gross wajib melalui jalur timbang.','QUARRY_SCALE_REQUIRED');
    if(!positive(payload.weightT))fail('Bobot gross wajib dicatat.','WEIGHT_REQUIRED');
    move('gross',{weightT:payload.weightT});
    Object.assign(gate,{weightT:trip.grossT,grossEventId:trip.grossEventId,netT:trip.netT,quantitySource:'SCALE_SIMULATION'});
    const reading=trip.weighingEvents.find(e=>e.id===trip.grossEventId);
    Object.assign(reading,{measurementKind:'SCALE_SIMULATION',laneSnapshot:structuredClone(lane),configVersion:config.version});
    trip.quarryGateEvents??=[];trip.quarryGateEvents.push(gate);
    move('depart');
  }else{
    if(payload.weightT!==undefined)fail('Scan kembali tidak membuat bobot atau penerimaan material.','QUARRY_RETURN_WEIGHT_FORBIDDEN',400);
    if(trip.status==='unloaded')move('return_start');
    move('return');gate.receiptCode=trip.receiptCode;
  }
  trip.quarryGateEvents??=[];if(!trip.quarryGateEvents.some(event=>event.id===gate.id))trip.quarryGateEvents.push(gate);
  const result={entityId:trip.id,tripId:trip.id,source:SOURCE,workflow:QUARRY_CILEGON_WORKFLOW,status:trip.status,purpose:payload.purpose,gateEventId:gate.id,configVersion:config.version};
  record(state,actor,'quarry.gate.scan',trip.id,{externalEventId:payload.externalEventId,eventFingerprint:digest,gateEventId:gate.id,scanResult:result});
  return result;
}

export function quarryTripProjection(state,trip,actor,options={}){
  const guardReasons={},allowedPurposes=[],canReuseTare=Boolean(quarryReusableTare(state,trip)),config=quarryCilegonConfig(state);
  for(const purpose of ['ENTRY','EXIT','RETURN']){
    try{
      purposeGuard(state,trip,purpose,actor,options);
      const direction=purpose==='EXIT'?'OUT':'IN';
      if(!config.lanes.some(l=>l.active&&['BIDIRECTIONAL',direction].includes(l.direction)&&(purpose==='RETURN'||l.mode!=='QR_ONLY'||purpose==='ENTRY'&&canReuseTare)))fail('Tidak ada jalur aktif dengan arah yang diperlukan.','QUARRY_LANE_UNAVAILABLE');
      guardReasons[purpose]=null;allowedPurposes.push(purpose);
    }catch(error){guardReasons[purpose]=error.code||'QUARRY_UNAVAILABLE';}
  }
  return {allowedPurposes,guardReasons,canReuseTare,dispatchPass:quarryDispatchPass(trip),gateEvents:structuredClone(list(trip.quarryGateEvents))};
}
