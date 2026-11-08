const open=t=>!['returned','cancelled'].includes(t.status);
export function quarryResourceReadiness(state={},drivers,user={}){
 const trips=Array.isArray(state.trips)?state.trips:[],fleet=Array.isArray(state.fleet)?state.fleet:[];
 const canSeeDrivers=user.role==='admin'&&Array.isArray(drivers);
 const heldDriverIds=new Set(trips.filter(t=>open(t)&&t.assignedDriverUserId).map(t=>t.assignedDriverUserId));
 const activeDrivers=canSeeDrivers?drivers.filter(d=>d.active!==false&&d.disabled!==true&&d.role==='driver'):null;
 const freeDrivers=activeDrivers?activeDrivers.filter(d=>!heldDriverIds.has(d.id)).length:null;
 const freeTrucks=fleet.filter(t=>t.status==='available').length;
 const policy=state.fleetPolicy,simulationEnabled=policy?.simulationEnabled===true,reportedPairs=Number.isInteger(policy?.availablePairs)&&policy.availablePairs>=0?policy.availablePairs:null;
 return {workflowEnabled:state.quarryCilegon?.enabled===true,freeTrucks,activeDrivers:activeDrivers?.length??null,freeDrivers,
  freePairs:simulationEnabled?reportedPairs:(freeDrivers===null?null:Math.min(freeTrucks,freeDrivers)),
  ...(simulationEnabled?{simulationEnabled:true,simulatedDriverCount:Number.isInteger(policy.simulatedDriverCount)&&policy.simulatedDriverCount>=0?policy.simulatedDriverCount:null}:{}),
  openLegacyTrips:trips.filter(t=>open(t)&&t.workflow!=='QUARRY_CILEGON').length,
  waitingQuarryTrips:trips.filter(t=>t.status==='waiting_truck'&&t.workflow==='QUARRY_CILEGON').length,
  quarryRequests:(state.requests||[]).filter(r=>r.workflow==='QUARRY_CILEGON').length};
}
