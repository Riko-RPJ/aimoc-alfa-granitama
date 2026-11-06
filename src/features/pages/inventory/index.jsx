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

export function InventoryPage({ context, contract }) {
  const demo=useTruckUatProgress();
  if (contract?.dataState === DATA_STATE.FORBIDDEN) return null;
  const { products, crushers, measurements, role, can, product, crusher, stockpile, jetty, scopeStock, search, setSearch, busy, setModal, openMeasurement } = context;
  const dumpedByStockpile=new Map();
  demo.items.filter(x=>x.simulated_dump&&x.stockpile_id&&x.planned_volume_m3!=null).forEach(x=>dumpedByStockpile.set(x.stockpile_id,(dumpedByStockpile.get(x.stockpile_id)||0)+number(x.planned_volume_m3)));
  const demoStock=scopeStock.map(s=>{const dumped=dumpedByStockpile.get(s.id)||0;return {...s,onHandM3:Math.max(0,number(s.onHandM3)-dumped),reservedM3:Math.max(0,number(s.reservedM3)-dumped),simulatedDumpM3:dumped}});
  return (<><div className="stats-grid three"><StatCard label={tr("STOK SETELAH DUMP DEMO")} value={fmt(sum(demoStock, "onHandM3"))} unit={tr("m³")} icon={Layers3} caption={tr("{0} stockpile · {1} crusher terdaftar", demoStock.length, crushers.length)} /><StatCard label={tr("STOK DIRESERVASI")} value={fmt(sum(demoStock, "reservedM3"))} unit={tr("m³")} icon={ClipboardCheck} tone="amber" caption={tr("Terikat ke dispatch yang belum dimuat")} /><StatCard label={tr("MENUNGGU VALIDASI")} value={measurements.filter(m => m.status === 'pending').length} unit={tr("pengukuran")} icon={Camera} tone="blue" caption={tr("Persetujuan Admin sebelum mengubah stok")} /></div><div className="notice"><Truck size={18}/><span><b>UAT SIMULATED:</b> Stok berkurang dari volume rencana task Driver yang selesai. Ini proyeksi dump demo, bukan ledger timbang production.</span></div><InventoryTable {...{
              scopeStock:demoStock,
              products,
              crushers,
              search,
              setSearch,
              role,
              setModal,
              product,
              crusher
            }} /><Panel title={tr("Pengukuran & bukti stockpile")} subtitle={tr("Foto tunggal tidak otomatis menghasilkan volume. Estimasi terkalibrasi harus diperiksa Admin.")} action={role === 'stock' && <Button variant="secondary" icon={Plus} onClick={openMeasurement}>{tr("Catat pengukuran")}</Button>}><DataTable headers={[tr("Waktu / referensi"), tr("Stockpile & SKU"), tr("Metode"), tr("Volume usulan"), tr("Status"), tr("Aksi")]}>{[...measurements].reverse().map(m => <tr key={m.id}><td><b>{m.code || m.id.slice(0, 12)}</b><small>{stamp(m.createdAt)}</small></td><td><b>{stockpile(m.stockpileId)?.code}</b><small>{product(m.skuId)?.name}</small></td><td>{statusText[m.method] || m.method}{m.evidenceName && <small>{m.evidenceName}</small>}</td><td>{m.volumeM3 != null ? `${fmt(m.volumeM3, 2)} m³` : <span className="muted">{tr("Belum diukur")}</span>}</td><td><Badge status={m.status} /></td><td><div className="row-actions">{m.evidenceId && <a className="text-btn" href={`/api/evidence/${m.evidenceId}`} target="_blank" rel="noreferrer">{tr("Lihat foto")}</a>}{can && m.status === 'pending' && m.method !== 'camera_pending' && <Button variant="secondary" disabled={busy} onClick={() => setModal({
                        type: 'approve',
                        record: m
                      })}>{tr("Tinjau & setujui")}</Button>}</div></td></tr>)}</DataTable>{!measurements.length && <Empty icon={Camera} title={tr("Belum ada pengukuran")} text={role === "admin" ? tr("Pengukuran diajukan operator Stockpile dan akan muncul untuk ditinjau Admin.") : tr("Ambil foto, catat hasil survei atau ajukan estimasi geometri terkalibrasi.")} />}</Panel></>);
}
