import React from 'react';
import {ShieldCheck,LockKeyhole,CheckCircle2,AlertTriangle,ArrowRight,Users} from 'lucide-react';
import {TARGET_ADMIN_CAPABILITIES,ROLE_PERMISSIONS} from '../../../contracts/role-permissions.js';
import './admin-access.css';

const ROLE_LABELS={admin:'Admin',stock:'Stockpile',jetty:'Jetty (legacy)',driver:'Driver UAT'};
export function AdminAccessPage({capabilities,onNavigate}){
 const active=TARGET_ADMIN_CAPABILITIES.filter(x=>x.state==='LEGACY_ACTIVE');
 const pending=TARGET_ADMIN_CAPABILITIES.filter(x=>x.state!=='LEGACY_ACTIVE');
 return <div className="admin-access-page">
   <div className="access-intro">
    <ShieldCheck size={22}/>
    <div><strong>Admin Permission & Feature Readiness</strong>
    <p>Hak akses aktif mengikuti API legacy. Fitur domain v1 belum aktif sampai integrasi dan acceptance selesai.</p></div>
   </div>
   {!capabilities&&<p className="access-muted" role="status">Status permission backend belum terbaca. Tindakan sensitif tetap divalidasi server.</p>}
   <section aria-label="Admin access summary" className="access-stats">
    <div><small>Role saat ini</small><strong>Admin</strong><span>Workspace management</span></div>
    <div><small>Modul legacy tersedia</small><strong>{active.length}</strong><span>Bisa dibuka sekarang</span></div>
    <div><small>Modul target tertunda</small><strong>{pending.length}</strong><span>Belum terintegrasi</span></div>
    <div><small>API v1 transactions</small><strong>OFF</strong><span>Production write disabled</span></div>
   </section>
   <section className="access-panel">
    <div className="access-section-heading"><h3>Modul Admin</h3><p>Pilih modul aktif untuk membuka halaman existing. Modul baru tidak akan menampilkan data simulasi sebagai data aktual.</p></div>
    <div className="access-modules">
      {TARGET_ADMIN_CAPABILITIES.map(item=><div className="access-module" key={item.id}>
       <div className="access-module-head">
        {item.state==='LEGACY_ACTIVE'?<CheckCircle2 size={18} className="access-ok"/>:<LockKeyhole size={18} className="access-wait"/>}
        <span className="access-module-title">{item.label}</span>
        <span className={item.state==='LEGACY_ACTIVE'?'access-label active':'access-label pending'}>{item.state==='LEGACY_ACTIVE'?'Legacy active':'Not integrated'}</span>
       </div>
       <div className="access-module-bottom"><code>{item.permission}</code>
       {item.page?<button type="button" onClick={()=>onNavigate(item.page==='dispatch'?'dispatchPlanning':item.page==='audit'?'integrations':item.page)}>Buka modul <ArrowRight size={14}/></button>:<span>Menunggu backend acceptance</span>}</div>
      </div>)}
    </div>
   </section>
   <section className="access-panel">
    <div className="access-section-heading"><h3><Users size={18}/> Matriks hak akses per role</h3><p>Permission operasional saat ini. Penerimaan barang dan pergerakan fisik tidak bisa diwakili Admin tanpa verifikasi petugas lokasi.</p></div>
    <div className="access-roles">{Object.entries(ROLE_PERMISSIONS).map(([role,permissions])=><div className="access-role" key={role}>
      <strong>{ROLE_LABELS[role]}</strong><span>{permissions.length} permission aktif</span>
      <div className="access-tags">{permissions.map(v=><code key={v}>{v}</code>)}</div>
    </div>)}</div>
   </section>
   <div className="access-warning"><AlertTriangle size={18}/> <p><strong>Batas operasional:</strong> Admin masih memiliki kendali start/depart/return dalam workflow legacy; ini belum setara bukti timbangan atau otorisasi operator pada domain v1. QR/TARE/GROSS aktual, Driver assignment production, inventory tonase dan recovery v1 tidak boleh dieksekusi melalui legacy action.</p></div>
 </div>;
}
