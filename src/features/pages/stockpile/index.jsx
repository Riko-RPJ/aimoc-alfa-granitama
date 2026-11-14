import React from 'react';
import { Activity, ClipboardCheck, Factory, Layers3, Truck } from 'lucide-react';
import { tr, eventTypeLabel } from '../../../i18n.js';
import { DataTable, Empty, Panel, StatCard } from '../../../components/ui/index.jsx';
import { EventList } from '../../overview/index.jsx';
import { TripTable } from '../../dispatch/index.jsx';
import {useTruckUatProgress} from '../../../hooks/useTruckUatProgress.js';
import {useOperationalV1} from '../../../hooks/useOperationalV1.js';
import { InventoryPage } from '../inventory/index.jsx';
import { fmt, stamp, sum } from '../../shared/legacy-utils.js';

export function StockpileHomePage({context}) {
  const {crushers,scopeStock,trips,events,product} = context;
  const waiting=trips.filter(t=>['queued','loading'].includes(t.status));
  return <>
    <div className="stats-grid four">
      <StatCard label={tr('LOKASI DITUGASKAN')} value={crushers.length} unit={tr('Area stok')} icon={Factory} caption={tr('{0} stockpile dalam scope akun',scopeStock.length)} />
      <StatCard label={tr('STOK TERSEDIA')} value={fmt(sum(scopeStock,x=>(x.onHandM3||0)-(x.reservedM3||0)))} unit={tr('m³')} icon={Layers3} caption={tr('Setelah reservasi aktif')} />
      <StatCard label={tr('PICKUP MENUNGGU')} value={waiting.length} unit={tr('ritase')} icon={Truck} tone="amber" caption={tr('Antrean atau sedang loading')} />
      <StatCard label={tr('AKTIVITAS TERCATAT')} value={events.length} unit={tr('event')} icon={Activity} tone="blue" caption={tr('Hanya untuk lokasi yang ditugaskan')} />
    </div>
    <Panel title={tr('Ringkasan lokasi ditugaskan')} subtitle={tr('Data inventory berasal dari snapshot operasional server yang sudah dibatasi sesuai akun.')}>
      <DataTable headers={[tr('Stockpile'),tr('SKU'),tr('Stok tercatat'),tr('Reservasi'),tr('Tersedia')]}>
        {scopeStock.map(row=><tr key={row.id}><td><b>{row.code}</b></td><td>{product(row.skuId)?.code||'—'}</td><td>{fmt(row.onHandM3,2)} m³</td><td>{fmt(row.reservedM3,2)} m³</td><td><b>{fmt(row.availableM3??((row.onHandM3||0)-(row.reservedM3||0)),2)} m³</b></td></tr>)}
      </DataTable>
      {!scopeStock.length&&<Empty icon={Factory} title={tr('Tidak ada lokasi ditugaskan')} text={tr('Hubungi Admin untuk memeriksa scope lokasi akun Stockpile.')} />}
    </Panel>
    <Panel title={tr('Aktivitas terbaru')} subtitle={tr('Jejak tindakan operasional dalam scope lokasi akun.')}><EventList events={[...events].reverse().slice(0,6)} /></Panel>
  </>;
}

export function StockpileInventoryPage(props) {
  return <InventoryPage {...props} />;
}

export function StockpilePickupsPage({context}) {
  const {trips,role,user,truck,stockpile,product,jetty,vessel,setModal,busy,act}=context;
  const taskProgress=useTruckUatProgress();
  const progressByTrip=new Map(taskProgress.items.map(x=>[x.trip_id,x]));
  const v1=useOperationalV1('/api/v1/stockpile/me/pickups');
  const staging=v1.source==='V1_STAGING';
  const stagingTrips=staging?(v1.data?.items||[]):[];
  const completedTripIds=new Set(taskProgress.items.filter(x=>x.task_uat_status==='COMPLETED').map(x=>x.trip_id));
  const activeDemoTrips=trips.filter(t=>!completedTripIds.has(t.id));
  const completedDemoTrips=trips.filter(t=>completedTripIds.has(t.id));
  const command=async(trip,action)=>{
    try{
      const response=await fetch(`/api/v1/trips/${encodeURIComponent(trip.trip_id)}/${action}`,{
        method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':context.csrf,'Idempotency-Key':crypto.randomUUID()},body:'{}'});
      const payload=await response.json();if(!response.ok)throw new Error(payload.message||'Aksi pickup ditolak.');
      context.notify('Pickup staging diperbarui dan akan terlihat oleh semua role.');await v1.reload();
    }catch(error){context.notify(error.message,'error')}
  };
  const stagingContent=staging?<>
    <div className="notice"><ClipboardCheck size={18}/><span><b>V1_STAGING:</b> Pickup, Driver, Tare, inventory reservation, dan status trip berasal dari graph operasional yang sama.</span></div>
    <Panel title="Pickup terintegrasi" subtitle="Backend membatasi daftar ini ke lokasi Stockpile yang ditugaskan.">
      <DataTable headers={['Trip / Dispatch','Truck / Driver','Material','Planned','Tare','Loading readiness','Aksi']}>
        {stagingTrips.map(t=><tr key={t.trip_id}><td><b>{t.trip_id}</b><small>{t.dispatch_id}</small></td>
          <td><b>{t.truck_id||'—'}</b><small>{t.driver_assignment?.display_name||t.driver_id||'—'}</small></td>
          <td>{t.sku_id||'—'}</td><td>{t.planned_quantity_t==null?'—':t.planned_quantity_t+' t'}</td>
          <td><b>{t.tare_status||'TARE_PENDING'}</b><small>{t.tare_t==null?'Belum tersedia':t.tare_t+' t'}</small></td>
          <td>{t.tare_status==='TARE_RECEIVED'?'Siap konfirmasi loading':'Menunggu Tare sah'}</td>
          <td>{t.tare_status==='TARE_RECEIVED'&&t.status==='START_AUTHORIZED'?<button className="text-btn" disabled={busy} onClick={()=>command(t,'accept-pickup')}>Confirm Loading</button>:
            t.status==='GROSS_CONFIRMED'?<button className="text-btn" disabled={busy} onClick={()=>command(t,'depart')}>Confirm Departure</button>:'—'}</td></tr>)}
      </DataTable>
      {!stagingTrips.length&&<Empty icon={Truck} title="Tidak ada pickup staging" text="Tidak ada pickup aktif dalam scope lokasi akun ini."/>}
    </Panel>
  </>:null;
  return <>
    {stagingContent}
    <div className="stats-grid three">
      <StatCard label={tr('PICKUP AKTIF')} value={activeDemoTrips.length+stagingTrips.length} unit={tr('ritase')} icon={Truck} caption={tr('Hanya pickup dari lokasi yang ditugaskan')} />
      <StatCard label={tr('MENUNGGU LOADING')} value={activeDemoTrips.filter(t=>t.status==='queued').length} unit={tr('ritase')} icon={ClipboardCheck} tone="amber" caption={tr('Urutan ditetapkan oleh Admin')} />
      <StatCard label={tr('SELESAI DEMO')} value={completedDemoTrips.length} unit={tr('ritase')} icon={Activity} tone="blue" caption={tr('Sinkron dari Task Driver UAT')} />
    </div>
    <div className="notice"><ClipboardCheck size={18}/><span><b>NOT_INTEGRATED:</b> {tr('Identitas Driver dan bukti timbang terverifikasi belum tersedia pada backend legacy. Kuantitas di bawah adalah rencana, bukan hasil timbang aktual.')}</span></div>
    <Panel title="Progres Driver UAT (bukan milestone operasional)" subtitle="Progres Mulai/Selesai simulasi, dibatasi ke lokasi Stockpile yang ditugaskan.">
      {taskProgress.available?<DataTable headers={['Ritase','Truck','QR UAT','Progres Driver UAT','Status operasional']}>
        {activeDemoTrips.map(t=>{const item=progressByTrip.get(t.id);return <tr key={t.id}>
          <td><b>{t.code||t.id}</b></td><td>{truck(t.truckId)?.code||'—'}</td>
          <td>{item?.qr_uat_scanned?'QR UAT tercatat':'Menunggu QR'}</td>
          <td>{item?.task_uat_status||'QR_PENDING'}</td>
          <td>{t.status.toUpperCase()}</td>
         </tr>})}</DataTable>:<div className="notice">Progres Driver UAT belum tersedia; status operasional tetap berasal dari snapshot legacy.</div>}
    </Panel>
    <TripTable stockpileMode {...{trips:activeDemoTrips,role,user,truck,stockpile,product,jetty,vessel,setModal,busy,act}} />
    {completedDemoTrips.length>0&&<Panel title="Pickup selesai · Demo" subtitle="Riwayat dump simulasi dari Task Driver pada lokasi Stockpile ini."><DataTable headers={['Ritase','Truck','Material','Volume rencana','Status']}>
      {completedDemoTrips.map(t=><tr key={t.id}><td><b>{t.code||t.id}</b></td><td>{truck(t.truckId)?.code||'—'}</td><td>{product(t.skuId)?.code||'—'}</td><td>{t.volumeM3==null?'—':fmt(t.volumeM3,2)+' m³'}</td><td><b>COMPLETED · DEMO</b></td></tr>)}
    </DataTable></Panel>}
  </>;
}

export function StockpileActivityPage({context}) {
  const {events,inventoryLedger,stockpile}=context;
  return <>
    <Panel title={tr('Riwayat operasional Stockpile')} subtitle={tr('Aksi dan perubahan yang terkait lokasi ditugaskan.')}><EventList events={[...events].reverse()} full /></Panel>
    <Panel title={tr('Pergerakan inventory')} subtitle={tr('Perubahan fisik hanya tercatat setelah konfirmasi backend berhasil.')}>
      <DataTable headers={[tr('Waktu'),tr('Jenis'),tr('Stockpile'),tr('Volume'),tr('Referensi')]}>
        {[...inventoryLedger].reverse().map(row=><tr key={row.id}><td>{stamp(row.createdAt||row.timestamp||row.at)}</td><td>{eventTypeLabel(row.type||row.kind)}</td><td>{stockpile(row.stockpileId)?.code||'—'}</td><td>{fmt(row.volumeM3??row.deltaM3??row.quantityM3,2)} m³</td><td>{row.reference||row.referenceId||row.tripId||row.measurementId||'—'}</td></tr>)}
      </DataTable>
      {!inventoryLedger.length&&<Empty icon={Activity} title={tr('Belum ada pergerakan inventory')} text={tr('Aktivitas akan muncul setelah operasi yang diizinkan dikonfirmasi server.')} />}
    </Panel>
    <div className="notice"><Activity size={18}/><span><b>NOT_INTEGRATED:</b> {tr('Penerimaan independen dan acknowledgement ERP belum tersedia pada backend legacy.')}</span></div>
  </>;
}
