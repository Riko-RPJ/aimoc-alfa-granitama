import React,{useEffect,useId,useRef,useState} from 'react';
import {ArrowRight,ClipboardList,Clock3,Loader2,Package,QrCode,RefreshCw,Truck,Wifi,WifiOff} from 'lucide-react';
import {useLanguage} from '../../i18n.js';
import {Button,Modal} from '../../components/ui/index.jsx';
import {AssignmentQr} from './AssignmentQr.jsx';
import './request-detail.css';

const list=value=>Array.isArray(value)?value:[];
const closed=new Set(['returned','completed','cancelled']);
const received=new Set(['unloaded','returning','returned']);
const stateLabels={
 requested:['Diminta','Requested'],planned:['Terencana','Planned'],allocated:['Teralokasi','Allocated'],
 queued:['Antre','Queued'],start_pending:['Menunggu QR / tare','Awaiting QR / tare'],ready_to_load:['Siap muat','Ready to load'],
 loading:['Memuat','Loading'],weighed:['Timbang selesai','Weighed'],in_transit:['Dalam perjalanan','In transit'],
 arrived:['Tiba','Arrived'],unloaded:['Diterima / bongkar','Received / unloaded'],returning:['Perjalanan kembali','Returning'],
 returned:['Kembali terverifikasi','Return verified'],completed:['Selesai','Completed'],cancelled:['Dibatalkan','Cancelled'],
 in_progress:['Berjalan','In progress'],waiting_truck:['Menunggu truk','Awaiting truck'],waiting_driver:['Menunggu pengemudi','Awaiting driver'],
 unassigned:['Belum dialokasikan','Unassigned'],waiting_assignment:['Menunggu penugasan','Awaiting assignment'],awaiting_assignment:['Menunggu penugasan','Awaiting assignment'],partially_cancelled:['Sebagian dibatalkan','Partially cancelled']
};
const describeStatus=(value,L)=>stateLabels[value]?L(...stateLabels[value]):L('Status belum tersedia','Status unavailable');
function Status({value,L}){return <span className={`rd-status rd-status-${value||'unknown'}`}>{describeStatus(value,L)}</span>;}
function assigned(trip){return !!(trip?.truckId&&trip?.assignedDriverUserId&&trip?.assignedDriver?.id===trip.assignedDriverUserId&&!['waiting_truck','waiting_driver','waiting_assignment','awaiting_assignment','unassigned'].includes(trip.status));}
function qrAvailable(trip){return assigned(trip)&&typeof trip.qr?.value==='string'&&trip.qr.value.length>0&&trip.qr.isAuthorization===false&&trip.qr.physicalScan===false;}
function historical(trip){return trip?.qr?.historical===true||closed.has(trip?.status);}
function waitingText(trip,L){if(!trip.truckId||trip.status==='waiting_truck')return L('Menunggu alokasi truk','Awaiting truck allocation');if(!trip.assignedDriverUserId||!trip.assignedDriver||trip.status==='waiting_driver')return L('Menunggu penugasan pengemudi','Awaiting driver assignment');return L('Penugasan belum tersedia atau belum valid','Assignment unavailable or not valid');}
function Metric({label,value,caption}){return <div className="rd-metric"><span>{label}</span><b>{value}</b>{caption&&<small>{caption}</small>}</div>;}

/** Read-only, request-scoped detail. Never sends allocation, scan, or trip commands. */
export function RequestDetailModal({requestId,L,onClose,onOpenTrip,onUnauthorized}){
 const language=useLanguage();
 const callbacks=useRef({onClose,onOpenTrip,onUnauthorized});callbacks.current={onClose,onOpenTrip,onUnauthorized};
 const [snapshot,setSnapshot]=useState(null),[error,setError]=useState(null),[loading,setLoading]=useState(true),[lastSync,setLastSync]=useState(null),[now,setNow]=useState(Date.now()),[selections,setSelections]=useState({});
 const generation=useRef(0),refreshRef=useRef(null);
 useEffect(()=>{
  const current=++generation.current,id=String(requestId||'');
  let disposed=false,inFlight=false,controller=null,unauthorized=false;
  setSnapshot(null);setLastSync(null);setError(null);setLoading(true);setSelections({});
  const valid=()=>!disposed&&generation.current===current;
  async function refresh(){
   if(!valid()||inFlight||unauthorized)return;
   if(!id){setError({kind:'invalid'});setLoading(false);return;}
   inFlight=true;controller=new AbortController();setLoading(true);
   try{
    const response=await fetch(`/api/v1/demo/requests/${encodeURIComponent(id)}/detail`,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if(!valid())return;
    if(!response.ok){
     if(response.status===401){unauthorized=true;callbacks.current.onUnauthorized?.();}
     throw Object.assign(new Error('Detail unavailable'),{kind:response.status===401?'auth':response.status===403?'forbidden':response.status===404?'missing':response.status===429?'rate':'server'});
    }
    let detail;try{detail=await response.json();}catch{throw Object.assign(new Error('Invalid response'),{kind:'format'});}
    if(!valid())return;
    if(!detail?.request||detail.request.id!==id)throw Object.assign(new Error('Request mismatch'),{kind:'mismatch'});
    setSnapshot({requestId:id,detail});setLastSync(Date.now());setNow(Date.now());setError(null);
   }catch(failure){if(valid()&&failure.name!=='AbortError')setError({kind:failure.kind||'network'});}
   finally{if(valid()){inFlight=false;setLoading(false);}}
  }
  refreshRef.current=refresh;refresh();
  const timer=setInterval(()=>{if(!valid())return;setNow(Date.now());if(document.visibilityState==='visible')refresh();},3000);
  const visible=()=>{if(document.visibilityState==='visible')refresh();};
  document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);
  return()=>{disposed=true;controller?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);if(refreshRef.current===refresh)refreshRef.current=null;};
 },[requestId]);
 const detail=snapshot?.requestId===String(requestId||'')?snapshot.detail:null;
 const request=detail?.request;
 // A defensive boundary keeps malformed or stale cross-request rows out of the UI.
 const trips=list(detail?.trips).filter(trip=>trip.requestId===requestId);
 const byId=new Map(trips.map(trip=>[trip.id,trip]));
 const dispatches=list(detail?.dispatches).filter(dispatch=>dispatch.requestId===requestId);
 const truckGroups=list(detail?.truckAssignments).filter(group=>group.truckId).map(group=>({...group,trips:trips.filter(trip=>trip.truckId===group.truckId&&qrAvailable(trip))})).filter(group=>group.trips.length);
 const groupByTruck=new Map(truckGroups.map(group=>[group.truckId,group]));
 const waiting=list(detail?.waitingLoads).map(trip=>byId.get(trip.id)).filter(Boolean);
 const extraWaiting=trips.filter(trip=>!assigned(trip)&&!waiting.some(row=>row.id===trip.id));
 const waitingRows=[...waiting,...extraWaiting];
 const summary=detail?.summary||{};
 const stale=!!error||!!detail&&(!lastSync||now-lastSync>10000);
 const fmt=(value,digits=2)=>value===null||value===undefined||value===''||!Number.isFinite(Number(value))?'—':Number(value).toLocaleString(language==='en'?'en-GB':'id-ID',{maximumFractionDigits:digits});
 const stamp=value=>{if(!value||!Number.isFinite(new Date(value).getTime()))return '—';return new Date(value).toLocaleString(language==='en'?'en-GB':'id-ID',{dateStyle:'short',timeStyle:'medium'});};
 const destination=trip=>trip.destinationLocationName||trip.destination||trip.destinationStockpileCode||L('Tujuan belum tersedia','Destination unavailable');
 const openTrip=id=>{if(!stale&&byId.has(id))callbacks.current.onOpenTrip?.(id);};
 const errorText=error&&({auth:L('Sesi berakhir. Silakan login kembali.','Your session ended. Sign in again.'),forbidden:L('Akun ini tidak dapat mengakses permintaan tersebut.','This account cannot access that request.'),missing:L('Permintaan tidak ditemukan atau sudah tidak tersedia.','The request was not found or is no longer available.'),rate:L('Detail belum dapat diperbarui. Coba lagi sebentar.','The details could not be refreshed. Try again shortly.'),invalid:L('Referensi permintaan tidak valid.','The request reference is invalid.'),mismatch:L('Respons tidak sesuai dengan permintaan yang dibuka. Muat ulang detail.','The response does not match the opened request. Reload the details.'),format:L('Respons detail belum dapat dibaca. Coba muat ulang.','The detail response could not be read. Try refreshing.'),server:L('Detail belum tersedia dari server. Coba muat ulang.','The server could not provide the details. Try refreshing.'),network:L('Koneksi terputus. Detail terakhir tetap ditampilkan bila tersedia.','The connection was interrupted. The last details remain visible when available.')}[error.kind]);
 return <Modal wide title={request?`${L('Detail permintaan','Request details')} · ${request.code}`:L('Detail permintaan transfer','Transfer request details')}
  subtitle={L('Ritase dan QR penugasan untuk permintaan yang dipilih.','Trips and assignment QR references for the selected request.')} onClose={()=>callbacks.current.onClose?.()}>
  <div className="request-detail" data-testid="request-detail" data-request-id={requestId}>
   <div className={`rd-connection ${stale?'stale':''}`}><span>{loading?<Loader2 size={15} className="spin"/>:stale?<WifiOff size={15}/>:<Wifi size={15}/>} {loading?L('Memperbarui detail…','Refreshing details…'):stale?L('Data terakhir · perlu diperbarui','Last received data · refresh needed'):L('Detail tersinkron','Details synchronized')}</span><div>{detail&&<small>{L('Revisi','Revision')} {detail.revision??'—'} · {stamp(lastSync)}</small>}<button type="button" className="rd-refresh" disabled={loading} aria-label={L('Muat ulang detail','Refresh request details')} onClick={()=>refreshRef.current?.()}><RefreshCw size={15}/></button></div></div>
   {error&&<div className="rd-error" role="alert"><span>{errorText||L('Detail belum dapat dimuat.','The details could not be loaded.')}</span><Button variant="secondary" disabled={loading} onClick={()=>refreshRef.current?.()}>{L('Coba lagi','Retry')}</Button></div>}
   {!detail?loading?<div className="rd-loading" role="status"><Loader2 size={26} className="spin"/><b>{L('Memuat permintaan yang dipilih…','Loading the selected request…')}</b></div>:<div className="rd-empty"><ClipboardList size={28}/><b>{L('Detail belum tersedia','Details unavailable')}</b><p>{L('Muat ulang detail atau tutup untuk memilih permintaan lain.','Refresh the details or close this dialog to choose another request.')}</p></div>:<>
    <div className="rd-request-head"><div><span className="rd-eyebrow">{request.code}</span><h3>{request.destinationLocationName||request.destination||L('Tujuan belum tersedia','Destination unavailable')}</h3><p>{request.destinationLocationCode||'—'} · {request.transferMode||'—'}</p></div><Status value={request.status} L={L}/></div>
    <div className="rd-metrics"><Metric label={L('Truk ditugaskan','Assigned trucks')} value={fmt(summary.assignedTruckCount,0)} caption={`${fmt(summary.assignedTrips,0)} ${L('ritase ditugaskan','assigned trips')}`}/><Metric label={L('Ritase / muatan permintaan ini','Trips / cargo in this request')} value={fmt(summary.tripCount,0)} caption={`${fmt(summary.waitingTrips,0)} ${L('menunggu alokasi','awaiting assignment')}`}/><Metric label={L('Muatan rencana','Planned load')} value={`${fmt(summary.plannedT)} t`} caption={`${fmt(summary.plannedM3)} m³`}/><Metric label={L('Diterima / sisa','Received / remaining')} value={`${fmt(summary.deliveredT)} / ${fmt(summary.remainingT)} t`} caption={`${fmt(summary.completedTrips,0)} ${L('ritase kembali','trips returned')}`}/></div>
    <section className="rd-section"><div className="rd-section-head"><h3>{L('Kebutuhan material','Material demand')}</h3></div><div className="rd-demand">{list(request.lines).map((line,index)=><div key={`${line.skuId}-${index}`}><span><b>{line.skuCode||'—'}</b><small>{line.skuName||'—'}</small></span><b>{fmt(line.quantity)} {line.unit==='m3'?'m³':line.unit||''}</b><small>{fmt(line.tonnageT)} t · {fmt(line.volumeM3)} m³</small></div>)}</div></section>
    <section className="rd-section"><div className="rd-section-head"><h3>{L('Ringkasan dispatch','Dispatch summary')}</h3><span>{dispatches.length} dispatch</span></div>{dispatches.length?<div className="rd-dispatches">{dispatches.map(dispatch=>{const own=trips.filter(trip=>trip.dispatchId===dispatch.id);return <article key={dispatch.id}><div><b>{dispatch.code}</b><Status value={dispatch.status} L={L}/></div><p>{fmt(dispatch.summary?.plannedT)} t · {fmt(dispatch.summary?.plannedM3)} m³</p><small>{own.length} {L('ritase','trips')} · {own.filter(trip=>received.has(trip.status)).length} {L('diterima','received')} · {own.filter(trip=>trip.status==='returned').length} {L('kembali','returned')}</small></article>;})}</div>:<div className="rd-inline-empty">{L('Belum ada dispatch untuk permintaan ini.','This request has no dispatch yet.')}</div>}</section>
    <section className="rd-section"><div className="rd-section-head"><div><h3>{L('Penugasan truk & QR ritase','Truck assignments & trip QR')}</h3><p>{L('Pilih ritase pada setiap truk untuk melihat QR penugasan yang sesuai.','Select a trip on each truck to view its matching assignment QR.')}</p></div></div>{truckGroups.length?<div className="rd-truck-grid">{truckGroups.map(group=><TruckAssignmentCard key={group.truckId} {...{group,L,fmt,stale,destination}} selectedId={selections[group.truckId]} onSelect={id=>setSelections(previous=>({...previous,[group.truckId]:id}))} onOpenTrip={openTrip}/>)}</div>:<div className="rd-empty rd-empty-small"><Truck size={27}/><b>{L('Belum ada truk yang ditugaskan','No trucks assigned yet')}</b><p>{L('QR tersedia setelah truk dan pengemudi ditugaskan pada ritase.','A QR reference is available after a truck and driver are assigned to a trip.')}</p></div>}</section>
    {waitingRows.length>0&&<section className="rd-section rd-waiting" data-testid="request-detail-waiting"><div className="rd-section-head"><div><h3>{L('Muatan menunggu alokasi','Cargo awaiting allocation')}</h3><p>{L('Muatan ini belum memiliki penugasan lengkap dan tidak memiliki QR.','These loads do not have a complete assignment and have no QR reference.')}</p></div><Clock3 size={20}/></div><div className="rd-waiting-list">{waitingRows.map(trip=><article key={trip.id} data-waiting-trip-id={trip.id}><div><b>{trip.code||trip.id}</b><small>{trip.skuCode||trip.skuName||'—'} · {fmt(trip.tonnageT)} t / {fmt(trip.volumeM3)} m³</small></div><span>{waitingText(trip,L)}</span><b className="rd-no-qr">{L('Tanpa QR','No QR')}</b></article>)}</div></section>}
    <section className="rd-section"><div className="rd-section-head"><h3>{L('Semua ritase / muatan permintaan ini','All trips / cargo in this request')}</h3><span>{trips.length} {L('ritase / muatan','trips / cargo')}</span></div>{trips.length?<div className="rd-table-scroll"><table className="rd-table"><thead><tr>{[L('Ritase / muatan / dispatch','Trip / cargo / dispatch'),L('Truk / pengemudi','Truck / driver'),L('SKU / muatan','SKU / load'),L('Sumber → tujuan','Source → destination'),L('Status','Status'),L('Tugas','Task')].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{trips.map(trip=><tr key={trip.id} data-request-trip-id={trip.id}><td><b>{trip.code}</b><small>{dispatches.find(dispatch=>dispatch.id===trip.dispatchId)?.code||'—'} · #{trip.sequence??'—'}</small></td><td><b>{trip.truckCode||groupByTruck.get(trip.truckId)?.truckCode||(trip.truckId?trip.truckId:L('Belum dialokasikan','Unassigned'))}</b><small>{trip.assignedDriver?.name||L('Pengemudi belum ditugaskan','Driver not assigned')}</small></td><td><b>{trip.skuCode||'—'}</b><small>{fmt(trip.tonnageT)} t / {fmt(trip.volumeM3)} m³</small></td><td>{trip.sourceStockpileCode||'—'}<small>→ {destination(trip)}</small></td><td><Status value={trip.status} L={L}/><small>{qrAvailable(trip)?historical(trip)?L('QR historis','Historical QR'):L('QR penugasan tersedia','Assignment QR available'):L('Tanpa QR penugasan','No assignment QR')}</small></td><td><Button variant="secondary" disabled={stale||!onOpenTrip} onClick={()=>openTrip(trip.id)}>{L('Buka tugas','Open task')}<ArrowRight size={13}/></Button></td></tr>)}</tbody></table></div>:<div className="rd-inline-empty">{L('Belum ada ritase. Permintaan ini belum menghasilkan penugasan truk atau QR.','No trips yet. This request has not produced truck assignments or QR references.')}</div>}</section>
    <footer className="rd-footer"><QrCode size={16}/><span>{L('QR adalah referensi ritase, bukan otorisasi atau bukti scan fisik. Scan dan aksi operasional tersedia di tugas ritase.','QR codes are trip references, not authorization or physical-scan evidence. Scan and operational actions are available in the trip task.')}</span><small>INTEGRATED_DEMO</small></footer>
   </>}
  </div>
 </Modal>;
}

function TruckAssignmentCard({group,L,fmt,stale,destination,selectedId,onSelect,onOpenTrip}){
 const selector=useId();
 const choices=list(group.trips).sort((a,b)=>(Number(a.sequence)||0)-(Number(b.sequence)||0));
 const trip=choices.find(row=>row.id===selectedId)||choices.find(row=>!closed.has(row.status))||choices[0];
 if(!trip)return null;
 const hasQr=qrAvailable(trip),isHistorical=historical(trip);
 return <article className="rd-truck-card" data-assigned-truck-id={group.truckId} data-selected-assignment-id={trip.id}>
  <div className="rd-truck-title"><span><Truck size={22}/></span><div><h4>{group.truckCode||group.truckId}</h4><p>{group.plate||'—'}</p></div><small>{choices.length} {L('ritase','trips')}</small></div>
  <label className="rd-trip-selector" htmlFor={selector}>{L('Ritase untuk QR ini','Trip for this QR')}<select id={selector} value={trip.id} onChange={event=>onSelect(event.target.value)}>{choices.map(row=><option key={row.id} value={row.id}>{row.code} · {row.skuCode||'—'} · {fmt(row.tonnageT)} t · {describeStatus(row.status,L)}</option>)}</select></label>
  <div className="rd-assignment-info"><div><small>{L('Pengemudi ditugaskan','Assigned driver')}</small><b>{trip.assignedDriver?.name||'—'}</b></div><Status value={trip.status} L={L}/></div>
  <div className="rd-qr-area">{hasQr?<><span className={`rd-qr-label ${isHistorical?'historical':''}`}>{isHistorical?L('QR historis · arsip ritase','Historical QR · trip archive'):L('QR referensi penugasan','Assignment reference QR')}</span><AssignmentQr value={trip.qr.value} label={`${L('QR ritase','Trip QR')} ${trip.code} · ${group.truckCode||group.truckId}`}/><b>{trip.code}</b></>:<div className="rd-qr-unavailable"><Package size={25}/><b>{L('QR belum tersedia','QR unavailable')}</b><small>{L('Penugasan truk dan pengemudi perlu lengkap.','A complete truck and driver assignment is required.')}</small></div>}</div>
  <div className="rd-card-route"><span>{trip.skuCode||'—'} · {fmt(trip.tonnageT)} t / {fmt(trip.volumeM3)} m³</span><p>{trip.sourceStockpileCode||'—'} → {destination(trip)}</p>{trip.jettyCode&&<small>{trip.jettyCode}{trip.vesselName?` · ${trip.vesselName}`:''}</small>}</div>
  <Button variant="secondary" disabled={stale} onClick={()=>onOpenTrip(trip.id)}>{L('Buka tugas ritase','Open trip task')}<ArrowRight size={14}/></Button>
 </article>;
}
