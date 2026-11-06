import React, {useEffect,useMemo,useState} from 'react';
import {
  Activity,AlertCircle,ArrowRight,CalendarDays,Check,CheckCircle2,ChevronRight,
  ClipboardCheck,Clock3,History,House,Info,Loader2,LogOut,MapPin,Package,
  RefreshCw,Route,ShieldAlert,ShieldCheck,Truck,UserRound,WifiOff
} from 'lucide-react';
import {Brand} from '../components/brand/index.jsx';
import {CrusherDestinationCard} from './CrusherDestinationCard.jsx';
import {targetNavigation} from '../app/navigation.js';
import {
  createDriverDemoAdapter,createDriverStagingAdapter,DRIVER_CHECKLIST,
  DRIVER_DEMO_SCENARIOS,DRIVER_SOURCE,DRIVER_STATE,isActiveDriverTrip
} from '../services/driver-workspace-adapter.js';

const sections=[
  {key:'home',label:'Home',path:'/driver/home',icon:House},
  {key:'tasks',label:'Tasks',path:'/driver/tasks',icon:ClipboardCheck},
  {key:'history',label:'History',path:'/driver/history',icon:History},
  {key:'profile',label:'Profile',path:'/driver/profile',icon:UserRound},
];
const statusLabels={
  QUEUED:'Menunggu keberangkatan',
  START_AUTHORIZED:'Mulai diizinkan',TARE_CONFIRMED:'Tare terverifikasi',
  LOADING:'Loading',GROSS_CONFIRMED:'Gross terverifikasi',
  IN_TRANSIT:'Dalam perjalanan',ARRIVED:'Tiba di tujuan',
  UNLOADED_VERIFIED:'Unloading terverifikasi',RETURNING:'Perjalanan kembali',
  RETURNED_AVAILABLE:'Selesai · tersedia',ON_HOLD:'Ditahan',
  UNKNOWN:'Belum diketahui',CANCELLED:'Dibatalkan',
};
const fmtDate=value=>{
  if(!value)return '—';
  const date=new Date(value);
  return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('id-ID',{
    timeZone:'Asia/Jakarta',day:'2-digit',month:'short',year:'numeric',
    hour:'2-digit',minute:'2-digit'
  }).format(date)+' WIB';
};
const sectionsForStatus=status=>{
  const steps=[
    {id:'assigned',title:'Trip ditugaskan',hint:'Penugasan diterima'},
    {id:'tare',title:'Tare & persiapan muat',hint:'Diverifikasi perangkat dan operator'},
    {id:'depart',title:'Berangkat dari stockpile',hint:'Menunggu gross dan pelepasan muatan'},
    {id:'arrival',title:'Tiba di lokasi tujuan',hint:'Konfirmasi penerimaan oleh petugas'},
    {id:'unloaded',title:'Unloading terverifikasi',hint:'Bukan konfirmasi dari Driver'},
    {id:'returned',title:'Kembali & siap digunakan',hint:'Verifikasi petugas berwenang'},
  ];
  const stages={START_AUTHORIZED:0,TARE_CONFIRMED:1,LOADING:1,GROSS_CONFIRMED:2,
    IN_TRANSIT:2,ARRIVED:3,UNLOADED_VERIFIED:4,RETURNING:4,RETURNED_AVAILABLE:5};
  const at=stages[status]??0;
  return steps.map((s,i)=>({...s,done:i<at,current:i===at}));
};
function IconBox({icon:Icon,variant='teal'}) {
  return <span className={'driver-icon-box '+variant}><Icon size={20} aria-hidden="true"/></span>;
}
function StatePanel({icon:Icon=Info,title,description,action,actionLabel}){
  return <section className="driver-state-panel" role="status">
    <span className="driver-state-icon"><Icon size={26} aria-hidden="true"/></span>
    <h3>{title}</h3><p>{description}</p>
    {action&&<button type="button" className="driver-btn outline" onClick={action}>
      <RefreshCw size={15}/>{actionLabel||'Coba lagi'}</button>}
  </section>;
}
function DriverCard({children,className=''}){return <section className={'driver-card '+className}>{children}</section>;}
function DriverSectionHeading({eyebrow,title,subtitle}){
  return <div className="driver-section-heading"><div className="driver-eyebrow">{eyebrow}</div>
    <h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div>;
}
function LocationFlow({trip}){
  return <div className="driver-location-flow">
    <div className="driver-location-pin start"><MapPin size={18}/></div>
    <div className="driver-location-label"><small>LOKASI ASAL</small>
      <strong>{trip.sourceLocation||'Belum tersedia'}</strong></div>
    <div className="driver-location-connector"/>
    <div className="driver-location-pin end"><MapPin size={18}/></div>
    <div className="driver-location-label"><small>TUJUAN</small>
      <strong>{trip.destinationLocation||'Belum tersedia'}</strong></div>
  </div>;
}
function StatusPill({status}){
  const warning=status==='ON_HOLD'||status==='UNKNOWN';
  const completed=status==='RETURNED_AVAILABLE'||status==='UNLOADED_VERIFIED';
  return <span className={'driver-status-pill '+(warning?'warning':completed?'complete':'active')}>
    <span className="driver-status-dot"/>{statusLabels[status]||status||'Belum tersedia'}
  </span>;
}
function ActiveSummary({trip,onOpen}){
  return <DriverCard className="driver-trip-summary">
    <div className="driver-card-top"><div><span className="driver-card-eyebrow">ASSIGNED TRIP</span>
      <h3>{trip.id}</h3></div><StatusPill status={trip.status}/></div>
    <div className="driver-trip-vehicle"><IconBox icon={Truck}/>
      <div><small>KENDARAAN</small><strong>{trip.truckIdentifier||trip.truckId||'Belum tersedia'}</strong></div>
      <span className="driver-trip-mode">{trip.mode||'TRIP'}</span></div>
    <LocationFlow trip={trip}/>
    <div className="driver-card-footer"><span><Clock3 size={15}/> Mulai: {fmtDate(trip.startedAt)}</span>
      <button type="button" onClick={onOpen}>Lihat tugas <ChevronRight size={16}/></button></div>
  </DriverCard>;
}
function HomeView({user,active,onNavigate,reload}){
  const trip=active.trip;
  return <>
    <div className="driver-hero">
      <div className="driver-eyebrow light">DRIVER OPERATIONS</div>
      <h1>Selamat bertugas,<br/><span>{user?.displayName||user?.username||'Driver'}</span></h1>
      <p>Periksa penugasan dan langkah berikutnya sebelum memulai aktivitas.</p>
      <div className="driver-hero-status"><span className="driver-pulse"/>Driver Workspace <span>·</span> {trip?'1 tugas aktif':'Belum ada tugas aktif terverifikasi'}</div>
    </div>
    <DriverSectionHeading eyebrow="OPERASI SAAT INI" title="Tugas perjalanan"
      subtitle="Hanya menampilkan assignment sesuai akses akun Driver."/>
    {active.state===DRIVER_STATE.LOADING?<StatePanel icon={Loader2} title="Memuat tugas" description="Menghubungkan ke staging service Driver."/>:
      [DRIVER_STATE.ERROR,DRIVER_STATE.FORBIDDEN].includes(active.state)?<StatePanel icon={active.state===DRIVER_STATE.FORBIDDEN?ShieldAlert:WifiOff} title={active.state===DRIVER_STATE.FORBIDDEN?'Akses tugas dibatasi':'Data tugas tidak dapat dimuat'}
        description={active.error||'Coba muat ulang setelah koneksi tersedia.'} action={reload}/>:
      trip?<ActiveSummary trip={trip} onOpen={()=>onNavigate('tasks')}/>:
      <StatePanel icon={active.state===DRIVER_STATE.NOT_INTEGRATED?ShieldAlert:ClipboardCheck}
        title={active.state===DRIVER_STATE.NOT_INTEGRATED?'Integrasi tugas belum aktif':'Belum ada trip aktif'}
        description={active.state===DRIVER_STATE.NOT_INTEGRATED?
          'Login berhasil. Staging API Driver belum menyediakan assignment untuk akun ini. Tidak ada trip produksi yang dibuat otomatis.':
          'Belum ada perjalanan yang ditugaskan. Tugas baru akan muncul setelah dispatch mengonfirmasi assignment.'}
        action={reload} actionLabel="Periksa ulang"/>}
    <DriverSectionHeading eyebrow="AKSES CEPAT" title="Ruang kerja"/>
    <div className="driver-quick-grid">
      <button type="button" onClick={()=>onNavigate('tasks')}><IconBox icon={ClipboardCheck}/>
        <span><strong>Checklist tugas</strong><small>Persiapan & laporan kondisi</small></span><ChevronRight size={18}/></button>
      <button type="button" onClick={()=>onNavigate('history')}><IconBox icon={History} variant="blue"/>
        <span><strong>Riwayat trip</strong><small>Lihat perjalanan sebelumnya</small></span><ChevronRight size={18}/></button>
    </div>
    <div className="driver-inline-note"><ShieldCheck size={18}/>
      <span>Berat timbangan, unloading, dan kesiapan truck hanya sah setelah diverifikasi sistem/petugas berwenang.</span></div>
  </>;
}
function Checklist({trip,adapter,onUpdated,notify}){
  const [saving,setSaving]=useState(null);
  const reportStatus=new Map((trip.checklist||[]).map(x=>[x.itemId,x.status]));
  const complete=DRIVER_CHECKLIST.filter(x=>reportStatus.get(x.id)==='DONE').length;
  const submit=async(item,status)=>{
    setSaving(item.id);
    try{
      await adapter.submitChecklist({tripId:trip.id,itemId:item.id,status});
      await onUpdated();
      notify('Laporan checklist '+(adapter.source===DRIVER_SOURCE.UAT_SIMULATION?'simulasi ':'')+'tersimpan.');
    }catch(error){notify(error.message||'Checklist gagal dicatat.','error');}
    finally{setSaving(null);}
  };
  return <DriverCard><div className="driver-card-top"><div><span className="driver-card-eyebrow">PRE-TRIP CHECKLIST</span>
    <h3>Pemeriksaan kendaraan</h3></div><span className="driver-count-pill">{complete}/{DRIVER_CHECKLIST.length}</span></div>
    <div className="driver-check-progress"><span style={{width:(complete/DRIVER_CHECKLIST.length*100)+'%'}}/></div>
    <p className="driver-muted driver-small">Laporan Driver hanya berupa self-report; bukan bukti penimbangan atau kelayakan truck.</p>
    <div className="driver-checklist">
      {DRIVER_CHECKLIST.map(item=>{
        const status=reportStatus.get(item.id)||'PENDING';
        return <div className="driver-check-row" key={item.id}>
          <div className={'driver-check-indicator '+(status==='DONE'?'done':status==='ISSUE'?'issue':'')}>
            {status==='DONE'?<Check size={16}/>:status==='ISSUE'?<AlertCircle size={16}/>:<span/>}</div>
          <div className="driver-check-label"><strong>{item.label}</strong><small>
            {status==='DONE'?'Dilaporkan selesai':status==='ISSUE'?'Dilaporkan bermasalah':'Belum dilaporkan'}</small></div>
          <div className="driver-check-actions">
            <button type="button" disabled={saving!==null} aria-label={'Tandai selesai: '+item.label}
              className={status==='DONE'?'selected':''} onClick={()=>submit(item,'DONE')}><Check size={16}/></button>
            <button type="button" disabled={saving!==null} aria-label={'Laporkan masalah: '+item.label}
              className={status==='ISSUE'?'issue':''} onClick={()=>submit(item,'ISSUE')}><AlertCircle size={16}/></button>
          </div>
        </div>;
      })}
    </div>
    {DRIVER_CHECKLIST.some(x=>reportStatus.get(x.id)==='ISSUE')&&
      <div className="driver-inline-note alert"><AlertCircle size={18}/>
        <span>Masalah telah dilaporkan. Hubungi pengawas sebelum melanjutkan perjalanan.</span></div>}
  </DriverCard>;
}
function TaskView({active,adapter,reload,notify}){
  const trip=active.trip;
  const [returnBusy,setReturnBusy]=useState(false);
  const returnReady=trip?.status==='UNLOADED_VERIFIED';
  const reportReturn=async()=>{
    setReturnBusy(true);
    try{
      const result=await adapter.reportReturnStart({tripId:trip.id});
      await reload();
      notify(result?.truck_available===false?'Perjalanan kembali dilaporkan. Truck belum dinyatakan tersedia.':'Laporan kembali berhasil.');
    }catch(error){notify(error.message||'Laporan kembali gagal.','error');}
    finally{setReturnBusy(false);}
  };
  return <>
    <DriverSectionHeading eyebrow="MY TASKS" title="Tugas & checklist"
      subtitle="Ikuti urutan operasional dan laporkan pemeriksaan yang dilakukan."/>
    {active.state===DRIVER_STATE.LOADING?<StatePanel icon={Loader2} title="Memuat detail tugas" description="Menyiapkan assignment Driver."/>:
      [DRIVER_STATE.ERROR,DRIVER_STATE.FORBIDDEN].includes(active.state)?<StatePanel icon={active.state===DRIVER_STATE.FORBIDDEN?ShieldAlert:WifiOff} title={active.state===DRIVER_STATE.FORBIDDEN?'Akses penugasan ditolak':'Detail tugas gagal dimuat'} description={active.error} action={reload}/>:
      !trip?<StatePanel icon={active.state===DRIVER_STATE.NO_ASSIGNMENT?ClipboardCheck:active.state===DRIVER_STATE.PENDING_DRIVER_VERIFICATION?ShieldAlert:active.state===DRIVER_STATE.NOT_INTEGRATED?WifiOff:ClipboardCheck}
        title={active.state==='NO_ASSIGNMENT'?'NO_ASSIGNMENT':
          active.state==='PENDING_DRIVER_VERIFICATION'?'PENDING_DRIVER_VERIFICATION':
          active.state===DRIVER_STATE.NOT_INTEGRATED?'NOT_INTEGRATED':'Tidak ada tugas aktif'}
        description={active.state===DRIVER_STATE.NOT_INTEGRATED?'Staging v1 belum terhubung. Tidak ada data trip yang disimulasikan.':
          active.state===DRIVER_STATE.PENDING_DRIVER_VERIFICATION?'Identitas Driver belum memiliki verifikasi independen. Hubungi Admin.' :
          active.state===DRIVER_STATE.NO_ASSIGNMENT?'Belum ada trip yang ditugaskan ke identitas Driver ini.':
          'Penugasan yang sah akan muncul setelah tercatat pada staging v1.'}
        action={reload} actionLabel="Periksa ulang"/>:<>
        <ActiveSummary trip={trip} onOpen={()=>document.getElementById('driver-task-milestones')?.scrollIntoView({behavior:'smooth'})}/>
        <CrusherDestinationCard trip={trip} simulated={adapter.source===DRIVER_SOURCE.UAT_SIMULATION}/>
        <DriverCard><div className="driver-card-top"><div><span className="driver-card-eyebrow">CARGO INFORMATION</span>
          <h3>Detail penugasan</h3></div><IconBox icon={Package} variant="blue"/></div>
          <div className="driver-detail-grid">
            <div><small>Material</small><strong>{trip.material||'Belum tersedia'}</strong></div>
            <div><small>Dispatch</small><strong>{trip.dispatchId||'Belum tersedia'}</strong></div>
            <div><small>Truck ID</small><strong>{trip.truckIdentifier||trip.truckId||'Belum tersedia'}</strong></div>
            <div><small>Status assignment</small><strong>{trip.assignmentStatus||'PENDING_DRIVER_VERIFICATION'}</strong></div>
            <div><small>Muatan rencana</small><strong>{trip.plannedT===null?'Belum tersedia':trip.plannedT.toLocaleString('id-ID')+' t'}</strong></div>
            <div><small>Berat aktual terverifikasi</small><strong>{trip.actualNetT===null?'Belum tersedia':trip.actualNetT.toLocaleString('id-ID')+' t'}</strong></div>
          </div>
        </DriverCard>
        <DriverCard><div className="driver-card-top"><div><span className="driver-card-eyebrow">AUTOMATIC WIM TARE</span>
          <h3>{trip.tareStatus||'TARE_PENDING'}</h3></div><IconBox icon={Activity} variant="blue"/></div>
          <p className="driver-muted">{trip.tareStatus==='TARE_RECEIVED'
            ?'TARE diterima dari event WIM tervalidasi. Status dibaca dari backend operasional.'
            :trip.tareStatus==='TARE_INVALID'
              ?'Event TARE ditolak; hubungi Admin untuk peninjauan sumber dan assignment.'
              :trip.tareStatus==='TARE_FAILED'
                ?'Integrasi gagal memproses event TARE. Status trip tidak berubah; hubungi Admin.'
              :'Menunggu event TARE tervalidasi dari WIM. Driver tidak dapat membuat atau mensimulasikan event ini.'}</p>
          <div className="driver-detail-grid">
            <div><small>Status WIM</small><strong>{trip.wimStatus||'WIM_NOT_CONNECTED'}</strong></div>
            <div><small>Assignment ID</small><strong>{trip.assignmentId||'Belum tersedia'}</strong></div>
          </div>
        </DriverCard>
        <DriverCard className="driver-milestone-card" ><div id="driver-task-milestones" className="driver-card-top"><div>
          <span className="driver-card-eyebrow">TRIP PROGRESS</span><h3>Alur perjalanan</h3></div><IconBox icon={Route}/></div>
          <div className="driver-timeline">{sectionsForStatus(trip.status).map(step=>
            <div className={'driver-timeline-step '+(step.done?'done':step.current?'current':'pending')} key={step.id}>
              <div className="driver-timeline-marker">{step.done?<Check size={14}/>:step.current?<span/>:null}</div>
              <div><strong>{step.title}</strong><small>{step.hint}</small></div>
            </div>)}</div>
          {trip.status==='ON_HOLD'&&<div className="driver-inline-note alert"><AlertCircle size={18}/>Trip HOLD. Ikuti arahan pengawas.</div>}
        </DriverCard>
        <Checklist key={trip.id} trip={trip} adapter={adapter} onUpdated={reload} notify={notify}/>
        <DriverCard><div className="driver-card-top"><div><span className="driver-card-eyebrow">RETURN PROCESS</span>
          <h3>Perjalanan kembali</h3></div><IconBox icon={Truck}/></div>
          <p className="driver-muted">Laporan kembali hanya diperbolehkan setelah unloading diverifikasi independen oleh petugas. Truck tetap BUSY hingga return verification.</p>
          <button className="driver-btn primary" type="button" onClick={reportReturn} disabled={!returnReady||returnBusy}>
            {returnBusy?<Loader2 className="spin" size={17}/>:<ArrowRight size={17}/>}
            {trip.status==='RETURNING'?'Menunggu verifikasi kembali':'Laporkan mulai kembali'}
          </button>
          {!returnReady&&<p className="driver-subnote">
            {trip.status==='RETURNING'?'Laporan kembali tercatat. Menunggu verifikasi petugas.':'Belum dapat dilakukan pada status '+(statusLabels[trip.status]||trip.status)+'.'}</p>}
        </DriverCard>
      </>}
  </>;
}
function HistoryView({history,reload}){
  return <><DriverSectionHeading eyebrow="MY HISTORY" title="Riwayat perjalanan"
    subtitle="Hanya perjalanan milik Driver yang terautentikasi."/>
    {history.state===DRIVER_STATE.LOADING?<StatePanel icon={Loader2} title="Memuat riwayat" description="Menghubungkan ke staging service."/>:
      [DRIVER_STATE.ERROR,DRIVER_STATE.FORBIDDEN].includes(history.state)?<StatePanel icon={history.state===DRIVER_STATE.FORBIDDEN?ShieldAlert:WifiOff} title={history.state===DRIVER_STATE.FORBIDDEN?'Akses riwayat dibatasi':'Riwayat gagal dimuat'} description={history.error} action={reload}/>:
      history.state===DRIVER_STATE.NOT_INTEGRATED?<StatePanel icon={ShieldAlert} title="Riwayat belum terintegrasi"
        description="Staging service belum menyediakan history untuk akun ini. Tidak ada perjalanan yang disembunyikan atau dihitung sebagai nol." action={reload}/>:
      !history.items.length?<StatePanel icon={History} title="Belum ada riwayat"
        description="Perjalanan yang telah selesai dan diverifikasi akan ditampilkan di sini." action={reload} actionLabel="Perbarui riwayat"/>:
      <div className="driver-history-list">{history.items.map(item=><DriverCard key={item.id}>
        <div className="driver-card-top"><div><span className="driver-card-eyebrow">TRIP COMPLETED</span>
          <h3>{item.id}</h3></div><StatusPill status={item.status}/></div>
        <div className="driver-history-meta"><span><CalendarDays size={16}/>{fmtDate(item.startedAt)}</span>
          <span><Truck size={16}/>{item.truckIdentifier||item.truckId||'Truck tidak tersedia'}</span></div>
        <div className="driver-card-footer"><span>Dispatch: {item.dispatchId||'—'}</span>
          <span>Kembali: {fmtDate(item.returnedAt)}</span></div>
      </DriverCard>)}</div>}
  </>;
}
function ProfileView({user,logout,source,canSimulate,scenario,setScenario,setSource,reload}){
  const simulated=source===DRIVER_SOURCE.UAT_SIMULATION;
  return <>
    <DriverSectionHeading eyebrow="MY PROFILE" title="Profil Driver"
      subtitle="Identitas sesi dan akses berdasarkan role."/>
    <DriverCard className="driver-profile-identity">
      <div className="driver-avatar"><UserRound size={32}/></div>
      <h3>{user?.displayName||user?.username||'Driver'}</h3>
      <p>@{user?.username||'—'}</p><span className="driver-role-tag"><ShieldCheck size={14}/> DRIVER ACCOUNT</span>
    </DriverCard>
    <DriverCard><div className="driver-card-top"><div><span className="driver-card-eyebrow">ACCOUNT STATUS</span>
      <h3>Akses & integrasi</h3></div><IconBox icon={ShieldCheck}/></div>
      <div className="driver-profile-rows">
        <div><span>Role akun</span><strong>Driver</strong></div>
        <div><span>Sumber data</span><strong>{simulated?'UAT · SIMULASI':'Staging API v1'}</strong></div>
        <div><span>Driver ID production</span><strong>Belum terverifikasi</strong></div>
        <div><span>Hak verifikasi weighing</span><strong>Tidak diizinkan</strong></div>
        <div><span>Hak otorisasi unloading</span><strong>Tidak diizinkan</strong></div>
      </div>
    </DriverCard>
    {canSimulate&&<DriverCard><div className="driver-card-top"><div><span className="driver-card-eyebrow">UAT SETTINGS</span>
      <h3>Sumber data untuk pengujian</h3></div><IconBox icon={Activity} variant="blue"/></div>
      <p className="driver-muted">Simulasi dibuat di memori browser. Tidak terhubung ke truck, timbangan, atau database operasional.</p>
      <div className="driver-mode-options" role="group" aria-label="Mode data Driver">
        <button type="button" className={!simulated?'selected':''} onClick={()=>setSource(DRIVER_SOURCE.STAGING)}>
          <ShieldCheck size={16}/>Staging API</button>
        <button type="button" className={simulated?'selected':''} onClick={()=>setSource(DRIVER_SOURCE.UAT_SIMULATION)}>
          <Activity size={16}/>UAT Simulation</button>
      </div>
      {simulated&&<><p className="driver-subnote">Pilih skenario simulasi:</p>
        <div className="driver-scenario-options" role="group" aria-label="Skenario UAT">
          {[['ASSIGNED','Trip aktif'],['EMPTY','Tidak ada trip'],['RETURN_READY','Unloading selesai']].map(([key,label])=>
            <button type="button" key={key} className={scenario===key?'selected':''}
              onClick={()=>setScenario(key)}>{label}</button>)}
        </div></>}
      <button className="driver-btn outline" type="button" onClick={reload}><RefreshCw size={16}/>Perbarui data</button>
    </DriverCard>}
    <button type="button" className="driver-btn logout" onClick={logout}><LogOut size={18}/>Keluar dari akun</button>
  </>;
}
export function DriverLayout({logout,user,csrf}){
  const canSimulate=import.meta.env.DEV;
  const [page,setPage]=useState(()=>sections.find(x=>x.path===window.location.pathname)?.key||'home');
  const [source,setSource]=useState(DRIVER_SOURCE.STAGING);
  const [scenario,setScenario]=useState(DRIVER_DEMO_SCENARIOS.ASSIGNED);
  const [active,setActive]=useState({state:DRIVER_STATE.LOADING,trip:null,items:[]});
  const [history,setHistory]=useState({state:DRIVER_STATE.LOADING,trip:null,items:[]});
  const [refreshCount,setRefreshCount]=useState(0);
  const [feedback,setFeedback]=useState(null);
  const adapter=useMemo(()=>source===DRIVER_SOURCE.UAT_SIMULATION?
    createDriverDemoAdapter({scenario}):createDriverStagingAdapter({csrf}),[source,scenario,csrf]);
  const notify=(message,type='success')=>setFeedback({message,type});
  const reload=()=>setRefreshCount(count=>count+1);
  useEffect(()=>{
    let live=true;
    setActive({state:DRIVER_STATE.LOADING,trip:null,items:[]});
    setHistory({state:DRIVER_STATE.LOADING,trip:null,items:[]});
    const load=async()=>{
      const [a,h]=await Promise.allSettled([adapter.getActiveTrip(),adapter.getHistory()]);
      if(!live)return;
      setActive(a.status==='fulfilled'?a.value:{state:a.reason?.status===403?DRIVER_STATE.FORBIDDEN:DRIVER_STATE.ERROR,
        trip:null,items:[],error:a.reason?.message||'Tidak dapat mengambil tugas Driver.'});
      setHistory(h.status==='fulfilled'?h.value:{state:h.reason?.status===403?DRIVER_STATE.FORBIDDEN:DRIVER_STATE.ERROR,
        trip:null,items:[],error:h.reason?.message||'Tidak dapat mengambil history Driver.'});
    };
    load();
    return ()=>{live=false;};
  },[adapter,refreshCount]);
  useEffect(()=>{
    if(source!==DRIVER_SOURCE.STAGING)return;
    const refresh=()=>{if(document.visibilityState==='visible')reload()};
    const timer=setInterval(refresh,3000);
    document.addEventListener('visibilitychange',refresh);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh)};
  },[source]);
  useEffect(()=>{
    const back=()=>setPage(sections.find(x=>x.path===window.location.pathname)?.key||'home');
    window.addEventListener('popstate',back);
    return ()=>window.removeEventListener('popstate',back);
  },[]);
  const navigate=key=>{
    const target=sections.find(x=>x.key===key);
    if(!target||!targetNavigation.DRIVER.includes(target.path))return;
    if(window.location.pathname!==target.path)window.history.pushState(null,'',target.path);
    setPage(key);
    window.scrollTo({top:0,behavior:'smooth'});
  };
  const demo=source===DRIVER_SOURCE.UAT_SIMULATION;
  return <div className="driver-shell">
    <header className="driver-header"><div className="driver-brand"><Brand light/>
      <span className="driver-header-label">DRIVER WORKSPACE</span></div>
      <button className="driver-header-icon" type="button" onClick={reload} aria-label="Perbarui data Driver"><RefreshCw size={19}/></button>
    </header>
    <div className={'driver-source-banner '+(demo?'simulated':'staging')} role="status">
      <span className="driver-source-indicator">{demo?<Activity size={16}/>:<ShieldAlert size={16}/>}</span>
      <div><strong>{demo?'UAT · SIMULATED DATA':'STAGING API · NO PRODUCTION DATA'}</strong>
        <small>{demo?'Data contoh untuk menguji UI. Semua laporan hanya disimpan dalam sesi ini.':
          'Data Driver hanya dibaca dari integrasi v1. Jika belum aktif, status akan ditampilkan secara eksplisit.'}</small></div>
      {canSimulate&&<button type="button" onClick={()=>setSource(demo?DRIVER_SOURCE.STAGING:DRIVER_SOURCE.UAT_SIMULATION)}
        aria-label={demo?'Kembali ke data staging':'Aktifkan simulasi UAT'}>
        {demo?'Keluar UAT':'Coba UAT'} <ChevronRight size={15}/></button>}
    </div>
    {demo&&<div className="driver-demo-scenarios" role="group" aria-label="Pilihan skenario demonstrasi">
      {[['ASSIGNED','Trip aktif'],['EMPTY','Tanpa trip'],['RETURN_READY','Unloaded']].map(([key,label])=>
        <button key={key} type="button" className={scenario===key?'selected':''} onClick={()=>setScenario(key)}>{label}</button>)}
    </div>}
    <main className="driver-main">
      {page==='home'&&<HomeView user={user} active={active} onNavigate={navigate} reload={reload}/>}
      {page==='tasks'&&<TaskView active={active} adapter={adapter} reload={reload} notify={notify}/>}
      {page==='history'&&<HistoryView history={history} reload={reload}/>}
      {page==='profile'&&<ProfileView user={user} logout={logout} source={source} canSimulate={canSimulate} scenario={scenario}
        setSource={setSource} setScenario={setScenario} reload={reload}/>}
      <footer className="driver-footer">AIMOC · PT Alfa Granitama <span>•</span> Driver Operations
        <div>{demo?'SIMULATED UAT — NOT PRODUCTION':'Staging integration · Verified operational data only'}</div></footer>
    </main>
    <nav className="driver-mobile-nav" aria-label="Navigasi Driver">
      {sections.map(item=><button key={item.key} type="button" onClick={()=>navigate(item.key)}
        aria-current={page===item.key?'page':undefined} className={page===item.key?'selected':''}>
        <item.icon size={20} aria-hidden="true"/><span>{item.label}</span>
      </button>)}
    </nav>
    {feedback&&<div className={'driver-toast '+(feedback.type==='error'?'error':'')} role="alert">
      {feedback.type==='error'?<AlertCircle size={18}/>:<CheckCircle2 size={18}/>}
      <span>{feedback.message}</span>
      <button type="button" onClick={()=>setFeedback(null)} aria-label="Tutup notifikasi">×</button></div>}
  </div>;
}
