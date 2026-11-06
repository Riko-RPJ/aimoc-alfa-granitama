import React from 'react';
import { DATA_STATE } from '../../../contracts/page-contracts.js';
import { tr, eventTypeLabel } from '../../../i18n.js';
import { Activity, ArrowDownLeft, ArrowDownToLine, ArrowRight, ArrowUpRight, BarChart3, Bell, Box, Camera, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, ClipboardCheck, ClipboardList, Clock3, Download, Factory, FileText, Filter, Layers3, LayoutDashboard, Loader2, LogOut, MapPin, Menu, Package, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck, Ship, Truck, Upload, Users, Video, Wifi, WifiOff, X } from 'lucide-react';
import { Badge, LanguageSwitcher, Empty, Button, Field, Modal, StatCard, Panel, DataTable, ProgressBar } from '../../../components/ui/index.jsx';
import { fmt, stamp, minute, number, arr, sum, lookup } from '../../shared/legacy-utils.js';
import { statusText } from '../../../domain/legacy-status.js';
import { FlowMap, VesselMini, EventList } from '../../overview/index.jsx';
import { InventoryTable } from '../../inventory/index.jsx';
import { RequestLines } from '../../transfer/index.jsx';
import { FleetBoard, TripTable } from '../../dispatch/index.jsx';
import { MasterData } from '../../master-data/index.jsx';
import { useOperationalV1 } from '../../../hooks/useOperationalV1.js';

export function LegacyJettyPage({ context, contract }) {
  const v1=useOperationalV1('/api/v1/trips');
  if (contract?.dataState === DATA_STATE.FORBIDDEN) return null;
  const { vessels, trips, role, user, product, stockpile, truck, vessel, jetty, scopeJetty, busy, setModal, act } = context;
  const staging=v1.source==='V1_STAGING';
  const stagingTrips=staging?(v1.data?.items||[]):[];
  const arrive=async trip=>{
    try{
      const response=await fetch(`/api/v1/trips/${encodeURIComponent(trip.trip_id)}/arrive`,{
        method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':context.csrf,'Idempotency-Key':crypto.randomUUID()},body:'{}'});
      const payload=await response.json();if(!response.ok)throw new Error(payload.message||'Konfirmasi kedatangan ditolak.');
      context.notify('Kedatangan tersimpan dan tersinkron ke seluruh role.');await v1.reload();
    }catch(error){context.notify(error.message,'error')}
  };
  if(staging)return <>
    <div className="notice"><Ship size={18}/><span><b>V1_STAGING:</b> Antrean ini berasal dari graph trip yang sama dengan Admin, Stockpile, dan Driver serta dibatasi ke Jetty akun ini oleh server.</span></div>
    <Panel title="Penerimaan Jetty terintegrasi" subtitle="Kuantitas penerimaan tidak dibuat dari rencana; receipt dan bukti timbang tetap wajib sebelum bongkar diverifikasi.">
      <DataTable headers={['Trip / Dispatch','Asal / Tujuan','Truck / Driver','Material','Net terverifikasi','Status','Aksi']}>
        {stagingTrips.map(t=><tr key={t.trip_id}><td><b>{t.trip_id}</b><small>{t.dispatch_id}</small></td>
          <td><b>{t.source_stockpile_id||'—'}</b><small>{t.destination_location_id||'—'}</small></td>
          <td><b>{t.truck_id||'—'}</b><small>{t.driver_assignment?.display_name||t.driver_id||'—'}</small></td>
          <td>{t.sku_id||'—'}</td><td>{t.actual_net_t==null?'Belum terverifikasi':t.actual_net_t+' t'}</td>
          <td><Badge status={t.status}>{t.status}</Badge></td>
          <td>{t.status==='IN_TRANSIT'?<button className="text-btn" disabled={busy} onClick={()=>arrive(t)}>Konfirmasi tiba</button>:
            t.status==='ARRIVED'?<span>Menunggu receipt terverifikasi</span>:'—'}</td></tr>)}
      </DataTable>
      {!stagingTrips.length&&<Empty icon={Ship} title="Tidak ada trip menuju Jetty" text="Tidak ada trip aktif dalam scope lokasi penerimaan akun ini."/>}
    </Panel>
  </>;
  return (<><div className="notice"><MapPin size={17} />{tr("Tujuan terikat sejak permintaan transfer. Operator mengonfirmasi kedatangan dan bongkar hanya pada jetty yang menjadi kewenangannya.")}</div><div className="jetty-layout">{scopeJetty.map(j => <Panel key={j.id} title={j.name} subtitle={tr("{0} · {1} kapal terdaftar", j.code, vessels.filter(v => v.jettyId === j.id).length)} action={<Badge tone="blue">{trips.filter(t => t.jettyId === j.id && ['in_transit', 'arrived'].includes(t.status)).length}{tr(" ritase menuju / tiba")}</Badge>}>{vessels.filter(v => v.jettyId === j.id).map(v => <div className="vessel-card" key={v.id}><div className="vessel-card-header"><span className="vessel-symbol"><Ship size={27} /></span><div><h3>{v.name}</h3><small>{v.code}</small></div><Badge status={v.status}>{v.status === 'loading' ? tr("Sedang loading") : statusText[v.status] || v.status}</Badge></div><div className="capacity-metrics"><div><small>{tr("Terkonfirmasi muat")}</small><strong>{fmt(v.loadedT, 1)} <em>{tr("ton")}</em></strong></div><div><small>{tr("Direservasi")}</small><strong>{fmt(v.reservedT, 1)} <em>{tr("ton")}</em></strong></div><div><small>{tr("Sisa belum terikat")}</small><strong className="teal-text">{fmt(Math.max(0, number(v.payloadLimitT) - number(v.loadedT) - number(v.reservedT)), 1)} <em>{tr("ton")}</em></strong></div></div><div className="vessel-capacity-track"><span style={{
                      width: `${Math.min(100, number(v.loadedT) / number(v.payloadLimitT) * 100)}%`
                    }} /><i style={{
                      width: `${Math.min(100, number(v.reservedT) / number(v.payloadLimitT) * 100)}%`
                    }} /></div><div className="capacity-footer"><span>{tr("Batas kargo aman ")}<b>{fmt(v.payloadLimitT)}{tr(" ton")}</b></span><span>{fmt((number(v.loadedT) + number(v.reservedT)) / Math.max(1, number(v.payloadLimitT)) * 100, 1)}{tr("% terikat")}</span></div>{(v.dwtT || v.dwt) && <small className="subtle-note">{tr("DWT katalog ")}{fmt(v.dwtT || v.dwt)}{tr(" t; batas kargo aman sudah ditetapkan terpisah.")}</small>}<div className="vessel-card-bottom"><span><Truck size={14} />{trips.filter(t => t.vesselId === v.id && ['unloaded', 'returned'].includes(t.status)).length}{tr(" ritase diterima")}</span>{role !== 'stock' && v.status !== 'closed' && <button className="text-btn" onClick={() => setModal({
                      type: 'request',
                      vesselId: v.id,
                      jettyId: j.id
                    })}>{tr("Minta material ")}<Plus size={14} /></button>}</div></div>)}</Panel>)}</div><TripTable {...{
              trips: trips.filter(t => scopeJetty.some(j => j.id === t.jettyId)),
              role,
              user,
              truck,
              stockpile,
              product,
              jetty,
              vessel,
              setModal,
              busy,
              act
            }} jettyMode /><div className="notice"><Ship size={18} /><span>{tr("Batas kargo aman diisi Admin berdasarkan dokumen operasi kapal. DWT katalog mencakup beban lain dan tidak digunakan langsung sebagai kapasitas material.")}</span></div></>);
}
