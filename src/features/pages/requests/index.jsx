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
import { useTruckUatProgress } from '../../../hooks/useTruckUatProgress.js';

export function TransfersPage({ context, contract }) {
  const demo=useTruckUatProgress();
  if (contract?.dataState === DATA_STATE.FORBIDDEN) return null;
  const { products, requests, dispatches, trips, role, can, stockpile, vessel, jetty, activeTrips, queuedTrips, busy, setModal, openRequest } = context;
  const completedTrips=new Set(demo.items.filter(x=>x.task_uat_status==='COMPLETED').map(x=>x.trip_id));
  const demoCompleted=request=>{const own=trips.filter(t=>t.requestId===request.id);return own.length>0&&own.every(t=>completedTrips.has(t.id))};
  const openRequests=requests.filter(x=>x.status!=='completed'&&!demoCompleted(x));
  const pendingTrips=trips.filter(t=>t.status==='queued'&&!completedTrips.has(t.id));
  return (<><div className="stats-grid three"><StatCard label={tr("PERMINTAAN TERBUKA")} value={openRequests.length} unit={tr("request")} icon={ClipboardList} caption={tr("{0} belum direncanakan", requests.filter(x => x.status === 'requested').length)} /><StatCard label={tr("DISPATCH TERBENTUK")} value={dispatches.length} unit={tr("dispatch")} icon={Send} tone="blue" caption={tr("Alokasi stockpile per SKU dan tujuan")} /><StatCard label={tr("RENCANA RITASE")} value={trips.length} unit={tr("ritase")} icon={Truck} tone="amber" caption={`${pendingTrips.length} antre · ${completedTrips.size} selesai demo`} /></div><div className="notice"><Truck size={18}/><span><b>UAT SIMULATED:</b> Penyelesaian Task Driver diproyeksikan ke status request dan inventory demo lintas role; bukan bukti timbang atau ledger production.</span></div><Panel title={tr("Permintaan stock transfer")} subtitle={tr("Satu permintaan dapat berisi beberapa SKU. Reservasi mencegah stok dan kapasitas kapal dipakai dua kali.")} action={role !== 'stock' && <Button icon={Plus} onClick={openRequest}>{tr("Buat permintaan")}</Button>}><DataTable headers={[tr("Request / tujuan"), tr("Material diminta"), "Mode / Tujuan", tr("Status"), tr("Aksi")]}>{[...requests].reverse().map(r => <tr key={r.id}><td><button className="table-link" onClick={() => setModal({
                      type: 'requestDetail',
                      record: r
                    })}>{r.code}</button><small>{r.destination || tr("Transfer internal")} · {stamp(r.createdAt)}</small></td><td><RequestLines request={r} products={products} /></td><td><b>{r.transferMode==="LAND"?"LAND · Darat":"MARINE · Laut"}</b><small>{r.transferMode==="LAND"?(r.destinationId||r.destination):[jetty(r.jettyId)?.name,vessel(r.vesselId)?.name].filter(Boolean).join(" / ")}</small></td><td>{demoCompleted(r)?<Badge tone="green">COMPLETED · DEMO</Badge>:<Badge status={r.status} />}</td><td>{r.status === 'requested' && can && r.transferMode==='LAND' ? <Button variant="secondary" icon={Truck} disabled={busy} onClick={() => setModal({
                      type: 'plan',
                      record: r
                    })}>{tr("Fleet Capacity & Allocation")}</Button> : r.status === 'requested' && can ? <Button variant="secondary" icon={Send} disabled={busy} onClick={() => setModal({
                    type: 'plan',
                    record: r
                    })}>{tr("Alokasi otomatis")}</Button> : <button className="text-btn" onClick={() => setModal({
                      type: 'requestDetail',
                      record: r
                    })}>{tr("Lihat detail ")}<ChevronRight size={14} /></button>}</td></tr>)}</DataTable>{!requests.length && <Empty icon={ClipboardList} title={tr("Belum ada permintaan transfer")} text={tr("Admin dapat membuat permintaan LAND atau MARINE berdasarkan tujuan.")} />}</Panel><div className="process-strip"><div><span>01</span><b>{tr("Permintaan")}</b><small>{tr("SKU + kuantitas + kapal")}</small></div><ArrowRight /><div><span>02</span><b>{tr("Reservasi")}</b><small>{tr("Stok & kapasitas aman")}</small></div><ArrowRight /><div><span>03</span><b>{tr("Dispatch serial")}</b><small>{tr("Armada tersedia / kembali")}</small></div><ArrowRight /><div><span>04</span><b>{tr("Konfirmasi jetty")}</b><small>{tr("Ritase diterima & dibongkar")}</small></div></div></>);
}
