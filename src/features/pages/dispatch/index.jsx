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

export function DispatchPage({ context, contract }) {
  if (contract?.dataState === DATA_STATE.FORBIDDEN) return null;
  const { products, stockpiles, trucks, vessels, requests, dispatches, trips, role, user, product, crusher, stockpile, truck, vessel, jetty, activeTruckIds, idleTrucks, queuedTrips, busy, setModal, act } = context;
  return (<><div className="stats-grid four"><StatCard label={tr("TRUK IDLE")} value={idleTrucks.length} unit={tr("truk")} icon={Truck} caption={tr("Tidak memiliki ritase aktif")} /><StatCard label={tr("SEDANG TRANSFER")} value={activeTruckIds.size} unit={tr("truk")} icon={ArrowUpRight} tone="blue" caption={tr("Muat, perjalanan, tiba atau kembali")} /><StatCard label={tr("ANTREAN SERIAL")} value={queuedTrips.length} unit={tr("ritase")} icon={Clock3} tone="amber" caption={tr("Dijalankan setelah ritase sebelumnya selesai")} /><StatCard label={tr("RITASE SELESAI")} value={trips.filter(x => x.status === 'returned').length} unit={tr("ritase")} icon={CheckCircle2} tone="purple" caption={tr("Bongkar terkonfirmasi dan truk kembali")} /></div><FleetBoard {...{
              trucks,
              trips,
              products,
              stockpiles,
              vessels,
              setModal
            }} /><TripTable {...{
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
              act
            }} /><Panel title={tr("Dispatch per permintaan")} subtitle={tr("Setiap permintaan memiliki satu dispatch dengan satu atau lebih ritase")}><DataTable headers={[tr("Dispatch / permintaan"), tr("Sumber stockpile"), tr("SKU"), tr("Rencana"), tr("Tujuan kapal"), tr("Status")]}>{[...dispatches].reverse().map(d => {const sources=d.stockpileIds?.length?d.stockpileIds:[d.stockpileId].filter(Boolean);const skus=d.skuIds?.length?d.skuIds:[d.skuId].filter(Boolean);const crushers=d.crusherIds?.length?d.crusherIds:[d.crusherId].filter(Boolean);return <tr key={d.id}><td><b>{d.code}</b><small>{lookup(requests, d.requestId)?.code}</small></td><td><b>{sources.length===1?stockpile(sources[0])?.code:tr("Beberapa sumber")}</b><small>{crushers.length===1?crusher(crushers[0])?.name:crushers.length>1?tr("Beberapa crusher"):''}</small></td><td>{skus.length===1?product(skus[0])?.code:skus.length>1?tr("Beberapa SKU"):'—'}</td><td><b>{fmt(d.volumeM3, 2)}{tr(" m³")}</b><small>{fmt(d.tonnageT, 2)}{tr(" ton · ")}{trips.filter(t => t.dispatchId === d.id).length}{tr(" ritase")}</small></td><td>{vessel(d.vesselId)?.name}<small>{jetty(d.jettyId)?.name}</small></td><td><Badge status={d.status} /></td></tr>})}</DataTable>{!dispatches.length && <Empty icon={Send} title={tr("Belum ada dispatch")} text={tr("Rencanakan permintaan transfer untuk membentuk alokasi stok dan antrean truk.")} />}</Panel></>);
}
