import React,{useEffect,useRef,useState} from 'react';
import {RefreshCw,Plus,ShieldAlert,CheckCircle2} from 'lucide-react';

/**
 * Execution-staging only: UI never auto-imports a legacy request or converts
 * m3 to tonnes. Every selection is returned by an authenticated v1 API.
 */
const fresh=()=>({mode:'LAND',account:'',crusher_id:'',loading_point_id:'',
  destination_location_id:'',quantity_t:'',truck_id:'',driver_id:'',
  voyage_id:'',jetty_window_id:''});
const stableId=prefix=>prefix+'-'+crypto.randomUUID();
const request=async(url,{method='GET',csrf,body,idempotencyKey}={})=>{
 const res=await fetch(url,{method,credentials:'same-origin',
  headers:{Accept:'application/json',...(method==='POST'?{
   'Content-Type':'application/json','X-CSRF-Token':csrf,
   'Idempotency-Key':idempotencyKey||crypto.randomUUID()}: {})},
  ...(method==='POST'?{body:JSON.stringify(body)}:{})});
 const payload=await res.json();
 if(!res.ok)throw new Error((payload.error||'STAGING_UNAVAILABLE')+': '+(payload.message||'Permintaan gagal'));
 return payload.data;
};
export function StagingDispatchExecution({csrf,notify,onCreated}){
 const [catalog,setCatalog]=useState(null),[status,setStatus]=useState('LOADING'),
 [error,setError]=useState(null),[draft,setDraft]=useState(fresh),
 [saving,setSaving]=useState(false),[created,setCreated]=useState(null);
 const attempt=useRef(null),actionKeys=useRef({});
 const update=(key,value)=>{attempt.current=null;setDraft(old=>({...old,[key]:value}));};
 const load=async()=>{
  setStatus('LOADING');setError(null);
  try{
   const data=await request('/api/v1/dispatch/planning-options');
   setCatalog(data);setStatus('READY');
  }catch(e){setCatalog(null);setStatus('BLOCKED');setError(e.message);}
 };
 useEffect(()=>{load();},[]);
 const accounts=catalog?.accounts||[],crushers=catalog?.crushers||[],points=catalog?.loading_points||[],
  trucks=catalog?.trucks||[],drivers=catalog?.drivers||[];
 const account=accounts.find(x=>x.location_id+'::'+x.sku_id===draft.account);
 const validCrushers=crushers.filter(x=>x.source_stockpile_id===account?.location_id);
 const validPoints=points.filter(x=>x.crusher_id===draft.crusher_id);
 const windows=(catalog?.jetty_windows||[]).filter(x=>x.voyage_id===draft.voyage_id);
 const validTruck=trucks.find(t=>t.truck_id===draft.truck_id);
 const qty=Number(draft.quantity_t),limit=validTruck?Number(validTruck.payload_limit_t):0;
 const available=account?Number(account.on_hand_t)-Number(account.reserved_t):0;
 const quantityValid=/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(draft.quantity_t)&&qty>0&&qty<=available&&qty<=limit;
 const submitReady=Boolean(account&&draft.crusher_id&&draft.loading_point_id&&(draft.mode==='MARINE'||draft.destination_location_id)&&
   draft.truck_id&&draft.driver_id&&quantityValid&&
   (draft.mode==='LAND'||draft.voyage_id&&draft.jetty_window_id));
 const selectStyle={minWidth:0,width:'100%',padding:'10px',border:'1px solid #d9e4e7',borderRadius:8,
   color:'#264451',background:'#fff'};
 const labelStyle={display:'grid',gap:6,fontSize:12,color:'#496b76',fontWeight:650};
 const submit=async event=>{
  event.preventDefault();if(!submitReady||saving)return;
  setSaving(true);setError(null);
  try{
   const snapshot=JSON.stringify(draft);
   const ids=(attempt.current?.snapshot===snapshot?attempt.current:null)||{dispatchId:stableId('dispatch-stg'),tripId:stableId('trip-stg'),assignmentId:stableId('assignment-stg'),key:stableId('retry'),snapshot};
   attempt.current=ids;
   const tripId=ids.tripId;
   const body={dispatch_id:ids.dispatchId,mode:draft.mode,
    source_stockpile_id:account.location_id,sku_id:account.sku_id,
    destination_location_id:draft.mode==='MARINE'?windows.find(x=>x.id===draft.jetty_window_id)?.jetty_id:draft.destination_location_id,
    planned_quantity_t:draft.quantity_t,crusher_id:draft.crusher_id,loading_point_id:draft.loading_point_id,
    ...(draft.mode==='MARINE'?{voyage_id:draft.voyage_id,jetty_window_id:draft.jetty_window_id}:{}),
    trips:[{trip_id:tripId,assignment_id:ids.assignmentId,sequence_no:1,
     driver_id:draft.driver_id,truck_id:draft.truck_id,planned_quantity_t:draft.quantity_t}]};
   const data=await request('/api/v1/dispatches',{method:'POST',csrf,body,idempotencyKey:ids.key});
   setCreated(data);attempt.current=null;actionKeys.current={};setDraft(fresh());
   notify?.('Execution staging: dispatch tersimpan dengan verified Driver binding.');
   onCreated?.();await load();
  }catch(e){setError(e.message);}finally{setSaving(false);}
 };
 const mutate=async(kind)=>{
  if(!created||saving)return;
  setSaving(true);setError(null);
  try{
   const actionKey=actionKeys.current[kind]||stableId('retry');actionKeys.current[kind]=actionKey;
   await request(kind==='reserve'
    ?'/api/v1/dispatches/'+encodeURIComponent(created.dispatch_id)+'/reserve'
    :'/api/v1/trips/'+encodeURIComponent(created.trip_ids[0])+'/start',
    {method:'POST',csrf,body:{},idempotencyKey:actionKey});
   delete actionKeys.current[kind];
   setCreated(old=>({...old,[kind==='reserve'?'inventory_reserved':'trip_start_authorized']:true}));
   onCreated?.();notify?.(kind==='reserve'?'Reservasi staging tersimpan.':'Start trip staging terotorisasi; TARE tetap dari WIM.');
  }catch(e){setError(e.message);}finally{setSaving(false);}
 };
 return <section className="af-panel" aria-label="Create execution staging dispatch">
  <header><div><h2>Execute Dispatch · V1 Staging</h2>
   <p>Transaksi terpisah dari legacy. Menggunakan inventory (ton), truck, loading point, dan Driver yang tersedia pada execution staging.</p></div>
   <button type="button" className="af-link" onClick={load} disabled={status==='LOADING'}><RefreshCw size={14}/> Refresh</button></header>
  <div className="af-staging-form">
   {status==='LOADING'?<p>Memeriksa sumber data staging…</p>:
    status==='BLOCKED'?<div className="af-staging-warning" role="status"><ShieldAlert size={18}/>
     <span><b>STAGING NOT READY</b> — {error}. Hubungkan database execution staging dan kontrak identitas secara eksplisit. Data legacy tidak disalin otomatis.</span></div>:
    <>
     <div className="af-staging-warning"><ShieldAlert size={17}/>
      <span>Hanya untuk staging. Nilai permintaan lama dalam m³ tidak dikonversi otomatis ke ton. Tujuan dan loading point memerlukan acceptance lapangan sebelum operasi production.</span></div>
     <div className="af-staging-checks">
      {Object.entries(catalog.requirements||{}).map(([key,ok])=><span key={key} className={ok?'ok':'missing'}>{ok?'✓':'!'} {key.replaceAll('_',' ')}</span>)}
     </div>
     <form onSubmit={submit}>
      <div className="af-staging-fields">
       <label style={labelStyle}>Mode
        <select style={selectStyle} value={draft.mode} onChange={e=>update('mode',e.target.value)}>
         <option value="LAND">LAND · Darat</option><option value="MARINE">MARINE · Laut</option>
        </select></label>
       <label style={labelStyle}>Inventory approved · Stockpile / SKU
        <select style={selectStyle} required value={draft.account} onChange={e=>setDraft(old=>({...old,account:e.target.value,crusher_id:'',loading_point_id:''}))}>
         <option value="">Pilih stok terverifikasi</option>
         {accounts.map(a=><option key={a.location_id+':'+a.sku_id} value={a.location_id+'::'+a.sku_id}>
          {a.location_id} · {a.sku_id} · tersedia {(Number(a.on_hand_t)-Number(a.reserved_t)).toFixed(3)} t</option>)}
        </select></label>
       <label style={labelStyle}>Crusher dari source stockpile
        <select style={selectStyle} required value={draft.crusher_id} onChange={e=>setDraft(old=>({...old,crusher_id:e.target.value,loading_point_id:''}))}>
         <option value="">Pilih crusher</option>{validCrushers.map(x=><option key={x.crusher_id} value={x.crusher_id}>{x.crusher_name}</option>)}
        </select></label>
       <label style={labelStyle}>Loading Point · status lokasi
        <select style={selectStyle} required value={draft.loading_point_id} onChange={e=>update('loading_point_id',e.target.value)}>
         <option value="">Pilih loading point</option>{validPoints.map(x=><option key={x.loading_point_id} value={x.loading_point_id}>
          {x.loading_point_name} · {x.verification_status}</option>)}
        </select></label>
       {draft.mode==='MARINE'&&<>
        <label style={labelStyle}>Voyage READY
         <select style={selectStyle} required value={draft.voyage_id} onChange={e=>setDraft(old=>({...old,voyage_id:e.target.value,jetty_window_id:''}))}>
          <option value="">Pilih voyage</option>{(catalog.voyages||[]).map(x=><option key={x.voyage_id} value={x.voyage_id}>{x.voyage_id}</option>)}
         </select></label>
        <label style={labelStyle}>Jetty Window READY
         <select style={selectStyle} required value={draft.jetty_window_id} onChange={e=>update('jetty_window_id',e.target.value)}>
          <option value="">Pilih window</option>{windows.map(x=><option key={x.id} value={x.id}>{x.jetty_id} · {x.id}</option>)}
         </select></label>
       </>}
       <label style={labelStyle}>Destination ID {draft.mode==='LAND'?'(receiving reference)':'(from jetty window)'}
        <input style={selectStyle} value={draft.mode==='LAND'?draft.destination_location_id:windows.find(w=>w.id===draft.jetty_window_id)?.jetty_id||''}
         onChange={e=>update('destination_location_id',e.target.value)}
         disabled={draft.mode==='MARINE'} required={draft.mode==='LAND'} pattern="[A-Za-z0-9_-]{1,120}"
         placeholder="ID receiving tujuan"/></label>
       <label style={labelStyle}>Requested cargo · Ton terverifikasi
        <input style={selectStyle} required type="text" inputMode="decimal" value={draft.quantity_t}
         onChange={e=>update('quantity_t',e.target.value)} placeholder="Contoh 15.000000"/></label>
       <label style={labelStyle}>Truck eligible
        <select style={selectStyle} required value={draft.truck_id} onChange={e=>update('truck_id',e.target.value)}>
         <option value="">Pilih truck</option>{trucks.map(x=><option key={x.truck_id} value={x.truck_id}>{x.truck_id} · max {x.payload_limit_t} t</option>)}
        </select></label>
       <label style={labelStyle}>Driver independently VERIFIED
        <select style={selectStyle} required value={draft.driver_id} onChange={e=>update('driver_id',e.target.value)}>
         <option value="">Pilih Driver terverifikasi</option>{drivers.map(x=><option key={x.driver_id} value={x.driver_id}>{x.display_name} · {x.driver_id}</option>)}
        </select></label>
      </div>
      {draft.quantity_t&&!quantityValid&&<p style={{color:'#9b5b24',fontSize:12}}>
       Quantity harus positif dan tidak melampaui stok tersedia maupun payload truck; satuannya harus ton dengan maksimal 6 desimal.</p>}
      <div className="af-staging-actions">
       <button type="submit" className="af-staging-primary" disabled={!submitReady||saving}>
        <Plus size={15}/> {saving?'Menyimpan…':'Create Staging Dispatch · 1 Trip'}
       </button>
       {drivers.length===0&&<span className="af-staging-warning">Tidak ada verified Driver yang bebas. Sediakan bukti identitas dan persetujuan independen terlebih dahulu.</span>}
      </div>
     </form>
    </>}
   {error&&status!=='BLOCKED'&&<div role="alert" className="af-staging-warning">{error}</div>}
   {created&&<div className="af-staging-created">
    <CheckCircle2 size={17}/>
    <div><b>Dispatch tersimpan pada staging: {created.dispatch_id}</b>
     <p>Trip: {created.trip_ids?.join(', ')} · Status {created.status}. Tidak mengubah request legacy.</p>
     <div className="af-staging-actions">
      <button type="button" disabled={saving||created.inventory_reserved} onClick={()=>mutate('reserve')}>Reserve Inventory</button>
      <button type="button" disabled={saving||!created.inventory_reserved||created.trip_start_authorized} onClick={()=>mutate('start')}>Authorize Trip Start</button>
     </div>
    </div>
   </div>}
  </div>
 </section>;
}
