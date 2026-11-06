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

export function OverviewPage({ context, contract }) {
  if (contract?.dataState === DATA_STATE.FORBIDDEN) return null;
  const { products, crushers, stockpiles, trucks, jetties, vessels, trips, events, crusher, stockpile, vessel, jetty, density, activeTrips, activeTruckIds, idleTrucks, queuedTrips, availableM3, transit, displayEvents, selectPage } = context;
  return (<><div className="stats-grid"><StatCard label={tr("STOK TERSEDIA")} value={fmt(availableM3)} unit={tr("m³")} icon={Layers3} caption={tr("{0} ton ekuivalen · setelah reservasi", fmt(sum(stockpiles, x => (number(x.onHandM3) - number(x.reservedM3)) * density(x.skuId))))} /><StatCard label={tr("ARMADA TERSEDIA")} value={idleTrucks.length} unit={tr("/ {0} truk", trucks.filter(x => x.active !== false).length)} icon={Truck} tone="blue" caption={tr("{0} aktif · {1} ritase dalam antrean", activeTruckIds.size, queuedTrips.length)} /><StatCard label={tr("MATERIAL DALAM PERJALANAN")} value={fmt(sum(transit, "tonnageT"), 1)} unit={tr("ton")} icon={ArrowUpRight} tone="amber" caption={tr("{0} ritase menuju jetty", transit.length)} /><StatCard label={tr("TERKONFIRMASI KE KAPAL")} value={fmt(sum(trips.filter(x => ['unloaded', 'returned'].includes(x.status)), "tonnageT"), 1)} unit={tr("ton")} icon={Ship} tone="purple" caption={tr("{0} ritase telah dibongkar", trips.filter(x => ['unloaded', 'returned'].includes(x.status)).length)} /></div>
    <div className="dashboard-grid"><Panel title={tr("Alur material hari ini")} subtitle={tr("Dari stockpile crusher ke kapal tujuan")} action={<Badge tone="neutral">{tr("Data transaksi tersimpan")}</Badge>} className="flow-panel"><FlowMap crushers={crushers} stockpiles={stockpiles} activeTrips={activeTrips} vessels={vessels} jetties={jetties} /><div className="flow-legend"><span><i className="dot teal" />{tr("Stok fisik")}</span><span><i className="dot amber" />{tr("Reservasi / proses")}</span><span><i className="dot blue" />{tr("Tujuan terikat per ritase")}</span></div></Panel><Panel title={tr("Status kapasitas kapal")} subtitle={tr("Muat + reservasi ≤ batas kargo aman")} action={<button className="text-btn" onClick={() => selectPage('jetty')}>{tr("Lihat jetty ")}<ArrowUpRight size={14} /></button>}><div className="vessel-list">{vessels.filter(x => x.status !== 'closed').slice(0, 3).map(v => <VesselMini key={v.id} v={v} jetty={jetty(v.jettyId)} />)}</div></Panel></div>
    <div className="dashboard-grid lower"><Panel title={tr("Stok per produk")} subtitle={tr("Tersedia dan telah direservasi untuk dispatch")} action={<button className="text-btn" onClick={() => selectPage('inventory')}>{tr("Detail stok ")}<ArrowUpRight size={14} /></button>}><div className="stock-bars">{products.slice(0, 6).map(p => {
                    let rows = stockpiles.filter(s => s.skuId === p.id);
                    return <div className="stock-bar-row" key={p.id}><div><b>{p.code}</b><small>{p.name}</small></div><div className="segmented-bar"><span className="available" style={{
                          width: `${Math.min(100, sum(rows, x => number(x.onHandM3) - number(x.reservedM3)) / Math.max(1, ...products.map(q => sum(stockpiles.filter(s => s.skuId === q.id), "onHandM3"))) * 100)}%`
                        }} /><span className="reserved" style={{
                          width: `${sum(rows, "reservedM3") / Math.max(1, ...products.map(q => sum(stockpiles.filter(s => s.skuId === q.id), "onHandM3"))) * 100}%`
                        }} /></div><strong>{fmt(sum(rows, "onHandM3"))}<small>{tr(" m³")}</small></strong></div>;
                  })}</div><div className="flow-legend"><span><i className="dot teal" />{tr("Tersedia")}</span><span><i className="dot amber" />{tr("Reservasi")}</span></div></Panel><Panel title={tr("Aktivitas operasional")} subtitle={tr("Jejak aksi pengguna, bukan aktivitas buatan")} action={<button className="text-btn" onClick={() => selectPage('audit')}>{tr("Semua ")}<ArrowUpRight size={14} /></button>}><EventList events={displayEvents} /></Panel></div>
    <div className="notice"><ShieldCheck size={17} /><span>{tr("Pengiriman baru dihitung diterima setelah operator jetty mengonfirmasi bongkar. Status antre dan perjalanan belum menambah muatan kapal.")}</span></div>
   </>);
}
