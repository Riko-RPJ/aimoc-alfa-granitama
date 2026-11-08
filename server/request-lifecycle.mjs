import {DomainError} from './domain.mjs';

const list=value=>Array.isArray(value)?value:[];
const present=value=>value!==undefined&&value!==null&&value!=='';
const reasons={
 FORBIDDEN:['Aksi ini hanya tersedia untuk Admin.','This action is available only to Admin.'],
 REQUEST_SOURCE_MISMATCH:['Permintaan tidak mendukung perubahan pada alur ini.','This request does not support changes in this workflow.'],
 REQUEST_CANCELLED:['Permintaan sudah dibatalkan.','The request has already been cancelled.'],
 REQUEST_ALREADY_PLANNED:['Permintaan sudah direncanakan dispatch dan tidak dapat diubah atau dibatalkan.','Dispatch has already been planned; this request cannot be edited or cancelled.'],
 REQUEST_NOT_EDITABLE:['Permintaan tidak lagi menunggu perencanaan dispatch.','The request is no longer awaiting dispatch planning.'],
 REQUEST_STATE_REVIEW:['Data versi permintaan perlu ditinjau sebelum perubahan.','The request version data must be reviewed before making changes.']
};

export function requestRevision(request){
 if(request?.requestRevision===undefined)return 1;
 return Number.isSafeInteger(request.requestRevision)&&request.requestRevision>=1?request.requestRevision:null;
}

export function requestLifecycle(state,request,actor){
 let code=null;
 const events=list(state.events).filter(event=>event.entityId===request?.id);
 if(actor?.role!=='admin'||actor.active===false||actor.disabled===true)code='FORBIDDEN';
 else if(request?.source!=='INTEGRATED_DEMO')code='REQUEST_SOURCE_MISMATCH';
 else if(request.status==='cancelled'||present(request.cancelledAt)||present(request.cancelledBy)||events.some(event=>event.type==='request.cancelled'))code='REQUEST_CANCELLED';
 else if(present(request.plannedAt)||present(request.plannedBy)||present(request.dispatchId)||list(request.dispatchIds).length||list(request.tripIds).length||present(request.demoRun)||
   list(state.dispatches).some(dispatch=>dispatch.requestId===request.id)||list(state.trips).some(trip=>trip.requestId===request.id)||
   events.some(event=>event.type==='request.planned')||['INTEGRATED_DEMO','PLANNED','COMPLETED'].includes(request.planningStatus)||
   ['deliveredT','deliveredM3','receivedTrips','pendingTrips'].some(key=>typeof request[key]==='number'&&request[key]>0))code='REQUEST_ALREADY_PLANNED';
 else if(request.status!=='requested')code='REQUEST_NOT_EDITABLE';
 else if(requestRevision(request)===null)code='REQUEST_STATE_REVIEW';
 const reason=code?reasons[code]:null;
 return {canEdit:code===null,canCancel:code===null,requestRevision:requestRevision(request),requestActionBlockedCode:code,
  requestActionBlockedReason:reason?.[0]||null,requestActionBlockedReasonEn:reason?.[1]||null,
  editBlockedReason:reason?.[0]||null,editBlockedReasonEn:reason?.[1]||null,cancelBlockedReason:reason?.[0]||null,cancelBlockedReasonEn:reason?.[1]||null};
}

export function assertRequestChange(state,request,actor,expectedRequestRevision){
 const eligibility=requestLifecycle(state,request,actor);
 if(!eligibility.canEdit)throw new DomainError(eligibility.requestActionBlockedReason,eligibility.requestActionBlockedCode,eligibility.requestActionBlockedCode==='FORBIDDEN'?403:409);
 if(!Number.isSafeInteger(expectedRequestRevision)||expectedRequestRevision<1)throw new DomainError('Versi permintaan saat formulir dibuka wajib dikirim.','REQUEST_REVISION_REQUIRED',400);
 if(expectedRequestRevision!==eligibility.requestRevision)throw new DomainError('Permintaan sudah diperbarui. Muat ulang lalu buka kembali formulir.','REQUEST_REVISION_CONFLICT',409);
 return eligibility.requestRevision;
}
