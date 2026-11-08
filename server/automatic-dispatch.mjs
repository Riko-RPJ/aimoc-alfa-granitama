import {randomUUID,createHash} from 'node:crypto';
import {DomainError} from './domain.mjs';
import {effectiveFleetDrivers,isSimulatedFleetDriver,fleetSimulationEnabled,FLEET_POLICY_MODE} from './fleet-simulation.mjs';

const SOURCE='INTEGRATED_DEMO', EPS=0.00001;
const round=n=>Math.round(n*1e6)/1e6;
const open=t=>!['returned','cancelled'].includes(t.status);
const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const now=()=>new Date().toISOString();
const fail=(message,code='AUTO_DISPATCH_REVIEW_REQUIRED')=>{throw new DomainError(message,code,409);};
const drivers=(state,options)=>effectiveFleetDrivers(state,options.drivers).filter(d=>d.id&&d.role==='driver'&&d.active!==false&&d.disabled!==true).sort((a,b)=>String(a.username||a.id).localeCompare(String(b.username||b.id)));
const order=t=>t.queueSequence??t.sequence??0;
const waiting=s=>s.trips.filter(t=>t.source===SOURCE&&t.status==='waiting_truck').sort((a,b)=>order(a)-order(b)||(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id));
const evidence=(t,s)=>Object.entries(t).some(([k,v])=>/^(startedAt$|tare|gross|netT$|qr|weigh|departed|arrived|received|receipt|unloaded|returned|returnStarted)/i.test(k)&&v!==undefined&&v!==null&&v!==false&&v!==''&&!(Array.isArray(v)&&v.length===0))||!!s&&(s.inventoryLedger.some(e=>e.referenceId===t.id)||s.erpOutbox.some(e=>e.entityId===t.id)||s.events.some(e=>e.entityId===t.id&&/^trip\.(start|qr|tare|gross|loading|depart|arrive|receive|return)/.test(e.type)));
const audit=(s,actor,type,t,extra={})=>s.events.push({id:'evt-'+randomUUID(),at:now(),actorId:actor.id,actorName:actor.username||actor.displayName||actor.id,role:actor.role,type,entityId:t.id,source:SOURCE,synthetic:true,...extra});
const executing=t=>open(t)&&(!!t.startedAt||['loading','weighed','in_transit','arrived','unloaded','returning'].includes(t.status));
const bySequence=(a,b)=>(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id);

function nextWaitingTask(s,queue){
 const first=queue[0],dispatch=s.dispatches.find(d=>d.id===first.dispatchId);
 if(dispatch?.workflow!=='QUARRY_CILEGON'||dispatch.sourceAllocationMode!=='BALANCED_CRUSHERS')return first;
 const counts=new Map();
 for(const t of s.trips.filter(t=>t.dispatchId===dispatch.id&&t.truckId&&t.status!=='cancelled'))counts.set(t.crusherId,(counts.get(t.crusherId)||0)+1);
 // Fan the first available pairs across crushers before filling serial tails.
 // Resource choice and execution ordering still use the existing serial rules.
 return queue.filter(t=>t.dispatchId===dispatch.id).sort((a,b)=>(counts.get(a.crusherId)||0)-(counts.get(b.crusherId)||0)||order(a)-order(b)||bySequence(a,b))[0];
}

/** Global claim classification; callers redact entity IDs only after computing it. */
export function truckAvailability(s,truck){
 const claims=s.trips.filter(t=>open(t)&&t.truckId===truck.id).sort(bySequence);
 const current=claims.find(executing),queued=claims.filter(t=>!executing(t));
 const dispatchIds=[...new Set(claims.map(t=>t.dispatchId).filter(Boolean))];
 const driverIds=[...new Set(claims.map(t=>t.assignedDriverUserId).filter(Boolean))];
 const conflict=dispatchIds.length>1||driverIds.length>1||claims.filter(executing).length>1;
 const legacyHold=claims.some(t=>t.source!==SOURCE||!t.dispatchId||!t.assignedDriverUserId);
 const latestEstimate=claims.reduce((latest,t)=>{const time=Date.parse(t.estimatedReturnAt);return Number.isFinite(time)?Math.max(latest,time):latest;},0);
 return {status:!truck.active?'unavailable':current?'busy':claims.length?'allocated':'available',dispatchId:dispatchIds.length===1?dispatchIds[0]:null,dispatchIds,activeTripId:current?.id||null,queuedTrips:queued.length,nextTripId:queued[0]?.id||null,serialTripsRemaining:claims.length,bindingStatus:!claims.length?'NONE':conflict?'CONFLICT':legacyHold?'LEGACY_HOLD':'DISPATCH',estimatedAvailableAt:latestEstimate?new Date(latestEstimate).toISOString():now()};
}

function validateClaims(s){
 const assigned=s.trips.filter(t=>open(t)&&t.truckId);
 const truckClaims=new Map(),driverClaims=new Map();
 for(const t of assigned){
  const key=t.dispatchId||`legacy-${t.requestId||t.id}`;
  const truck=truckClaims.get(t.truckId);
  if(truck&&(truck.key!==key||truck.driverId!==t.assignedDriverUserId||executing(t)&&truck.executing))fail('Truk memiliki claim dispatch/pengemudi atau eksekusi ganda; rekonsiliasi operator diperlukan.');
  truckClaims.set(t.truckId,{key,driverId:t.assignedDriverUserId,executing:executing(t)||!!truck?.executing,trips:[...(truck?.trips||[]),t]});
  if(t.assignedDriverUserId){
   const driver=driverClaims.get(t.assignedDriverUserId);
   if(driver&&(driver.key!==key||driver.truckId!==t.truckId||executing(t)&&driver.executing))fail('Pengemudi memiliki claim truk/dispatch atau eksekusi ganda; rekonsiliasi operator diperlukan.');
   driverClaims.set(t.assignedDriverUserId,{key,truckId:t.truckId,executing:executing(t)||!!driver?.executing});
  }
 }
 return {assigned,truckClaims,driverClaims};
}
export function assertSerialDispatchClaims(s){validateClaims(s);return true;}

export function automaticDispatchSummary(s,dispatchId){
 const trips=s.trips.filter(t=>t.source===SOURCE&&(!dispatchId||t.dispatchId===dispatchId));
 const pending=trips.filter(t=>t.status==='waiting_truck');
 const assigned=trips.filter(t=>open(t)&&t.truckId);
 const estimate=pending.reduce((sum,t)=>{
  const capacities=s.trucks.filter(v=>v.active&&valid(v.bedM3)&&valid(v.payloadLimitT)).map(v=>Math.min(v.payloadLimitT,v.bedM3*t.densityTPerM3));
  const cap=Math.max(0,...capacities);return sum+(cap>0?Math.ceil((t.tonnageT-EPS)/cap):0);
 },0);
 return {assignedTrips:assigned.length,assignedTruckCount:new Set(assigned.map(t=>t.truckId)).size,waitingLoads:pending.length,waitingT:round(pending.reduce((sum,t)=>sum+t.tonnageT,0)),waitingM3:round(pending.reduce((sum,t)=>sum+t.volumeM3,0)),estimatedRemainingTrips:estimate,allocationMode:'AUTOMATIC_SERIAL'};
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
  for (const r of s.requests.filter(r=>r.source===SOURCE&&r.status!=='cancelled')) {
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


/** Inside a locked transaction: one dispatch claim, many serial trips per pair. */
export function scheduleAutomaticDispatch(s,options,actor){
 const assigned=[],blocked=new Set();
 validateClaims(s);
 for(;;){
  const queue=waiting(s).filter(t=>!blocked.has(t.id));if(!queue.length)break;
  const task=nextWaitingTask(s,queue);
  if(evidence(task,s)||task.truckId||task.assignedDriverUserId||!valid(task.tonnageT)||!valid(task.volumeM3)||!valid(task.densityTPerM3))fail('Muatan menunggu mengandung assignment atau bukti eksekusi yang tidak konsisten.');
  const dispatch=s.dispatches.find(d=>d.id===task.dispatchId&&d.requestId===task.requestId&&d.source===SOURCE);
  if(!dispatch||!dispatch.tripIds.includes(task.id))fail('Muatan menunggu tidak terhubung pada dispatch kanonis.');
  const claims=validateClaims(s),policy=dispatch.allocationPolicy,limited=dispatch.workflow==='QUARRY_CILEGON'&&policy!==undefined;
  if(limited&&(!policy||policy.mode!==FLEET_POLICY_MODE||policy.version!==1||!Number.isSafeInteger(policy.totalActiveFleet)||policy.totalActiveFleet<0||policy.baseQuota!==Math.max(5,Math.ceil(policy.totalActiveFleet*0.05))||policy.maxTruckCount!==policy.baseQuota||typeof policy.simulatedDrivers!=='boolean'||policy.driverMode!==(policy.simulatedDrivers?'REAL_THEN_SIMULATED':'REAL_ONLY')))fail('Kebijakan alokasi armada dispatch tidak valid; rekonsiliasi operator diperlukan.');
  const allowVirtual=limited&&policy.simulatedDrivers===true&&fleetSimulationEnabled(s);
  const activeDrivers=drivers(s,options).filter(d=>!isSimulatedFleetDriver(d)||allowVirtual);
  const freeDrivers=activeDrivers.filter(d=>!isSimulatedFleetDriver(d)&&!claims.driverClaims.has(d.id));
  const freeTrucks=s.trucks.filter(v=>v.active&&!claims.truckClaims.has(v.id)&&valid(v.bedM3)&&valid(v.payloadLimitT));
  const pairs=[];
  for(const [truckId,claim]of claims.truckClaims){
   const truck=s.trucks.find(v=>v.id===truckId),driver=activeDrivers.find(d=>d.id===claim.driverId);
   if(claim.key===task.dispatchId&&claim.trips.every(t=>t.source===SOURCE)&&truck?.active&&driver&&valid(truck.bedM3)&&valid(truck.payloadLimitT))pairs.push({truck,driver,load:claim.trips.length*truck.cycleMinutes});
  }
  // Only AVAILABLE units enter a new dispatch. Once bound, the same pair may
  // receive additional queue entries exclusively within that dispatch.
  const claimedCount=[...claims.truckClaims.values()].filter(claim=>claim.key===task.dispatchId).length;
  let slots=limited?Math.max(0,policy.maxTruckCount-claimedCount):Infinity;
  for(const truck of freeTrucks.sort((a,b)=>Math.min(b.payloadLimitT,b.bedM3*task.densityTPerM3)-Math.min(a.payloadLimitT,a.bedM3*task.densityTPerM3)||a.code.localeCompare(b.code))){
   if(slots<=0)break;
   const driver=freeDrivers.shift()||activeDrivers.find(d=>isSimulatedFleetDriver(d)&&d.truckId===truck.id&&!claims.driverClaims.has(d.id));
   if(!driver)continue;pairs.push({truck,driver,load:0});slots--;
  }
  if(!pairs.length){blocked.add(task.id);continue;}
  const source=s.stockpiles.find(x=>x.id===task.stockpileId),product=s.products.find(x=>x.id===task.skuId),crusher=s.crushers.find(x=>x.id===task.crusherId);
  if(!source?.active||!product?.active||!crusher?.active){task.assignmentHold='SOURCE_INACTIVE';blocked.add(task.id);continue;}
  const pair=pairs.sort((a,b)=>a.load-b.load||Math.min(b.truck.payloadLimitT,b.truck.bedM3*task.densityTPerM3)-Math.min(a.truck.payloadLimitT,a.truck.bedM3*task.densityTPerM3)||a.truck.code.localeCompare(b.truck.code))[0];
  const truck=pair.truck;
  const tonnageT=round(Math.min(task.tonnageT,truck.payloadLimitT,truck.bedM3*task.densityTPerM3));
  const volumeM3=tonnageT===task.tonnageT?task.volumeM3:round(Math.min(task.volumeM3,tonnageT/task.densityTPerM3));
  if(!valid(tonnageT)||!valid(volumeM3)||volumeM3>truck.bedM3+EPS){task.assignmentHold='TRUCK_CAPACITY';blocked.add(task.id);continue;}
  const remainingT=round(task.tonnageT-tonnageT),remainingM3=round(task.volumeM3-volumeM3);
  if(remainingT>0){
   if(s.trips.length>=20000||dispatch.tripIds.length>=2000){task.assignmentHold='TRIP_LIMIT_REACHED';blocked.add(task.id);continue;}
   if(!valid(remainingM3))fail('Sisa volume muatan tidak cocok dengan sisa tonase.');
   const pending={...structuredClone(task),id:'trip-'+randomUUID(),code:'RIT-'+String(s.trips.length+1).padStart(5,'0'),sequence:s.trips.reduce((m,t)=>Math.max(m,t.sequence||0),0)+1,queueSequence:order(task),splitFromTripId:task.id,tonnageT:remainingT,volumeM3:remainingM3,createdAt:now(),estimatedStartAt:null,estimatedReturnAt:null};
   s.trips.push(pending);dispatch.tripIds.push(pending.id);
  }
  const selectedDriver=pair.driver,at=now();
  Object.assign(task,{tonnageT,volumeM3,truckId:truck.id,assignedDriverUserId:selectedDriver.id,assignedDriverName:selectedDriver.displayName||selectedDriver.name||selectedDriver.username||selectedDriver.id,status:'queued',assignmentMode:'AUTOMATIC_SERIAL',assignedAt:at,assignmentHold:null,estimatedStartAt:new Date(Date.now()+pair.load*60000).toISOString(),estimatedReturnAt:new Date(Date.now()+(pair.load+truck.cycleMinutes)*60000).toISOString(),...(limited?{assignedDriverSynthetic:isSimulatedFleetDriver(selectedDriver),assignedDriverMode:isSimulatedFleetDriver(selectedDriver)?'SIMULATED_NO_LOGIN':'REAL_ACCOUNT'}:{})});
  audit(s,actor,'trip.automatically_assigned',task,{truckId:truck.id,assignedDriverUserId:selectedDriver.id});assigned.push(task.id);
 }
 const busyDrivers=new Set(s.trips.filter(t=>open(t)&&t.truckId).map(t=>t.assignedDriverUserId).filter(Boolean));
 const hasDriver=drivers(s,options).some(d=>!isSimulatedFleetDriver(d)&&!busyDrivers.has(d.id));
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
 validateClaims({...draft,trips:preserved});
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
