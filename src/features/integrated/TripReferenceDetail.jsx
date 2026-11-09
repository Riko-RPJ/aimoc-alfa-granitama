import React,{useEffect,useRef,useState} from 'react';
import {Clock3,Loader2,Package,QrCode,RefreshCw,Truck,Wifi,WifiOff} from 'lucide-react';
import {Button,Modal} from '../../components/ui/index.jsx';
import {useLanguage} from '../../i18n.js';
import {AssignmentQr} from './AssignmentQr.jsx';
import './trip-reference-detail.css';

const list=value=>Array.isArray(value)?value:[];
const waiting=new Set(['waiting_truck','waiting_driver','waiting_assignment','awaiting_assignment','unassigned']);
const terminal=new Set(['returned','completed','cancelled']);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
const stateLabels={waiting_truck:['Menunggu alokasi truk','Awaiting truck allocation'],waiting_driver:['Menunggu penugasan','Awaiting assignment'],waiting_assignment:['Menunggu penugasan','Awaiting assignment'],awaiting_assignment:['Menunggu penugasan','Awaiting assignment'],unassigned:['Belum dialokasikan','Unassigned'],queued:['Antre','Queued'],start_pending:['Menunggu QR / tare','Awaiting QR / tare'],ready_to_load:['Siap muat','Ready to load'],loading:['Memuat','Loading'],weighed:['Timbang selesai','Weighed'],in_transit:['Dalam perjalanan','In transit'],arrived:['Tiba','Arrived'],unloaded:['Diterima / bongkar','Received / unloaded'],returning:['Perjalanan kembali','Returning'],returned:['Kembali terverifikasi','Return verified'],completed:['Selesai','Completed'],cancelled:['Dibatalkan','Cancelled']};

/** Exact request/trip boundary: never reuse another trip's assignment details. */
export function selectTripReference(detail,requestId,tripId){
 if(!detail?.request||detail.request.id!==requestId)return null;
 const matches=list(detail.trips).filter(row=>row?.id===tripId&&row.requestId===requestId);
 if(matches.length!==1)return null;
 const trip=matches[0],dispatches=list(detail.dispatches).filter(row=>row?.id===trip.dispatchId&&row.requestId===requestId);
 return {trip,dispatch:dispatches.length===1?dispatches[0]:null,request:detail.request};
}

/** Render only a server-issued reference whose tuple matches the exact allocated trip. */
export function hasAssignmentQr(reference){
 const trip=reference?.trip,qr=trip?.qr;
 if(!reference?.dispatch||!trip||waiting.has(trip.status)||!validId(trip.id)||!validId(trip.requestId)||!validId(trip.dispatchId)||!validId(trip.truckId)||!validId(trip.assignedDriverUserId)||trip.assignedDriver?.id!==trip.assignedDriverUserId||typeof qr?.value!=='string'||qr.isAuthorization!==false||qr.physicalScan!==false)return false;
 try{
  const value=JSON.parse(qr.value);
  if(value?.v!==1)return false;
  if(value.type==='AIMOC_ASSIGNMENT_REFERENCE')return value.requestId===trip.requestId&&value.dispatchId===trip.dispatchId&&value.tripId===trip.id&&value.truckId===trip.truckId;
  return value.type==='AIMOC_DRIVER_DISPATCH_REFERENCE'&&Object.keys(value).length===5&&value.dispatchId===trip.dispatchId&&value.truckId===trip.truckId&&value.assignedDriverUserId===trip.assignedDriverUserId;
 }catch{return false;}
}

/** Wait for context and detail to agree before showing a changed truck's QR. */
export function hasCurrentAssignmentQr(reference,expectedTrip){
 if(!hasAssignmentQr(reference)||waiting.has(expectedTrip?.status))return false;
 return ['dispatchId','truckId','assignedDriverUserId'].every(key=>!Object.hasOwn(expectedTrip||{},key)||reference.trip[key]===expectedTrip[key]);
}

// Resolver fallbacks must not turn internal UUIDs into operator-facing labels.
const label=value=>typeof value==='string'&&!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)?value.trim():'';
function Reference({name,title,value,caption}){return <div className="trd-reference" data-trip-reference={name}><small>{title}</small><b>{value||'—'}</b>{caption&&<span>{caption}</span>}</div>;}

/** Admin-only presentation. This component issues GET requests and no operational commands. */
export function TripReferenceDetail({trip,L,source,destination,truck,product,fmt,onClose}){
 const language=useLanguage();
 const requestId=String(trip?.requestId||''),tripId=String(trip?.id||'');
 const identity=[requestId,tripId,trip?.dispatchId||'',trip?.truckId||'',trip?.assignedDriverUserId||''].join(':');
 const [snapshot,setSnapshot]=useState(null),[error,setError]=useState(null),[loading,setLoading]=useState(true),[lastSync,setLastSync]=useState(null),[now,setNow]=useState(Date.now());
 const generation=useRef(0),refreshRef=useRef(null);
 useEffect(()=>{
  const current=++generation.current;
  let disposed=false,inFlight=false,controller=null,accessDenied=false;
  const active=()=>!disposed&&generation.current===current;
  setSnapshot(null);setError(null);setLastSync(null);setLoading(true);
  async function refresh(manual=false){
   if(!active()||inFlight||accessDenied&&!manual)return;
   if(!validId(requestId)||!validId(tripId)){setError('invalid');setLoading(false);return;}
   inFlight=true;controller=new AbortController();setLoading(true);
   try{
    const response=await fetch(`/api/v1/demo/requests/${encodeURIComponent(requestId)}/detail`,{method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if(!active())return;
    if(!response.ok){
     if(response.status===401||response.status===403){accessDenied=true;setSnapshot(null);}
     throw Object.assign(new Error('REFERENCE_UNAVAILABLE'),{kind:response.status===401?'auth':response.status===403?'forbidden':response.status===404?'missing':response.status===429?'rate':'server'});
    }
    let detail;try{detail=await response.json();}catch{throw Object.assign(new Error('INVALID_RESPONSE'),{kind:'format'});}
    if(!active())return;
    const selected=selectTripReference(detail,requestId,tripId);
    if(!selected){setSnapshot(null);throw Object.assign(new Error('TRIP_REFERENCE_MISMATCH'),{kind:detail?.request?.id===requestId?'tripMissing':'mismatch'});}
    accessDenied=false;setSnapshot({identity,selected,revision:detail.revision});setLastSync(Date.now());setNow(Date.now());setError(null);
   }catch(failure){if(active()&&failure.name!=='AbortError')setError(failure.kind||'network');}
   finally{if(active()){inFlight=false;setLoading(false);}}
  }
  refreshRef.current=()=>refresh(true);refresh();
  const timer=setInterval(()=>{if(!active())return;setNow(Date.now());if(document.visibilityState==='visible')refresh();},3000);
  const visible=()=>{if(document.visibilityState==='visible')refresh();};
  document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);
  return()=>{disposed=true;controller?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);refreshRef.current=null;};
 },[identity,requestId,tripId]);

 const selected=snapshot?.identity===identity?snapshot.selected:null,latest=selected?.trip;
 const current=latest?{...trip,...latest,stockpileId:latest.sourceStockpileId||trip.stockpileId}:trip||{};
 const stale=Boolean(error)||Boolean(selected)&&(!lastSync||now-lastSync>10000);
 const hasQr=Boolean(selected)&&!stale&&hasCurrentAssignmentQr(selected,trip);
 const historical=latest&&(latest.historical===true||latest.qr?.historical===true||terminal.has(latest.status));
 const allocated=latest?Boolean(latest.truckId)&&!waiting.has(latest.status):Boolean(trip?.truckId)&&!waiting.has(trip?.status);
 const truckRecord=typeof truck==='function'?truck(current.truckId):null;
 const productRecord=typeof product==='function'?product(current.skuId):null;
 const truckCode=label(latest?latest.truckCode:truckRecord?.code),plate=label(latest?latest.plate:truckRecord?.plate);
 const sourceText=[label(latest?.sourceCrusherCode),label(latest?.sourceStockpileCode)].filter(Boolean).join(' / ')||label(typeof source==='function'?source(current):null);
 const land=current.transferMode==='LAND'||(!current.vesselId&&Boolean(current.destinationId||current.destinationCrusherId));
 const locationText=label(latest?.destinationLocationName)||label(latest?.destination);
 const destinationFallback=land?[locationText,label(latest?.destinationStockpileCode)].filter(Boolean).join(' / '):[[label(latest?.jettyCode),label(latest?.vesselName)].filter(Boolean).join(' / '),locationText].filter(Boolean).join(' → ');
 const destinationText=label(typeof destination==='function'?destination(current):null)||destinationFallback;
 const skuCode=label(latest?.skuCode)||label(productRecord?.code),skuName=label(latest?.skuName)||label(productRecord?.name);
 const format=(value,digits=2)=>numeric(value)?typeof fmt==='function'?fmt(value,digits):value.toLocaleString(language==='en'?'en-GB':'id-ID',{maximumFractionDigits:digits}):'—';
 const stamp=lastSync?new Date(lastSync).toLocaleTimeString(language==='en'?'en-GB':'id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
 const displayStatus=current.displayStatus||current.status;
 const status=stateLabels[displayStatus]?L(...stateLabels[displayStatus]):L('Status belum tersedia','Status unavailable');
 const errorText=error&&({auth:L('Sesi berakhir. Tutup panel dan login kembali.','Your session ended. Close this panel and sign in again.'),forbidden:L('Akun ini tidak memiliki akses ke rincian ritase tersebut.','This account cannot access these trip details.'),missing:L('Permintaan tidak ditemukan atau sudah tidak tersedia.','The request was not found or is no longer available.'),tripMissing:L('Ritase ini tidak tersedia pada permintaan yang dipilih.','This trip is unavailable in the selected request.'),invalid:L('Referensi ritase belum lengkap atau tidak valid.','The trip reference is incomplete or invalid.'),mismatch:L('Respons server tidak sesuai permintaan yang dipilih.','The server response does not match the selected request.'),format:L('Rincian dari server belum dapat dibaca. Coba muat ulang.','The server details could not be read. Try refreshing.'),rate:L('Pembaruan sedang dibatasi. Coba lagi sebentar.','Updates are temporarily limited. Try again shortly.'),server:L('Rincian belum tersedia dari server. Coba muat ulang.','The server could not provide the details. Try refreshing.'),network:L('Koneksi terputus. Referensi terakhir ditampilkan; QR disembunyikan sampai tersinkron kembali.','The connection was interrupted. Last received references remain visible; the QR is hidden until synchronization resumes.')}[error]);
 return <Modal wide title={`${L('Detail ritase','Trip details')} · ${label(current.code)||L('Belum tersedia','Unavailable')}`} subtitle={L('Dispatch, truk, material dan QR referensi untuk ritase yang dipilih.','Dispatch, truck, material and reference QR for the selected trip.')} onClose={onClose}>
  <div className="trip-reference-detail" data-testid="trip-reference-detail" data-trip-id={tripId}>
   <div className={`trd-connection ${stale?'stale':''}`} role="status"><span>{loading?<Loader2 size={15} className="spin"/>:stale?<WifiOff size={15}/>:<Wifi size={15}/>} {loading?L('Memperbarui rincian…','Refreshing details…'):stale?L('Perlu diperbarui','Refresh needed'):L('Rincian tersinkron','Details synchronized')}</span><div><small>{lastSync?stamp:L('Menunggu server','Waiting for server')}</small><button type="button" disabled={loading} aria-label={L('Muat ulang detail ritase','Refresh trip details')} onClick={()=>refreshRef.current?.()}><RefreshCw size={15}/></button></div></div>
   {error&&<div className="trd-error" role="alert"><p>{errorText||L('Rincian belum dapat dimuat.','Details could not be loaded.')}</p><Button variant="secondary" disabled={loading} onClick={()=>refreshRef.current?.()}>{L('Coba lagi','Retry')}</Button></div>}
   <div className="trd-heading"><span>{L('Ringkasan ritase','Trip summary')}</span><b className={`trd-status ${terminal.has(current.status)?'complete':''}`}>{status}</b></div>
   <div className="trd-reference-grid">
    <Reference name="dispatch" title={L('Dispatch','Dispatch')} value={label(selected?.dispatch?.code)} />
    <Reference name="trip" title={L('Ritase','Trip')} value={label(current.code)} />
    <Reference name="truck" title={L('Truk','Truck')} value={allocated?truckCode||L('Kode belum tersedia','Code unavailable'):L('Menunggu alokasi','Awaiting allocation')} caption={allocated?plate:null}/>
    <Reference name="source" title={L('Sumber','Source')} value={sourceText}/>
    <Reference name="destination" title={L('Tujuan','Destination')} value={destinationText}/>
    <Reference name="sku" title="SKU" value={skuCode} caption={skuName}/>
   </div>
   <div className="trd-loads"><div><small>{L('Volume rencana ritase','Trip planned volume')}</small><b>{format(current.volumeM3)} <span>m³</span></b></div><div><small>{L('Tonase rencana ritase','Trip planned tonnage')}</small><b>{format(current.tonnageT)} <span>t</span></b></div></div>
   <section className="trd-qr-panel" data-testid="trip-assignment-qr" aria-label={L('QR penugasan truk','Allocated truck QR')}>
    <div className="trd-qr-heading"><span><QrCode size={20}/></span><div><h3>{L('QR per truk yang dialokasikan','QR for the allocated truck')}</h3><p>{L('Sesuai penugasan pada ritase ini.','Matches the assignment on this trip.')}</p></div></div>
    {hasQr?<div className="trd-qr-content"><span className={`trd-qr-tag ${historical?'historical':''}`}>{historical?L('QR historis · arsip ritase','Historical QR · trip archive'):L('QR referensi penugasan','Assignment reference QR')}</span><AssignmentQr value={latest.qr.value} label={`${L('QR ritase','Trip QR')} ${label(latest.code)||''} · ${truckCode||L('Truk dialokasikan','Allocated truck')}`}/><b>{truckCode} · {label(latest.code)}</b></div>:<div className="trd-qr-empty" role="status">{loading&&!selected?<Loader2 size={26} className="spin"/>:!allocated?<Truck size={28}/>:stale?<WifiOff size={26}/>:<Package size={27}/>}<b>{loading&&!selected?L('Memuat QR dari server…','Loading QR from server…'):stale?L('QR menunggu sinkronisasi','QR awaiting synchronization'):!allocated?L('Belum ada QR · menunggu truk','No QR yet · awaiting truck'):L('QR belum tersedia','QR unavailable')}</b><p>{stale?L('Muat ulang rincian untuk memastikan QR sesuai penugasan terbaru.','Refresh the details to confirm the QR matches the latest assignment.'):!allocated?L('QR akan tampil setelah alokasi penugasan lengkap.','The QR will appear after allocation is complete.'):L('Referensi penugasan belum lengkap atau belum tersedia dari server.','The assignment reference is incomplete or unavailable from the server.')}</p></div>}
   </section>
   {current.driverScan?.quantityBasis==='PLANNED_DEMO'&&current.driverScan?.measurementPending===true&&<div className="trd-footer" data-testid="trip-planned-demo-note"><Clock3 size={15}/><span>{L('Dua scan demo memakai kuantitas rencana dispatch. Bukti timbang lapangan masih menunggu verifikasi.','The two demo scans use planned dispatch quantities. Field weighing evidence still awaits verification.')}</span></div>}
   <div className="trd-footer"><Clock3 size={15}/><span>{current.driverScan?.mode==='TWO_SCAN_PLANNED_DEMO'?L('Rincian diperbarui otomatis dari pemindaian Driver dan catatan transaksi bersama.','Details refresh automatically from Driver scans and shared transaction records.'):L('Rincian diperbarui otomatis. Pemindaian dan pencatatan operasional dilakukan melalui aplikasi petugas.','Details refresh automatically. Scanning and operational records are handled in the operator application.')}</span></div>
  </div>
 </Modal>;
}
