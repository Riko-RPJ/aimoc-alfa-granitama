import React,{useEffect,useState} from 'react';
import {ChevronDown,Clock3,Truck} from 'lucide-react';
import {api} from '../../services/legacy-api.js';
import {tr} from '../../i18n.js';
import {Badge,DataTable,Empty,Panel} from '../../components/ui/index.jsx';
import {fmt} from '../shared/legacy-utils.js';

const reasonText={
 LAND_DESTINATION_UNVERIFIED:'Receiving destination has no verified location master.',
 DRIVER_INTEGRATION_UNAVAILABLE:'Verified and available Driver identities are not integrated.',
 LAND_EXECUTION_NOT_INTEGRATED:'LAND inventory and trip state transitions are not integrated.',
 SKU_DENSITY_UNVERIFIED:'SKU density is not verified; effective payload and trip estimates are unavailable.',
 TRUCK_MASTER_INCOMPLETE:'At least one truck is missing active status or a required capacity/cycle-time value.',
 NO_AVAILABLE_TRUCKS:'No active truck is currently free of unfinished work.',
};
const availabilityLabel={AVAILABLE:'Available',BUSY:'Busy',INACTIVE:'Inactive',PENDING_VERIFICATION:'Pending Verification'};
const requestedByUnit=rows=>Object.entries((rows||[]).reduce((totals,line)=>{
 const unit=line.unit==='t'?'t':'m3';
 totals[unit]=(totals[unit]||0)+Number(line.requested_quantity||0);
 return totals;
},{})).map(([unit,quantity])=>`${fmt(quantity,2)} ${unit==='t'?tr("ton"):tr("m³")}`).join(' · ')||'—';

export function FleetCapacityAllocation({request,products=[]}){
 const [result,setResult]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 const [showAllFleet,setShowAllFleet]=useState(false);
 useEffect(()=>{
  let current=true;
  setLoading(true);setError('');setResult(null);setShowAllFleet(false);
  api(`/api/v1/transfer-requests/${encodeURIComponent(request.id)}/fleet-allocation`)
   .then(response=>{if(current)setResult(response.data);})
   .catch(e=>{if(current)setError(e.message||'Fleet allocation preview could not be loaded.');})
   .finally(()=>{if(current)setLoading(false);});
  return()=>{current=false;};
 },[request.id]);
 const skuName=id=>products.find(x=>x.id===id)?.code||id;
 const requestedSummary=requestedByUnit(result?.requested_quantity);
 const recommended=result?.recommended_trucks||[];
 const estimatedTrips=result?.estimated_trips;
 const capacityFor=truckId=>result.lines.map(line=>{
  const capacity=line.truck_capacities?.find(x=>x.truck_id===truckId)?.effective_capacity_t;
  return `${skuName(line.sku_id)}: ${capacity===null||capacity===undefined?tr("Pending Verification"):`${fmt(capacity,2)} ${tr("ton")}`}`;
 }).join(' / ');
 return <Panel title={tr("Fleet Capacity & Allocation")} subtitle={tr("Truck capacity is read from the Truck Master. This is a read-only planning preview.")}>
  {loading?<div className="inline-loading"><Clock3 size={17}/>{tr("Loading current fleet master and availability…")}</div>:error?<div className="form-error" role="alert">{tr(error)}</div>:result&&<>
   <div className="notice error" role="status"><Truck size={18}/><span>{tr("Allocation Status")}: <b>{tr(result.status==='INSUFFICIENT'?'Insufficient':'Pending Verification')}</b>. {tr("No dispatch or trip has been created.")}</span></div>
   <div className="confirm-details">
    <div><span>{tr("Requested")}</span><b>{requestedSummary}</b><small>{result.requested_quantity.map(x=>`${skuName(x.sku_id)} · ${fmt(x.requested_quantity,2)} ${x.unit==='t'?tr("ton"):tr("m³")}`).join(' / ')}</small></div>
    <div><span>{tr("Eligible Trucks")}</span><b>{result.eligible_trucks}</b></div>
    <div><span>{tr("Recommended Trucks")}</span><b>{recommended.length?recommended.map(t=>t.plate_number||t.truck_id).join(', '):tr("Not Available / Pending Verification")}</b></div>
    <div><span>{tr("Estimated Trips")}</span><b>{estimatedTrips??tr("Not Available / Pending Verification")}</b></div>
   </div>
   <button type="button" className="text-btn" aria-expanded={showAllFleet} onClick={()=>setShowAllFleet(value=>!value)}>
    <Truck size={15}/>{tr(showAllFleet?"Hide All Fleet":"View All Fleet")}<ChevronDown size={15} style={{transform:showAllFleet?'rotate(180deg)':undefined}}/>
   </button>
   {showAllFleet&&<>
    {result.trucks.length?<DataTable headers={[tr("Truck"),tr("Payload per Truck"),tr("Bed Capacity"),tr("Cycle Time"),tr("Effective Capacity"),tr("Availability"),tr("Assigned Driver")]}>
     {result.trucks.map(t=><tr key={t.truck_id}>
      <td><b>{t.plate_number||t.truck_id}</b><small>{t.truck_id}</small></td>
      <td>{t.payload_limit_t===null?tr("Not Available"):`${fmt(t.payload_limit_t,2)} ${tr("ton")}`}</td>
      <td>{t.bed_capacity_m3===null?tr("Not Available"):`${fmt(t.bed_capacity_m3,2)} ${tr("m³")}`}</td>
      <td>{t.cycle_time_minutes===null?tr("Not Available"):`${fmt(t.cycle_time_minutes,0)} ${tr("minutes")}`}</td>
      <td>{capacityFor(t.truck_id)}</td>
      <td><Badge tone={t.availability==='AVAILABLE'?'green':t.availability==='BUSY'?'amber':'neutral'}>{tr(availabilityLabel[t.availability]||t.availability)}</Badge></td>
      <td>{tr("Pending Verification")}</td>
     </tr>)}
    </DataTable>:<Empty icon={Truck} title={tr("No eligible trucks available")} text={tr("No currently available truck can be recommended for this request.")}/>}
   </>}
   <div className="notice compact"><div>{result.reasons.map(reason=><p key={reason}>{tr(reasonText[reason]||reason)}</p>)}</div></div>
   <small>{tr("Source")}: {tr(result.source)} · {tr(result.data_mode)}. {tr("Current master values are a legacy snapshot, not verified production telemetry.")}</small>
  </>}
 </Panel>;
}
