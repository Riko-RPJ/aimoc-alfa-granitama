import React,{useEffect,useRef,useState} from 'react';
import {ArrowRight,Clock3,Loader2,QrCode,RefreshCw,Wifi,WifiOff} from 'lucide-react';
import {Button,Modal} from '../../components/ui/index.jsx';
import {useLanguage} from '../../i18n.js';
import {AssignmentQr} from './AssignmentQr.jsx';
import {driverAssignmentIdentity,selectDriverAssignmentQr} from './driver-assignment-qr.mjs';
import './driver-assignment-qr.css';

const states={waiting_truck:['Menunggu alokasi truk','Awaiting truck allocation'],waiting_driver:['Menunggu pengemudi','Awaiting a driver'],waiting_assignment:['Menunggu penugasan','Awaiting assignment'],awaiting_assignment:['Menunggu penugasan','Awaiting assignment'],unassigned:['Belum dialokasikan','Unassigned'],queued:['Antre','Queued'],start_pending:['Menunggu QR / tare','Awaiting QR / tare'],ready_to_load:['Siap muat','Ready to load'],loading:['Memuat','Loading'],weighed:['Timbang selesai','Weighed'],in_transit:['Dalam perjalanan','In transit'],arrived:['Tiba','Arrived'],unloaded:['Diterima / bongkar','Received / unloaded'],returning:['Perjalanan kembali','Returning'],returned:['Kembali terverifikasi','Return verified'],completed:['Selesai','Completed'],cancelled:['Dibatalkan','Cancelled']};
const text=value=>typeof value==='string'?value.trim():'';
function Reference({name,title,value,caption}){return <div className="daq-reference" data-driver-reference={name}><small>{title}</small><b>{value||'—'}</b>{caption&&<span>{caption}</span>}</div>;}

/** GET-only assignment card; opening this panel never records a scan or starts a trip. */
export function DriverAssignmentQrModal({trip,user,L,onClose,onOpenTask,onUnauthorized}){
 const language=useLanguage(),identity=driverAssignmentIdentity(trip,user?.id);
 const [snapshot,setSnapshot]=useState(null),[loading,setLoading]=useState(true),[opening,setOpening]=useState(false),[error,setError]=useState(null),[lastSync,setLastSync]=useState(null),[now,setNow]=useState(Date.now());
 const generation=useRef(0),reader=useRef(null),handoff=useRef(null),latestIdentity=useRef(identity);
 latestIdentity.current=identity;
 useEffect(()=>{
  const current=++generation.current;let disposed=false,inFlight=false,controller=null,accessDenied=false;
  const active=()=>!disposed&&generation.current===current&&latestIdentity.current===identity;
  setSnapshot(null);setLastSync(null);setError(null);setLoading(true);setOpening(false);
  async function refresh(manual=false){
   if(!active()||inFlight||accessDenied&&!manual)return null;
   inFlight=true;controller=new AbortController();setLoading(true);
   try{
    if(user?.role!=='driver'||trip?.assignedDriverUserId!==user?.id)throw Object.assign(new Error('INVALID_ASSIGNMENT'),{kind:'binding'});
    const response=await fetch(`/api/v1/demo/trips/${encodeURIComponent(trip.id)}/assignment-qr`,{method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if(!active())return null;
    if(!response.ok){
     if([401,403,404,409].includes(response.status)){accessDenied=true;setSnapshot(null);}
     throw Object.assign(new Error('ASSIGNMENT_UNAVAILABLE'),{kind:response.status===401?'auth':response.status===403||response.status===404?'access':response.status===409?'binding':response.status===429?'rate':'server'});
    }
    let data;try{data=await response.json();}catch{throw Object.assign(new Error('INVALID_RESPONSE'),{kind:'format'});}
    if(!active())return null;
    const selected=selectDriverAssignmentQr(data,trip,user.id);
    if(!selected){setSnapshot(null);accessDenied=true;throw Object.assign(new Error('ASSIGNMENT_MISMATCH'),{kind:'binding'});}
    accessDenied=false;setSnapshot({identity,selected});setLastSync(Date.now());setNow(Date.now());setError(null);return selected;
   }catch(failure){if(active()&&failure.name!=='AbortError'){setError(failure.kind||'network');if(failure.kind==='auth')onUnauthorized?.();}return null;}
   finally{if(active()){inFlight=false;setLoading(false);}}
  }
  reader.current=()=>refresh(true);
  handoff.current=async()=>{
   if(!active()||inFlight)return;setOpening(true);
   const selected=await refresh(true);
   if(active()){setOpening(false);if(selected?.canOpenTask)onOpenTask?.(selected.trip.id,selected.binding);}
  };
  refresh();
  const ticker=setInterval(()=>{if(active())setNow(Date.now());},1000);
  const timer=setInterval(()=>{if(document.visibilityState==='visible')refresh();},3000);
  const visible=()=>{if(document.visibilityState==='visible'){setNow(Date.now());refresh();}};
  document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);
  return()=>{disposed=true;controller?.abort();clearInterval(timer);clearInterval(ticker);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);reader.current=null;handoff.current=null;};
 },[identity,user?.role,onUnauthorized]);

 const selected=snapshot?.identity===identity?snapshot.selected:null;
 const fresh=Boolean(selected)&&!error&&Boolean(lastSync)&&now-lastSync<=10000;
 const current=selected?.trip,reference=current||trip||{};
 const historical=selected?.historical===true;
 const source=[text(current?.sourceCrusherCode),text(current?.sourceStockpileCode)].filter(Boolean).join(' / ');
 const driverName=text(current?.assignedDriver?.name)||text(current?.assignedDriver?.displayName)||text(user?.displayName)||text(user?.username);
 const status=states[reference.status]?L(...states[reference.status]):L('Status belum tersedia','Status unavailable');
 const stamp=lastSync?new Date(lastSync).toLocaleTimeString(language==='en'?'en-GB':'id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
 const errorText=({auth:L('Sesi berakhir. Silakan login kembali.','Your session ended. Please sign in again.'),access:L('Penugasan ini tidak lagi tersedia untuk akun Anda.','This assignment is no longer available to your account.'),binding:L('Penugasan berubah atau belum lengkap. Muat ulang daftar tugas sebelum membuka QR.','The assignment changed or is incomplete. Refresh your task list before opening the QR.'),rate:L('Pembaruan sedang dibatasi. Coba lagi sebentar.','Updates are temporarily limited. Try again shortly.'),server:L('QR belum tersedia dari server. Coba muat ulang.','The server could not provide the QR. Try refreshing.'),format:L('Respons penugasan belum dapat diverifikasi.','The assignment response could not be verified.'),network:L('Koneksi terputus. QR disembunyikan sampai penugasan tersinkron kembali.','The connection was interrupted. The QR is hidden until the assignment is synchronized again.')}[error]);
 return <Modal wide title={`Scan QR · ${text(reference.code)||L('Ritase','Trip')}`} subtitle={L('Tunjukkan QR penugasan ini kepada petugas untuk ritase yang dipilih.','Show this assignment QR to the operator for the selected trip.')} onClose={onClose}>
  <div className="driver-assignment-qr" data-testid="driver-assignment-qr" data-trip-id={trip?.id} data-binding-identity={identity}>
   <div className={`daq-sync ${!fresh&&!loading?'stale':''}`} role="status"><span>{loading?<Loader2 size={15} className="spin"/>:fresh?<Wifi size={15}/>:<WifiOff size={15}/>} {loading?L('Memverifikasi penugasan…','Verifying assignment…'):fresh?L('Penugasan tersinkron','Assignment synchronized'):L('Perlu verifikasi ulang','Verification needed')}</span><div><small>{stamp}</small><button type="button" aria-label={L('Muat ulang QR penugasan','Refresh assignment QR')} disabled={loading||opening} onClick={()=>reader.current?.()}><RefreshCw size={15}/></button></div></div>
   {error&&<div className="daq-error" role="alert"><p>{errorText}</p><Button variant="secondary" disabled={loading||opening} onClick={()=>reader.current?.()}>{L('Coba lagi','Retry')}</Button></div>}
   <div className="daq-heading"><b>{L('Referensi penugasan saya','My assignment reference')}</b><span>{status}</span></div>
   <div className="daq-references">
    <Reference name="source" title={L('Sumber','Source')} value={source}/>
    <Reference name="dispatch" title="Dispatch" value={text(selected?.dispatch?.code)}/>
    <Reference name="trip" title={L('Ritase','Trip')} value={text(reference.code)}/>
    <Reference name="truck" title={L('Truk','Truck')} value={text(current?.truckCode)} caption={text(current?.plate)}/>
    <Reference name="driver" title={L('Pengemudi','Driver')} value={driverName}/>
    <Reference name="request" title={L('Permintaan','Request')} value={text(selected?.request?.code)}/>
   </div>
   <section className="daq-code-panel" data-testid="driver-assignment-qr-code" aria-label={L('QR penugasan ritase saya','My trip assignment QR')}>
    {fresh?<><span className={`daq-tag ${historical?'historical':''}`}>{historical?L('QR historis · arsip ritase','Historical QR · trip archive'):L('QR referensi penugasan','Assignment reference QR')}</span><AssignmentQr value={selected.qr.value} label={`${L('QR ritase','Trip QR')} ${text(current.code)} · ${text(current.truckCode)}`}/><b>{text(current.truckCode)} · {text(current.code)}</b></>:<div className="daq-code-empty">{loading?<Loader2 size={34} className="spin"/>:<QrCode size={36}/>}<b>{loading?L('Memuat QR terverifikasi…','Loading verified QR…'):L('QR menunggu verifikasi','QR awaiting verification')}</b><p>{L('QR tampil hanya ketika penugasan terbaru sesuai dengan akun dan ritase ini.','The QR appears only when the latest assignment matches this account and trip.')}</p></div>}
   </section>
   <p className="daq-note"><Clock3 size={15}/><span>{L('Membuka QR tidak mencatat scan atau mengubah status tugas. Petugas mencatat pemindaian melalui aplikasi operasional.','Opening the QR does not record a scan or change the task status. The operator records the scan in the operations application.')}</span></p>
   {historical?<p className="daq-history">{L('Arsip penugasan yang sudah berakhir; tidak dapat digunakan untuk memulai tugas.','This assignment has ended and is archived; it cannot start a task.')}</p>:<div className="daq-actions"><Button variant="secondary" onClick={onClose}>{L('Tutup','Close')}</Button><Button data-testid="driver-open-trip-task" disabled={!fresh||!selected?.canOpenTask||loading||opening} onClick={()=>handoff.current?.()}>{opening?<Loader2 size={16} className="spin"/>:<ArrowRight size={16}/>} {L('Buka tugas ritase','Open trip task')}</Button></div>}
  </div>
 </Modal>;
}
