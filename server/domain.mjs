import { randomUUID } from 'node:crypto';
import {isPhysicalCrusher,isDispatchSourceArea} from '../shared/inventory-areas.mjs';
import {previewMeasurementQuantity} from '../shared/measurement-units.mjs';
export { createSeed } from './seed.mjs';

const EPS=0.0000005, r=n=>Math.round(n*1e6)/1e6, now=()=>new Date().toISOString();
const activeStatuses=new Set(['start_pending','ready_to_load','loading','weighed','in_transit','arrived','unloaded','returning']);
const openTrip=t=>!['returned','cancelled'].includes(t.status);
export class DomainError extends Error { constructor(message,code='VALIDATION',status=400){super(message);this.name='DomainError';this.code=code;this.status=status;} }
const fail=(message,code,status)=>{throw new DomainError(message,code,status);};
const text=(x,label,max=160)=>{if(typeof x!=='string'||!x.trim()||x.trim().length>max)fail(`${label} wajib diisi (maks. ${max} karakter).`);return x.trim();};
const num=(x,label,min=0,max=1e9)=>{const n=Number(x);if(x===null||x===''||!Number.isFinite(n)||n<min||n>max)fail(`${label} tidak valid.`);return r(n);};
const positive=(x,label,max=1e9)=>num(x,label,0.000001,max);
const get=(s,key,id)=>s[key].find(x=>x.id===id)||fail(`${key}: data tidak ditemukan.`,'NOT_FOUND',404);
const admin=u=>{if(u?.role!=='admin')fail('Akses khusus Admin AIMOC.','FORBIDDEN',403);};
const scope=(u,role,id)=>{if(u?.role==='admin')return;if(u?.role!==role||!(u[role==='stock'?'crusherIds':'jettyIds']||[]).includes(id))fail('Akun tidak ditugaskan untuk lokasi ini.','FORBIDDEN',403);};
const uid=prefix=>`${prefix}-${randomUUID()}`;
const code=(prefix,list)=>`${prefix}-${String(list.length+1).padStart(5,'0')}`;
const nextReceiptCode=s=>`RCV-${String(s.trips.reduce((max,t)=>{const match=/^RCV-(\d+)$/.exec(t.receiptCode||'');return match?Math.max(max,Number(match[1])):max;},0)+1).padStart(5,'0')}`;
export function trimLegacyDisplayEvents(s){
  // Integrated event identities are retry receipts, not expendable UI history.
  // Bound only the legacy history; keep all integrated evidence in its order.
  const protectedEvent=e=>['INTEGRATED_DEMO','LEGACY_DEMO_RECONCILIATION'].includes(e.source);
  const legacy=s.events.filter(e=>!protectedEvent(e));
  if(legacy.length>1500){const expired=new Set(legacy.slice(0,legacy.length-1500));s.events=s.events.filter(e=>!expired.has(e));}
}
const record=(s,u,type,entityId,description)=>{
  s.events.push({id:uid('evt'),at:now(),actorId:u.id,actorName:u.name||u.username||u.id,role:u.role,type,entityId,description});
  trimLegacyDisplayEvents(s);
};
const erp=(s,type,entityId,payload)=>{s.erpOutbox.push({id:uid('erp'),createdAt:now(),type,entityId,status:'awaiting_configuration',system:'oracle_netsuite',payload});};
const ledger=(s,u,type,stockpileId,volumeM3,referenceId)=>s.inventoryLedger.push({id:uid('led'),at:now(),actorId:u.id,type,stockpileId,volumeM3:r(volumeM3),referenceId});
const tripScope=(s,u,t,role)=>scope(u,role,role==='stock'?get(s,'stockpiles',t.stockpileId).crusherId:t.jettyId);
const metricsForTruck=(s,t)=>{const trips=s.trips.filter(x=>x.truckId===t.id&&openTrip(x));const active=trips.find(x=>activeStatuses.has(x.status));const queued=trips.filter(x=>x.status==='queued').sort((a,b)=>a.sequence-b.sequence);return {...t,status:!t.active?'unavailable':active?'busy':queued.length?'allocated':'available',activeTripId:active?.id||null,queuedTrips:queued.length,nextTripId:queued[0]?.id||null,estimatedAvailableAt:active?.estimatedReturnAt||queued.at(-1)?.estimatedReturnAt||now()};};

function refreshStatuses(s){
  for(const d of s.dispatches){if(d.source==='INTEGRATED_DEMO'||d.status==='cancelled')continue;const tt=s.trips.filter(t=>t.dispatchId===d.id&&t.status!=='cancelled');d.completedTrips=tt.filter(t=>['unloaded','returned'].includes(t.status)).length;d.deliveredM3=r(tt.filter(t=>['unloaded','returned'].includes(t.status)).reduce((a,t)=>a+t.volumeM3,0));d.deliveredT=r(tt.filter(t=>['unloaded','returned'].includes(t.status)).reduce((a,t)=>a+t.tonnageT,0));d.status=tt.length&&d.completedTrips===tt.length?'completed':tt.some(t=>t.status!=='queued')?'in_progress':'planned';}
  for(const req of s.requests){if(req.source==='INTEGRATED_DEMO'||req.status==='cancelled')continue;const ds=s.dispatches.filter(d=>d.requestId===req.id&&d.status!=='cancelled');req.deliveredM3=r(ds.reduce((a,d)=>a+(d.deliveredM3||0),0));req.deliveredT=r(ds.reduce((a,d)=>a+(d.deliveredT||0),0));if(ds.length)req.status=ds.every(d=>d.status==='completed')?'completed':ds.some(d=>d.status==='in_progress'||d.status==='completed')?'in_progress':'planned';}
}

function saveMaster(s,entity,p,u){
  admin(u);
  const keys={product:'products',crusher:'crushers',stockpile:'stockpiles',truck:'trucks',jetty:'jetties',vessel:'vessels'};
  const key=keys[entity];if(!key)fail('Master tidak didukung.');
  const prev=p.id?get(s,key,p.id):null;
  if(entity==='crusher'&&(prev?.kind==='RECEIVING_AREA'||['kind','production','sourceEligible','managedBy','stockpileLocationId'].some(k=>Object.hasOwn(p,k))))fail('Area penerimaan dikelola otomatis melalui lokasi stockpile.','SYSTEM_MANAGED_AREA',409);
  if(entity==='stockpile'&&prev?.managedBy==='STOCKPILE_LOCATION'&&((p.crusherId!==undefined&&p.crusherId!==prev.crusherId)||(p.skuId!==undefined&&p.skuId!==prev.skuId)))fail('Identitas persediaan penerimaan dikelola otomatis.','SYSTEM_MANAGED_STOCKPILE',409);
  const row={...(prev||{}),id:prev?.id||uid(entity),code:text(p.code??prev?.code,'Kode',64),active:p.active===undefined?(prev?.active??true):Boolean(p.active)};
  const referenceField={product:'skuId',crusher:'crusherId',stockpile:'stockpileId',truck:'truckId',jetty:'jettyId',vessel:'vesselId'}[entity];
  if(prev&&!row.active&&s.trips.some(t=>t[referenceField]===row.id&&openTrip(t)))fail('Master masih memiliki ritase yang belum kembali. Selesaikan pekerjaan sebelum menonaktifkan.','OPEN_WORK',409);
  if(s[key].some(x=>x.id!==row.id&&x.code.toLowerCase()===row.code.toLowerCase()))fail('Kode sudah digunakan.','DUPLICATE',409);
  if(['product','crusher','jetty','vessel'].includes(entity))row.name=text(p.name??prev?.name,'Nama');
  if(entity==='product'){row.sizeMm=text(p.sizeMm??prev?.sizeMm,'Ukuran batu',80);row.densityTPerM3=positive(p.densityTPerM3??prev?.densityTPerM3,'Berat jenis',5);}
  if(entity==='stockpile'){
    row.crusherId=get(s,'crushers',p.crusherId??prev?.crusherId).id;row.skuId=get(s,'products',p.skuId??prev?.skuId).id;
    if(prev&&(prev.crusherId!==row.crusherId||prev.skuId!==row.skuId)&&(prev.onHandM3>EPS||prev.reservedM3>EPS||s.trips.some(t=>t.stockpileId===row.id)||s.measurements.some(m=>m.stockpileId===row.id)||s.inventoryLedger.some(l=>l.stockpileId===row.id)))fail('Identitas stockpile yang memiliki stok, pengukuran, atau riwayat tidak boleh diganti.');
    const skus=new Set(s.stockpiles.filter(x=>x.id!==row.id&&x.crusherId===row.crusherId&&x.active).map(x=>x.skuId));skus.add(row.skuId);if(row.active&&isPhysicalCrusher(get(s,'crushers',row.crusherId))&&skus.size>6)fail('Satu crusher maksimal menghasilkan enam SKU.');
    row.onHandM3=num(p.onHandM3??prev?.onHandM3??0,'Stok m³');row.reservedM3=prev?.reservedM3||0;if(row.onHandM3+EPS<row.reservedM3)fail('Stok tidak boleh lebih rendah dari stok tereservasi.');
    if(prev&&row.onHandM3!==prev.onHandM3)fail('Gunakan pengukuran dan persetujuan stok untuk mengubah stok existing.');
  }
  if(entity==='truck'){
    row.plate=text(p.plate??prev?.plate??row.code,'Identitas truk',60);row.bedM3=positive(p.bedM3??prev?.bedM3,'Volume bak',100);row.payloadLimitT=positive(p.payloadLimitT??prev?.payloadLimitT,'Batas payload',200);row.cycleMinutes=positive(p.cycleMinutes??prev?.cycleMinutes??30,'Waktu siklus',1440);
    if(s.trips.some(t=>t.truckId===row.id&&openTrip(t)&&(t.volumeM3>row.bedM3+EPS||t.tonnageT>row.payloadLimitT+EPS)))fail('Kapasitas lebih kecil dari penugasan yang belum selesai.');
    if(!row.active&&s.trips.some(t=>t.truckId===row.id&&openTrip(t)))fail('Truk masih memiliki pekerjaan yang belum selesai.');
  }
  if(entity==='vessel'){
    row.jettyId=get(s,'jetties',p.jettyId??prev?.jettyId).id;row.payloadLimitT=positive(p.payloadLimitT??prev?.payloadLimitT,'Batas muatan operasional',100000);row.loadedT=prev?.loadedT||0;row.reservedT=prev?.reservedT||0;row.status=p.status??prev?.status??'waiting';if(!['waiting','loading','closed'].includes(row.status))fail('Status kapal tidak valid.');
    if(row.payloadLimitT+EPS<row.loadedT+row.reservedT)fail('Batas muatan kurang dari muatan dan reservasi.');
    if(prev&&prev.jettyId!==row.jettyId&&row.reservedT>EPS)fail('Kapal memiliki pengiriman aktif pada jetty sebelumnya.');
    if(row.status==='closed'&&row.reservedT>EPS)fail('Kapal masih memiliki muatan dalam perjalanan/antrean.');
  }
  if(prev)s[key][s[key].indexOf(prev)]=row;else s[key].push(row);
  record(s,u,'master.saved',row.id,`${entity} ${row.code} disimpan`);return{entityId:row.id,message:'Master tersimpan.'};
}

function deleteMaster(s,entity,p,u){
  admin(u);
  const keys={product:'products',crusher:'crushers',stockpile:'stockpiles',truck:'trucks',jetty:'jetties',vessel:'vessels'};
  const key=keys[entity];if(!key)fail('Master tidak didukung.');
  const row=get(s,key,p.id);
  if(entity==='crusher'&&row.kind==='RECEIVING_AREA')fail('Area penerimaan dikelola otomatis melalui lokasi stockpile.','SYSTEM_MANAGED_AREA',409);
  if(entity==='stockpile'&&row.managedBy==='STOCKPILE_LOCATION')fail('Persediaan penerimaan dikelola melalui lokasi stockpile.','SYSTEM_MANAGED_STOCKPILE',409);
  const referenced={
    product:()=>s.stockpiles.some(x=>x.skuId===row.id)||s.requests.some(x=>x.lines?.some(l=>l.skuId===row.id))||s.dispatches.some(x=>x.skuId===row.id)||s.trips.some(x=>x.skuId===row.id),
    crusher:()=>s.stockpiles.some(x=>x.crusherId===row.id)||s.dispatches.some(x=>x.crusherId===row.id)||s.trips.some(x=>x.crusherId===row.id)||s.measurements.some(x=>x.crusherId===row.id),
    stockpile:()=>row.onHandM3>EPS||row.reservedM3>EPS||s.requests.some(x=>x.lines?.some(line=>line.destinationStockpileId===row.id))||s.dispatches.some(x=>x.stockpileId===row.id)||s.trips.some(x=>x.stockpileId===row.id||x.destinationStockpileId===row.id)||s.measurements.some(x=>x.stockpileId===row.id)||s.inventoryLedger.some(x=>x.stockpileId===row.id),
    truck:()=>s.trips.some(x=>x.truckId===row.id),
    jetty:()=>s.vessels.some(x=>x.jettyId===row.id)||s.requests.some(x=>x.jettyId===row.id)||s.dispatches.some(x=>x.jettyId===row.id)||s.trips.some(x=>x.jettyId===row.id),
    vessel:()=>row.loadedT>EPS||row.reservedT>EPS||s.requests.some(x=>x.vesselId===row.id)||s.dispatches.some(x=>x.vesselId===row.id)||s.trips.some(x=>x.vesselId===row.id)
  }[entity];
  if(referenced())fail('Master masih digunakan oleh data operasional dan tidak dapat dihapus. Nonaktifkan master bila riwayat harus dipertahankan.','MASTER_IN_USE',409);
  s[key].splice(s[key].indexOf(row),1);
  record(s,u,'master.deleted',row.id,`${entity} ${row.code} dihapus`);return{entityId:row.id,message:'Master dihapus.'};
}

function createRequest(s,p,u){
  // Land transfer requests are stored as planning requests only. They do not
  // trigger the legacy jetty/vessel dispatch planner or convert m3 to tonnes.
  if(p.transferMode==='LAND'){
    admin(u);
    const allowed=['transferMode','destinationId','destination','lines'];
    if(!p||Object.keys(p).some(k=>!allowed.includes(k)))fail('Field permintaan LAND tidak dikenali.','REQUEST_FIELD_INVALID',400);
    const destinationId=text(p.destinationId,'Destination ID',100);
    if(!/^[a-zA-Z0-9_-]{2,100}$/.test(destinationId))fail('ID lokasi tujuan LAND tidak valid.','DESTINATION_INVALID',400);
    const destination=text(p.destination,'Nama tujuan',160);
    if(!Array.isArray(p.lines)||!p.lines.length||p.lines.length>6)fail('Permintaan harus berisi 1–6 SKU.','REQUEST_LINES_INVALID',400);
    const seen=new Set();
    const lines=p.lines.map(l=>{
      const product=get(s,'products',l.skuId);
      if(!product.active||seen.has(product.id))fail('SKU nonaktif atau duplikat.','SKU_INVALID',400);
      seen.add(product.id);
      const quantity=positive(l.quantity,'Jumlah transfer',1000000);
      if(!['m3','t'].includes(l.unit))fail('Satuan harus m3 atau t.','UNIT_INVALID',400);
      return {skuId:product.id,quantity,unit:l.unit,volumeM3:null,tonnageT:null,
        quantitySource:'REQUESTED_UNVERIFIED'};
    });
    const req={id:uid('req'),code:code('TR',s.requests),transferMode:'LAND',
      destinationId,destination,jettyId:null,vesselId:null,lines,status:'requested',
      planningStatus:'NOT_INTEGRATED',requestedBy:u.id,createdAt:now(),
      deliveredM3:0,deliveredT:0,quantitySource:'REQUESTED_UNVERIFIED'};
    s.requests.push(req);
    record(s,u,'request.created',req.id,req.code+': LAND '+lines.length+' SKU ke '+destination);
    return {entityId:req.id,message:'Permintaan LAND tersimpan. Dispatch planning belum terintegrasi.'};
  }
  if(p.transferMode!==undefined&&p.transferMode!=='MARINE')fail('Mode harus LAND atau MARINE.','TRANSFER_MODE_INVALID',400);

  const jetty=get(s,'jetties',p.jettyId);scope(u,'jetty',jetty.id);const vessel=get(s,'vessels',p.vesselId);
  if(vessel.jettyId!==jetty.id||vessel.active===false||vessel.status==='closed'||jetty.active===false)fail('Kapal dan jetty tidak cocok, nonaktif, atau sudah ditutup.');
  if(!Array.isArray(p.lines)||!p.lines.length||p.lines.length>6)fail('Permintaan harus berisi 1–6 SKU.');
  const seen=new Set();const lines=p.lines.map(l=>{const product=get(s,'products',l.skuId);if(!product.active||seen.has(product.id))fail('SKU nonaktif atau duplikat.');seen.add(product.id);const quantity=positive(l.quantity,'Jumlah transfer',1000000);if(!['m3','t'].includes(l.unit))fail('Satuan harus m3 atau t.');const volumeM3=l.unit==='m3'?quantity:r(quantity/product.densityTPerM3);return{skuId:product.id,quantity,unit:l.unit,volumeM3,tonnageT:r(volumeM3*product.densityTPerM3),densityTPerM3:product.densityTPerM3};});
  const req={id:uid('req'),code:code('TR',s.requests),transferMode:'MARINE',jettyId:jetty.id,vesselId:vessel.id,destination:text(p.destination||'Stockpile Marunda','Tujuan',160),lines,status:'requested',requestedBy:u.id,createdAt:now(),deliveredM3:0,deliveredT:0};s.requests.push(req);record(s,u,'request.created',req.id,`${req.code}: ${lines.length} SKU ke ${vessel.name}`);return{entityId:req.id,message:'Permintaan transfer dibuat.'};
}

function planRequest(s,p,u){
  admin(u);const req=get(s,'requests',p.requestId);if(req.transferMode==='LAND')fail('LAND dispatch planner belum terintegrasi. Request tersimpan tanpa reservasi.','LAND_DISPATCH_NOT_INTEGRATED',409);if(req.status!=='requested')fail('Permintaan sudah direncanakan.','ALREADY_PLANNED',409);
  const vessel=get(s,'vessels',req.vesselId);if(vessel.active===false||get(s,'jetties',req.jettyId).active===false||vessel.status==='closed'||vessel.jettyId!==req.jettyId)fail('Tujuan kapal atau jetty tidak lagi tersedia.');
  const totalT=r(req.lines.reduce((a,l)=>a+l.tonnageT,0));if(totalT>vessel.payloadLimitT-vessel.loadedT-vessel.reservedT+EPS)fail('Sisa kapasitas kapal tidak mencukupi termasuk reservasi berjalan.','VESSEL_CAPACITY',409);
  const claimedTruckIds=new Set(s.trips.filter(openTrip).map(t=>t.truckId).filter(Boolean));
  const fleet=s.trucks.filter(t=>t.active&&!claimedTruckIds.has(t.id));if(!fleet.length)fail('Tidak ada truk tersedia. Truk baru dapat digunakan setelah seluruh ritase dispatch sebelumnya selesai.','NO_AVAILABLE_TRUCKS',409);
  const allocations=[];
  for(const line of req.lines){if(!get(s,'products',line.skuId).active)fail('SKU dalam permintaan sudah nonaktif.');let remaining=line.volumeM3;const stocks=s.stockpiles.filter(x=>x.active&&x.skuId===line.skuId&&isDispatchSourceArea(get(s,'crushers',x.crusherId))).sort((a,b)=>(b.onHandM3-b.reservedM3)-(a.onHandM3-a.reservedM3)||a.code.localeCompare(b.code));for(const stock of stocks){const take=r(Math.min(remaining,stock.onHandM3-stock.reservedM3));if(take>EPS){allocations.push({stock,line,volumeM3:take});remaining=r(remaining-take);}if(remaining<=EPS)break;}if(remaining>EPS)fail(`Stok tersedia ${get(s,'products',line.skuId).name} tidak mencukupi.`,'INSUFFICIENT_STOCK',409);}
  const loads=new Map(fleet.map(t=>[t.id,s.trips.filter(x=>x.truckId===t.id&&openTrip(x)).length*t.cycleMinutes]));const result=[];let globalSequence=s.trips.reduce((m,t)=>Math.max(m,t.sequence||0),0);
  const initialTripCount=s.trips.length;let totalTripsEstimate=0;for(const a of allocations){const maxCap=Math.max(...fleet.map(t=>Math.min(t.bedM3,t.payloadLimitT/a.line.densityTPerM3)));totalTripsEstimate+=Math.ceil(a.volumeM3/maxCap);}if(totalTripsEstimate>2000||s.trips.length+totalTripsEstimate>20000)fail('Permintaan terlalu besar untuk satu rencana (maks. 2.000 ritase).','TRIP_LIMIT',409);
  const stockpileIds=[...new Set(allocations.map(a=>a.stock.id))],crusherIds=[...new Set(allocations.map(a=>a.stock.crusherId))],skuIds=[...new Set(allocations.map(a=>a.line.skuId))];
  const dispatch={id:uid('dsp'),code:code('DSP',s.dispatches),requestId:req.id,
    stockpileId:stockpileIds.length===1?stockpileIds[0]:null,
    crusherId:crusherIds.length===1?crusherIds[0]:null,
    skuId:skuIds.length===1?skuIds[0]:null,
    stockpileIds,crusherIds,skuIds,
    allocations:allocations.map(a=>({stockpileId:a.stock.id,crusherId:a.stock.crusherId,skuId:a.line.skuId,
      volumeM3:a.volumeM3,tonnageT:r(a.volumeM3*a.line.densityTPerM3)})),
    jettyId:req.jettyId,vesselId:req.vesselId,
    volumeM3:r(allocations.reduce((total,a)=>total+a.volumeM3,0)),
    tonnageT:r(allocations.reduce((total,a)=>total+a.volumeM3*a.line.densityTPerM3,0)),
    tripIds:[],status:'planned',createdAt:now(),completedTrips:0,deliveredM3:0,deliveredT:0};
  s.dispatches.push(dispatch);result.push(dispatch.id);
  for(const a of allocations){let remaining=a.volumeM3;
    while(remaining>EPS){if(s.trips.length-initialTripCount>=2000||s.trips.length>=20000)fail('Rencana aktual melampaui batas ritase. Pecah permintaan menjadi beberapa batch.','TRIP_LIMIT',409);const truck=[...fleet].sort((a,b)=>loads.get(a.id)-loads.get(b.id)||a.code.localeCompare(b.code))[0];const volumeM3=r(Math.min(remaining,truck.bedM3,Math.floor(truck.payloadLimitT/a.line.densityTPerM3*1e6)/1e6));if(volumeM3<=EPS)fail('Kapasitas truk terlalu kecil.');const readyMinutes=loads.get(truck.id);const t={id:uid('trip'),code:code('RIT',s.trips),dispatchId:dispatch.id,requestId:req.id,stockpileId:a.stock.id,crusherId:a.stock.crusherId,skuId:a.line.skuId,truckId:truck.id,jettyId:req.jettyId,vesselId:req.vesselId,volumeM3,tonnageT:r(volumeM3*a.line.densityTPerM3),densityTPerM3:a.line.densityTPerM3,status:'queued',sequence:++globalSequence,createdAt:now(),estimatedStartAt:new Date(Date.now()+readyMinutes*60000).toISOString(),estimatedReturnAt:new Date(Date.now()+(readyMinutes+truck.cycleMinutes)*60000).toISOString()};s.trips.push(t);dispatch.tripIds.push(t.id);loads.set(truck.id,readyMinutes+truck.cycleMinutes);remaining=r(remaining-volumeM3);}
    a.stock.reservedM3=r(a.stock.reservedM3+a.volumeM3);
  }
  const actualReservedT=r(s.trips.filter(t=>t.requestId===req.id).reduce((a,t)=>a+t.tonnageT,0));if(actualReservedT>vessel.payloadLimitT-vessel.loadedT-vessel.reservedT+EPS)fail('Pembulatan kuantitas melampaui kapasitas kapal; kurangi sedikit permintaan.','VESSEL_CAPACITY',409);vessel.reservedT=r(vessel.reservedT+actualReservedT);req.dispatchId=dispatch.id;req.status='planned';req.plannedAt=now();req.plannedBy=u.id;record(s,u,'request.planned',req.id,`${req.code}: 1 dispatch, ${dispatch.tripIds.length} ritase serial`);return{entityId:req.id,dispatchIds:result,message:'Stok dan kapasitas kapal direservasi; antrean truk dibuat.'};
}

function moveTrip(s,action,p,u){
  const t=get(s,'trips',p.tripId),truck=get(s,'trucks',t.truckId),stock=get(s,'stockpiles',t.stockpileId),vessel=get(s,'vessels',t.vesselId);
  const transitions={start:['queued','loading','stock'],depart:['loading','in_transit','stock'],arrive:['in_transit','arrived','jetty'],unload:['arrived','unloaded','jetty'],return:['unloaded','returned','stock']};const rule=transitions[action];if(!rule)fail('Transisi tidak didukung.');
  if(action==='return'&&u.role==='jetty')tripScope(s,u,t,'jetty');else tripScope(s,u,t,rule[2]);
  if(t.status!==rule[0])fail(`Ritase berstatus ${t.status}; tindakan ini membutuhkan ${rule[0]}.`,'INVALID_TRANSITION',409);
  if(p.jettyId&&p.jettyId!==t.jettyId||p.vesselId&&p.vesselId!==t.vesselId||p.skuId&&p.skuId!==t.skuId)fail('Tujuan jetty/kapal atau SKU tidak sesuai dispatch.','DESTINATION_MISMATCH',409);
  if(['start','depart','arrive','unload'].includes(action)&&(vessel.active===false||vessel.status==='closed'||get(s,'jetties',t.jettyId).active===false))fail('Tujuan kapal atau jetty nonaktif. Hubungi Admin.','INACTIVE_DESTINATION',409);
  if(['start','depart'].includes(action)&&(!stock.active||!get(s,'crushers',stock.crusherId).active||!get(s,'products',t.skuId).active))fail('Sumber stockpile, crusher, atau SKU nonaktif. Hubungi Admin.','INACTIVE_SOURCE',409);
  if(action==='start'){
    if(!truck.active||s.trips.some(x=>x.id!==t.id&&x.truckId===t.truckId&&activeStatuses.has(x.status)))fail('Truk masih menjalankan ritase lain.','TRUCK_BUSY',409);
    if(s.trips.some(x=>x.truckId===t.truckId&&x.status==='queued'&&x.sequence<t.sequence))fail('Selesaikan antrean truk sesuai urutan serial.','QUEUE_ORDER',409);
    t.startedAt=now();t.estimatedReturnAt=new Date(Date.now()+truck.cycleMinutes*60000).toISOString();
  }
  if(action==='depart'){
    if(stock.onHandM3+EPS<t.volumeM3||stock.reservedM3+EPS<t.volumeM3)fail('Saldo stok/reservasi tidak mencukupi.','STOCK_CONFLICT',409);
    if(p.tareT===undefined||p.grossT===undefined)fail('Tare dan gross wajib dicatat sebelum keberangkatan.','WEIGHT_REQUIRED',409);
    const tareT=positive(p.tareT,'Tare (ton)'),grossT=positive(p.grossT,'Gross (ton)');if(grossT<=tareT||Math.abs(r(grossT-tareT)-t.tonnageT)>0.001)fail('Netto timbang harus sesuai kuantitas reservasi. Selisih memerlukan rekonsiliasi Admin.','WEIGHT_RECONCILIATION',409);t.tareT=tareT;t.grossT=grossT;t.quantitySource='operator_entered_weight';
    stock.onHandM3=r(stock.onHandM3-t.volumeM3);stock.reservedM3=r(stock.reservedM3-t.volumeM3);t.departedAt=now();ledger(s,u,'transfer_departed',stock.id,-t.volumeM3,t.id);erp(s,'stock_transfer_departed',t.id,{tripCode:t.code,skuId:t.skuId,volumeM3:t.volumeM3,tonnageT:t.tonnageT,sourceStockpileId:stock.id,jettyId:t.jettyId,vesselId:t.vesselId});
  }
  if(action==='arrive')t.arrivedAt=now();
  if(action==='unload'){
    if(vessel.status!=='loading')fail('Kapal belum aktif loading. Admin harus membuka status loading.','VESSEL_NOT_LOADING',409);
    if(vessel.jettyId!==t.jettyId||vessel.loadedT+t.tonnageT>vessel.payloadLimitT+EPS||vessel.reservedT+EPS<t.tonnageT)fail('Tujuan atau kapasitas kapal tidak valid.','VESSEL_CAPACITY',409);
    vessel.loadedT=r(vessel.loadedT+t.tonnageT);vessel.reservedT=r(vessel.reservedT-t.tonnageT);t.unloadedAt=now();t.receiptCode=nextReceiptCode(s);t.receivedBy=u.id;ledger(s,u,'vessel_received',stock.id,0,t.id);erp(s,'stock_transfer_received',t.id,{tripCode:t.code,receiptCode:t.receiptCode,skuId:t.skuId,volumeM3:t.volumeM3,tonnageT:t.tonnageT,jettyId:t.jettyId,vesselId:t.vesselId});
  }
  if(action==='return')t.returnedAt=now();t.status=rule[1];record(s,u,`trip.${action}`,t.id,`${t.code} → ${t.status}`);refreshStatuses(s);return{entityId:t.id,message:`Ritase ${t.code}: ${t.status}.`};
}

export function previewLandFleetAllocation(s,requestId){
  const request=get(s,'requests',requestId);
  if(request.transferMode!=='LAND')fail('Fleet allocation preview hanya tersedia untuk permintaan LAND.','TRANSFER_MODE_INVALID',400);
  const positiveFinite=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))&&Number(value)>0?Number(value):null;
  const trucks=(s.trucks||[]).map(t=>{
    const hasOpenTrip=(s.trips||[]).some(x=>x.truckId===t.id&&openTrip(x));
    const active=t.active===true;
    const payloadLimit=positiveFinite(t.payloadLimitT),bedCapacity=positiveFinite(t.bedM3),cycleTime=positiveFinite(t.cycleMinutes);
    const masterComplete=payloadLimit!==null&&bedCapacity!==null&&cycleTime!==null;
    return {
      truck_id:t.id,plate_number:t.plate||null,
      payload_limit_t:payloadLimit,bed_capacity_m3:bedCapacity,cycle_time_minutes:cycleTime,
      active:t.active===true?true:t.active===false?false:null,
      busy:hasOpenTrip,
      availability:t.active===false?'INACTIVE':!active||!masterComplete?'PENDING_VERIFICATION':hasOpenTrip?'BUSY':'AVAILABLE',
    };
  });
  const lines=(request.lines||[]).map(line=>{
    const product=(s.products||[]).find(x=>x.id===line.skuId);
    const density=product?.densityVerified===true?positiveFinite(product.densityTPerM3):null;
    const densityVerified=density!==null;
    const truckCapacities=trucks.map(t=>({
      truck_id:t.truck_id,
      effective_capacity_t:densityVerified&&t.active===true&&t.payload_limit_t!==null&&t.bed_capacity_m3!==null
        ?Math.min(t.payload_limit_t,t.bed_capacity_m3*density):null,
    }));
    const availableCapacity=truckCapacities.reduce((max,x)=>x.effective_capacity_t===null||trucks.find(t=>t.truck_id===x.truck_id)?.availability!=='AVAILABLE'?max:Math.max(max,x.effective_capacity_t),0);
    return {
      sku_id:line.skuId,requested_quantity:line.quantity,unit:line.unit,
      quantity_source:'REQUESTED_UNVERIFIED',
      density_status:densityVerified?'VERIFIED':'PENDING_VERIFICATION',
      truck_capacities:truckCapacities,
      effective_capacity_t:availableCapacity||null,
      estimated_trips:null,
    };
  });
  const reasons=['LAND_DESTINATION_UNVERIFIED','DRIVER_INTEGRATION_UNAVAILABLE','LAND_EXECUTION_NOT_INTEGRATED'];
  if(lines.some(x=>x.density_status!=='VERIFIED'))reasons.push('SKU_DENSITY_UNVERIFIED');
  if(trucks.some(x=>x.availability==='PENDING_VERIFICATION'))reasons.push('TRUCK_MASTER_INCOMPLETE');
  const availableTrucks=trucks.filter(x=>x.availability==='AVAILABLE').length;
  if(!availableTrucks)reasons.push('NO_AVAILABLE_TRUCKS');
  const pendingTruckData=trucks.some(x=>x.availability==='PENDING_VERIFICATION');
  return {
    request_id:request.id,transfer_mode:'LAND',destination_id:request.destinationId??null,
    destination_name:request.destination??null,source:'LEGACY_MASTER_SNAPSHOT',
    data_mode:s.dataMode||'UNKNOWN',
    status:availableTrucks||pendingTruckData?'PENDING_VERIFICATION':'INSUFFICIENT',
    requested_quantity:lines.map(({sku_id,requested_quantity,unit})=>({sku_id,requested_quantity,unit})),
    available_trucks:availableTrucks,eligible_trucks:0,recommended_trucks:[],
    estimated_trips:null,
    busy_trucks:trucks.filter(x=>x.busy).length,
    trucks,lines,assigned_driver_id:null,driver_status:'PENDING_VERIFICATION',
    reasons,operational_dispatch_enabled:false,
  };
}

function createMeasurement(s,p,u){
  if(!['admin','stock'].includes(u?.role))fail('Hanya Admin atau operator Stockpile dapat mengajukan pengukuran.','FORBIDDEN',403);
  const stock=get(s,'stockpiles',p.stockpileId),product=get(s,'products',p.skuId||stock.skuId);scope(u,'stock',stock.crusherId);if(!stock.active||!get(s,'crushers',stock.crusherId).active||!product.active)fail('Stockpile, crusher, atau SKU sudah nonaktif.');
  const method=p.method||'camera_pending';if(!['manual','calibrated_geometry','camera_pending'].includes(method))fail('Metode pengukuran tidak dikenal.');
  if(method==='camera_pending'&&u.role!=='stock')fail('Bukti kamera diajukan oleh operator Stockpile.','FORBIDDEN',403);
  let volumeM3=null,geometry=null,quantityFields={};
  const hasQuantity=Object.hasOwn(p,'quantityValue')||Object.hasOwn(p,'quantityUnit');
  if(method!=='manual'&&hasQuantity)fail('Satuan survei hanya berlaku untuk hasil survei lapangan.','INVALID_MEASUREMENT_UNIT');
  if(method==='manual'){
    if(['tonnageT','densityTPerM3','densityTPerM3Snapshot','conversionBasis','unit','quantity','weightT','tonnes'].some(key=>Object.hasOwn(p,key))||hasQuantity&&Object.hasOwn(p,'volumeM3'))fail('Kirim nilai dan satuan survei asli saja; konversi ditentukan server.','AMBIGUOUS_MEASUREMENT_QUANTITY');
    const converted=previewMeasurementQuantity(hasQuantity?p.quantityValue:p.volumeM3,hasQuantity?p.quantityUnit:'m3',product.densityTPerM3);
    if(!converted.valid){const messages={INVALID_MEASUREMENT_UNIT:'Pilih satuan survei m³ atau ton.',INVALID_MEASUREMENT_QUANTITY:'Jumlah hasil survei harus angka 0–1.000.000.000 dengan maksimal enam desimal.',INVALID_MEASUREMENT_DENSITY:'Berat jenis SKU harus valid sebelum hasil survei ton dapat dikonversi.',INVALID_MEASUREMENT_CONVERSION:'Konversi hasil survei berada di luar batas atau ketelitian volume.'};fail(messages[converted.errorCode],converted.errorCode);}
    const {valid,errorCode,...stored}=converted;quantityFields={...stored,conversionBasis:'SKU_MASTER_SNAPSHOT'};volumeM3=stored.volumeM3;
  }
  if(method==='calibrated_geometry'){const g=p.geometry||{};geometry={lengthM:positive(g.lengthM,'Panjang',10000),widthM:positive(g.widthM,'Lebar',10000),heightM:positive(g.heightM,'Tinggi',500),shapeFactor:positive(g.shapeFactor??0.5,'Faktor bentuk',1)};volumeM3=r(geometry.lengthM*geometry.widthM*geometry.heightM*geometry.shapeFactor);}
  const m={id:uid('msr'),code:code('MSR',s.measurements),stockpileId:stock.id,crusherId:stock.crusherId,skuId:product.id,method,volumeM3,...quantityFields,geometry,status:method==='camera_pending'?'needs_calibration':'pending',stockLedgerSequence:s.inventoryLedger.filter(x=>x.stockpileId===stock.id).length,evidenceId:typeof p.evidenceId==='string'?p.evidenceId.slice(0,100):null,evidenceName:typeof p.evidenceName==='string'?p.evidenceName.slice(0,160):null,notes:typeof p.notes==='string'?p.notes.slice(0,500):'',createdAt:now(),createdBy:u.id,measurementLabel:method==='camera_pending'?'Bukti kamera, volume belum terukur':method==='calibrated_geometry'?'Estimasi geometri berdimensi — perlu validasi survei':'Hasil survei/operator — perlu persetujuan'};s.measurements.push(m);record(s,u,'measurement.created',m.id,`${m.code}: ${m.measurementLabel}`);return{entityId:m.id,message:volumeM3===null?'Bukti dicatat. Volume memerlukan kalibrasi/survei.':'Pengukuran menunggu persetujuan Admin.'};
}

export function applyAction(s,action,p={},u){
  if(!u?.id||!['admin','stock','jetty'].includes(u.role))fail('Sesi pengguna tidak valid.','UNAUTHORIZED',401);
  if(typeof action!=='string')fail('Tindakan wajib diisi.');let result;
  if(/^master\.(product|crusher|stockpile|truck|jetty|vessel)\.save$/.test(action))result=saveMaster(s,action.split('.')[1],p,u);
  else if(/^master\.(product|crusher|stockpile|truck|jetty|vessel)\.delete$/.test(action))result=deleteMaster(s,action.split('.')[1],p,u);
  else if(action==='request.create')result=createRequest(s,p,u);
  else if(action==='request.plan')result=planRequest(s,p,u);
  else if(action.startsWith('trip.'))result=moveTrip(s,action.slice(5),p,u);
  else if(action==='measurement.create')result=createMeasurement(s,p,u);
  else if(action==='measurement.approve'){
    admin(u);const m=get(s,'measurements',p.measurementId);if(m.status!=='pending'||typeof m.volumeM3!=='number'||!Number.isFinite(m.volumeM3)||m.volumeM3<0)fail('Pengukuran belum terkalibrasi atau sudah diproses.','INVALID_MEASUREMENT',409);const stock=get(s,'stockpiles',m.stockpileId);if(s.inventoryLedger.filter(x=>x.stockpileId===stock.id).length!==m.stockLedgerSequence)fail('Stok sudah bergerak setelah pengukuran. Buat pengukuran baru agar saldo tidak menimpa transaksi.','STALE_MEASUREMENT',409);if(m.volumeM3+EPS<stock.reservedM3)fail('Volume pengukuran lebih kecil dari reservasi aktif.','RESERVED_STOCK',409);if(m.skuId!==stock.skuId&&stock.reservedM3>EPS)fail('SKU stockpile tidak dapat diganti selama masih memiliki reservasi aktif.','RESERVED_STOCK',409);const delta=r(m.volumeM3-stock.onHandM3);stock.skuId=m.skuId;stock.onHandM3=m.volumeM3;m.status='approved';m.approvedAt=now();m.approvedBy=u.id;ledger(s,u,'measurement_adjustment',stock.id,delta,m.id);erp(s,'inventory_measurement_approved',m.id,{stockpileId:stock.id,skuId:m.skuId,volumeM3:m.volumeM3,deltaM3:delta,method:m.method,...(Object.hasOwn(m,'quantityUnit')?Object.fromEntries(['quantityValue','quantityUnit','densityTPerM3Snapshot','tonnageT','conversionBasis'].filter(key=>Object.hasOwn(m,key)).map(key=>[key,m[key]])): {})});record(s,u,'measurement.approved',m.id,`${m.code}: saldo dan SKU stockpile diperbarui`);result={entityId:m.id,message:'Stok diperbarui dan jejak audit disimpan.'};
  }else fail('Tindakan tidak dikenal.','UNKNOWN_ACTION',400);
  s.updatedAt=now();return result;
}

export function publicState(s,u){
  const view=structuredClone(s);
  delete view.adminSidebarNotifications;
  if(u.role!=='admin')delete view.automaticDispatchUpgrade;
  if(u.role==='stock'){
    const ids=new Set(u.crusherIds||[]);view.crushers=view.crushers.filter(x=>ids.has(x.id));view.stockpiles=view.stockpiles.filter(x=>ids.has(x.crusherId));view.trips=view.trips.filter(x=>ids.has(x.crusherId));view.measurements=view.measurements.filter(x=>ids.has(x.crusherId));const stocks=new Set(view.stockpiles.map(x=>x.id));view.inventoryLedger=view.inventoryLedger.filter(x=>stocks.has(x.stockpileId));
    const trucks=new Set(view.trips.map(x=>x.truckId)),jetties=new Set(view.trips.map(x=>x.jettyId)),vessels=new Set(view.trips.map(x=>x.vesselId)),products=new Set([...view.stockpiles,...view.trips].map(x=>x.skuId));
    view.trucks=view.trucks.filter(x=>trucks.has(x.id));view.jetties=view.jetties.filter(x=>jetties.has(x.id));view.vessels=view.vessels.filter(x=>vessels.has(x.id));view.products=view.products.filter(x=>products.has(x.id));
    // Pickup operators need assigned trips, not Admin transfer or dispatch plans.
    view.requests=[];view.dispatches=[];
  }else if(u.role==='jetty'){
    const ids=new Set(u.jettyIds||[]);view.jetties=view.jetties.filter(x=>ids.has(x.id));view.vessels=view.vessels.filter(x=>ids.has(x.jettyId));view.trips=view.trips.filter(x=>ids.has(x.jettyId));view.dispatches=view.dispatches.filter(x=>ids.has(x.jettyId));view.requests=view.requests.filter(x=>ids.has(x.jettyId));view.measurements=[];view.inventoryLedger=[];
  }
  if(u.role!=='admin'){const visible=new Set([...view.stockpiles,...view.trips,...view.dispatches,...view.requests,...view.measurements].map(x=>x.id));view.events=view.events.filter(x=>visible.has(x.entityId));view.erpOutbox=view.erpOutbox.filter(x=>visible.has(x.entityId));}
  const visibleTripIds=new Set(view.trips.map(t=>t.id));
  view.trucks=view.trucks.map(t=>{const metrics=metricsForTruck(s,t);if(u.role!=='admin'){if(!visibleTripIds.has(metrics.activeTripId))metrics.activeTripId=null;if(!visibleTripIds.has(metrics.nextTripId))metrics.nextTripId=null;}return metrics;});
  const sum=(arr,key)=>r(arr.reduce((a,x)=>a+(x[key]||0),0));const activeTrips=view.trips.filter(t=>activeStatuses.has(t.status));
  view.metrics={onHandM3:sum(view.stockpiles,'onHandM3'),reservedM3:sum(view.stockpiles,'reservedM3'),availableM3:r(sum(view.stockpiles,'onHandM3')-sum(view.stockpiles,'reservedM3')),inTransitM3:sum(view.trips.filter(t=>['in_transit','arrived'].includes(t.status)),'volumeM3'),deliveredM3:sum(view.trips.filter(t=>['unloaded','returned'].includes(t.status)),'volumeM3'),deliveredT:sum(view.trips.filter(t=>['unloaded','returned'].includes(t.status)),'tonnageT'),availableTrucks:view.trucks.filter(t=>t.status==='available').length,busyTrucks:view.trucks.filter(t=>t.status==='busy').length,allocatedTrucks:view.trucks.filter(t=>t.status==='allocated').length,activeTrips:activeTrips.length,queuedTrips:view.trips.filter(t=>t.status==='queued').length,completedTrips:view.trips.filter(t=>['unloaded','returned'].includes(t.status)).length,openRequests:view.requests.filter(t=>!['completed','cancelled'].includes(t.status)).length,pendingMeasurements:view.measurements.filter(m=>m.status==='pending').length,erpPending:view.erpOutbox.length};
  view.products=view.products.map(p=>({...p,onHandM3:sum(view.stockpiles.filter(x=>x.skuId===p.id),'onHandM3'),reservedM3:sum(view.stockpiles.filter(x=>x.skuId===p.id),'reservedM3')}));
  for(const stock of view.stockpiles)stock.availableM3=r(stock.onHandM3-stock.reservedM3);
  for(const vessel of view.vessels)vessel.remainingT=r(vessel.payloadLimitT-vessel.loadedT-vessel.reservedT);
  // Product masters and fleet are shared; operational rows are scoped server-side.
  view.access={role:u.role,crusherIds:u.crusherIds||[],jettyIds:u.jettyIds||[]};view.erpStatus='awaiting_configuration';return view;
}
