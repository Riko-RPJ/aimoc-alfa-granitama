import React,{useEffect,useState} from 'react';
import {Truck} from 'lucide-react';
import {Button} from '../../components/ui/index.jsx';
import {buildFleetView,paginateFleet} from './fleet-dispatch-view.mjs';

export function FleetAvailability({trucks,fleet,trips,dispatches=[],L,fmt}){
 const [filter,setFilter]=useState('all'),[page,setPage]=useState(1);
 const view=buildFleetView({trucks,fleet,trips});
 const pagination=paginateFleet(view.rows,{filter,page,pageSize:3});
 useEffect(()=>{if(page!==pagination.page)setPage(pagination.page);},[page,pagination.page]);
 const labels={available:L('Tersedia','Available'),allocated:L('Dialokasi','Allocated'),busy:L('Sedang bertugas','Busy'),unavailable:L('Tidak tersedia','Unavailable'),unknown:L('Status belum tersedia','Status unavailable')};
 const dispatchCode=id=>dispatches.find(dispatch=>dispatch.id===id)?.code||id;
 const count=value=>typeof value==='number'?fmt(value,0):'—';
 const driverName=trip=>trip?.assignedDriverName||trip?.driverName||trip?.assignedDriver?.name||L('Pengemudi dialokasi','Driver assigned');
 function binding(row){
  if(row.bindingStatus==='CONFLICT')return <><b className="ig-fleet-hold">{L('Konflik ikatan dispatch','Dispatch binding conflict')}</b>{row.dispatchIds.length>0&&<small>{row.dispatchIds.map(dispatchCode).join(' · ')}</small>}</>;
  if(row.bindingStatus==='LEGACY_HOLD')return <b className="ig-fleet-hold">{L('Tertahan: penugasan lama','On hold: legacy assignment')}</b>;
  if(row.bindingStatus==='DISPATCH')return <b>{row.dispatchId?dispatchCode(row.dispatchId):L('Dispatch di luar cakupan tampilan','Dispatch outside this view')}</b>;
  if(row.bindingStatus==='NONE')return <span className="ig-subtle">{L('Belum terikat dispatch','No dispatch binding')}</span>;
  return <span className="ig-subtle">{L('Ikatan belum tersedia','Binding unavailable')}</span>;
 }
 return <section className="ig-panel ig-fleet-panel" data-section="fleet-availability" data-testid="fleet-section" aria-labelledby="fleet-availability-title">
  <div className="ig-panel-head"><div><h2 id="fleet-availability-title">{L('Ketersediaan armada','Fleet availability')}</h2><p>{L('Satu truk terikat ke satu dispatch dan dapat memiliki beberapa ritase serial. Ikatan dilepas setelah seluruh antrean truk tersebut selesai.','A truck is bound to one dispatch and may have multiple serial trips. Its binding is released after that truck’s full queue is complete.')}</p></div><Truck size={22} aria-hidden="true"/></div>
  <div className="ig-fleet-summary">
   <article className="ig-metric" data-fleet-kpi="available" data-testid="fleet-kpi-available" data-value={view.summary.available}><span>{L('Truk tersedia','Available trucks')}</span><strong>{fmt(view.summary.available,0)}</strong><small>{L('Aktif dan belum terikat pekerjaan','Active with no work binding')}</small></article>
   <article className="ig-metric" data-fleet-kpi="allocated" data-testid="fleet-kpi-allocated" data-value={view.summary.allocated}><span>{L('Truk dialokasi','Allocated trucks')}</span><strong>{fmt(view.summary.allocated,0)}</strong><small>{L('Terikat pekerjaan: antre atau bertugas','Work-bound: queued or working')} · {fmt(view.operationalSummary.allocated,0)} {L('antre','queued')} / {fmt(view.operationalSummary.busy,0)} {L('bertugas','busy')}</small></article>
   <article className="ig-metric" data-fleet-kpi="total" data-testid="fleet-kpi-total" data-value={view.summary.total}><span>{L('Total truk','Total trucks')}</span><strong>{fmt(view.summary.total,0)}</strong><small>{L('Seluruh armada terdaftar','All registered fleet')}{view.operationalSummary.unavailable>0&&<> · {fmt(view.operationalSummary.unavailable,0)} {L('tidak tersedia','unavailable')}</>}</small></article>
  </div>
  <div className="ig-fleet-controls">
   <label className="ig-filter"><span>{L('Status alokasi armada','Fleet allocation status')}</span><select data-testid="fleet-filter" aria-label={L('Filter ketersediaan armada','Fleet availability filter')} value={filter} onChange={e=>{setFilter(e.target.value);setPage(1);}}><option value="all">{L('Semua armada','All fleet')}</option><option value="allocated">{L('Dialokasi: antre / bertugas','Allocated: queued / working')}</option><option value="available">{labels.available}</option></select></label>
   <span className="ig-subtle">{L('KPI merangkum seluruh armada; filter hanya mengubah baris tabel.','KPIs summarize the entire fleet; filters only change the table rows.')}</span>
  </div>
  <div className="ig-table-scroll"><table className="ig-table ig-fleet-table" data-testid="fleet-table"><thead><tr>{[L('Truk / nomor polisi','Truck / plate'),L('Kapasitas','Capacity'),L('Status armada','Fleet status'),L('Ikatan dispatch','Dispatch binding'),L('Antrean serial','Serial queue'),L('Ritase berjalan / berikutnya','Current / next trip')].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>
   {!pagination.rows.length?<tr><td colSpan={6}><div className="ig-empty">{L('Tidak ada armada dengan filter ini.','No fleet matches this filter.')}</div></td></tr>:pagination.rows.map(row=><tr key={row.truckId} data-fleet-truck-id={row.truckId} data-truck-id={row.truckId} data-allocation-status={row.assignmentStatus} data-fleet-status={row.operationalStatus} data-binding-dispatch-id={row.dispatchId||''}>
    <td><b>{row.truck.code||row.truckId}</b><small>{row.truck.plate||'—'}</small></td>
    <td><b>{fmt(row.truck.bedM3)} m³</b><small>{L('Batas muatan','Payload limit')}: {fmt(row.truck.payloadLimitT)} t</small></td>
    <td><span className={'ig-status ig-status-'+row.operationalStatus}>{labels[row.operationalStatus]}</span><small>{!row.active?L('Truk dinonaktifkan','Truck inactive'):row.operationalStatus==='allocated'?L('Menunggu mulai ritase berikutnya','Waiting to start the next trip'):row.operationalStatus==='busy'?L('Ritase sudah dimulai','A trip has started'):row.operationalStatus==='available'?L('Tidak memiliki pekerjaan terbuka','No open work'):L('Perlu data status terkini','Current status data required')}</small></td>
    <td data-fleet-binding>{binding(row)}</td>
    <td><div className="ig-fleet-serial-cell"><small>{L('Antre serial','Serial queue')}: <strong data-fleet-queued>{count(row.queuedTrips)}</strong></small><small>{L('Tugas tersisa','Remaining tasks')}: <strong data-fleet-remaining>{count(row.serialTripsRemaining)}</strong></small></div></td>
    <td>{row.operationalStatus==='busy'?row.activeTrip?<><b>{row.activeTrip.code}</b><small>{driverName(row.activeTrip)}</small></>:<span className="ig-subtle">{L('Ritase berjalan di luar cakupan tampilan','Current trip outside this view')}</span>:row.operationalStatus==='allocated'?row.nextTrip?<><b>{row.nextTrip.code}</b><small>{driverName(row.nextTrip)}</small></>:<span className="ig-subtle">{L('Ritase berikutnya di luar cakupan tampilan','Next trip outside this view')}</span>:<span className="ig-subtle">{row.assignmentStatus==='allocated'?L('Penugasan tertahan','Assignment on hold'):L('Belum ada tugas','No assignment')}</span>}{row.operationalStatus==='busy'&&row.nextTrip&&<small>{L('Berikutnya','Next')}: {row.nextTrip.code}</small>}</td>
   </tr>)}
  </tbody></table></div>
  <nav className="ig-pagination" aria-label={L('Halaman ketersediaan armada','Fleet availability pages')}>
   <span aria-live="polite">{pagination.total?L('Menampilkan '+pagination.start+'–'+pagination.end+' dari '+pagination.total+' truk','Showing '+pagination.start+'–'+pagination.end+' of '+pagination.total+' trucks'):L('0 truk','0 trucks')} · {L('3 baris per halaman','3 rows per page')}</span>
   <div><Button data-testid="fleet-prev" variant="secondary" disabled={pagination.page<=1} onClick={()=>setPage(pagination.page-1)}>{L('Sebelumnya','Previous')}</Button><span>{L('Halaman','Page')} {pagination.page} / {pagination.pageCount}</span><Button data-testid="fleet-next" variant="secondary" disabled={pagination.page>=pagination.pageCount} onClick={()=>setPage(pagination.page+1)}>{L('Berikutnya','Next')}</Button></div>
  </nav>
 </section>;
}
