import React,{useEffect,useState} from 'react';
import {Truck} from 'lucide-react';
import {Button} from '../../components/ui/index.jsx';
import {buildFleetView,paginateFleet} from './fleet-dispatch-view.mjs';

export function FleetAvailability({trucks,fleet,trips,L,fmt}){
 const [filter,setFilter]=useState('all'),[page,setPage]=useState(1);
 const view=buildFleetView({trucks,fleet,trips});
 const pagination=paginateFleet(view.rows,{filter,page,pageSize:3});
 useEffect(()=>{if(page!==pagination.page)setPage(pagination.page);},[page,pagination.page]);
 const labels={available:L('Tersedia','Available'),allocated:L('Teralokasi','Allocated'),unavailable:L('Tidak tersedia','Unavailable')};
 return <section className="ig-panel ig-fleet-panel" data-section="fleet-availability" data-testid="fleet-section" aria-labelledby="fleet-availability-title">
  <div className="ig-panel-head"><div><h2 id="fleet-availability-title">{L('Ketersediaan armada','Fleet availability')}</h2><p>{L('Alokasi otomatis mencakup tugas antre dan tugas berjalan. Truk tersedia kembali setelah kembali terverifikasi.','Automatic allocation includes queued and active tasks. A truck becomes available again after its return is verified.')}</p></div><Truck size={22} aria-hidden="true"/></div>
  <div className="ig-fleet-summary">
   <article className="ig-metric" data-fleet-kpi="available" data-testid="fleet-kpi-available" data-value={view.summary.available}><span>{L('Truk tersedia','Available trucks')}</span><strong>{fmt(view.summary.available,0)}</strong><small>{L('Aktif dan belum dialokasikan','Active and unassigned')}</small></article>
   <article className="ig-metric" data-fleet-kpi="allocated" data-testid="fleet-kpi-allocated" data-value={view.summary.allocated}><span>{L('Truk teralokasi','Allocated trucks')}</span><strong>{fmt(view.summary.allocated,0)}</strong><small>{L('Sudah diassign · antre atau sedang bertugas','Assigned · queued or working')}</small></article>
   <article className="ig-metric" data-fleet-kpi="total" data-testid="fleet-kpi-total" data-value={view.summary.total}><span>{L('Total truk','Total trucks')}</span><strong>{fmt(view.summary.total,0)}</strong><small>{L('Seluruh armada terdaftar','All registered fleet')}{view.summary.unavailable>0&&<> · {fmt(view.summary.unavailable,0)} {L('tidak tersedia','unavailable')}</>}</small></article>
  </div>
  <div className="ig-fleet-controls">
   <label className="ig-filter"><span>{L('Status alokasi armada','Fleet allocation status')}</span><select data-testid="fleet-filter" aria-label={L('Filter ketersediaan armada','Fleet availability filter')} value={filter} onChange={e=>{setFilter(e.target.value);setPage(1);}}><option value="all">{L('Semua armada','All fleet')}</option><option value="allocated">{labels.allocated}</option><option value="available">{labels.available}</option></select></label>
   <span className="ig-subtle">{L('KPI merangkum seluruh armada; filter hanya mengubah baris tabel.','KPIs summarize the entire fleet; filters only change the table rows.')}</span>
  </div>
  <div className="ig-table-scroll"><table className="ig-table ig-fleet-table" data-testid="fleet-table"><thead><tr>{[L('Truk / nomor polisi','Truck / plate'),L('Kapasitas','Capacity'),L('Status alokasi','Allocation status'),L('Tugas saat ini','Current assignment')].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>
   {!pagination.rows.length?<tr><td colSpan={4}><div className="ig-empty">{L('Tidak ada armada dengan filter ini.','No fleet matches this filter.')}</div></td></tr>:pagination.rows.map(row=><tr key={row.truckId} data-fleet-truck-id={row.truckId} data-truck-id={row.truckId} data-allocation-status={row.assignmentStatus}>
    <td><b>{row.truck.code||row.truckId}</b><small>{row.truck.plate||'—'}</small></td>
    <td><b>{fmt(row.truck.bedM3)} m³</b><small>{L('Batas muatan','Payload limit')}: {fmt(row.truck.payloadLimitT)} t</small></td>
    <td><span className={`ig-status ig-status-${row.assignmentStatus}`}>{labels[row.assignmentStatus]}</span><small>{!row.active?L('Truk dinonaktifkan','Truck inactive'):row.assignmentStatus==='allocated'?(row.operationalStatus==='busy'?L('Sedang bertugas','Working'):L('Menunggu mulai tugas','Waiting to start')):L('Belum diassign','Unassigned')}</small></td>
    <td>{row.assignedTrip?<><b>{row.assignedTrip.code}</b><small>{row.assignedTrip.assignedDriverName||row.assignedTrip.driverName||L('Pengemudi teralokasi','Driver assigned')}</small></>:<span className="ig-subtle">{row.assignmentStatus==='allocated'?L('Tugas teralokasi di luar cakupan tampilan','Assigned task outside this view'):L('Belum ada tugas','No assignment')}</span>}</td>
   </tr>)}
  </tbody></table></div>
  <nav className="ig-pagination" aria-label={L('Halaman ketersediaan armada','Fleet availability pages')}>
   <span aria-live="polite">{pagination.total?L(`Menampilkan ${pagination.start}–${pagination.end} dari ${pagination.total} truk`,`Showing ${pagination.start}–${pagination.end} of ${pagination.total} trucks`):L('0 truk','0 trucks')} · {L('3 baris per halaman','3 rows per page')}</span>
   <div><Button data-testid="fleet-prev" variant="secondary" disabled={pagination.page<=1} onClick={()=>setPage(pagination.page-1)}>{L('Sebelumnya','Previous')}</Button><span>{L('Halaman','Page')} {pagination.page} / {pagination.pageCount}</span><Button data-testid="fleet-next" variant="secondary" disabled={pagination.page>=pagination.pageCount} onClick={()=>setPage(pagination.page+1)}>{L('Berikutnya','Next')}</Button></div>
  </nav>
 </section>;
}
