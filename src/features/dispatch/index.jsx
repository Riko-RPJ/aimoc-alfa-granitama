import React, { useState, useEffect, useMemo, useRef } from 'react';
import { tr, localize, locale, useLanguage, setLanguage, eventText, eventTypeLabel } from '../../i18n.js';
import { statusText } from '../../domain/legacy-status.js';
import { api } from '../../services/legacy-api.js';
import { ArrowRight, Check, ChevronRight, ClipboardCheck, Clock3, Factory, Filter, Ship, Truck } from 'lucide-react';
import { fmt, stamp, lookup } from '../shared/legacy-utils.js';
import { Badge, Empty, Button, Modal, Panel, DataTable } from '../../components/ui/index.jsx';

export function FleetBoard({
  trucks,
  trips,
  products,
  stockpiles,
  vessels,
  setModal,
  uatProgressByTrip
}) {
  const [filter, setFilter] = useState('all');
  const fleetState=t=>{
    const own=trips.filter(x=>x.truckId===t.id&&x.status!=='returned');
    const demoInProgress=own.find(x=>uatProgressByTrip?.get(x.id)?.task_uat_status==='IN_PROGRESS');
    const remaining=own.filter(x=>uatProgressByTrip?.get(x.id)?.task_uat_status!=='COMPLETED');
    const operationalActive=remaining.find(x=>x.status!=='queued');
    const active=demoInProgress||operationalActive;
    const demoAvailable=own.length>0&&remaining.length===0;
    return {own,remaining,active,demoInProgress,demoAvailable,
      allocated:!active&&!demoAvailable&&remaining.length>0,
      idle:t.active!==false&&(demoAvailable||(!active&&!remaining.length&&t.status!=='busy'))};
  };
  return <Panel title={tr("Ketersediaan armada")} subtitle={tr("Truk tersedia setelah kembali. ETA mengikuti waktu siklus rencana; bukan posisi GPS.")} action={<div className="segmented small">{[['all', tr("Semua")], ['idle', tr("Idle")], ['allocated', tr("Dialokasikan")], ['active', tr("Beroperasi")]].map(([id, t]) => <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{t}</button>)}</div>}><div className="fleet-grid">{trucks.filter(t => {
        const state=fleetState(t);
        return filter === 'all' || (filter === 'active' ? state.active : filter === 'allocated' ? state.allocated : state.idle);
      }).map(t => {
        const state=fleetState(t),active=state.active,next=active||state.remaining[0];
        return <button key={t.id} className={`fleet-card ${active ? 'active' : ''}`} onClick={() => setModal({
          type: 'truck',
          record: t
        })}><div className="fleet-card-top"><span className="truck-icon"><Truck size={25} /></span>{state.demoAvailable?<Badge tone="green">AVAILABLE · DEMO</Badge>:state.demoInProgress?<Badge tone="amber">IN PROGRESS · DEMO</Badge>:<Badge status={active?.status || (t.active === false ? 'unavailable' : state.allocated ? 'allocated' : t.status === 'busy' ? 'in_progress' : 'idle')} />}</div><h3>{t.code}</h3><small>{t.plate} · {fmt(t.bedM3)}{tr(" m³ / ")}{fmt(t.payloadLimitT)}{tr(" t")}</small><div className="fleet-card-task">{state.demoAvailable?<><b>Task demo selesai · truck tersedia</b><span>Tidak ada task demo tersisa.</span></>:next ? <><b>{lookup(products, next.skuId)?.code} → {lookup(vessels, next.vesselId)?.name}</b><span>{state.demoInProgress?'Ritase sedang dikerjakan · demo':active?tr("Ritase aktif"):tr("Ritase sudah dialokasikan · belum dimulai")} · {fmt(next.volumeM3, 1)}{tr(" m³")}</span></> : <span>{t.status === 'busy' ? tr("Bertugas pada lokasi lain") : t.active === false ? tr("Armada nonaktif") : tr("Tersedia untuk penugasan")}</span>}</div>{t.status === 'busy' && t.estimatedAvailableAt && <small className="fleet-eta">{tr("Estimasi tersedia ")}{stamp(t.estimatedAvailableAt)}</small>}<div className="fleet-card-bottom"><span><Clock3 size={13} />{state.remaining.length}{' task demo tersisa'}</span><ChevronRight size={15} /></div></button>;
      })}</div>{!trucks.length && <Empty icon={Truck} title={tr("Belum ada armada")} />}</Panel>;
}

export function TripTable({
  trips,
  role,
  user,
  truck,
  stockpile,
  product,
  jetty,
  vessel,
  setModal,
  busy,
  act,
  jettyMode = false,
  stockpileMode = false
}) {
  const [status, setStatus] = useState(jettyMode ? 'receiving' : 'active');
  let filtered = trips.filter(t => status === 'all' || status === 'active' ? !['returned'].includes(t.status) || status === 'all' : status === 'receiving' ? ['in_transit', 'arrived', 'unloaded'].includes(t.status) : t.status === status);
  return <Panel title={jettyMode ? tr("Antrean penerimaan ritase") : stockpileMode ? tr('Pickup ditugaskan') : tr("Ritase & penugasan")} subtitle={jettyMode ? tr("Konfirmasi tiba lalu bongkar pada kapal yang tercantum.") : stockpileMode ? tr('Lihat instruksi pickup dan konfirmasi operasi loading yang diizinkan. Perencanaan tetap milik Admin.') : tr("Muatan dan tujuan terikat ke dispatch; truk dapat memiliki beberapa tugas serial.")} action={<select aria-label={tr("Filter status ritase")} value={status} onChange={e => setStatus(e.target.value)}><option value="active">{tr("Belum selesai")}</option>{jettyMode && <option value="receiving">{tr("Penerimaan jetty")}</option>}<option value="queued">{tr("Antrean serial")}</option><option value="in_transit">{tr("Dalam perjalanan")}</option><option value="arrived">{tr("Tiba di jetty")}</option><option value="unloaded">{tr("Bongkar selesai")}</option><option value="returned">{tr("Kembali / selesai")}</option><option value="all">{tr("Semua status")}</option></select>}><DataTable headers={[tr("Ritase / truk"), tr("SKU & muatan"), tr("Stockpile asal"), tr("Jetty & kapal tujuan"), tr("Status"), tr("Aksi")]}>{filtered.map(t => <tr key={t.id}><td><button className="table-link" onClick={() => setModal({
            type: 'trip',
            record: t
          })}>{t.code}</button><small>{truck(t.truckId)?.code} · {truck(t.truckId)?.plate}</small></td><td><b>{product(t.skuId)?.code} · {fmt(t.volumeM3, 2)}{tr(" m³")}</b><small>{fmt(t.tonnageT, 2)}{tr(" ton")}</small></td><td>{stockpile(t.stockpileId)?.code}</td><td><b>{vessel(t.vesselId)?.name}</b><small>{jetty(t.jettyId)?.name}</small></td><td><Badge status={t.status} /></td><td><TripAction trip={t} {...{
            role,
            user,
            busy
          }} onClick={() => setModal({
            type: 'trip',
            record: t
          })} /></td></tr>)}</DataTable>{!filtered.length && <Empty icon={Truck} title={tr("Tidak ada ritase pada status ini")} text={stockpileMode?tr('Pickup akan muncul setelah Admin menetapkan tugas untuk lokasi ini.'):tr("Penugasan muncul setelah permintaan transfer direncanakan.")} />}</Panel>;
}

function tripAction(t, role, user) {
  const stock = role === 'admin' || role === 'stock' && (!user.crusherIds?.length || user.crusherIds.includes(t.crusherId));
  const jet = role === 'admin' || role === 'jetty' && (!user.jettyIds?.length || user.jettyIds.includes(t.jettyId));
  if (t.status === 'queued' && stock) return ['trip.start', tr("Mulai muat")];
  if (t.status === 'loading' && role === 'admin') return ['trip.depart', tr("Konfirmasi berangkat")];
  if (t.status === 'in_transit' && jet) return ['trip.arrive', tr("Konfirmasi tiba")];
  if (t.status === 'arrived' && jet) return ['trip.unload', tr("Konfirmasi bongkar")];
  if (t.status === 'unloaded' && (stock || jet)) return ['trip.return', tr("Truk kembali")];
  return null;
}

export function TripAction({
  trip,
  role,
  user,
  busy,
  onClick
}) {
  const a = tripAction(trip, role, user);
  return <button className={`text-btn ${a ? '' : 'muted'}`} disabled={busy} onClick={onClick}>{a?.[1] || tr("Lihat detail")} <ChevronRight size={14} /></button>;
}

export function TripDetail({
  trip,
  truck,
  stockpile,
  product,
  jetty,
  vessel,
  role,
  user,
  busy,
  onClose,
  onAction
}) {
  const a = tripAction(trip, role, user);
  return <Modal title={tr("Ritase {0}", trip.code)} subtitle={tr("Verifikasi identitas, muatan dan tujuan sebelum mengonfirmasi.")} onClose={onClose}><div className="trip-route"><span><Factory size={24} /><b>{stockpile(trip.stockpileId)?.code}</b></span><ArrowRight size={23} /><span><Ship size={24} /><b>{vessel(trip.vesselId)?.name}</b></span></div><div className="confirm-details"><div><span>{tr("Truk")}</span><b>{truck(trip.truckId)?.code} · {truck(trip.truckId)?.plate}</b></div><div><span>{tr("SKU")}</span><b>{product(trip.skuId)?.code} · {product(trip.skuId)?.name}</b></div><div><span>{tr("Volume rencana")}</span><b>{fmt(trip.volumeM3, 2)}{tr(" m³")}</b></div><div><span>{tr("Tonase rencana")}</span><b>{fmt(trip.tonnageT, 2)}{tr(" ton")}</b></div><div><span>{tr("Jetty tujuan")}</span><b>{jetty(trip.jettyId)?.name}</b></div><div><span>{tr("Kapal tujuan")}</span><b>{vessel(trip.vesselId)?.name}</b></div><div><span>{tr("Status")}</span><Badge status={trip.status} /></div></div>{trip.status === 'arrived' && a && <div className="notice"><ClipboardCheck size={18} /><span>{tr("Saya mengonfirmasi bahwa material SKU dan kuantitas pada ritase ini telah dibongkar ke kapal tujuan. Muatan kapal baru bertambah setelah aksi ini.")}</span></div>}{trip.status === 'queued' && <div className="notice"><Clock3 size={18} />{tr("Truk harus idle dan seluruh tugas sebelumnya selesai sebelum ritase ini dapat dimulai.")}</div>}<div className="modal-actions"><Button variant="secondary" onClick={onClose}>{tr("Tutup")}</Button>{a && <Button disabled={busy} icon={Check} onClick={() => onAction(a[0], {
        tripId: trip.id
      })}>{a[1]}</Button>}</div></Modal>;
}

export function TruckDetail({
  record,
  trips,
  product,
  stockpile,
  vessel,
  onClose
}) {
  let own = trips.filter(t => t.truckId === record.id && t.status !== 'returned');
  return <Modal wide title={tr("{0} · {1}", record.code, record.plate)} subtitle={tr("Bak {0} m³ · batas payload {1} ton · siklus rencana {2} menit", fmt(record.bedM3), fmt(record.payloadLimitT), record.cycleMinutes)} onClose={onClose}><div className="notice"><Clock3 size={18} />{tr("Setiap truk hanya boleh menjalankan satu ritase aktif. Urutan berikutnya menunggu truk kembali.")}</div><DataTable headers={[tr("Urutan"), tr("Ritase / SKU"), tr("Stockpile → kapal"), tr("Volume"), tr("Status")]}>{own.map((t, i) => <tr key={t.id}><td>{i + 1}</td><td><b>{t.code}</b><small>{product(t.skuId)?.code}</small></td><td><b>{stockpile(t.stockpileId)?.code}</b><small>→ {vessel(t.vesselId)?.name}</small></td><td>{fmt(t.volumeM3, 2)}{tr(" m³")}</td><td><Badge status={t.status} /></td></tr>)}</DataTable>{!own.length && <Empty icon={Truck} title={tr("Truk tersedia")} text={tr("Belum ada tugas aktif atau antrean pada truk ini.")} />}<div className="modal-actions"><Button variant="secondary" onClick={onClose}>{tr("Tutup")}</Button></div></Modal>;
}
