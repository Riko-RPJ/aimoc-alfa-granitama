import {previewLandFleetAllocation} from '../domain.mjs';

/**
 * Phase 4 compatibility read model.
 * Existing database has a single legacy operation document (m3-oriented).
 * This adapter never presents planned tonnage as weighed actual tonnage,
 * never asserts verified cargo receipts, and never publishes sequence readiness.
 */
const arr=(s,k)=>Array.isArray(s?.[k])?s[k]:[];
const known=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x))?Number(x):null;
const stamp=s=>s?.updatedAt??null;
const dto=(resource,data,{asOf,source='LEGACY_SNAPSHOT',status='READY'}={})=>({
  schema_version:'1.0',resource,source,data_status:status,as_of:asOf??null,data,
});
const wait=(resource,reason,asOf=null)=>({
  schema_version:'1.0',resource,source:'NOT_INTEGRATED',data_status:'NOT_INTEGRATED',
  as_of:asOf,reason,data:null,
});
const forbidden=(message='Akses ke resource ini tidak diizinkan.')=>Object.assign(new Error(message),{status:403,code:'FORBIDDEN_SCOPE'});
const invalid=(message)=>Object.assign(new Error(message),{status:404,code:'RESOURCE_NOT_FOUND'});
export const NOT_IMPLEMENTED='NOT_INTEGRATED';

export function projectV1Read(path,view,actor,query=new URLSearchParams()){
  const s=view.state,asOf=view.updatedAt??stamp(s),role=actor.role;
  const admin=()=>{if(role!=='admin')throw forbidden();};
  const stock=()=>{if(!['admin','stock'].includes(role))throw forbidden();};
  const rows=(name)=>arr(s,name);
  const scopedStock=rows('stockpiles');
  const stockDto=sp=>{
    const onHandM3=known(sp.onHandM3),reservedM3=known(sp.reservedM3);
    return {
      stockpile_id:sp.id,sku_id:sp.skuId,source_crusher_id:sp.crusherId,
      legacy_quantity:{unit:'m3',on_hand:onHandM3,reserved:reservedM3,
        available:onHandM3===null||reservedM3===null?null:onHandM3-reservedM3},
      // These are not derived from volume/density. Actual tonnes need a verified source.
      on_hand_t:null,reserved_t:null,available_t:null,
      source:'LEGACY_SNAPSHOT',as_of:asOf,
    };
  };
  const tripDto=t=>({
    id:t.id,dispatch_id:t.dispatchId,truck_id:t.truckId,driver_id:t.driverId??null,sku_id:t.skuId,
    source_stockpile_id:t.stockpileId,destination_location_id:t.jettyId,
    legacy_status:t.status,legacy_sequence:t.sequence??null,
    planned_quantity_t:known(t.tonnageT),
    actual_net_t:null,
    tare_verified:false,gross_verified:false,
    unload_verified:false,unloaded_verified_at:null,
    returned_available_at:null,
    sequence_eligibility:null,active_resource_claim:null,
  });
  const dispatchDto=d=>({
    id:d.id,request_id:d.requestId??null,code:d.code??null,legacy_status:d.status??null,
    mode:rows('requests').find(x=>x.id===d.requestId)?.transferMode??null,allocation_id:null,
    source_stockpile_id:d.stockpileId??null,source_stockpile_ids:d.stockpileIds??(d.stockpileId?[d.stockpileId]:[]),
    sku_ids:d.skuIds??(d.skuId?[d.skuId]:[]),allocations:d.allocations??[],
    voyage_id:null,planned_quantity_t:known(d.tonnageT),
    verified_received_quantity_t:null,sequence_eligibility:null,
    active_resource_claims:null,
  });
  const paginate=(items)=>{
    const limitRaw=query.get('limit');
    const limit=limitRaw===null?50:Number(limitRaw);
    if(!Number.isInteger(limit)||limit<1||limit>200)throw Object.assign(new Error('Limit harus 1–200.'),{status:400,code:'VALIDATION_ERROR'});
    const cursor=query.get('cursor');
    let begin=0;
    if(cursor!==null){
      begin=items.findIndex(item=>item.id===cursor);
      if(begin<0)throw Object.assign(new Error('Cursor tidak valid.'),{status:400,code:'INVALID_CURSOR'});
      begin++;
    }
    const page=items.slice(begin,begin+limit);
    return {items:page,next_cursor:begin+limit<items.length?page.at(-1)?.id??null:null};
  };

  if(path==='/api/v1/session')return dto('session',{user_id:actor.id,role:role==='stock'?'STOCKPILE':role.toUpperCase(),
    display_name:actor.displayName,location_scope:{crusher_ids:actor.crusherIds||[],jetty_ids:actor.jettyIds||[]},
    permissions:null}, {asOf});
  if(path==='/api/v1/operations/overview'){
    admin();
    return dto('operations_overview',{
      source:'LEGACY_SNAPSHOT',legacy_metrics:s.metrics??null,
      active_dispatches:rows('dispatches').filter(x=>x.status==='in_progress').length,
      active_trips:rows('trips').filter(x=>['loading','in_transit','arrived','unloaded'].includes(x.status)).length,
      needs_attention:null,
      verified_net_cargo_t:null,
      marine_sequence_ready_count:null,
      as_of:asOf,
    },{asOf});
  }
  if(path==='/api/v1/inventory'){
    stock();
    const items=scopedStock.map(stockDto);
    const filtered=query.get('stockpile_id')?items.filter(x=>x.stockpile_id===query.get('stockpile_id')):items;
    return dto('inventory',{items:filtered,unit:'m3',verified_tonnage_available:false},{asOf,status:filtered.length?'READY':'EMPTY'});
  }
  if(path==='/api/v1/inventory/movements'){
    stock();
    const stocks=new Set(scopedStock.map(x=>x.id));
    const movements=rows('inventoryLedger').filter(x=>stocks.has(x.stockpileId))
      .map(x=>({id:x.id,stockpile_id:x.stockpileId,reference_id:x.referenceId??null,
        occurred_at:x.at??null,legacy_kind:x.type,volume_m3:known(x.volumeM3),
        verified_net_t:null}));
    return dto('inventory_movements',paginate(movements),{asOf,status:movements.length?'READY':'EMPTY'});
  }
  if(path==='/api/v1/transfer-requests'){
    admin();
    const items=rows('requests').map(x=>({
      id:x.id,code:x.code,legacy_status:x.status,mode:x.transferMode??'MARINE',
      destination_id:x.destinationId??null,destination_name:x.destination??null,
      planning_status:x.planningStatus??null,lines:arr(x,'lines').map(l=>({
        sku_id:l.skuId,requested_quantity:l.quantity,unit:l.unit,
        planned_volume_m3:known(l.volumeM3),planned_tonnage_t:known(l.tonnageT),
        quantity_source:l.quantitySource??(x.transferMode==='LAND'?'REQUESTED_UNVERIFIED':'LEGACY_PLANNED'),verified_actual_tonnage_t:null,
      })),
      jetty_id:x.jettyId??null,vessel_id:x.vesselId??null,
      destination_allocations:null,created_at:x.createdAt??null,
    }));
    return dto('transfer_requests',paginate(items),{asOf,status:items.length?'READY':'EMPTY'});
  }
  const landFleetMatch=/^\/api\/v1\/transfer-requests\/([^/]+)\/fleet-allocation$/.exec(path);
  if(landFleetMatch){
    admin();
    const requestId=decodeURIComponent(landFleetMatch[1]);
    const preview=previewLandFleetAllocation(s,requestId);
    return dto('fleet_allocation',preview,{asOf,status:preview.status});
  }
  if(path==='/api/v1/dispatches'){
    admin();
    const items=rows('dispatches').map(dispatchDto);
    return dto('dispatches',paginate(items),{asOf,status:items.length?'READY':'EMPTY'});
  }
  const dispatchMatch=/^\/api\/v1\/dispatches\/([^/]+)$/.exec(path);
  if(dispatchMatch){
    admin();
    const d=rows('dispatches').find(x=>x.id===decodeURIComponent(dispatchMatch[1]));
    if(!d)throw invalid();
    return dto('dispatch', {...dispatchDto(d),trips:rows('trips').filter(t=>t.dispatchId===d.id).map(tripDto)},{asOf});
  }
  const tripsMatch=/^\/api\/v1\/dispatches\/([^/]+)\/trips$/.exec(path);
  if(tripsMatch){
    admin();
    if(!rows('dispatches').some(x=>x.id===decodeURIComponent(tripsMatch[1])))throw invalid();
    const items=rows('trips').filter(t=>t.dispatchId===decodeURIComponent(tripsMatch[1])).map(tripDto);
    return dto('dispatch_trips',paginate(items),{asOf,status:items.length?'READY':'EMPTY'});
  }
  if(path==='/api/v1/stockpile/me/pickups'){
    if(role!=='stock')throw forbidden();
    const items=rows('trips').map(tripDto);
    return dto('stockpile_pickups',paginate(items),{asOf,status:items.length?'READY':'EMPTY'});
  }
  if(path==='/api/v1/stockpile/me/receipts'){
    if(role!=='stock')throw forbidden();
    return wait('stockpile_receipts','Independent destination receipt verification is not implemented in the legacy backend.',asOf);
  }
  if(path==='/api/v1/master-data'){
    admin();
    return dto('master_data',{
      skus:rows('products').map(p=>({...p,
        density_t_per_m3:known(p.densityTPerM3),density_verified:p.densityVerified===true,
      })),stockpiles:scopedStock,crushers:rows('crushers'),
      trucks:rows('trucks').map(t=>({
        id:t.id,truck_id:t.id,code:t.code,
        plate:t.plate??null,plate_number:t.plate??null,
        bed_m3:known(t.bedM3),bed_capacity_m3:known(t.bedM3),
        payload_limit_t:known(t.payloadLimitT),
        cycle_time_minutes:known(t.cycleMinutes),active:t.active===true,
        availability_status:t.status??null,
      })),
      vessels:rows('vessels'),legacy_jetties:rows('jetties'),
      drivers:null,voyages:null,locations:null,
    },{asOf});
  }
  if(path==='/api/v1/operational-events'){
    admin();
    return dto('operational_events',paginate(rows('events').map(x=>({
      id:x.id,event_type:x.type,aggregate_id:x.entityId,occurred_at:x.at,
      actor_id:x.actorId,source:'LEGACY_AUDIT',
    }))),{asOf});
  }
  if(path==='/api/v1/exceptions'){
    admin();
    return wait('exceptions','Structured v1 exceptions and recovery workflows not yet implemented.',asOf);
  }
  if(path.startsWith('/api/v1/driver/')){
    if(role!=='driver')throw forbidden();
    return wait('driver_trip','Driver assignment and self-scope domain are not yet implemented.',asOf);
  }
  return null;
}

export function isV1UnimplementedMutation(path,method){
  return method!=='GET'&&method!=='HEAD'&&
    (path.startsWith('/api/v1/') || path.startsWith('/api/v1/integrations/'));
}
