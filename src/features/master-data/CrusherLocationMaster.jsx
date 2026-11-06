import React,{useCallback,useEffect,useState} from 'react';
import {MapPin,Navigation,ShieldAlert,Plus,RefreshCw,Check,Layers3} from 'lucide-react';
import {api} from '../../services/legacy-api.js';
import {Button,Panel} from '../../components/ui/index.jsx';

const empty={crusher_id:'',zone:'',loading_point_id:'',loading_point_name:'',latitude:'',longitude:'',access_notes:'',evidence_ref:''};
export function CrusherLocationMaster({crushers,csrf,notify}){
 const [items,setItems]=useState([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const [editing,setEditing]=useState(false),[form,setForm]=useState(empty);
 const [loading,setLoading]=useState(true);
 const load=useCallback(async()=>{
  setLoading(true);setError('');
  try{const result=await api('/api/crusher-loading-points');setItems(result.items||[]);}
  catch(e){setError(e.message||'Lokasi tidak dapat dimuat.');}
  finally{setLoading(false);}
 },[]);
 useEffect(()=>{load();},[load]);
 const update=(key,value)=>setForm(prev=>({...prev,[key]:value}));
 const submit=async e=>{
  e.preventDefault();setBusy(true);setError('');
  try{
   const body={...form,
    latitude:form.latitude===''?null:form.latitude,
    longitude:form.longitude===''?null:form.longitude};
   await api('/api/crusher-loading-points',{method:'POST',headers:{'X-CSRF-Token':csrf},body:JSON.stringify(body)});
   await load();setEditing(false);setForm(empty);notify('Draft lokasi tersimpan. Koordinat belum diverifikasi.');
  }catch(e){setError(e.message||'Gagal menyimpan lokasi.');}
  finally{setBusy(false);}
 };
 return <div className="crusher-master">
  <Panel title="Crusher Location Master" subtitle="Titik loading, zona, dan akses internal untuk tiap crusher. Hanya data terverifikasi yang boleh menjadi dasar navigasi."
   action={<Button icon={Plus} onClick={()=>{setEditing(true);setForm({...empty,crusher_id:crushers[0]?.id||''});}}>Tambah Loading Point</Button>}>
   <div className="crusher-location-callout"><ShieldAlert size={20}/><div>
    <strong>Lokasi belum diverifikasi untuk navigasi</strong>
    <span>Koordinat dapat disimpan sebagai draft. Validasi GPS, jaringan jalan hauling, dan persetujuan HSE harus dilakukan secara terpisah sebelum routing live.</span>
   </div></div>
   {error&&<div role="alert" className="form-error">{error}</div>}
   {loading?<p className="driver-muted">Memuat master lokasi…</p>:
   items.length?<div className="crusher-location-list">{items.map(item=>{
    const c=crushers.find(c=>c.id===item.crusher_id);
    return <div className="crusher-location-row" key={item.id}>
     <div className="crusher-location-icon"><MapPin size={22}/></div>
     <div className="crusher-location-info"><b>{item.loading_point_name} · {item.loading_point_id}</b>
      <span>{c?.name||item.crusher_id} · {item.zone}</span>
      <small>{item.latitude!==null&&item.longitude!==null?
       'Koordinat draft dicatat · Belum diverifikasi':'Koordinat belum tersedia'}</small></div>
     <div className="crusher-location-actions"><span className="crusher-location-status">Unverified</span>
      <button type="button" onClick={()=>{setForm({
       crusher_id:item.crusher_id,zone:item.zone,loading_point_id:item.loading_point_id,
       loading_point_name:item.loading_point_name,latitude:item.latitude??'',longitude:item.longitude??'',
       access_notes:item.access_notes||'',evidence_ref:item.evidence_ref||''
      });setEditing(true);}}>Edit</button></div>
    </div>;
   })}</div>:
   <div className="crusher-location-empty"><Layers3 size={30}/><h3>Belum ada loading point terdaftar</h3>
    <p>Tambahkan identitas crusher dan titik loading terlebih dahulu. Jangan mengisi koordinat perkiraan sebagai posisi lapangan.</p></div>}
  </Panel>
  {editing&&<div className="crusher-master-edit">
   <div className="driver-card-top"><div><span className="driver-card-eyebrow">LOCATION DRAFT</span><h3>Identitas Crusher & Loading Point</h3></div>
    <button type="button" className="driver-btn outline" onClick={()=>setEditing(false)}>Tutup</button></div>
   <form onSubmit={submit}>
    <div className="crusher-master-grid">
     <label>Crusher terdaftar<select required value={form.crusher_id} onChange={e=>update('crusher_id',e.target.value)}>
      {crushers.map(c=><option value={c.id} key={c.id}>{c.code||c.id} · {c.name}</option>)}</select></label>
     <label>Loading Point ID<input required maxLength={60} pattern="[A-Za-z0-9_-]{2,60}" value={form.loading_point_id}
       onChange={e=>update('loading_point_id',e.target.value)} placeholder="LP-01"/></label>
     <label>Nama Loading Point<input required maxLength={120} value={form.loading_point_name}
       onChange={e=>update('loading_point_name',e.target.value)} placeholder="Loading Point Utama"/></label>
     <label>Zona / Area<input required maxLength={80} value={form.zone} onChange={e=>update('zone',e.target.value)}
       placeholder="Zona operasional"/></label>
     <label>Latitude (draft)<input type="number" step="any" min="-90" max="90" value={form.latitude}
       onChange={e=>update('latitude',e.target.value)} placeholder="Belum tersedia"/></label>
     <label>Longitude (draft)<input type="number" step="any" min="-180" max="180" value={form.longitude}
       onChange={e=>update('longitude',e.target.value)} placeholder="Belum tersedia"/></label>
     <label>Referensi bukti (opsional)<input maxLength={160} value={form.evidence_ref}
       onChange={e=>update('evidence_ref',e.target.value)} placeholder="Dokumen survey / identitas sumber"/></label>
     <label>Catatan akses (opsional)<input maxLength={500} value={form.access_notes}
       onChange={e=>update('access_notes',e.target.value)} placeholder="Instruksi operasional"/></label>
    </div>
    <p className="driver-muted">Status otomatis UNVERIFIED. Tidak ada aktivasi navigasi otomatis setelah menyimpan.</p>
    <div className="crusher-master-buttons"><Button type="submit" icon={Check} disabled={busy}>Simpan draft</Button>
     <Button type="button" variant="secondary" onClick={()=>setEditing(false)}>Batal</Button></div>
   </form>
  </div>}
 </div>;
}
