import React,{useEffect,useRef,useState} from 'react';
import {Check,Clock3,Loader2,QrCode,RefreshCw,Wifi,WifiOff} from 'lucide-react';
import {Button,Modal} from '../../components/ui/index.jsx';
import {tr,useLanguage} from '../../i18n.js';
import {AssignmentQr} from './AssignmentQr.jsx';
import {buildDriverScanIntent,driverAssignmentIdentity,driverScanStage,selectDriverAssignmentQr} from './driver-assignment-qr.mjs';
import './driver-assignment-qr.css';

const states={queued:['Antre','Queued'],start_pending:['Menunggu QR / tare','Awaiting QR / tare'],ready_to_load:['Siap muat','Ready to load'],loading:['Memuat','Loading'],weighed:['Timbang selesai','Weighed'],in_transit:['Dalam perjalanan','In transit'],arrived:['Tiba','Arrived'],unloaded:['Diterima / bongkar','Received / unloaded'],returning:['Perjalanan kembali','Returning'],returned:['Kembali terverifikasi','Return verified'],completed:['Selesai','Completed'],cancelled:['Dibatalkan','Cancelled']};
const text=value=>typeof value==='string'?value.trim():'';
function Reference({name,title,value,caption}){return <div className="daq-reference" data-driver-reference={name}><small>{title}</small><b>{value||'—'}</b>{caption&&<span>{caption}</span>}</div>;}

/** Reads never record a scan. Each stage needs a fresh explicit confirmation. */
export function DriverAssignmentQrModal({trip,user,L,onClose,onRecordScan,onRetryScan,onUnauthorized,blocked=false,busy=false,commandError='',retryAvailable=false,keepOpenOnScan=false,readOnly=false}){
 const language=useLanguage(),identity=driverAssignmentIdentity(trip,user?.id);
 const [snapshot,setSnapshot]=useState(null),[loading,setLoading]=useState(true),[submitting,setSubmitting]=useState(false),[intentError,setIntentError]=useState(null),[error,setError]=useState(null),[lastSync,setLastSync]=useState(null),[now,setNow]=useState(Date.now());
 const generation=useRef(0),reader=useRef(null),scanner=useRef(null),retryScan=useRef(null),scanMutex=useRef(false),latestIdentity=useRef(identity),latestSnapshot=useRef(null),callbacks=useRef(null);
 latestIdentity.current=identity;callbacks.current={onClose,onRecordScan,onRetryScan,onUnauthorized,blocked,busy,retryAvailable,keepOpenOnScan};
 useEffect(()=>{
  const current=++generation.current;let disposed=false,inFlight=false,controller=null,accessDenied=false;
  const active=()=>!disposed&&generation.current===current&&latestIdentity.current===identity;
  latestSnapshot.current=null;scanMutex.current=false;setSnapshot(null);setLastSync(null);setError(null);setIntentError(null);setLoading(true);setSubmitting(false);
  async function refresh(manual=false){
   if(!active()||inFlight||accessDenied&&!manual||scanMutex.current&&!manual)return null;
   inFlight=true;controller=new AbortController();setLoading(true);
   try{
    if(user?.role!=='driver'||trip?.assignedDriverUserId!==user?.id)throw Object.assign(new Error('INVALID_ASSIGNMENT'),{kind:'binding'});
    const response=await fetch(`/api/v1/demo/trips/${encodeURIComponent(trip.id)}/assignment-qr`,{method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if(!active())return null;
    if(!response.ok){
     if([401,403,404,409].includes(response.status)){accessDenied=true;latestSnapshot.current=null;setSnapshot(null);}
     throw Object.assign(new Error('ASSIGNMENT_UNAVAILABLE'),{kind:response.status===401?'auth':[403,404].includes(response.status)?'access':response.status===409?'binding':response.status===429?'rate':'server'});
    }
    let data;try{data=await response.json();}catch{throw Object.assign(new Error('INVALID_RESPONSE'),{kind:'format'});}
    if(!active())return null;
    const selected=selectDriverAssignmentQr(data,trip,user.id);
    if(!selected){latestSnapshot.current=null;setSnapshot(null);accessDenied=true;throw Object.assign(new Error('ASSIGNMENT_MISMATCH'),{kind:'binding'});}
    accessDenied=false;latestSnapshot.current=selected;setSnapshot({identity,selected});setLastSync(Date.now());setNow(Date.now());setError(null);return selected;
   }catch(failure){if(active()&&failure.name!=='AbortError'){setError(failure.kind||'network');if(failure.kind==='auth')callbacks.current.onUnauthorized?.();}return null;}
   finally{if(active()){inFlight=false;setLoading(false);}}
  }
  reader.current=()=>{setIntentError(null);return refresh(true);};
  scanner.current=async event=>{
   if(event?.detail>1||!active()||scanMutex.current||inFlight||callbacks.current.blocked||typeof callbacks.current.onRecordScan!=='function')return;
   const expectedStage=driverScanStage(latestSnapshot.current);if(!expectedStage)return;
   scanMutex.current=true;setSubmitting(true);setIntentError(null);
   try{
    const fresh=await refresh(true);if(!active())return;
    const payload=buildDriverScanIntent(fresh,expectedStage,'driver-scan-'+crypto.randomUUID());
    if(!payload){setIntentError('changed');return;}
    const result=await callbacks.current.onRecordScan(payload);if(active()&&result&&!callbacks.current.keepOpenOnScan)callbacks.current.onClose?.();
   }catch{if(active())setIntentError('command');}
   finally{if(active()){scanMutex.current=false;setSubmitting(false);}}
  };
  retryScan.current=async event=>{
   if(event?.detail>1||!active()||scanMutex.current||callbacks.current.busy||!callbacks.current.retryAvailable||typeof callbacks.current.onRetryScan!=='function')return;
   scanMutex.current=true;setSubmitting(true);setIntentError(null);
   try{const result=await callbacks.current.onRetryScan();if(active()&&result&&!callbacks.current.keepOpenOnScan)callbacks.current.onClose?.();}
   catch{if(active())setIntentError('command');}
   finally{if(active()){scanMutex.current=false;setSubmitting(false);}}
  };
  refresh();
  const ticker=setInterval(()=>{if(active())setNow(Date.now());},1000),timer=setInterval(()=>{if(document.visibilityState==='visible')refresh();},3000);
  const visible=()=>{if(document.visibilityState==='visible'){setNow(Date.now());refresh();}};
  document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);
  return()=>{disposed=true;controller?.abort();clearInterval(timer);clearInterval(ticker);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);reader.current=null;scanner.current=null;retryScan.current=null;};
 },[identity,user?.role]);
 const selected=snapshot?.identity===identity?snapshot.selected:null,fresh=Boolean(selected)&&!error&&Boolean(lastSync)&&now-lastSync<=10000;
 const current=selected?.trip,reference=current||trip||{},stage=driverScanStage(selected),historical=selected?.historical===true;
 const source=[text(current?.sourceCrusherCode),text(current?.sourceStockpileCode)].filter(Boolean).join(' / ');
 const driverName=text(current?.assignedDriver?.name)||text(current?.assignedDriver?.displayName)||text(user?.displayName)||text(user?.username);
 const displayStatus=reference.displayStatus||reference.status,status=states[displayStatus]?L(...states[displayStatus]):L('Status belum tersedia','Status unavailable');
 const stamp=lastSync?new Date(lastSync).toLocaleTimeString(language==='en'?'en-GB':'id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
 const errorText=({auth:L('Sesi berakhir. Silakan login kembali.','Your session ended. Please sign in again.'),access:L('Penugasan ini tidak lagi tersedia untuk akun Anda.','This assignment is no longer available to your account.'),binding:L('Penugasan berubah atau belum lengkap. Muat ulang daftar tugas sebelum membuka QR.','The assignment changed or is incomplete. Refresh your task list before opening the QR.'),rate:L('Pembaruan sedang dibatasi. Coba lagi sebentar.','Updates are temporarily limited. Try again shortly.'),server:L('QR belum tersedia dari server. Coba muat ulang.','The server could not provide the QR. Try refreshing.'),format:L('Respons penugasan belum dapat diverifikasi.','The assignment response could not be verified.'),network:L('Koneksi terputus. QR disembunyikan sampai penugasan tersinkron kembali.','The connection was interrupted. The QR is hidden until the assignment is synchronized again.')}[error]);
 const close=()=>{if(!scanMutex.current)onClose?.();};
 return <Modal wide title={readOnly?`${L('Detail ritase','Trip details')} · ${text(reference.code)}`:`${L('Scan QR dispatch','Scan dispatch QR')} · ${text(selected?.dispatch?.code)||L('Dispatch','Dispatch')}`} subtitle={L('Satu QR berlaku untuk seluruh ritase pada truk dan dispatch yang sama. Ritase aktif ditampilkan sebagai konteks terpisah.','One QR covers every trip on the same truck and dispatch. The current trip is shown as separate context.')} onClose={close}>
  <div className="driver-assignment-qr" data-testid="driver-assignment-qr" data-trip-id={trip?.id} data-binding-identity={identity} data-scan-stage={stage||''}>
   <div className={`daq-sync ${!fresh&&!loading?'stale':''}`} role="status"><span>{loading?<Loader2 size={15} className="spin"/>:fresh?<Wifi size={15}/>:<WifiOff size={15}/>} {loading?L('Memverifikasi penugasan…','Verifying assignment…'):fresh?L('Penugasan tersinkron','Assignment synchronized'):L('Perlu verifikasi ulang','Verification needed')}</span><div><small>{stamp}</small><button type="button" aria-label={L('Muat ulang QR penugasan','Refresh assignment QR')} disabled={loading||submitting} onClick={()=>reader.current?.()}><RefreshCw size={15}/></button></div></div>
   {error&&<div className="daq-error" role="alert"><p>{errorText}</p><Button variant="secondary" disabled={loading||submitting} onClick={()=>reader.current?.()}>{L('Coba lagi','Retry')}</Button></div>}
   {!readOnly&&(commandError||intentError)&&<div className="daq-error" role="alert"><p>{commandError?tr(commandError):intentError==='changed'?L('Tahap atau penugasan berubah. Periksa informasi terbaru lalu lakukan klik scan baru.','The stage or assignment changed. Review the latest information, then make a new scan click.'):L('Scan belum dapat dipastikan. Periksa status atau ulangi permintaan yang sama jika tersedia.','The scan could not be confirmed. Check its status or retry the same request when available.')}</p>{retryAvailable&&<Button variant="secondary" data-testid="driver-scan-retry" disabled={busy||submitting} onClick={event=>retryScan.current?.(event)}>{L('Ulangi scan yang sama','Retry the same scan')}</Button>}</div>}
   <div className="daq-heading"><b>{L('Referensi penugasan saya','My assignment reference')}</b><span data-testid="driver-scan-status">{status}</span></div>
   <div className="daq-references"><Reference name="source" title={L('Sumber','Source')} value={source}/><Reference name="dispatch" title="Dispatch" value={text(selected?.dispatch?.code)}/><Reference name="trip" title={L('Ritase','Trip')} value={text(reference.code)}/><Reference name="truck" title={L('Truk','Truck')} value={text(current?.truckCode)} caption={text(current?.plate)}/><Reference name="driver" title={L('Pengemudi','Driver')} value={driverName}/><Reference name="request" title={L('Permintaan','Request')} value={text(selected?.request?.code)}/></div>
   {!readOnly&&<section className="daq-code-panel" data-testid="driver-assignment-qr-code" aria-label={L('QR dispatch truk saya','My truck dispatch QR')}>
    {fresh?<><span className={`daq-tag ${historical?'historical':''}`}>{historical?L('QR dispatch · konteks riwayat','Dispatch QR · historical context'):L('QR dispatch · seluruh ritase','Dispatch QR · all trips')}</span><AssignmentQr value={selected.qr.value} label={`${L('QR dispatch','Dispatch QR')} · ${text(selected?.dispatch?.code)} · ${text(current.truckCode)}`}/><b>{text(current.truckCode)} · {text(selected?.dispatch?.code)}</b></>:<div className="daq-code-empty">{loading?<Loader2 size={34} className="spin"/>:<QrCode size={36}/>}<b>{loading?L('Memuat QR terverifikasi…','Loading verified QR…'):L('QR menunggu verifikasi','QR awaiting verification')}</b><p>{L('QR tampil hanya ketika penugasan terbaru sesuai dengan akun dan ritase ini.','The QR appears only when the latest assignment matches this account and trip.')}</p></div>}
   </section>}
   <p className="daq-note"><Clock3 size={15}/><span>{selected?.driverScan?.quantityBasis==='EXISTING_DEMO_WEIGHING'?L('Demo: hanya tombol Catat scan yang mencatat pemindaian. Bobot dan penerimaan mengikuti catatan yang sudah tersimpan.','Demo: only Record scan submits a scan. Weights and receipts follow the existing stored records.'):selected?.driverScan?.quantityBasis==='PLANNED_DEMO'?L('Demo: hanya tombol Catat scan yang mencatat pemindaian. Muatan memakai rencana dispatch dan masih memerlukan bukti timbang lapangan.','Demo: only Record scan submits a scan. Quantities use the dispatch plan and still require field weighing evidence.'):L('Demo: pemindaian hanya dicatat melalui tombol Catat scan.','Demo: scans are recorded only through the Record scan button.')}</span></p>
   {readOnly?<p className="daq-history">{L('Rincian ritase ini hanya baca. Buka Scan QR pada header dispatch untuk menggunakan satu QR seluruh ritase.','These trip details are read-only. Open Scan QR in the dispatch header to use the single QR for all trips.')}</p>:historical?<p className="daq-history">{L('Ritase telah berakhir. QR ini tersimpan sebagai arsip penugasan.','This trip has ended. Its QR remains an assignment archive.')}</p>:<>
    <div className="daq-scan-intent" data-testid="driver-scan-intent"><b>{stage===2?L('Scan 2 · Penerimaan dan kembali','Scan 2 · Receipt and return'):stage===1?L('Scan 1 · Siap muat','Scan 1 · Ready to load'):L('Menunggu izin scan','Awaiting scan eligibility')}</b><p>{stage===2?L('Dengan mencatat scan 2, saya mengonfirmasi material sudah diterima di tujuan dan truk sudah kembali ke sumber.','By recording scan 2, I confirm that the material was received at its destination and the truck returned to the source.'):stage===1?L('Catat scan pertama untuk menetapkan status Siap muat.','Record the first scan to set the status to Ready to load.'):selected?.driverScan?.phase==='LEGACY_WORKFLOW'?L('Ritase ini memerlukan penanganan Admin sebelum dapat diproses dengan dua scan.','This trip requires Admin handling before it can use the two-scan workflow.'):L('Ikuti urutan ritase. Muat ulang penugasan jika tahap berikutnya belum tersedia.','Follow the trip sequence. Refresh the assignment if its next stage is not yet available.')}</p></div>
    <div className="daq-actions"><Button variant="secondary" disabled={submitting} onClick={close}>{L('Tutup','Close')}</Button><Button data-testid="driver-record-scan" disabled={!fresh||!stage||loading||submitting||blocked||typeof onRecordScan!=='function'} onClick={event=>scanner.current?.(event)}>{submitting?<Loader2 size={16} className="spin"/>:stage===2?<Check size={16}/>:<QrCode size={16}/>} {submitting?L('Mencatat scan…','Recording scan…'):stage===2?L('Catat scan 2 · Selesaikan ritase','Record scan 2 · Complete trip'):stage===1?L('Catat scan 1 · Siap muat','Record scan 1 · Ready to load'):L('Scan belum tersedia','Scan unavailable')}</Button></div>
   </>}
  </div>
 </Modal>;
}
