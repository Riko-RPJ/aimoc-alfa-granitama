import {randomUUID,createHash} from 'node:crypto';
import {DomainError} from './domain.mjs';

const SOURCE='INTEGRATED_DEMO', EPS=0.00001;
const round=n=>Math.round(n*1e6)/1e6;
const open=t=>!['returned','cancelled'].includes(t.status);
const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const now=()=>new Date().toISOString();
const fail=(message,code='AUTO_DISPATCH_REVIEW_REQUIRED')=>{throw new DomainError(message,code,409);};
const drivers=options=>(Array.isArray(options.drivers)?options.drivers:[]).filter(d=>d.id&&d.role==='driver'&&d.active!==false&&d.disabled!==true).sort((a,b)=>String(a.username||a.id).localeCompare(String(b.username||b.id)));
const order=t=>t.queueSequence??t.sequence??0;
const waiting=s=>s.trips.filter(t=>t.source===SOURCE&&t.status==='waiting_truck').sort((a,b)=>order(a)-order(b)||(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id));
const evidence=(t,s)=>Object.entries(t).some(([k,v])=>/^(startedAt$|tare|gross|netT$|qr|weigh|departed|arrived|received|receipt|unloaded|returned|returnStarted)/i.test(k)&&v!==undefined&&v!==null&&v!==false&&v!==''&&!(Array.isArray(v)&&v.length===0))||!!s&&(s.inventoryLedger.some(e=>e.referenceId===t.id)||s.erpOutbox.some(e=>e.entityId===t.id)||s.events.some(e=>e.entityId===t.id&&/^trip\.(start|qr|tare|gross|loading|depart|arrive|receive|return)/.test(e.type)));
const audit=(s,actor,type,t,extra={})=>s.events.push({id:'evt-'+randomUUID(),at:now(),actorId:actor.id,actorName:actor.username||actor.displayName||actor.id,role:actor.role,type,entityId:t.id,source:SOURCE,synthetic:true,...extra});

export function automaticDispatchSummary(s,dispatchId){
 const trips=s.trips.filter(t=>t.source===SOURCE&&(!dispatchId||t.dispatchId===dispatchId));
 const pending=trips.filter(t=>t.status==='waiting_truck');
 const assigned=trips.filter(t=>open(t)&&t.truckId);
 const estimate=pending.reduce((sum,t)=>{
  const capacities=s.trucks.filter(v=>v.active&&valid(v.bedM3)&&valid(v.payloadLimitT)).map(v=>Math.min(v.payloadLimitT,v.bedM3*t.densityTPerM3));
  const cap=Math.max(0,...capacities);return sum+(cap>0?Math.ceil((t.tonnageT-EPS)/cap):0);
 },0);
 return {assignedTrips:assigned.length,waitingLoads:pending.length,waitingT:round(pending.reduce((sum,t)=>sum+t.tonnageT,0)),waitingM3:round(pending.reduce((sum,t)=>sum+t.volumeM3,0)),estimatedRemainingTrips:estimate,allocationMode:'AUTOMATIC'};
}

export function refreshAutomaticDispatchProgress(s) {
  for (const d of s.dispatches.filter(d=>d.source===SOURCE)) {
    const trips = s.trips.filter(t => t.dispatchId === d.id);
    const received = trips.filter(t => t.receivedAt);
    d.completedTrips = trips.filter(t => t.status === 'returned').length;
    d.receivedTrips = received.length;
    d.pendingTrips = trips.length - d.completedTrips;
    d.deliveredM3 = round(received.reduce((sum, t) => sum + t.volumeM3, 0));
    d.deliveredT = round(received.reduce((sum, t) => sum + t.tonnageT, 0));
    d.remainingT = round(Math.max(0, d.tonnageT - d.deliveredT));
    d.deliveryStatus = received.length === trips.length ? 'received' : received.length ? 'partial' : 'pending';
    d.status = trips.length && d.completedTrips === trips.length ? 'completed' : trips.some(t => !['queued','waiting_truck'].includes(t.status)) ? 'in_progress' : 'planned';
    d.autoDispatch = automaticDispatchSummary(s,d.id);
  }
  for (const r of s.requests.filter(r=>r.source===SOURCE)) {
    const dispatches = s.dispatches.filter(d => d.requestId === r.id);
    r.deliveredM3 = round(dispatches.reduce((sum, d) => sum + (d.deliveredM3 || 0), 0));
    r.deliveredT = round(dispatches.reduce((sum, d) => sum + (d.deliveredT || 0), 0));
    r.remainingT = round(Math.max(0, r.lines.reduce((sum, line) => sum + line.tonnageT, 0) - r.deliveredT));
    r.pendingTrips = dispatches.reduce((sum, d) => sum + d.pendingTrips, 0);
    if (dispatches.length) r.status = dispatches.every(d => d.status === 'completed') ? 'completed' : dispatches.some(d => d.status === 'in_progress') ? 'in_progress' : 'planned';
    r.deliveryStatus = r.remainingT <= EPS && dispatches.length ? 'received' : r.deliveredT > EPS ? 'partial' : 'pending';
    if(dispatches.length)r.autoDispatch=automaticDispatchSummary(s,dispatches[0].id);
  }
}


/** Inside a locked operation transaction. No truck or Driver is pre-booked twice. */
export function scheduleAutomaticDispatch(s,options,actor){
 const assigned=[];
 for(;;){
  const queue=waiting(s);if(!queue.length)break;
  const occupied=s.trips.filter(t=>open(t)&&t.truckId);
  const usedTrucks=new Set(occupied.map(t=>t.truckId)),usedDrivers=new Set(occupied.map(t=>t.assignedDriverUserId).filter(Boolean));
  const freeDrivers=drivers(options).filter(d=>!usedDrivers.has(d.id));
  const freeTrucks=s.trucks.filter(v=>v.active&&!usedTrucks.has(v.id)&&valid(v.bedM3)&&valid(v.payloadLimitT));
  if(!freeDrivers.length||!freeTrucks.length)break;
  const task=queue[0];
  if(evidence(task,s)||task.truckId||task.assignedDriverUserId||!valid(task.tonnageT)||!valid(task.volumeM3)||!valid(task.densityTPerM3))fail('Muatan menunggu mengandung assignment atau bukti eksekusi yang tidak konsisten.');
  const source=s.stockpiles.find(x=>x.id===task.stockpileId),product=s.products.find(x=>x.id===task.skuId),crusher=s.crushers.find(x=>x.id===task.crusherId);
  if(!source?.active||!product?.active||!crusher?.active){task.assignmentHold='SOURCE_INACTIVE';break;}
  const truck=freeTrucks.sort((a,b)=>Math.min(b.payloadLimitT,b.bedM3*task.densityTPerM3)-Math.min(a.payloadLimitT,a.bedM3*task.densityTPerM3)||a.code.localeCompare(b.code))[0];
  const tonnageT=round(Math.min(task.tonnageT,truck.payloadLimitT,truck.bedM3*task.densityTPerM3));
  const volumeM3=tonnageT===task.tonnageT?task.volumeM3:round(Math.min(task.volumeM3,tonnageT/task.densityTPerM3));
  if(!valid(tonnageT)||!valid(volumeM3)||volumeM3>truck.bedM3+EPS){task.assignmentHold='TRUCK_CAPACITY';break;}
  const remainingT=round(task.tonnageT-tonnageT),remainingM3=round(task.volumeM3-volumeM3);
  if(remainingT>0){
   const dispatch=s.dispatches.find(d=>d.id===task.dispatchId);
   if(s.trips.length>=20000||dispatch.tripIds.length>=2000){task.assignmentHold='TRIP_LIMIT_REACHED';break;}
   if(!valid(remainingM3))fail('Sisa volume muatan tidak cocok dengan sisa tonase.');
   const pending={...structuredClone(task),id:'trip-'+randomUUID(),code:'RIT-'+String(s.trips.length+1).padStart(5,'0'),sequence:s.trips.reduce((m,t)=>Math.max(m,t.sequence||0),0)+1,queueSequence:order(task),splitFromTripId:task.id,tonnageT:remainingT,volumeM3:remainingM3,createdAt:now(),estimatedStartAt:null,estimatedReturnAt:null};
   s.trips.push(pending);dispatch.tripIds.push(pending.id);
  }
  const selectedDriver=freeDrivers[0],at=now();
  Object.assign(task,{tonnageT,volumeM3,truckId:truck.id,assignedDriverUserId:selectedDriver.id,assignedDriverName:selectedDriver.displayName||selectedDriver.name||selectedDriver.username||selectedDriver.id,status:'queued',assignmentMode:'AUTOMATIC',assignedAt:at,assignmentHold:null,estimatedStartAt:at,estimatedReturnAt:new Date(Date.now()+truck.cycleMinutes*60000).toISOString()});
  audit(s,actor,'trip.automatically_assigned',task,{truckId:truck.id,assignedDriverUserId:selectedDriver.id});assigned.push(task.id);
 }
 const busyDrivers=new Set(s.trips.filter(t=>open(t)&&t.truckId).map(t=>t.assignedDriverUserId).filter(Boolean));
 const hasDriver=drivers(options).some(d=>!busyDrivers.has(d.id));
 for(const task of waiting(s))if(!['SOURCE_INACTIVE','TRUCK_CAPACITY','TRIP_LIMIT_REACHED'].includes(task.assignmentHold))task.assignmentHold=hasDriver?'NO_AVAILABLE_TRUCK':'NO_AVAILABLE_DRIVER';
 refreshAutomaticDispatchProgress(s);
 return {assignedTripIds:assigned,autoAssignedTripIds:assigned,waitingTripIds:waiting(s).map(t=>t.id),autoDispatch:automaticDispatchSummary(s)};
}

export function allocateAutomaticDispatch(state,options,actor){
 const draft=structuredClone(state);const result=scheduleAutomaticDispatch(draft,options,actor);draft.updatedAt=now();Object.assign(state,draft);return result;
}

/** Offline cutover only: preserve evidence and convert only unexecuted old queues. */
export function upgradeToAutomaticDispatch(state,options,actor){
 if(actor?.role!=='admin'||!actor.id)fail('Migrasi otomatis memerlukan Admin.','FORBIDDEN');
 const before=structuredClone(state),draft=structuredClone(state),detached=[];
 const previous=draft.automaticDispatchUpgrade;
 if(previous?.version===1){const result=scheduleAutomaticDispatch(draft,options,actor);draft.updatedAt=now();Object.assign(state,draft);return {...result,detachedTripIds:[],replayed:true};}
 const preserved=draft.trips.filter(t=>open(t)&&t.truckId&&!(t.source===SOURCE&&t.status==='queued'&&!evidence(t,draft)));
 const truckClaims=new Set(),driverClaims=new Set();
 for(const t of preserved){
  if(truckClaims.has(t.truckId)||t.assignedDriverUserId&&driverClaims.has(t.assignedDriverUserId))fail('Terdapat assignment dengan bukti aktif ganda; rekonsiliasi operator diperlukan.');
  truckClaims.add(t.truckId);if(t.assignedDriverUserId)driverClaims.add(t.assignedDriverUserId);
 }
 for(const t of draft.trips.filter(t=>t.source===SOURCE&&t.status==='queued'&&!evidence(t,draft))){
  t.assignmentHistory=[...(t.assignmentHistory||[]),{truckId:t.truckId||null,assignedDriverUserId:t.assignedDriverUserId||null,assignedAt:t.assignedAt||null,estimatedStartAt:t.estimatedStartAt||null,estimatedReturnAt:t.estimatedReturnAt||null,reason:'Automatic dispatch cutover; no execution evidence',at:now(),actorId:actor.id}];
  Object.assign(t,{status:'waiting_truck',queueSequence:order(t),truckId:null,assignedDriverUserId:null,assignedDriverName:null,assignmentMode:'AUTOMATIC',assignmentHold:null,estimatedStartAt:null,estimatedReturnAt:null});
  detached.push(t.id);audit(draft,actor,'trip.automatic_queue_upgraded',t);
 }
 const result=scheduleAutomaticDispatch(draft,options,actor);
 // Allocation can split pending cargo, but total reserved inventory and each
 // original plan allocation must remain exact; physical and ERP evidence is untouched.
 for(const key of ['stockpiles','vessels','inventoryLedger','erpOutbox'])if(JSON.stringify(draft[key])!==JSON.stringify(before[key]))fail('Migrasi assignment tidak boleh mengubah saldo fisik, reservasi, atau ERP.');
 draft.automaticDispatchUpgrade={version:1,at:now(),actorId:actor.id,detachedTripIds:detached,beforeSha256:createHash('sha256').update(JSON.stringify(before)).digest('hex')};
 draft.updatedAt=now();Object.assign(state,draft);
 return {...result,detachedTripIds:detached,replayed:false};
}
