import React,{useEffect,useState} from 'react';
import {ArrowRight,CheckCircle2,ClipboardCheck,Database,LogOut,RefreshCcw,ShieldAlert,Truck,Warehouse,Scale,Route,LockKeyhole,Activity} from 'lucide-react';
import './cross-role-uat.css';
const phases={
 ASSIGNED:['start','admin','Authorize Trip'],START_AUTHORIZED:['accept','driver','Accept Assignment'],
 TARE_SIMULATED:['loading','stock','Confirm Loading'],
 LOADING_CONFIRMED:['gross','admin','Simulate Gross'],GROSS_SIMULATED:['depart','stock','Confirm Departure'],
 IN_TRANSIT:['arrive','stock','Confirm Arrival'],ARRIVED:['receive','stock','Verify UAT Receipt'],
 RECEIVED:['return_start','driver','Report Return Start'],RETURNING:['verify_return','stock','Verify Return Independently']
};
const names={admin:'Admin',stock:'Stockpile',driver:'Driver'};
const show=v=>v===null||v===undefined?'—':String(v);
const showTonnes=v=>v===null||v===undefined?'—':`${v} t`;
const showTime=value=>{
 if(!value)return '—';
 const date=new Date(value);
 return Number.isNaN(date.getTime())?'—':date.toLocaleString('id-ID');
};
const capacityLimit={GVW:'Approved GVW',PAYLOAD:'Approved payload',REMAINING_PLANNED:'Remaining planned'};
function tarePresentation(trip){
 const simulation=trip?.tareSimulation;
 if(!simulation)return {tone:'missing',title:'Automatic Tare unavailable',text:'Backend belum menyediakan status Automatic Tare untuk trip ini.'};
 if(simulation.status==='TARE_RECEIVED')return {tone:'received',title:'Automatic Tare received',text:'Backend telah menerapkan Tare simulasi ke workflow UAT.'};
 if(simulation.status==='TARE_PENDING')return {tone:'pending',title:'Automatic Tare pending',text:'Job tercatat dan direkonsiliasi backend setelah prasyarat trip terpenuhi.'};
 if(simulation.status==='TARE_FAILED'&&simulation.lastErrorCode==='UAT_TARE_PROFILE_MISSING')return {tone:'failed',title:'UAT Tare profile missing',text:'Tidak ada profil sintetis yang disetujui. Sistem tidak membuat nilai Tare default.'};
 if(simulation.status==='TARE_INVALID'&&simulation.lastErrorCode==='STALE_ASSIGNMENT')return {tone:'invalid',title:'Stale assignment rejected',text:'Event tidak cocok dengan assignment aktif dan tidak diterapkan ke trip.'};
 if(simulation.status==='TARE_INVALID')return {tone:'invalid',title:'Automatic Tare invalid',text:'Backend menolak event simulasi; workflow trip tidak dipindahkan.'};
 return {tone:'failed',title:'Automatic Tare failed',text:'Pemrosesan backend gagal. Metadata retry tetap dikelola oleh backend.'};
}
function AutomaticTareStatus({trip}){
 const simulation=trip.tareSimulation;
 const state=tarePresentation(trip);
 return <section className={`cross-role-tare ${state.tone}`} aria-labelledby="automatic-tare-title" aria-live="polite">
  <header><div>{state.tone==='received'?<CheckCircle2 size={19}/>:<ShieldAlert size={19}/>}<div><h3 id="automatic-tare-title">{state.title}</h3><p>{state.text}</p></div></div><div className="cross-role-provenance"><span>UAT_SIMULATED</span><span>UNVERIFIED</span></div></header>
  <dl className="cross-role-data-list">
   <div><dt>Status</dt><dd>{show(simulation?.status)}</dd></div><div><dt>Mode</dt><dd>{show(simulation?.mode)}</dd></div>
   <div><dt>Tare result</dt><dd>{showTonnes(trip.simulatedTareT)}</dd></div><div><dt>Event timestamp</dt><dd>— <small>not exposed by backend</small></dd></div>
   <div><dt>Processing completed</dt><dd>{showTime(simulation?.completedAt)}</dd></div><div><dt>Next attempt</dt><dd>{showTime(simulation?.nextAttemptAt)}</dd></div>
   <div><dt>Attempts</dt><dd>{show(simulation?.attempts)}</dd></div><div><dt>Last error</dt><dd>{show(simulation?.lastErrorCode)}</dd></div>
   <div><dt>Assignment revision</dt><dd>{show(simulation?.assignmentRevision)}</dd></div><div><dt>Profile revision</dt><dd>{show(simulation?.profileRevision)}</dd></div>
  </dl>
 </section>;
}
function LoadingCapacity({trip}){
 const capacity=trip.loadingCapacity;
 return <section className="cross-role-capacity" aria-labelledby="loading-capacity-title">
  <header><Scale size={19}/><div><h3 id="loading-capacity-title">Loading capacity</h3><p>Nilai kapasitas dibaca dari DTO backend; browser tidak menghitung berat.</p></div></header>
  <dl className="cross-role-data-list">
   <div><dt>Approved GVW</dt><dd>— <small>not exposed by backend</small></dd></div><div><dt>GVW available</dt><dd>{showTonnes(capacity?.gvwAvailableT)}</dd></div>
   <div><dt>Approved payload</dt><dd>— <small>not exposed by backend</small></dd></div><div><dt>Remaining planned</dt><dd>— <small>not exposed by backend</small></dd></div>
   <div><dt>Loading limit</dt><dd>{showTonnes(capacity?.loadingLimitT)}</dd></div><div><dt>Limited by</dt><dd>{capacityLimit[capacity?.limitedBy]||show(capacity?.limitedBy)}</dd></div>
  </dl>
  {!capacity&&<p className="cross-role-capacity-empty">Capacity belum tersedia sampai Automatic Tare diterima dan backend menyelesaikan kalkulasi.</p>}
 </section>;
}
const automaticTareWaiting=trip=>{
 const simulation=trip?.tareSimulation;
 if(simulation?.status==='TARE_FAILED'&&simulation.lastErrorCode==='UAT_TARE_PROFILE_MISSING')return 'Automatic Tare tertahan: profil UAT belum tersedia.';
 if(simulation?.status==='TARE_INVALID'&&simulation.lastErrorCode==='STALE_ASSIGNMENT')return 'Automatic Tare ditolak karena assignment sudah tidak sesuai.';
 if(simulation?.status==='TARE_INVALID')return 'Automatic Tare ditolak backend. Tidak ada Tare yang diterapkan.';
 if(simulation?.status==='TARE_FAILED')return 'Automatic Tare gagal diproses backend.';
 return 'Menunggu rekonsiliasi Automatic Tare dari backend.';
};
export function CrossRoleUatPage({user,csrf,logout}){
 const [data,setData]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [busy,setBusy]=useState(false),[selected,setSelected]=useState(null);
 const [form,setForm]=useState({sourceLocation:'crusher-1',destinationLocation:'crusher-2',driverUserId:'',truckId:'UAT-TRUCK-01',material:'Batu Split (UAT)',plannedT:'40.000000'});
 const [gross,setGross]=useState('52.000000'),[note,setNote]=useState('Kondisi kendaraan diperiksa (simulasi)');
 const load=async(silent=false)=>{
  try{
   const response=await fetch('/api/uat/context',{credentials:'same-origin'});
   const out=await response.json();
   if(!response.ok)throw Error(out.message||'UAT data unavailable');
   setData(out);setError('');if(!silent)setMessage('');
  }catch(e){setError(e.message)}finally{setLoading(false)}
 };
 useEffect(()=>{load();const t=setInterval(()=>{if(document.visibilityState==='visible')load(true)},2500);return()=>clearInterval(t)},[]);
 useEffect(()=>{if(data?.drivers?.length&&!form.driverUserId)setForm(s=>({...s,driverUserId:data.drivers[0].id}))},[data?.drivers?.length]);
 const run=async(path,body)=>{
  if(busy)return;
  setBusy(true);setMessage('');setError('');
  try{
   const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{
    'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)});
   const out=await response.json();if(!response.ok)throw Error(out.message||out.error||'Action rejected');
   setMessage('Transisi UAT berhasil: '+(out.status||'saved')+'. Refresh pada akun lain akan menampilkan state yang sama.');
   if(out.id)setSelected(out.id);await load(true);
  }catch(e){setError(e.message)}finally{setBusy(false)}
 };
 const create=e=>{e.preventDefault();run('/api/uat/dispatches',form)};
 const jobs=data?.jobs||[];
 const active=jobs.find(j=>j.id===selected)||jobs[0];
 const next=active&&phases[active.status];
 const correctLocation=active&&(user?.crusherIds||[]).includes(['loading','depart','verify_return'].includes(next?.[0])?active.sourceLocation:active.destinationLocation);
 const canAdvance=next?.[1]===user.role&&(user.role!=='stock'||correctLocation);
 const takeAction=()=>{
  if(!active||!next)return;
  run('/api/uat/trips/'+active.id+'/actions',{action:next[0],
   ...(next[0]==='gross'?{simulatedT:gross}:{})});
 };
 const ownEvents=(data?.events||[]).filter(e=>e.tripId===active?.id);
 return <div className="cross-role-shell">
  <header className="cross-role-top"><div className="cross-role-mark"><span>AIMOC</span><small>Cross-Role Integration Lab</small></div><div className="cross-role-user"><b>{user.displayName||user.username}</b><span>{names[user.role]||user.role} · UAT</span><button onClick={logout} type="button"><LogOut size={17}/> Logout</button></div></header>
  <main className="cross-role-main">
   <div className="cross-role-banner" role="status"><ShieldAlert size={21}/><div><strong>ISOLATED UAT · UAT_SIMULATED · UNVERIFIED</strong><p>Semua role membaca database UAT yang sama. Automatic Tare, Gross, receiving, dan inventory bersifat simulasi. Tidak ada perubahan stok production, event alat nyata, atau bukti penerimaan resmi.</p></div></div>
   <div className="cross-role-heading"><div><span>WORKSPACE / {names[user.role]?.toUpperCase()}</span><h1>{user.role==='admin'?'Dispatch & Operations Monitoring':user.role==='stock'?'Pickup & Receiving Operations':'Assigned Trips & Return'}</h1><p>Admin → Stockpile → Driver → Weighing simulation → Receiving → Return</p></div><button className="cross-role-refresh" type="button" onClick={()=>load()} aria-label="Refresh UAT trips"><RefreshCcw size={16}/> Refresh</button></div>
   {error&&<div className="cross-role-notice error" role="alert">{error}</div>}
   {message&&<div className="cross-role-notice ok" role="status">{message}</div>}
   {loading?<div className="cross-role-empty">Memuat UAT shared transaction store…</div>:!data?<div className="cross-role-empty" role="status"><ShieldAlert size={28}/><strong>UAT data unavailable</strong><p>Data Automatic Tare tidak dapat dimuat. Gunakan Refresh setelah koneksi backend tersedia.</p></div>:<>
    <div className="cross-role-kpis">
     <div><span>Visible trips</span><strong>{jobs.length}</strong><small>Sesuai akses role</small></div>
     <div><span>Active trip</span><strong>{jobs.filter(x=>x.status!=='RETURNED_AVAILABLE').length}</strong><small>Belum selesai return</small></div>
     <div><span>Completed return</span><strong>{jobs.filter(x=>x.status==='RETURNED_AVAILABLE').length}</strong><small>Independently verified UAT</small></div>
     <div><span>Real inventory posting</span><strong>OFF</strong><small>Isolated from production</small></div>
    </div>
    {user.role==='admin'&&<section className="cross-role-panel"><header><h2><Truck size={18}/> Create UAT Dispatch</h2><p>Tambah dispatch menggunakan Driver UAT dan truck simulasi. Sumber dan tujuan berdasarkan lokasi yang tersedia untuk Stockpile.</p></header>
     <form className="cross-role-form" onSubmit={create}>
      <label>Source Stockpile<select value={form.sourceLocation} onChange={e=>setForm(v=>({...v,sourceLocation:e.target.value}))}>{['crusher-1','crusher-2'].map(x=><option key={x}>{x}</option>)}</select></label>
      <label>Destination<select value={form.destinationLocation} onChange={e=>setForm(v=>({...v,destinationLocation:e.target.value}))}>{['crusher-1','crusher-2'].map(x=><option key={x}>{x}</option>)}</select></label>
      <label>Driver<select required value={form.driverUserId} onChange={e=>setForm(v=>({...v,driverUserId:e.target.value}))}><option value="">Select Driver UAT</option>{data.drivers.map(d=><option value={d.id} key={d.id}>{d.username} · {d.label}</option>)}</select></label>
      <label>Truck ID<input value={form.truckId} onChange={e=>setForm(v=>({...v,truckId:e.target.value}))} required/></label>
      <label>Material<input value={form.material} onChange={e=>setForm(v=>({...v,material:e.target.value}))} required/></label>
      <label>Planned amount · UAT tonnes<input value={form.plannedT} onChange={e=>setForm(v=>({...v,plannedT:e.target.value}))} required/></label>
      <button type="submit" disabled={busy||!form.driverUserId}>Create & Assign <ArrowRight size={15}/></button>
     </form>
    </section>}
    <div className="cross-role-grid">
     <section className="cross-role-panel"><header><h2><Route size={18}/> Shared Trip Register</h2><p>{user.role==='stock'?`Pickup yang dikembalikan backend untuk scope lokasi: ${(data.permissions?.stockScope||[]).join(', ')||'—'}.`:'Menampilkan transaksi dari satu database UAT, dengan scope Admin, Stockpile, dan Driver.'}</p></header>
      {!jobs.length?<div className="cross-role-empty"><Truck size={28}/><strong>Belum ada trip untuk role ini</strong><p>Admin harus membuat dispatch terlebih dahulu. Role lain akan melihat assignment yang sesuai setelah refresh.</p></div>:<div className="cross-role-list">{jobs.map(job=><button type="button" className={'cross-role-trip '+(active?.id===job.id?'selected':'')} onClick={()=>setSelected(job.id)} key={job.id} aria-pressed={active?.id===job.id}><span><b>{job.truckId}</b><small>{job.id.slice(0,18)}… · {job.driverLabel}</small></span><span className="cross-role-status">{job.status.replaceAll('_',' ')}</span></button>)}</div>}
     </section>
     <section className="cross-role-panel"><header><h2><Activity size={18}/> Current Trip & Next Action</h2><p>Transisi dikontrol role dan urutan state; aksi dari role yang salah tidak akan diterima.</p></header>
      {!active?<div className="cross-role-empty">Pilih trip untuk menampilkan langkah operasional.</div>:<div className="cross-role-detail">
       <div className="cross-role-route"><Warehouse size={17}/> {active.sourceLocation} <ArrowRight size={17}/> {active.destinationLocation}</div>
       <div className="cross-role-facts">{[['Material',active.material],['Driver',active.driverLabel],['Truck ID',active.truckId],['Plate number','— · unavailable'],['Planned (UAT)',active.plannedT+' t'],['Tare · simulated',active.simulatedTareT!==null?active.simulatedTareT+' t':'—'],['Gross · simulated',active.simulatedGrossT!==null?active.simulatedGrossT+' t':'—'],['Net · simulated',active.simulatedNetT!==null?active.simulatedNetT+' t':'—'],['Current state',active.status.replaceAll('_',' ')]].map(([k,v])=><div key={k}><span>{k}</span><b>{v}</b></div>)}</div>
       <AutomaticTareStatus trip={active}/>
       <LoadingCapacity trip={active}/>
       {canAdvance?<div className="cross-role-next"><small>NEXT ACTION · {names[user.role]}</small>
        {next[0]==='gross'&&<label>Simulated Gross · tonnes<input value={gross} onChange={e=>setGross(e.target.value)}/></label>}
        <button disabled={busy} onClick={takeAction}>{next[2]} <ArrowRight size={16}/></button>
        <p>{next[0]==='gross'?'Simulasi software, bukan pesan atau bukti Weighbridge asli.':'Perubahan hanya terjadi pada database UAT terisolasi.'}</p></div>:
        <div className="cross-role-next waiting"><LockKeyhole size={17}/>{active.status==='DRIVER_ACCEPTED'?automaticTareWaiting(active):next?'Menunggu '+names[next[1]]+' melakukan: '+next[2]:'Trip selesai dan truck kembali tersedia (UAT).'}</div>}
       {user.role==='driver'&&['DRIVER_ACCEPTED','TARE_SIMULATED','LOADING_CONFIRMED','GROSS_SIMULATED','IN_TRANSIT','ARRIVED','RECEIVED'].includes(active.status)&&<div className="cross-role-next"><small>DRIVER CHECKLIST · SELF REPORT</small><textarea value={note} onChange={e=>setNote(e.target.value)} rows="2"/><button disabled={busy} onClick={()=>run('/api/uat/trips/'+active.id+'/actions',{action:'checklist',note})}>Submit Checklist <ClipboardCheck size={16}/></button></div>}
      </div>}
     </section>
    </div>
    <section className="cross-role-panel"><header><h2><Database size={18}/> Shared Operational Event Timeline</h2><p>Setiap aksi mempunyai actor role dan sumber UAT_SIMULATED. Ini bukan audit log produksi.</p></header>
     {!ownEvents.length?<div className="cross-role-empty">Belum ada event untuk trip.</div>:<div className="cross-role-timeline">{ownEvents.map(e=><div key={e.id}><span className="cross-role-dot"/><strong>{e.action.replaceAll('_',' ')}</strong><small>{e.role} · {new Date(e.at).toLocaleString('id-ID')} · {e.source}</small></div>)}</div>}
    </section>
   </>}
  </main>
 </div>;
}
