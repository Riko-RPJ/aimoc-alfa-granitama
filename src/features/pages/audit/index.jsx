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

export function AuditPage({ context, contract }) {
  if (contract?.dataState === DATA_STATE.FORBIDDEN) return null;
  const { events, inventoryLedger, erpOutbox, stockpile } = context;
  return (<><div className="erp-banner"><span className="erp-logo">{tr("N")}</span><div><h2>{tr("Oracle NetSuite")}</h2><p>{tr("Event operasional sudah tercatat. Konektor ERP menunggu account sandbox, mapping dan otorisasi.")}</p></div><Badge tone="amber">{tr("Belum tersambung ke ERP")}</Badge></div><Panel title={tr("Antrean dokumen ERP")} subtitle={tr("Intent tersimpan bukan bukti posting ERP. Tidak ada dokumen yang ditandai terkirim tanpa acknowledgement NetSuite.")}><DataTable headers={[tr("Referensi"), tr("Jenis event"), tr("Waktu"), tr("Status"), tr("Keterangan")]}>{[...erpOutbox].reverse().map(e => <tr key={e.id}><td><b>{e.code || e.reference || e.id.slice(0, 12)}</b></td><td>{eventTypeLabel(e.type || e.eventType || "Transfer inventory")}</td><td>{stamp(e.createdAt)}</td><td><Badge status={e.status || 'awaiting_configuration'} /></td><td>{tr(e.message || e.reason || "Menunggu konfigurasi & mapping Oracle NetSuite")}</td></tr>)}</DataTable>{!erpOutbox.length && <Empty icon={FileText} title={tr("Belum ada event untuk ERP")} text={tr("Konfirmasi pergerakan material akan membentuk intent integrasi yang dapat ditelusuri.")} />}</Panel><Panel title={tr("Jejak audit")} subtitle={tr("Perubahan stok, reservasi, dispatch dan konfirmasi operator")}><EventList events={[...events].reverse()} full /></Panel><Panel title={tr("Ledger inventory")} subtitle={tr("Pencatatan kuantitas sumber dan perpindahan yang sudah dikonfirmasi")}><DataTable headers={[tr("Waktu"), tr("Jenis"), tr("Stockpile"), tr("Volume"), tr("Referensi")]}>{[...inventoryLedger].reverse().map(e => <tr key={e.id}><td>{stamp(e.createdAt || e.timestamp || e.at)}</td><td>{eventTypeLabel(e.type || e.kind)}</td><td>{stockpile(e.stockpileId)?.code || '—'}</td><td>{fmt(e.volumeM3 ?? e.deltaM3 ?? e.quantityM3, 2)}{tr(" m³")}</td><td>{e.reference || e.referenceId || e.tripId || e.measurementId || '—'}</td></tr>)}</DataTable>{!inventoryLedger.length && <Empty title={tr("Belum ada pergerakan stok")} />}</Panel></>);
}
