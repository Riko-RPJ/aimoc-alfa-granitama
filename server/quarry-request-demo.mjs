import {randomUUID,createHash} from 'node:crypto';
import {DomainError} from './domain.mjs';
import {applyIntegratedAction} from './integrated-demo-domain.mjs';
import {assertSerialDispatchClaims} from './automatic-dispatch.mjs';
import {QUARRY_CILEGON_WORKFLOW,quarryCilegonConfig,quarryDispatchPass,quarryReusableTare,quarryHasJettyReceipt} from './quarry-cilegon-domain.mjs';
import {driverAssignmentQr} from './driver-assignment-qr.mjs';

const SOURCE='INTEGRATED_DEMO',EPS=0.00001,MAX_ACTIONS=64;
const stamp=()=>new Date().toISOString(),round=n=>Math.round(n*1e6)/1e6;
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=1e9&&Math.abs(value-round(value))<1e-10;
const fail=(message,code='QUARRY_DEMO_INVALID',status=409)=>{throw new DomainError(message,code,status);};
const requestFor=(state,id)=>state.requests.find(request=>request.id===id);
const runFor=(state,id)=>requestFor(state,id).demoRun;
const tripFor=(state,id)=>state.trips.find(trip=>trip.id===id);
const eventId=(runId,tripId,phase)=>'qdemo-'+createHash('sha256').update(runId+'|'+tripId+'|'+phase).digest('hex');

function payloadGuard(payload,actor){
 if(actor?.role!=='admin'||!validId(actor.id)||actor.active===false||actor.disabled===true)fail('Demo permintaan hanya dapat dijalankan Admin.','FORBIDDEN',403);
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||!validId(payload.requestId)||!['start','step','pause','resume'].includes(payload.command))fail('Permintaan dan perintah demo wajib valid.','QUARRY_DEMO_PAYLOAD_INVALID',400);
 const allowed=payload.command==='start'?['requestId','command','tareT']:payload.command==='step'?['requestId','command','runId','rounds']:['requestId','command','runId'];
 if(Object.keys(payload).some(key=>!allowed.includes(key))||payload.command!=='start'&&!validId(payload.runId)||payload.command==='step'&&payload.rounds!==undefined&&(!Number.isSafeInteger(payload.rounds)||payload.rounds<1||payload.rounds>8)||payload.command==='start'&&payload.tareT!==undefined&&!positive(payload.tareT))fail('Field atau batas langkah demo tidak valid.','QUARRY_DEMO_PAYLOAD_INVALID',400);
}

function requestGuard(state,requestId){
 for(const key of ['requests','dispatches','trips','trucks','products','crushers','stockpiles','jetties','vessels','events','inventoryLedger','erpOutbox'])if(!Array.isArray(state?.[key]))fail('Dokumen demo tidak lengkap.','STATE_INVALID');
 const requests=state.requests.filter(request=>request.id===requestId);
 if(requests.length!==1)fail('Permintaan demo tidak ditemukan.','NOT_FOUND',404);
 const request=requests[0],dispatches=state.dispatches.filter(dispatch=>dispatch.requestId===requestId),trips=state.trips.filter(trip=>trip.requestId===requestId);
 const synthetic=record=>record.source===SOURCE&&record.synthetic===true&&record.transferMode==='MARINE';
 const quarry=[request,...dispatches,...trips].every(record=>record.workflow===QUARRY_CILEGON_WORKFLOW),standard=[request,...dispatches,...trips].every(record=>!record.workflow&&!record.quarryWorkflow);
 if(!synthetic(request)||!['planned','in_progress','completed'].includes(request.status)||dispatches.length!==1||!synthetic(dispatches[0])||request.dispatchId!==dispatches[0].id||!trips.length||!quarry&&!standard||trips.some(trip=>!synthetic(trip)||trip.dispatchId!==dispatches[0].id||trip.jettyId!==request.jettyId||trip.vesselId!==request.vesselId||!positive(trip.tonnageT)||!positive(trip.volumeM3)))fail('Demo memerlukan dispatch sintetis terencana dengan workflow yang konsisten.','QUARRY_DEMO_WORKFLOW_REQUIRED');
 const dispatch=dispatches[0],ids=trips.map(trip=>trip.id);
 if(ids.some(id=>!validId(id))||new Set(ids).size!==ids.length||!Array.isArray(dispatch.tripIds)||dispatch.tripIds.length!==ids.length||new Set(dispatch.tripIds).size!==ids.length||dispatch.tripIds.some(id=>!ids.includes(id))||state.trips.some(trip=>trip.dispatchId===dispatch.id&&trip.requestId!==requestId)||!Array.isArray(request.lines)||!request.lines.length||request.lines.some(line=>!positive(line.tonnageT))||Math.abs(trips.reduce((sum,trip)=>sum+trip.tonnageT,0)-request.lines.reduce((sum,line)=>sum+line.tonnageT,0))>EPS)fail('Identitas atau kuantitas rencana demo tidak konsisten.','QUARRY_DEMO_BINDING_INVALID');
 return {request,trips,workflow:quarry?QUARRY_CILEGON_WORKFLOW:'STANDARD'};
}

function complete(state,requestId,workflow){
 const trips=state.trips.filter(trip=>trip.requestId===requestId);
 if(!trips.every(trip=>trip.status==='returned'))return false;
 if(trips.some(trip=>!trip.returnedAt||!trip.returnVerifiedBy||workflow===QUARRY_CILEGON_WORKFLOW&&!quarryHasJettyReceipt(state,trip)))fail('Ritase selesai belum memiliki bukti penerimaan dan kembali yang lengkap.','QUARRY_DEMO_COMPLETION_REVIEW');
 return true;
}

function runGuard(run){
 if(!run||!validId(run.id)||run.synthetic!==true||!['running','paused','completed'].includes(run.status)||!positive(run.tareT)||!Number.isSafeInteger(run.steps)||run.steps<0)fail('Metadata sesi demo tidak valid.','QUARRY_DEMO_RUN_INVALID');
}

function firstAssignedTrips(state,requestId){
 const first=new Map();
 const trips=state.trips.filter(trip=>trip.requestId===requestId&&trip.status!=='returned'&&trip.status!=='cancelled'&&trip.truckId).sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id));
 for(const trip of trips)if(!first.has(trip.truckId))first.set(trip.truckId,trip.id);
 return [...first.values()];
}

function laneFor(state,purpose,reuse){
 const config=quarryCilegonConfig(state),direction=purpose==='EXIT'?'OUT':'IN';
 const permitted=lane=>lane.active===true&&['BIDIRECTIONAL',direction].includes(lane.direction);
 if(purpose==='RETURN'||purpose==='ENTRY'&&reuse){
  const qr=config.lanes.find(lane=>lane.id==='lane-3'&&lane.mode==='QR_ONLY'&&permitted(lane));
  if(qr)return qr;
  if(purpose==='RETURN')fail('Lajur QR 3 harus aktif untuk arah kembali.','QUARRY_LANE_UNAVAILABLE');
 }
 const preferred=purpose==='EXIT'?'lane-2':'lane-1';
 const lanes=config.lanes.filter(lane=>permitted(lane)&&['WIM','STATIC'].includes(lane.mode)).sort((a,b)=>Number(b.id===preferred)-Number(a.id===preferred)||a.id.localeCompare(b.id));
 if(!lanes.length)fail('Tidak ada lajur timbang aktif dengan arah yang diperlukan.','QUARRY_LANE_UNAVAILABLE');
 return lanes[0];
}

function nextAction(state,requestId,tripId,workflow,options){
 const trip=tripFor(state,tripId),run=runFor(state,requestId);
 if(workflow==='STANDARD'){
  const actor=(options.drivers||[]).find(driver=>driver.id===trip.assignedDriverUserId&&driver.role==='driver'&&driver.active!==false);
  if(!actor)fail('Driver penugasan tidak aktif.','WAITING_FOR_DRIVER');
  const descriptor=driverAssignmentQr(state,actor,{tripId,drivers:options.drivers}),stage=descriptor.trip?.driverScan?.nextStage;
  if(![1,2].includes(stage))fail('Tahap scan Driver memerlukan peninjauan.','QUARRY_DEMO_TRIP_REVIEW_REQUIRED');
  return {action:'trip.driver_scan',actor,payload:{tripId,expectedStage:stage,externalEventId:eventId(run.id,tripId,'SCAN_'+stage),qrValue:descriptor.qr.value,binding:descriptor.binding,...(stage===2?{confirmations:{materialReceived:true,truckReturned:true}}:{})}};
 }
 if(['queued','start_pending'].includes(trip.status)||trip.status==='loading'||['unloaded','returning'].includes(trip.status)){
  const purpose=['queued','start_pending'].includes(trip.status)?'ENTRY':trip.status==='loading'?'EXIT':'RETURN';
  const reuse=purpose==='ENTRY'&&quarryReusableTare(state,trip),lane=laneFor(state,purpose,reuse),pass=quarryDispatchPass(trip);
  if(!pass)fail('Pasangan truk dan Driver belum tersedia.','WAITING_FOR_TRUCK');
  if(purpose==='EXIT'&&!positive(trip.tareT))fail('Tare sah wajib tersedia sebelum gross.','TARE_REQUIRED');
  return {action:'quarry.gate.scan',purpose,payload:{tripId,truckId:trip.truckId,laneId:lane.id,direction:purpose==='EXIT'?'OUT':'IN',purpose,qrValue:pass.value,externalEventId:eventId(run.id,tripId,purpose),...(purpose==='ENTRY'&&lane.mode!=='QR_ONLY'?{weightT:run.tareT}:purpose==='EXIT'?{weightT:round(trip.tareT+trip.tonnageT)}:{})}};
 }
 const phase={ready_to_load:'loading',in_transit:'arrive',arrived:'receive'}[trip.status];
 if(!phase)fail('Tahap ritase memerlukan peninjauan operator sebelum demo dilanjutkan.','QUARRY_DEMO_TRIP_REVIEW_REQUIRED');
 return {action:'trip.'+phase,payload:{tripId,externalEventId:eventId(run.id,tripId,phase)}};
}

function resultFor(state,requestId,workflow,extra={}){
 const demoRun=structuredClone(runFor(state,requestId));
 return {entityId:requestId,requestId,runId:demoRun.id,source:SOURCE,workflow,synthetic:true,demoRun,advancedActions:0,progressed:false,waiting:false,waitReason:null,executedActions:[],...extra};
}

/** One bounded transaction over the existing synthetic operation document.
 * Every movement uses the canonical domain with the real Admin actor. Receipt
 * is a separate action before the return QR; no physical/ERP ACK is invented.
 */
export function applyQuarryRequestDemo(state,payload,actor,options={}){
 payloadGuard(payload,actor);
 const draft=structuredClone(state),{request,workflow}=requestGuard(draft,payload.requestId),requestId=request.id;
 if(payload.command==='start'){
  if(request.demoRun){runGuard(request.demoRun);return resultFor(draft,requestId,workflow,{replayed:true});}
  const at=stamp(),done=complete(draft,requestId,workflow);
  request.demoRun={id:'qrun-'+randomUUID(),status:done?'completed':'running',synthetic:true,startedBy:actor.id,startedAt:at,updatedAt:at,tareT:payload.tareT??15,steps:0,waitReason:null,...(done?{completedAt:at}:{})};
  draft.updatedAt=at;Object.assign(state,draft);return resultFor(draft,requestId,workflow);
 }
 const current=runFor(draft,requestId);runGuard(current);
 if(current.id!==payload.runId)fail('ID sesi demo tidak sesuai permintaan.','QUARRY_DEMO_RUN_CONFLICT');
 if(current.status==='completed')return resultFor(draft,requestId,workflow,{replayed:true});
 if(payload.command==='pause'||payload.command==='resume'){
  const status=payload.command==='pause'?'paused':'running';
  if(current.status===status)return resultFor(draft,requestId,{replayed:true});
  const at=stamp();Object.assign(current,{status,updatedAt:at,waitReason:null,...(status==='paused'?{pausedAt:at}:{resumedAt:at})});
  draft.updatedAt=at;Object.assign(state,draft);return resultFor(draft,requestId,workflow);
 }
 if(current.status!=='running')fail('Sesi demo dijeda. Lanjutkan sebelum menjalankan langkah berikutnya.','QUARRY_DEMO_PAUSED');
 const executedActions=[];let roundsProcessed=0,limited=false;
 for(let index=0;index<(payload.rounds??1);index++){
  assertSerialDispatchClaims(draft);
  if(complete(draft,requestId,workflow))break;
  const heads=firstAssignedTrips(draft,requestId);if(!heads.length)break;
  roundsProcessed++;
  for(const tripId of heads){
   if(executedActions.length>=MAX_ACTIONS){limited=true;break;}
   const before=tripFor(draft,tripId).status,command=nextAction(draft,requestId,tripId,workflow,options);
   applyIntegratedAction(draft,command.action,command.payload,command.actor||actor,options);
   // Each canonical action replaces arrays and nested objects. Reacquire them.
   const trip=tripFor(draft,tripId),run=runFor(draft,requestId);
   if(trip.status===before)fail('Langkah demo tidak mengubah tahap ritase.','QUARRY_DEMO_TRIP_REVIEW_REQUIRED');
   run.steps++;run.lastAction=command.action;run.updatedAt=stamp();
   executedActions.push({tripId,action:command.action,...(command.purpose?{purpose:command.purpose}:{}),status:trip.status});
  }
  if(limited)break;
 }
 const run=runFor(draft,requestId),done=complete(draft,requestId,workflow),at=stamp(),waiting=!done&&firstAssignedTrips(draft,requestId).length===0;
 Object.assign(run,{status:done?'completed':'running',updatedAt:at,waitReason:waiting?'WAITING_FOR_RESOURCES':null,...(done?{completedAt:at}:{})});
 draft.updatedAt=at;Object.assign(state,draft);
 return resultFor(draft,requestId,workflow,{advancedActions:executedActions.length,progressed:executedActions.length>0,waiting,waitReason:run.waitReason,roundsProcessed,limited,executedActions});
}
