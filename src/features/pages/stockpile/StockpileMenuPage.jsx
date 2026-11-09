import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, ClipboardClock, Eye, Filter, Layers3, PackagePlus, RefreshCw, Search } from 'lucide-react';

export const stockpileMenus = [
  ['add', 'Tambah Stockpile', 'Catat hasil pengukuran stockpile dan kirim untuk persetujuan.', 'Buka Form', PackagePlus],
  ['materials', 'Data Material', 'Lihat seluruh pengajuan material dan status persetujuannya.', 'Lihat Data', Layers3]
];

const number = value => Number(value) || 0;
const quantity = value => new Intl.NumberFormat('id-ID', {maximumFractionDigits: 1}).format(number(value));
const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function MaterialQuantity({row,material}) {
  const volumeM3=row.officialStock?row.onHandM3:row.volumeM3;
  const tonnageT=row.officialStock&&known(volumeM3)&&known(material?.densityTPerM3)?volumeM3*material.densityTPerM3:row.tonnageT;
  return <span className="available"><b>{known(tonnageT)?`${quantity(tonnageT)} ton`:'— ton'}</b><small>{known(volumeM3)?`${quantity(volumeM3)} m³`:'— m³'}</small></span>;
}

function StockpileMaterialPage({ context, theme, selectTheme, back }) {
  const [search, setSearch] = useState('');
  const [status,setStatus]=useState('all');
  const [page,setPage]=useState(1);
  const [detail,setDetail]=useState(null);
  const pageSize=6;
  const pendingRows=context.measurements.filter(row=>row.status!=='approved');
  const approvedRows=context.scopeStock.map(row=>({...row,id:`approved-${row.id}`,stockpileId:row.id,status:'approved',officialStock:true}));
  const materialRows=[...pendingRows,...approvedRows];
  const waiting=pendingRows.length;
  const approved=approvedRows.length;
  const filtered=materialRows.filter(row=>{const material=context.product(row.skuId),location=context.stockpile(row.stockpileId),matchesStatus=status==='all'||(status==='waiting'?['pending','needs_calibration'].includes(row.status):row.status===status);return matchesStatus&&`${row.code} ${material?.code||''} ${material?.name||''} ${location?.code||''}`.toLowerCase().includes(search.toLowerCase())});
  const pages=Math.max(1,Math.ceil(filtered.length/pageSize));
  const current=Math.min(page,pages);
  const rows=filtered.slice((current-1)*pageSize,current*pageSize);
  const date=value=>value?new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'—';
  const statusLabel=value=>value==='approved'?'Disetujui':value==='needs_calibration'?'Perlu pengukuran':'Menunggu persetujuan';
  return <main className={`stockpile-inventory-tablet ${theme}`}>
    <header className="stockpile-inventory-top"><button type="button" onClick={back}><ArrowLeft /><span>Kembali ke menu</span></button><div className="stockpile-menu-theme" role="group" aria-label="Tema tampilan"><button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => selectTheme('light')} aria-label="Gunakan tema terang" aria-pressed={theme === 'light'}><img src="/login/sun.png" alt="" /></button><button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => selectTheme('dark')} aria-label="Gunakan tema gelap" aria-pressed={theme === 'dark'}><img src="/login/moon.png" alt="" /></button></div></header>
    <section className="stockpile-inventory-content">
      <div className="stockpile-inventory-title"><span>DATA STOCKPILE</span><h1>Data Material</h1><p>Seluruh pengajuan material pada lokasi Anda, termasuk yang menunggu dan sudah disetujui.</p></div>
      <div className="stockpile-inventory-summary material-kpis"><article><Layers3/><span>Total data material</span><strong>{materialRows.length}</strong></article><article><ClipboardClock/><span>Menunggu proses</span><strong>{waiting}</strong></article><article><CheckCircle2/><span>Stok disetujui</span><strong>{approved}</strong></article></div>
      <div className="stockpile-inventory-toolbar material-tools"><label><Search /><input value={search} onChange={event=>{setSearch(event.target.value);setPage(1)}} placeholder="Cari nomor, material, atau lokasi" aria-label="Cari data material" /></label><div><label className="stockpile-filter"><Filter/><select value={status} onChange={event=>{setStatus(event.target.value);setPage(1)}} aria-label="Filter status"><option value="all">Semua status</option><option value="waiting">Menunggu proses</option><option value="approved">Disetujui</option></select></label><button type="button" onClick={context.refresh}><RefreshCw /> Perbarui</button></div></div>
      {context.loading&&<div className="stockpile-pending-state">Memuat data material…</div>}
      {!context.loading&&context.error&&<div className="stockpile-pending-state error"><span>{context.error}</span><button type="button" onClick={context.refresh}>Coba lagi</button></div>}
      {!context.loading&&!context.error&&
      <div className="stockpile-inventory-list pending" role="table" aria-label="Seluruh data material">
        <div className="stockpile-inventory-row heading" role="row"><span>Referensi / tanggal</span><span>Material</span><span>Lokasi</span><span>Kuantitas</span><span>Status / aksi</span></div>
        {rows.map(row=>{const material=context.product(row.skuId),location=context.stockpile(row.stockpileId);return <div className="stockpile-inventory-row" role="row" key={row.id}><span><b>{row.code||row.id}</b><small>{row.officialStock?'Stok resmi aktif':date(row.createdAt)}</small></span><span><b>{material?.name||material?.code||'—'}</b><small>{material?.code||'—'}</small></span><span><b>{location?.code||'—'}</b></span><MaterialQuantity {...{row,material}}/><span><i className={row.status==='approved'?'approved':'waiting'}>{statusLabel(row.status)}</i><button className="pending-detail-button" type="button" onClick={()=>setDetail(row)}><Eye/>Lihat Detail</button></span></div>})}
        {!rows.length && <div className="stockpile-inventory-empty">Belum ada data material yang sesuai.</div>}
      </div>}
      {!context.loading&&!context.error&&filtered.length>0&&<nav className="stockpile-pagination" aria-label="Pagination data material"><span>Menampilkan {(current-1)*pageSize+1}–{Math.min(current*pageSize,filtered.length)} dari {filtered.length}</span><div><button type="button" disabled={current===1} onClick={()=>setPage(value=>value-1)} aria-label="Halaman sebelumnya"><ChevronLeft/></button><strong>Halaman {current} dari {pages}</strong><button type="button" disabled={current===pages} onClick={()=>setPage(value=>value+1)} aria-label="Halaman berikutnya"><ChevronRight/></button></div></nav>}
    </section>
    {detail&&<div className="stockpile-detail-backdrop" onMouseDown={event=>event.target===event.currentTarget&&setDetail(null)}><section className="stockpile-detail" role="dialog" aria-modal="true" aria-label="Detail material"><h2>Detail Material</h2><dl><div><dt>Referensi</dt><dd>{detail.code||detail.id}</dd></div><div><dt>Tanggal</dt><dd>{detail.officialStock?'Stok resmi aktif':date(detail.createdAt)}</dd></div><div><dt>Material</dt><dd>{context.product(detail.skuId)?.name||'—'}</dd></div><div><dt>Lokasi</dt><dd>{context.stockpile(detail.stockpileId)?.code||'—'}</dd></div><div><dt>Jumlah</dt><dd><MaterialQuantity row={detail} material={context.product(detail.skuId)}/></dd></div><div><dt>Status</dt><dd>{statusLabel(detail.status)}</dd></div><div><dt>Catatan</dt><dd>{detail.officialStock?'Saldo stok resmi yang sudah disetujui.':detail.notes||'—'}</dd></div></dl><button type="button" onClick={()=>setDetail(null)}>Tutup</button></section></div>}
  </main>;
}

export function StockpileMenuPage({ logout, context }) {
  const [selected,setSelected]=useState(()=>window.location.pathname.endsWith('/materials')?'materials':null);
  const theme=context.theme;
  const selectTheme=context.selectTheme;
  const back=()=>{window.history.pushState(null,'','/stockpile');setSelected(null)};
  if(selected==='materials')return <StockpileMaterialPage context={context} theme={theme} selectTheme={selectTheme} back={back}/>;
  const openMenu=id=>{
    if(id==='add'){
      context.openMeasurement();
      return;
    }
    window.history.pushState(null,'','/stockpile/materials');
    setSelected('materials');
  };

  return <main className={`stockpile-menu-page ${theme}`}>
    <header className="stockpile-menu-top">
      <button type="button" className="stockpile-menu-back" onClick={logout}><ArrowLeft size={24} /><span>Kembali ke login</span></button>
      <div className="stockpile-menu-theme" role="group" aria-label="Tema tampilan"><button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => selectTheme('light')} aria-label="Gunakan tema terang" aria-pressed={theme === 'light'}><img src="/login/sun.png" alt="" /></button><button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => selectTheme('dark')} aria-label="Gunakan tema gelap" aria-pressed={theme === 'dark'}><img src="/login/moon.png" alt="" /></button></div>
    </header>
    <section className="stockpile-menu-content" aria-labelledby="stockpile-menu-title">
      <div className="stockpile-menu-heading"><h1 id="stockpile-menu-title">Pilih Pekerjaan Anda</h1></div>
      <nav className="stockpile-menu-grid" aria-label="Menu Stockpile">
        {stockpileMenus.map(([id,label,description,cta,Icon])=><button key={id} type="button" className={id} onClick={()=>openMenu(id)}>
          <span className="stockpile-menu-icon"><Icon /></span><strong>{label}</strong><small>{description}</small>{id==='materials'&&context.measurements.filter(row=>['pending','needs_calibration'].includes(row.status)).length>0&&<b className="stockpile-menu-count">{context.measurements.filter(row=>['pending','needs_calibration'].includes(row.status)).length}</b>}<span className="stockpile-menu-arrow"><span>{cta}</span><ArrowRight /></span>
        </button>)}
      </nav>
    </section>
    <footer className="stockpile-menu-partners"><img src="/login/gandasari.png" alt="Gandasari Shipyard" /><img src="/login/alfa-granitama.png" alt="Alfa Granitama" /></footer>
  </main>;
}
