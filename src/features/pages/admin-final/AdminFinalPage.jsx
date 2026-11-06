import React,{useEffect,useState} from 'react';
import {ArrowRight,LockKeyhole,Package,RefreshCw,Search,ShieldCheck} from 'lucide-react';
import {InventoryPage} from '../inventory/index.jsx';
import {TransfersPage} from '../requests/index.jsx';
import {MasterDataPage} from '../master/index.jsx';
import {AuditPage} from '../audit/index.jsx';
import {LegacyJettyPage} from '../jetty/index.jsx';
import {AdminAccessPage} from '../admin-access/AdminAccessPage.jsx';
import {StagingDispatchExecution} from './StagingDispatchExecution.jsx';
import {FleetBoard} from '../../dispatch/index.jsx';
import {useTruckUatProgress} from '../../../hooks/useTruckUatProgress.js';
import {useOperationalV1} from '../../../hooks/useOperationalV1.js';
import './admin-final.css';

const active=s=>['loading','in_transit','arrived','unloaded'].includes(s);
const shown=x=>x===null||x===undefined||x===''?'—':String(x);
const pretty=x=>String(x||'unknown').replaceAll('_',' ').toUpperCase();
const number=x=>Number(x||0).toLocaleString('id-ID',{maximumFractionDigits:2});
const date=x=>!x?'—':new Date(x).toLocaleString('id-ID',{dateStyle:'medium',timeStyle:'short'});
function Tag({children,tone='neutral'}){return <span className={'af-tag '+tone}>{children}</span>}
function Banner({children,warning=false}){return <div role="note" className={'af-banner '+(warning?'warn':'')}><ShieldCheck size={18}/><span>{children}</span></div>}
function Section({title,description,action,children}){return <section className="af-panel"><header><div><h2>{title}</h2><p>{description}</p></div>{action}</header>{children}</section>}
function Locked({title,description}){return <div className="af-locked"><LockKeyhole size={22}/><div><b>{title}</b><p>{description}</p></div><Tag>NOT INTEGRATED</Tag></div>}
function Metrics({items}){return <div className="af-metrics">{items.map((x,i)=><div key={x.label} className={'af-metric m'+i}><span>{x.label}</span><strong>{x.value}<small>{x.unit||''}</small></strong><p>{x.detail}</p></div>)}</div>}
function Table({columns,rows,empty='Tidak ada record dalam snapshot yang tersedia.'}){return <div className="af-scroll"><table className="af-table"><thead><tr>{columns.map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{rows.length?rows.map((r,i)=><tr key={r.id||i}>{r.cells.map((cell,j)=><td key={j}>{cell}</td>)}</tr>):<tr><td colSpan={columns.length}><div className="af-empty"><Package size={24}/><b>Belum ada data</b><p>{empty}</p></div></td></tr>}</tbody></table></div>}
function Overview({c}){
 const on=c.trips.filter(t=>active(t.status));
 const pending=c.measurements.filter(m=>['pending','needs_calibration'].includes(m.status));
 return <><Banner>Overview bersumber dari snapshot legacy. Tidak ada QR/TARE/GROSS aktual, telemetry perangkat, atau verified net tonnes yang diasumsikan.</Banner>
 <Metrics items={[
 {label:'ACTIVE TRIPS · LEGACY',value:on.length,detail:'Loading, transit, arrived, unloaded'},
 {label:'QUEUED TRIPS',value:c.queuedTrips.length,detail:'Dari populasi trip legacy'},
 {label:'MEASUREMENTS TO REVIEW',value:pending.length,detail:'Termasuk bukti belum terkalibrasi'},
 {label:'ERP OUTBOX INTENTS',value:c.erpOutbox.length,detail:'Belum merupakan posted ERP'}
 ]}/>
 <div className="af-split">
 <Section title="Trip process overview" description="Status dari populasi trip yang sama">
 <div className="af-process">{['queued','loading','in_transit','arrived','unloaded','returned'].map(s=><div key={s}><span>{pretty(s)}</span><b>{c.trips.filter(t=>t.status===s).length}</b></div>)}</div>
 </Section>
 <Section title="Source & integration readiness" description="Status unknown tidak dinyatakan healthy">
 <div className="af-status-lines">{[['Weighbridge','NOT INTEGRATED'],['Actual cargo tonnes','NOT VERIFIED'],['Driver identity','NOT INTEGRATED'],['ERP acknowledgement','AWAITING CONFIG']].map(([k,v])=><div key={k}><span>{k}</span><Tag>{v}</Tag></div>)}</div>
 </Section></div>
 <Section title="Active & recent trips" description="Data dari legacy transaction store" action={<button className="af-link" onClick={()=>c.selectPage('dispatchMonitoring')}>Trip Monitoring <ArrowRight size={14}/></button>}>
 <Table columns={['Trip','Truck','Source','Destination','State']} rows={[...c.trips].reverse().slice(0,12).map(t=>({id:t.id,cells:[<b>{t.code||t.id}</b>,shown(c.truck(t.truckId)?.plate),shown(c.stockpile(t.stockpileId)?.code),shown(c.jetty(t.jettyId)?.name),<Tag tone={active(t.status)?'amber':'neutral'}>{pretty(t.status)}</Tag>]}))}/></Section></>;
}
function SimulatedQrAction({trip,truck,csrf,onSuccess}){
 const [status,setStatus]=useState('LOADING');
 const [pending,setPending]=useState(false);
 const [error,setError]=useState(null);
 const [accessToken,setAccessToken]=useState(null);
 const refresh=async()=>{
  try{
   const res=await fetch('/api/uat/truck-qr',{credentials:'same-origin'});
   const body=await res.json();
   if(!res.ok)throw new Error(body.message||'QR staging unavailable');
   setStatus(body.items?.some(e=>e.trip_id===trip.id&&e.truck_id===trip.truckId)?'SIMULATED':'PENDING');
  }catch(e){setStatus('UNAVAILABLE');setError(e.message)}
 };
 useEffect(()=>{refresh()},[trip.id,trip.truckId]);
 const simulate=async()=>{
  if(pending)return;
  setPending(true);setError(null);
  try{
   const res=await fetch('/api/uat/truck-qr',{
    method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
    body:JSON.stringify({tripId:trip.id,truckId:trip.truckId})});
   const body=await res.json();
   if(!res.ok)throw new Error(body.message||'QR simulation failed');
   setStatus('SIMULATED');
   setAccessToken(body.accessToken||null);
   onSuccess?.('Scan QR UAT dicatat. Salin token akses ke Driver melalui saluran UAT yang aman.');
  }catch(e){setError(e.message)}finally{setPending(false)}
 };
 const driverLink=accessToken?`/driver/tasks#${new URLSearchParams({truck:truck?.code||''})}`:null;
 return <div style={{display:'grid',gap:5}}>
  <button type="button" className="af-link" disabled={pending||status==='LOADING'||status==='UNAVAILABLE'}
   onClick={simulate}>{pending?'Mencatat…':status==='SIMULATED'?'Buat Ulang Akses Driver':'Simulasi Scan QR'} <ArrowRight size={14}/></button>
  {driverLink&&<a className="af-link" href={driverLink} target="_blank" rel="noreferrer">Buka Task Driver <ArrowRight size={14}/></a>}
  {status==='UNAVAILABLE'&&<small>QR demo lokal belum tersedia. Jalankan ulang server lokal.</small>}
  {error&&<small role="alert" style={{color:'#b54c3d'}}>{error}</small>}
 </div>;
}
function Planning({c}){
 const qrProgress=useTruckUatProgress();
 const progressByTrip=new Map(qrProgress.items.map(x=>[x.trip_id,x]));
 const reqs=c.requests.filter(r=>r.status==='requested');
 return <><Banner>Dispatch dibuat dari Transfer Request. Armada yang mempunyai ritase QUEUED tampil Dialokasikan, bukan Idle maupun Sedang Transfer. Status perjalanan baru aktif setelah milestone tercatat.</Banner>
 <Metrics items={[
 {label:'UNPLANNED REQUESTS',value:reqs.length,detail:'Menunggu alokasi dispatch'},
 {label:'DISPATCH RECORDS',value:c.dispatches.length,detail:'Legacy source'},
 {label:'AVAILABLE TRUCKS',value:c.idleTrucks.length,detail:'Berdasarkan status snapshot'},
 {label:'ALLOCATED TRUCKS',value:c.allocatedTruckIds?.size??c.trucks.filter(t=>t.status==='allocated').length,detail:c.queuedTrips.length+' ritase QUEUED, belum mulai'}
 ]}/>
 <FleetBoard trucks={c.trucks} trips={c.trips} products={c.products} stockpiles={c.stockpiles} vessels={c.vessels} setModal={c.setModal} uatProgressByTrip={progressByTrip}/>
 <Section title="Trip & Truck Allocation · Legacy" description="Simulasikan QR lalu buka Task Driver langsung dari ritase yang dipilih.">
 <Table columns={['Trip / Dispatch','Truck','Material / Stockpile','Muatan rencana','Progres Demo','Status','Aksi QR']} rows={c.trips.filter(t=>t.dispatchId).map(t=>({
  id:t.id,cells:[
   <><b>{t.code||t.id}</b><small>{shown(c.dispatches.find(d=>d.id===t.dispatchId)?.code||t.dispatchId)}</small></>,
   <><b>{shown(c.truck(t.truckId)?.code||t.truckId)}</b><small>{shown(c.truck(t.truckId)?.plate)}</small></>,
   <><b>{shown(c.product(t.skuId)?.code)}</b><small>{shown(c.stockpile(t.stockpileId)?.code)}</small></>,
   <span>{t.volumeM3==null?'—':number(t.volumeM3)+' m³'}{t.tonnageT==null?'':' / '+number(t.tonnageT)+' t'}</span>,
   <Tag tone={progressByTrip.get(t.id)?.task_uat_status==='COMPLETED'?'teal':
       progressByTrip.get(t.id)?.task_uat_status==='IN_PROGRESS'?'amber':'neutral'}>
       {qrProgress.available?pretty(progressByTrip.get(t.id)?.task_uat_status||'QR_PENDING'):'UAT UNAVAILABLE'}
       </Tag>,
   <Tag tone={progressByTrip.get(t.id)?.task_uat_status==='COMPLETED'?'teal':progressByTrip.get(t.id)?.task_uat_status==='IN_PROGRESS'?'amber':t.status==='queued'?'neutral':'amber'}>{pretty(progressByTrip.get(t.id)?.task_uat_status?progressByTrip.get(t.id).task_uat_status+' · DEMO':t.status)}</Tag>,
   <SimulatedQrAction trip={t} truck={c.truck(t.truckId)} csrf={c.csrf} onSuccess={c.notify}/>
  ]
 }))} empty="Belum ada ritase yang dialokasikan di legacy."/></Section>
 </>;
}
function StagingTripAssignments({c}){
 const [state,setState]=useState({status:'LOADING',trips:[],drivers:[],error:null});
 const [selected,setSelected]=useState({});
 const [saving,setSaving]=useState(null);
 const load=async()=>{
  setState(previous=>({...previous,status:'LOADING',error:null}));
  try{
   const [tripResponse,driverResponse]=await Promise.all([
    fetch('/api/v1/trips',{credentials:'same-origin',headers:{Accept:'application/json'}}),
    fetch('/api/v1/drivers/assignable',{credentials:'same-origin',headers:{Accept:'application/json'}})
   ]);
   const [tripPayload,driverPayload]=await Promise.all([tripResponse.json(),driverResponse.json()]);
   if(!tripResponse.ok)throw new Error(tripPayload.message||'Trip staging belum tersedia.');
   if(!driverResponse.ok)throw new Error(driverPayload.message||'Identitas Driver terverifikasi belum tersedia.');
   setState({status:'READY',trips:tripPayload.data?.items||[],drivers:driverPayload.data?.items||[],error:null});
  }catch(error){
   setState({status:'ERROR',trips:[],drivers:[],error:error.message||'Staging assignment gagal dimuat.'});
  }
 };
 useEffect(()=>{load();},[]);
 const assign=async trip=>{
  const driverId=selected[trip.trip_id];
  if(!driverId)return;
  setSaving(trip.trip_id);
  try{
   const response=await fetch('/api/v1/trips/'+encodeURIComponent(trip.trip_id)+'/assign-driver',{
    method:'POST',credentials:'same-origin',
    headers:{Accept:'application/json','Content-Type':'application/json','X-CSRF-Token':c.csrf,
     'Idempotency-Key':crypto.randomUUID()},
    body:JSON.stringify({driver_id:driverId,assignment_id:crypto.randomUUID()})
   });
   const payload=await response.json();
   if(!response.ok)throw new Error(payload.message||'Assignment Driver gagal disimpan.');
   await load();
   c.notify('Assignment Driver staging tersimpan sebelum trip dimulai.');
  }catch(error){c.notify(error.message||'Assignment Driver gagal disimpan.','error');}
  finally{setSaving(null);}
 };
 return <Section title="Verified Driver Assignment · V1 Staging" description="Hanya trip execution staging yang dapat ditugaskan ke Driver beridentitas VERIFIED. RIT legacy tidak otomatis menjadi assignment Driver."
  action={<button className="af-link" type="button" onClick={load} disabled={state.status==='LOADING'}><RefreshCw size={14}/>Refresh</button>}>
  {state.status==='ERROR'?<div className="af-empty"><b>STAGING_NOT_AVAILABLE</b><p>{state.error}</p></div>:
   state.status==='LOADING'?<div className="af-empty"><b>Memuat assignment staging…</b></div>:
   <Table columns={['Trip / Dispatch','Truck','Assigned Driver','Status assignment','Automatic TARE','Driver available','Action']}
    empty="Belum ada trip pada execution staging. Data legacy tidak otomatis disalin."
    rows={state.trips.map(trip=>({id:trip.trip_id,cells:[
     <><b>{trip.trip_id}</b><small>{trip.dispatch_id}</small></>,
     shown(trip.truck_id),
     <><b>{trip.assignment_status==='ASSIGNED'?shown(trip.driver_assignment?.display_name):'Belum terverifikasi'}</b>
      <small>{trip.assignment_status==='ASSIGNED'?shown(trip.assignment_id):'No verified assignment'}</small></>,
     <Tag tone={trip.assignment_status==='ASSIGNED'?'teal':'amber'}>{pretty(trip.assignment_status)}</Tag>,
     <Tag tone={trip.tare_status==='TARE_RECEIVED'?'teal':trip.tare_status==='TARE_INVALID'?'amber':'neutral'}>{shown(trip.tare_status)}</Tag>,
     <select aria-label={'Pilih Driver untuk '+trip.trip_id} value={selected[trip.trip_id]||''}
      onChange={event=>setSelected(current=>({...current,[trip.trip_id]:event.target.value}))}
      disabled={trip.status!=='QUEUED'||state.drivers.length===0}>
      <option value="" disabled>Pilih Driver</option>
      {state.drivers.map(driver=><option key={driver.driver_id} value={driver.driver_id}>
       {driver.display_name} · {driver.driver_id}</option>)}
     </select>,
     <button className="af-link" type="button" disabled={trip.status!=='QUEUED'||!selected[trip.trip_id]||saving===trip.trip_id}
      onClick={()=>assign(trip)}>{saving===trip.trip_id?'Menyimpan…':'Assign Driver'}</button>
    ]}))}/>}
 </Section>;
}
function Monitoring({c}){
 const v1=useOperationalV1('/api/v1/trips');
 const qrProgress=useTruckUatProgress();
 const progressByTrip=new Map(qrProgress.items.map(x=>[x.trip_id,x]));
 const [q,setQ]=useState('');const [status,setStatus]=useState('all');
 const staging=v1.source==='V1_STAGING';
 const rows=staging?(v1.data?.items||[]):c.trips;
 const filtered=rows.filter(t=>{
  const state=t.status||'UNKNOWN';
  const text=staging?[t.trip_id,t.dispatch_id,t.truck_id,t.driver_id,t.source_stockpile_id]:[t.code,c.truck(t.truckId)?.plate,c.stockpile(t.stockpileId)?.code];
  return (status==='all'||state.toLowerCase()===status.toLowerCase())&&text.join(' ').toLowerCase().includes(q.toLowerCase());
 });
 if(staging)return <><Banner>V1_STAGING aktif. Admin, Stockpile, dan Driver membaca trip dari graph operasional yang sama.</Banner>
 <Metrics items={[
  {label:'ACTIVE TRIPS',value:rows.filter(t=>!['RETURNED_AVAILABLE','CANCELLED'].includes(t.status)).length,detail:'Execution staging'},
  {label:'TARE RECEIVED',value:rows.filter(t=>t.tare_status==='TARE_RECEIVED').length,detail:'Status backend'},
  {label:'ASSIGNED DRIVER',value:rows.filter(t=>t.assignment_status==='ASSIGNED').length,detail:'Verified assignment'},
  {label:'VISIBLE TRIPS',value:rows.length,detail:'Unified role graph'}]}/>
 <Section title="Unified Trip Register" description="Refresh otomatis setiap 3 detik; data berasal dari execution staging."
  action={<button className="af-link" onClick={v1.reload}><RefreshCw size={14}/>Refresh</button>}>
  <Table columns={['Trip / Dispatch','Truck / Driver','Source / Destination','Planned','Tare','State']} rows={filtered.map(t=>({id:t.trip_id,cells:[
   <><b>{t.trip_id}</b><small>{t.dispatch_id}</small></>,
   <><b>{shown(t.truck_id)}</b><small>{t.driver_assignment?.display_name||shown(t.driver_id)}</small></>,
   <><b>{shown(t.source_stockpile_id)}</b><small>{shown(t.destination_location_id)}</small></>,
   t.planned_quantity_t==null?'—':t.planned_quantity_t+' t',
   <Tag tone={t.tare_status==='TARE_RECEIVED'?'teal':t.tare_status==='TARE_INVALID'?'amber':'neutral'}>{shown(t.tare_status)}</Tag>,
   <Tag tone={['IN_TRANSIT','ARRIVED','LOADING'].includes(t.status)?'amber':'neutral'}>{pretty(t.status)}</Tag>
  ]}))}/></Section></>;
 return <><Banner>Register legacy dan execution staging adalah sumber terpisah. Trip legacy tidak akan dipetakan otomatis ke transaksi staging tanpa rekonsiliasi ID dan verifikasi.</Banner>
 <Metrics items={[
 {label:'ACTIVE TRIPS',value:c.activeTrips.length,detail:'Status kerja yang tercatat'},
 {label:'IN TRANSIT / ARRIVED',value:c.transit.length,detail:'Belum dihitung delivered'},
 {label:'RETURNED',value:c.trips.filter(t=>t.status==='returned').length,detail:'Legacy return confirmation'},
 {label:'QUEUED',value:c.queuedTrips.length,detail:'Belum aktif'}
 ]}/>
 <Section title="Trip Register" description="Cari atau filter data tanpa mengubah populasi trip yang sama" action={<div className="af-filters"><label><Search size={15}/><input aria-label="Cari trip" placeholder="Trip / truck / stockpile" value={q} onChange={e=>setQ(e.target.value)}/></label><select aria-label="Filter status trip" value={status} onChange={e=>setStatus(e.target.value)}>{['all','queued','loading','in_transit','arrived','unloaded','returned'].map(s=><option key={s} value={s}>{s==='all'?'All status':pretty(s)}</option>)}</select></div>}>
 <Table columns={['Trip','Truck','SKU','Stockpile','Destination','Operational State','Driver UAT','Detail']} rows={filtered.map(t=>({id:t.id,cells:[<b>{t.code||t.id}</b>,shown(c.truck(t.truckId)?.plate),shown(c.product(t.skuId)?.code),shown(c.stockpile(t.stockpileId)?.code),shown(c.jetty(t.jettyId)?.name),<Tag tone={active(t.status)?'amber':'neutral'}>{pretty(t.status)}</Tag>,
 <Tag>{qrProgress.available?pretty(progressByTrip.get(t.id)?.task_uat_status||'QR_PENDING'):'UAT UNAVAILABLE'}</Tag>,
 <button className="af-link" onClick={()=>c.setModal({type:'trip',record:t})}>View detail <ArrowRight size={14}/></button>]}))}/></Section>
 <Locked title="Verified milestones and driver identity" description="Tare/gross event references, source identities and evidence are required before displaying transaction-stage health."/></>;
}
function Exceptions({c}){
 const pending=c.measurements.filter(m=>['pending','needs_calibration'].includes(m.status));
 const matching=c.events.filter(e=>/hold|error|reject|conflict|exception/i.test([e.type,e.description].join(' ')));
 return <><Banner warning>Ini bukan data Open Issues production. Exception service v1 belum diaktifkan; hanya bukti review legacy yang dapat ditampilkan.</Banner>
 <Metrics items={[{label:'PENDING MEASUREMENTS',value:pending.length,detail:'Legacy data review'}, {label:'MATCHING AUDIT EVENTS',value:matching.length,detail:'Hasil pencarian label event'}, {label:'VERIFIED OPEN ISSUES',value:'—',detail:'Source not integrated'}, {label:'HOLD / RECOVERY',value:'—',detail:'Not integrated'}]}/>
 <Section title="Review queue" description="Tidak menyatakan zero exceptions ketika sumbernya belum ada">
 <Table columns={['Type','Reference','Source detail','Status','Action']} rows={[
 ...pending.map(m=>({id:m.id,cells:['Measurement',m.code||m.id,shown(c.stockpile(m.stockpileId)?.code),<Tag tone="amber">{pretty(m.status)}</Tag>,<button className="af-link" onClick={()=>c.selectPage('inventory')}>Inventory <ArrowRight size={14}/></button>]})),
 ...matching.map(e=>({id:e.id,cells:['Audit event',e.entityId||e.id,shown(e.description),<Tag>REVIEW</Tag>,<button className="af-link" onClick={()=>c.selectPage('integrations')}>Audit <ArrowRight size={14}/></button>]}))
 ]} empty="Belum ada item legacy yang cocok. Hal ini bukan bukti bahwa production bebas masalah."/></Section>
 <Locked title="Exception management" description="HOLD, recovery, shortfall, cancellation dan override tidak boleh diaktifkan sebelum backend final lulus acceptance."/></>;
}
function FinalInventory({c,contract}){
 const on=c.stockpiles.reduce((n,s)=>n+(Number(s.onHandM3)||0),0);
 const reserved=c.stockpiles.reduce((n,s)=>n+(Number(s.reservedM3)||0),0);
 return <><Banner>Seluruh angka inventory saat ini adalah volume legacy m³. Tonase stok aktual masih menunggu reconciliation fisik dan persetujuan independen.</Banner>
 <Metrics items={[{label:'STOCK ON HAND',value:number(on),unit:'m³',detail:'Volume tercatat legacy'}, {label:'RESERVED',value:number(reserved),unit:'m³',detail:'Reservasi legacy'}, {label:'STOCKPILE MASTER',value:c.stockpiles.length,detail:'Lokasi terdaftar'}, {label:'MEASUREMENT PENDING',value:c.measurements.filter(m=>m.status==='pending').length,detail:'Menunggu peninjauan Admin'}]}/>
 <InventoryPage context={c} contract={contract}/>
 <Locked title="Reconciled inventory tonnes" description="Opening inventory v1 dan physical mass evidence tidak tersedia pada legacy snapshot."/></>;
}
function FinalIntegrations({c,contract}){
 return <><Banner>ERP outbox adalah intent; bukan bukti posting NetSuite. Signature perangkat, calibration dan source health belum terhubung.</Banner>
 <Metrics items={[{label:'AUDIT EVENTS',value:c.events.length,detail:'Legacy activity'}, {label:'ERP OUTBOX',value:c.erpOutbox.length,detail:'Awaiting confirmation'}, {label:'WEIGHBRIDGE SOURCE',value:'—',detail:'Not integrated'}, {label:'FINAL API DTO',value:'NO-GO',detail:'Source evidence pending'}]}/>
 <AuditPage context={c} contract={contract}/>
 <Locked title="Device & integration health" description="Fault event, acknowledgement, source lag dan recovery proof belum memiliki sumber operational yang diverifikasi."/></>;
}
export function AdminFinalPage({page,context:c,contract,capabilities}){
 return <div className="admin-final-page" data-admin-final-page={page}>
 {page==='overview'&&<Overview c={c}/>}
 {page==='requests'&&<><Banner>Transfer Requests kini menerima LAND dan MARINE. LAND tersimpan sebagai request tanpa dispatch otomatis; alokasi tujuan dan inventory v1 menunggu backend final.</Banner><TransfersPage context={c} contract={contract}/><Locked title="Final destination allocation" description="Alokasi per tujuan dan mode LAND/MARINE akan tersedia setelah contract acceptance."/></>}
 {page==='dispatchPlanning'&&<Planning c={c}/>}
 {page==='dispatchMonitoring'&&<Monitoring c={c}/>}
 {page==='inventory'&&<FinalInventory c={c} contract={contract}/>}
 {page==='exceptions'&&<Exceptions c={c}/>}
 {page==='master'&&<><Banner>Master Data legacy masih aktif, sedangkan Driver identity dan voyage scheduling v1 belum terintegrasi.</Banner><MasterDataPage context={c} contract={contract}/><Locked title="Production Driver & voyage masters" description="Identitas Driver harus bersumber dari provider resmi, bukan akun UAT."/></>}
 {page==='integrations'&&<FinalIntegrations c={c} contract={contract}/>}
 {page==='jetty'&&<><Banner>Jetty receiving menggunakan workflow legacy; unloading verified v1 tetap menunggu bukti independen.</Banner><LegacyJettyPage context={c} contract={contract}/></>}
 {page==='access'&&<AdminAccessPage capabilities={capabilities} onNavigate={c.selectPage}/>}
 </div>;
}
