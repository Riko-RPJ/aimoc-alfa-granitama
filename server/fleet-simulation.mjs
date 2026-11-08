import {createHash} from 'node:crypto';
import {DomainError} from './domain.mjs';

export const FLEET_POLICY_MODE='TOTAL_ACTIVE_FLEET_5_PERCENT_MIN_5';
const SOURCE='FLEET_SIMULATION',open=trip=>!['returned','cancelled'].includes(trip.status);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const fail=(message,code='FLEET_SIMULATION_INVALID',status=409)=>{throw new DomainError(message,code,status);};
const rows=value=>Array.isArray(value)?value:[];
const activeDriver=driver=>driver?.id&&driver.role==='driver'&&driver.active!==false&&driver.disabled!==true;
export const isSimulatedFleetDriver=driver=>driver?.synthetic===true&&driver.source===SOURCE&&driver.mode==='SIMULATED_NO_LOGIN';
export const isSimulatedFleetTruck=truck=>truck?.synthetic===true&&truck.source===SOURCE&&truck.simulationManaged===true;
export const simulatedDriverId=truckId=>'sim-driver-'+createHash('sha256').update(truckId).digest('hex').slice(0,32);
export const fleetSimulationEnabled=state=>state.fleetSimulation?.enabled===true&&state.fleetSimulation.synthetic===true&&/\b(?:UAT|DEMO)\b/i.test(state.dataMode||'');

/** Internal execution catalog only; these identities are never login accounts. */
export function effectiveFleetDrivers(state,provided=[]){
 const real=rows(provided).filter(driver=>!isSimulatedFleetDriver(driver)),catalog=new Map(real.map(driver=>[driver.id,driver]));
 const historical=new Set(),claimed=new Set();
 for(const trip of rows(state.trips))if(trip.assignedDriverSynthetic===true&&validId(trip.truckId)&&trip.assignedDriverUserId===simulatedDriverId(trip.truckId)){
  historical.add(trip.truckId);if(open(trip))claimed.add(trip.truckId);
 }
 const enabled=fleetSimulationEnabled(state);
 for(const truck of rows(state.trucks)){
  if(!validId(truck.id)||!(enabled&&truck.active===true)&&!historical.has(truck.id))continue;
  const id=simulatedDriverId(truck.id);if(catalog.has(id))continue;
  catalog.set(id,{id,username:'sim-'+truck.id,displayName:'SIMULATED Driver · '+truck.code,role:'driver',active:truck.active===true&&(enabled||claimed.has(truck.id)),synthetic:true,source:SOURCE,mode:'SIMULATED_NO_LOGIN',truckId:truck.id,loginEnabled:false,canLogin:false});
 }
 return [...catalog.values()];
}

/** Snapshot this only on new Cilegon dispatches; existing plans keep their rule. */
export function fleetDispatchPolicy(state){
 const totalActiveFleet=rows(state.trucks).filter(truck=>truck.active===true).length,baseQuota=Math.max(5,Math.ceil(totalActiveFleet*0.05)),simulatedDrivers=fleetSimulationEnabled(state);
 return {version:1,mode:FLEET_POLICY_MODE,totalActiveFleet,baseQuota,maxTruckCount:baseQuota,simulatedDrivers,driverMode:simulatedDrivers?'REAL_THEN_SIMULATED':'REAL_ONLY'};
}

export function fleetPolicyProjection(state,provided=[],actor={}){
 const policy=fleetDispatchPolicy(state),claimedTrucks=new Set(rows(state.trips).filter(open).map(trip=>trip.truckId).filter(Boolean)),claimedDrivers=new Set(rows(state.trips).filter(open).map(trip=>trip.assignedDriverUserId).filter(Boolean));
 const idle=rows(state.trucks).filter(truck=>truck.active===true&&!claimedTrucks.has(truck.id)),catalog=effectiveFleetDrivers(state,provided),real=catalog.filter(driver=>activeDriver(driver)&&!isSimulatedFleetDriver(driver)),simulated=catalog.filter(driver=>activeDriver(driver)&&isSimulatedFleetDriver(driver)),realFree=real.filter(driver=>!claimedDrivers.has(driver.id));
 return {...policy,totalRegisteredFleet:rows(state.trucks).length,availableIdleTrucks:idle.length,availableQuota:Math.min(idle.length,policy.baseQuota),realDriverCount:actor.role==='admin'?real.length:null,availableRealDrivers:actor.role==='admin'?realFree.length:null,simulatedDriverCount:simulated.length,simulationEnabled:fleetSimulationEnabled(state),availablePairs:actor.role==='admin'?Math.min(idle.length,policy.baseQuota,fleetSimulationEnabled(state)?idle.length:realFree.length):null};
}

/** Configure simulated masters only. No assignment, inventory, or account write. */
export function applyFleetSimulationConfigure(state,payload,actor){
 if(actor?.role!=='admin'||!validId(actor.id)||actor.active===false||actor.disabled===true)fail('Konfigurasi armada simulasi memerlukan Admin.','FORBIDDEN',403);
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['totalTrucks','enabled'].includes(key))||!Number.isSafeInteger(payload.totalTrucks)||payload.totalTrucks<12||payload.totalTrucks>300||payload.enabled!==undefined&&typeof payload.enabled!=='boolean')fail('Total armada aktif simulasi harus 12–300 truk.','FLEET_SIMULATION_PAYLOAD_INVALID',400);
 if(!/\b(?:UAT|DEMO)\b/i.test(state.dataMode||'')||!Array.isArray(state.trucks)||!Array.isArray(state.trips))fail('Armada ini hanya tersedia pada data demo sintetis.','FLEET_SIMULATION_DEMO_REQUIRED');
 const draft=structuredClone(state),claimed=new Set(draft.trips.filter(open).map(trip=>trip.truckId).filter(Boolean)),manual=draft.trucks.filter(truck=>truck.active===true&&!isSimulatedFleetTruck(truck)),pinned=draft.trucks.filter(truck=>isSimulatedFleetTruck(truck)&&claimed.has(truck.id));
 if(pinned.some(truck=>truck.active!==true)||payload.totalTrucks<manual.length+pinned.length)fail('Target tidak boleh menonaktifkan armada manual atau truk yang masih terikat dispatch.','FLEET_SIMULATION_CLAIMED');
 const keep=new Set(pinned.map(truck=>truck.id)),needed=payload.totalTrucks-manual.length;
 const simulated=draft.trucks.filter(isSimulatedFleetTruck).sort((a,b)=>Number(b.active===true)-Number(a.active===true)||a.code.localeCompare(b.code));
 for(const truck of simulated)if(keep.size<needed)keep.add(truck.id);
 let sequence=1;
 while(keep.size<needed){
  let id,code;
  do{id='sim-truck-'+String(sequence).padStart(3,'0');code='SIM-DT-'+String(sequence++).padStart(3,'0');}while(draft.trucks.some(truck=>truck.id===id||truck.code.toLowerCase()===code.toLowerCase()));
  draft.trucks.push({id,code,plate:'SIMULATED '+code,bedM3:32,payloadLimitT:48,cycleMinutes:30,active:true,synthetic:true,source:SOURCE,simulationManaged:true});keep.add(id);
 }
 for(const truck of draft.trucks.filter(isSimulatedFleetTruck))truck.active=keep.has(truck.id);
 const at=new Date().toISOString();
 draft.fleetSimulation={version:(draft.fleetSimulation?.version||0)+1,enabled:payload.enabled??true,synthetic:true,source:SOURCE,totalTrucks:payload.totalTrucks,targetActiveFleet:payload.totalTrucks,driverMode:'SIMULATED_NO_LOGIN',updatedBy:actor.id,updatedAt:at};
 draft.updatedAt=at;Object.assign(state,draft);
 return {entityId:'fleet-simulation',source:'INTEGRATED_DEMO',synthetic:true,fleetSimulation:structuredClone(draft.fleetSimulation),accountsCreated:0,existingAssignmentsPreserved:true};
}
