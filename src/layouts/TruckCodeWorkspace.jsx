import React,{useEffect,useState} from 'react';
import {ArrowRight,Truck,RefreshCw,ShieldAlert,LogOut,ClipboardList} from 'lucide-react';
import {Brand} from '../components/brand/index.jsx';
import {api} from '../services/legacy-api.js';

/**
 * UAT-only read-only truck task lookup. Truck code is an identifier, not
 * proof of possession; signed scanner events must come independently.
 */
export function TruckCodeWorkspace(){
 const shortcut=new URLSearchParams(window.location.hash.slice(1));
 const [truckCode,setTruckCode]=useState(shortcut.get('truck')||'');
 const [view,setView]=useState(null);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const [taskPending,setTaskPending]=useState(null);
 const load=async(code=truckCode)=>{
  setBusy(true);setError('');
  try{const data=await api('/api/driver/truck-tasks',{method:'POST',body:JSON.stringify({truckCode:code.trim().toUpperCase()})});
   setView(data);setTruckCode(data.truck.code);
  }catch(e){setError(e.message||'Tidak dapat mengambil tugas truck.');setView(null)}
  finally{setBusy(false)}
 };
 useEffect(()=>{
  if(!shortcut.get('truck'))return;
  window.history.replaceState(null,'',window.location.pathname);
  load(shortcut.get('truck'));
 },[]);
 useEffect(()=>{
  if(!view?.truck?.code)return;
  const code=view.truck.code;
  let alive=true;
  const interval=setInterval(async()=>{
   try{
    const latest=await api('/api/driver/truck-tasks',{
     method:'POST',body:JSON.stringify({truckCode:code})});
    if(alive)setView(latest);
   }catch{/* Manual refresh reports errors; background polls retain last known state. */}
  },15000);
  return()=>{alive=false;clearInterval(interval)};
 },[view?.truck?.code]);
 const taskAction=async(trip,action)=>{
  if(taskPending)return;
  setTaskPending(trip.tripId);setError('');
  try{
   await api('/api/driver/truck-task-action',{
    method:'POST',body:JSON.stringify({truckCode:view.truck.code,tripId:trip.tripId,action})
   });
   await load(view.truck.code);
  }catch(e){setError(e.message||'Perubahan tugas UAT ditolak oleh backend.')}
  finally{setTaskPending(null)}
 };
 const reset=()=>{setView(null);setTruckCode('');setError('');};
 return <div className="truck-code-page">
  <header className="truck-code-top"><Brand light/><span>TRUCK TASKS · AIMOC UAT</span></header>
  <main className="truck-code-main">
   {!view?<section className="truck-code-login">
    <Truck size={40} color="#087b7d"/>
    <div className="truck-code-eyebrow">AKSES TUGAS ARMADA</div>
    <h1>Masukkan Kode Truck</h1>
    <p>Buka tautan dari Admin setelah simulasi QR, atau masukkan kode truck untuk melihat task demo yang sudah dibuka Admin.</p>
    <form onSubmit={e=>{e.preventDefault();load()}}>
     <label htmlFor="truck-entry">Kode truck</label>
     <input id="truck-entry" autoFocus autoCapitalize="characters" autoComplete="off"
      maxLength={10} required placeholder="Contoh: DT-001" value={truckCode}
      onChange={e=>setTruckCode(e.target.value.toUpperCase())}/>
     <button type="submit" disabled={busy||!/^DT-[0-9]{3,6}$/.test(truckCode.trim())}>
      {busy?'Mencari tugas…':'Lihat Task List'} <ArrowRight size={17}/>
     </button>
    </form>
    {error&&<p role="alert" className="truck-code-error">{error}</p>}
    <p className="truck-code-security"><ShieldAlert size={15}/> UAT · Kode truck membuka task UAT. Tombol Mulai/Selesai mencatat simulasi progres saja, bukan pergerakan fisik, TARE, GROSS, atau status perjalanan production.</p>
   </section>:<section className="truck-code-results">
    <div className="truck-code-toolbar"><button onClick={reset} type="button"><LogOut size={16}/> Ganti truck</button>
     <button disabled={busy} onClick={()=>load(view.truck.code)} type="button"><RefreshCw size={16}/> Refresh</button></div>
    <div className="truck-code-vehicle"><Truck size={31}/><div><small>TRUCK TERPILIH</small>
      <h1>{view.truck.code}</h1><p>{view.truck.availability==='DEMO_AVAILABLE'?'Available · seluruh task demo selesai':view.truck.availability==='ALLOCATED'?'Dialokasikan · menunggu proses':view.truck.availability==='IN_OPERATION'?'Ada perjalanan yang telah dimulai':'Tidak ada pekerjaan terbuka'}</p></div></div>
    <div className="truck-code-readiness"><ShieldAlert size={16}/>
     {view.trips.length?'Scan QR UAT telah membuka antrean truck. Mulai dan Selesai mengubah progres tugas simulasi secara serial; tidak mengubah status perjalanan fisik atau bukti WIM.':
    'Menunggu Scan QR. Admin dapat memilih Simulasi Scan QR pada Dispatch Planning, atau nanti sistem menerima event dari scanner fisik yang terintegrasi.'}
   </div>
    <h2><ClipboardList size={21}/> Task List <span>{view.trips.length} ritase</span></h2>
    {view.awaitingQrCount>0&&<p className="truck-code-awaiting">{view.awaitingQrCount} ritase dialokasikan tetapi menunggu scan QR.</p>}
    {view.trips.length?view.trips.map(t=><article className="truck-code-task" key={t.tripCode}>
     <div className="truck-code-task-head"><strong>{t.tripCode}</strong>
      <span>{t.uatTaskStatus==='COMPLETED'?'SELESAI · UAT':t.uatTaskStatus==='IN_PROGRESS'?'SEDANG DIKERJAKAN · UAT':t.uatCanStart?'SIAP DIMULAI':'MENUNGGU GILIRAN'}</span></div>
     <p>{t.materialCode||'Material belum tersedia'} · {t.plannedVolumeM3==null?'—':t.plannedVolumeM3+' m³'} {t.plannedTonnes==null?'':'· '+t.plannedTonnes+' ton'}</p>
     <dl><div><dt>Dispatch</dt><dd>{t.dispatchCode||'—'}</dd></div><div><dt>Transfer Request</dt><dd>{t.requestCode||'—'}</dd></div>
     <div><dt>Pickup</dt><dd>{t.stockpileCode||'—'}</dd></div><div><dt>Tujuan</dt><dd>{t.destination||'Belum terverifikasi'}</dd></div></dl>
     <div className="truck-code-task-actions">
       {t.uatCanStart&&<button type="button" disabled={Boolean(taskPending)}
        onClick={()=>taskAction(t,'START')}>{taskPending===t.tripId?'Mencatat…':'Mulai'} <ArrowRight size={16}/></button>}
       {t.uatCanComplete&&<button type="button" disabled={Boolean(taskPending)}
        onClick={()=>taskAction(t,'COMPLETE')}>{taskPending===t.tripId?'Mencatat…':'Selesai'} <ArrowRight size={16}/></button>}
       {t.uatTaskStatus==='WAITING'&&!t.uatCanStart&&<p>Ritase sebelumnya harus diselesaikan terlebih dahulu.</p>}
       {t.uatTaskStatus==='COMPLETED'&&<p>Selesai dalam simulasi UAT · {t.uatCompletedAt?new Date(t.uatCompletedAt).toLocaleString('id-ID'):'—'}</p>}
      </div>
     <div className="truck-code-task-note">Status operasional asli: {t.status.toUpperCase()}. Mulai/Selesai di sini khusus simulasi antrean Driver, bukan verifikasi WIM atau receiving.</div>
    </article>):<div className="truck-code-empty">{view.awaitingQrCount>0?'Menunggu Scan QR untuk menampilkan ritase.':'Belum ada ritase terbuka untuk truck ini.'}</div>}
    {error&&<p className="truck-code-error" role="alert">{error}</p>}
   </section>}
  </main>
 </div>;
}
