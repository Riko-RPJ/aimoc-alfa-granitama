import { tr, localize, locale, useLanguage, getLanguage, setLanguage, apiErrorSource, eventText, eventTypeLabel } from "./i18n.js";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Login } from './features/auth/index.jsx';
import { FlowMap, VesselMini, EventList } from './features/overview/index.jsx';
import { InventoryTable, MeasurementModal } from './features/inventory/index.jsx';
import { RequestLines, RequestModal, RequestDetail } from './features/transfer/index.jsx';
import { FleetBoard, TripTable, TripAction, TripDetail, TruckDetail } from './features/dispatch/index.jsx';
import { FleetCapacityAllocation } from './features/dispatch/FleetCapacityAllocation.jsx';
import { MasterData, MasterModal, UserManagement } from './features/master-data/index.jsx';
import { fmt, stamp, minute, number, arr, sum, lookup, roleName } from './features/shared/legacy-utils.js';
import { api } from './services/legacy-api.js';
import { legacyPageDataContract } from './contracts/page-contracts.js';
import { OverviewPage } from './features/pages/overview/index.jsx';
import { InventoryPage } from './features/pages/inventory/index.jsx';
import { TransfersPage } from './features/pages/requests/index.jsx';
import { DispatchPage } from './features/pages/dispatch/index.jsx';
import { LegacyJettyPage } from './features/pages/jetty/index.jsx';
import { MasterDataPage } from './features/pages/master/index.jsx';
import { AuditPage } from './features/pages/audit/index.jsx';
import { StockpileActivityPage, StockpileHomePage, StockpileInventoryPage, StockpilePickupsPage } from './features/pages/stockpile/index.jsx';
import { Badge, LanguageSwitcher, Empty, Button, Field, Modal, StatCard, Panel, DataTable, ProgressBar } from './components/ui/index.jsx';
import { Brand, BrandPartners } from './components/brand/index.jsx';
import { statusText } from './domain/legacy-status.js';
import { AdminLayout } from './layouts/AdminLayout.jsx';
import { StockpileLayout } from './layouts/StockpileLayout.jsx';
import { DriverLayout } from './layouts/DriverLayout.jsx';
import {TruckCodeWorkspace} from './layouts/TruckCodeWorkspace.jsx';
import {useTruckUatProgress} from './hooks/useTruckUatProgress.js';
import { LegacyTopbar } from './layouts/LegacyTopbar.jsx';
import { legacyPagesForRole, defaultLegacyPage, legacyPageFromPath, legacyPathForPage, stockpileNavigation } from './app/navigation.js';
import { permissionsForRole, authorizeLegacyAction } from './contracts/role-permissions.js';
import { AdminFinalPage } from './features/pages/admin-final/AdminFinalPage.jsx';
import { CrossRoleUatPage } from './features/uat/CrossRoleUatPage.jsx';
import { IntegratedWorkspace } from './features/integrated/IntegratedWorkspace.jsx';
import { QuarryCilegonWorkspace } from './features/quarry-cilegon/QuarryCilegonWorkspace.jsx';
const QUARRY_CILEGON_SITE=import.meta.env.VITE_APP_VARIANT==='quarry-cilegon';
const CROSS_ROLE_UAT=import.meta.env.VITE_CROSS_ROLE_UAT==='1';
import { Activity, ArrowDownLeft, ArrowDownToLine, ArrowRight, ArrowUpRight, BarChart3, Bell, Box, Camera, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, ClipboardCheck, ClipboardList, Clock3, Download, Factory, FileText, Filter, Layers3, LayoutDashboard, Loader2, LogOut, MapPin, Menu, Package, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck, Ship, Truck, Upload, Users, Video, Wifi, WifiOff, X } from 'lucide-react';
const legacyNavs = [['overview', 'Ringkasan operasi', LayoutDashboard], ['inventory', 'Stock inventory', Layers3], ['requests', 'Permintaan transfer', ClipboardList], ['dispatch', 'Dispatch & armada', Truck], ['jetty', 'Operasi jetty', Ship], ['master', 'Master data', Settings2], ['audit', 'Audit & NetSuite', FileText], ['access','Role & Access Control',ShieldCheck]];
const adminNavs = [
 ['overview','Operations Overview',LayoutDashboard],
 ['requests','Transfer Requests',ClipboardList],
 ['dispatchPlanning','Dispatch Planning',Send],
 ['inventory','Inventory',Layers3],
 ['jetty','Jetty & Receiving',Ship],
 ['master','Master Data',Settings2],
 ['integrations','Integrations & Audit',FileText],
 ['access','Role & Access Control',ShieldCheck],
];
const adminMeta={
 overview:['OPERATIONS OVERVIEW','Operations Overview','Operational visibility, trip status dan readiness yang dapat ditelusuri.'],
 requests:['TRANSFER MANAGEMENT','Transfer Requests','Permintaan material, alokasi dan approval yang tercatat.'],
 dispatchPlanning:['DISPATCH PLANNING','Dispatch Planning','Perencanaan sumber, kapasitas armada dan ketersediaan dispatch.'],
 dispatchMonitoring:['TRIP MONITORING','Live Trip Monitoring','Monitor seluruh trip berdasarkan data yang tersedia.'],
 inventory:['INVENTORY CONTROL','Inventory','Stok terdaftar, reservasi dan bukti pengukuran.'],
 exceptions:['EXCEPTION CONTROL','Exceptions & Recovery','Tinjauan HOLD, discrepancy, dan tindakan yang tersedia.'],
 jetty:['RECEIVING CONTROL','Jetty & Receiving','Monitor penerimaan, kapal dan sumber data jetty.'],
 master:['MASTER DATA','Master Data','Kelola material, lokasi, truck dan master legacy.'],
 integrations:['INTEGRATIONS','Integrations & Audit','Jejak aktivitas, ERP dan kesiapan integrasi.'],
 access:['ACCESS CONTROL','Role & Access Control','Hak akses serta ketersediaan fitur menurut role.']
};
const stockpileIcons={home:LayoutDashboard,inventory:Layers3,pickups:Truck,activity:Activity};
const stockpileNavs=stockpileNavigation.map(({id,label})=>[id,label,stockpileIcons[id]]);
const meta = localize({
  home: ['STOCKPILE OPERATIONS', 'Home', 'Operational overview for assigned Stockpile locations.'],
  overview: ['OVERVIEW', 'Ringkasan operasi', 'Satu pandangan untuk stok, armada, dan muatan kapal.'],
  inventory: ['STOCK OPERATIONS', 'Stock inventory', 'Stok per SKU, crusher dan lokasi — dengan jejak pengukuran.'],
  pickups: ['PICKUP OPERATIONS', 'Pickups', 'Assigned truck pickups and permitted loading operations.'],
  activity: ['STOCKPILE HISTORY', 'Activity', 'Movement and operational history for assigned locations.'],
  requests: ['TRANSFER CONTROL', 'Permintaan transfer', 'Tetapkan kebutuhan material dan tujuan sebelum dispatch.'],
  dispatch: ['FLEET OPERATIONS', 'Dispatch & armada', 'Penugasan serial. Satu truk, satu pekerjaan aktif.'],
  jetty: ['JETTY OPERATIONS', 'Penerimaan & loading', 'Pastikan setiap ritase diterima oleh jetty dan kapal yang tepat.'],
  master: ['ADMINISTRATION', 'Master data', 'Atur produk, crusher, stockpile, armada, dan kapasitas muat aman.'],
  audit: ['TRACEABILITY', 'Audit & Oracle NetSuite', 'Telusuri perubahan stok dan dokumen yang menunggu integrasi ERP.'],
  access: ['ADMIN CONTROL', 'Role & Access Control', 'Permission aktif dan readiness tiap fitur AIMOC.'],
  dispatchPlanning: ['DISPATCH MANAGEMENT', 'Dispatch Planning', 'Alokasi request, stockpile dan armada sebelum eksekusi.'],
  dispatchMonitoring: ['TRIP MONITORING', 'Live Trip Monitoring', 'Status setiap trip dan jejak milestone yang tersedia.'],
  exceptions: ['EXCEPTION CONTROL', 'Exceptions & Recovery', 'Permasalahan dan tindak lanjut dengan sumber data yang dapat ditelusuri.'],
  integrations: ['SYSTEM INTEGRATIONS', 'Integrations & Audit', 'Event operasional, ERP outbox dan readiness integrasi.']
});
export function LegacyApp() {
  useLanguage();
  const truckCodeRoute=window.location.pathname==='/driver'||window.location.pathname==='/driver/tasks';
  const [user, setUser] = useState(null),
    [csrf, setCsrf] = useState(''),
    [boot, setBoot] = useState(true),
    [data, setData] = useState(null),
    [revision, setRevision] = useState(null),
    [lastSync, setLastSync] = useState(null),
    [connected, setConnected] = useState(false),
    [loadError, setLoadError] = useState(''),
    [page, setPage] = useState('overview'),
    [mobileNav, setMobileNav] = useState(false),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState(null),
    [modal, setModal] = useState(null),
    [search, setSearch] = useState('');
  const latestRevision = useRef(-1),
    pollRef = useRef(false);
  const demoProgress=useTruckUatProgress(Boolean(user&&user.role!=='driver'&&!truckCodeRoute));
  const notify = (text, type = 'success') => setToast({
    text,
    type,
    id: Date.now()
  });
  useEffect(() => {
    if (toast) {
      let t = setTimeout(() => setToast(null), 5500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const accept = d => {
    if (d.state) {
      const next = Number(d.revision);
      if (Number.isFinite(next) && next < latestRevision.current) return;
      if (Number.isFinite(next)) latestRevision.current = next;
      setData(d.state);
      setRevision(d.revision);
      setLastSync(new Date().toISOString());
      setConnected(true);
      setLoadError('');
    }
  };
  const refresh = async () => {
    if (pollRef.current) return;
    pollRef.current = true;
    try {
      const d = await api('/api/state');
      accept(d);
    } catch (e) {
      setConnected(false);
      setLoadError(e.message||'Data operasional belum dapat dimuat.');
      if (e.status === 401) {
        setUser(null);
        setData(null);
      }
    } finally {
      pollRef.current = false;
    }
  };
  useEffect(() => {
    api('/api/me').then(d => {
      setUser(d.user);
      setCsrf(d.csrfToken || '');
    }).catch(() => {}).finally(() => setBoot(false));
  }, []);
  useEffect(() => {
    if (!user || user.role === 'driver' || CROSS_ROLE_UAT) return;
    refresh();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 3000);
    const v = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', v);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', v);
    };
  }, [user?.id]);
  const [capabilities,setCapabilities] = useState(null);
  useEffect(()=>{
    if(!user||CROSS_ROLE_UAT)return;
    let active=true;
    api('/api/capabilities').then(r=>{if(active)setCapabilities(r);}).catch(()=>{if(active)setCapabilities(null);});
    return ()=>{active=false;};
  },[user?.id]);
  const mutate = async (action, payload, {
    close = true,
    message = "Perubahan berhasil disimpan."
  } = {}) => {
    const decision=authorizeLegacyAction(user?.role,action);
    if(!decision.allowed){
      notify('Hak akses tidak tersedia atau workflow belum terintegrasi.', 'error');
      return null;
    }
    setBusy(true);
    try {
      const d = await api('/api/action', {
        method: 'POST',
        headers: {
          'X-CSRF-Token': csrf
        },
        body: JSON.stringify({
          action,
          payload,
          requestId: crypto.randomUUID(),
          expectedRevision: revision
        })
      });
      accept(d);
      if (!d.state) await refresh();
      if (close) setModal(null);
      notify(message);
      return d;
    } catch (e) {
      notify(e.message, 'error');
      if (e.status === 409) await refresh();
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const act = (a, p, o) => mutate(a, p, o).catch(() => {});
  const logout = async () => {
    try {
      await api('/api/logout', {
        method: 'POST',
        headers: {
          'X-CSRF-Token': csrf
        },
        body: '{}'
      });
    } finally {
      setUser(null);
      setData(null);
      setRevision(null);
      latestRevision.current = -1;
      setConnected(false);
    }
  };
  const role = user?.role || 'stock';
  const can = role === 'admin';
  const sources = useMemo(() => {
    const s = data || {};
    return Object.fromEntries(['products', 'crushers', 'stockpiles', 'trucks', 'jetties', 'vessels', 'requests', 'dispatches', 'trips', 'measurements', 'events', "inventoryLedger", "erpOutbox"].map(k => [k, arr(s, k)]));
  }, [data]);
  const {
    products,
    crushers,
    stockpiles,
    trucks,
    jetties,
    vessels,
    requests,
    dispatches,
    trips,
    measurements,
    events,
    inventoryLedger,
    erpOutbox
  } = sources;
  const product = id => lookup(products, id),
    crusher = id => lookup(crushers, id),
    stockpile = id => lookup(stockpiles, id),
    truck = id => lookup(trucks, id),
    vessel = id => lookup(vessels, id),
    jetty = id => lookup(jetties, id);
  const density = id => number(product(id)?.densityTPerM3) || 1.5;
  const scopeStock = role === 'admin' ? stockpiles : role === 'stock' ? stockpiles.filter(x => !user.crusherIds?.length || user.crusherIds.includes(x.crusherId)) : stockpiles;
  const scopeJetty = role === 'jetty' && user.jettyIds?.length ? jetties.filter(x => user.jettyIds.includes(x.id)) : jetties;
  const demoCompletedTripIds=new Set(demoProgress.items.filter(x=>x.task_uat_status==='COMPLETED').map(x=>x.trip_id));
  const demoInProgressTripIds=new Set(demoProgress.items.filter(x=>x.task_uat_status==='IN_PROGRESS').map(x=>x.trip_id));
  const activeTrips = trips.filter(t => demoInProgressTripIds.has(t.id)||(!demoCompletedTripIds.has(t.id)&&!['queued', 'returned'].includes(t.status)));
  const activeTruckIds = new Set(trucks.filter(t => t.activeTripId || activeTrips.some(x => x.truckId === t.id)).map(t => t.id));
  const idleTrucks = trucks.filter(t => t.active !== false && !trips.some(x => x.truckId === t.id && x.status !== 'returned'&&!demoCompletedTripIds.has(x.id)) && t.status !== 'busy');
  const allocatedTruckIds = new Set(trucks.filter(t => trips.some(x => x.truckId === t.id && x.status === 'queued'&&!demoCompletedTripIds.has(x.id)) && !activeTruckIds.has(t.id)).map(t => t.id));
  const queuedTrips = trips.filter(t => t.status === 'queued'&&!demoCompletedTripIds.has(t.id));
  const availableM3 = sum(stockpiles, x => Math.max(0, number(x.onHandM3) - number(x.reservedM3)));
  const transit = trips.filter(t => ['in_transit', 'arrived'].includes(t.status));
  const displayEvents = [...events].reverse().slice(0, 6);
  const permittedNav = role==='admin' ? adminNavs : legacyPagesForRole(role,role==='stock'?stockpileNavs:legacyNavs);
  const selectPage = id => {
    if (!permittedNav.some(([allowed]) => allowed === id)) return;
    const path = legacyPathForPage(role, id);
    if (path && window.location.pathname !== path) window.history.pushState(null, '', path);
    setPage(id);
    setMobileNav(false);
    setSearch('');
  };
  useEffect(() => {
    if (!user || !defaultLegacyPage(role)) return;
    const readRoute = () => {
      const fromPath = legacyPageFromPath(role, window.location.pathname);
      if (fromPath && permittedNav.some(([id]) => id === fromPath)) {
        setPage(fromPath);
      } else {
        const fallback = defaultLegacyPage(role);
        setPage(fallback);
        // Preserve the existing root URL for backward compatibility.
        if ((window.location.pathname !== '/' || role === 'stock') && !fromPath) {
          window.history.replaceState(null, '', legacyPathForPage(role, fallback));
        }
      }
    };
    readRoute();
    window.addEventListener('popstate', readRoute);
    return () => window.removeEventListener('popstate', readRoute);
  }, [user?.id, user?.role]);
  const openMeasurement = () => setModal({
    type: 'measurement'
  });
  const openRequest = () => setModal({
    type: 'request'
  });
  const visiblePage = permittedNav.some(([id]) => id === page) ? page : (defaultLegacyPage(role) || 'overview');
  const head = role==='admin' ? (adminMeta[visiblePage]||meta.overview) : (meta[visiblePage]||meta.overview);
  const pageDataContract = useMemo(() => legacyPageDataContract({
    role, page: role==='admin'&&visiblePage==='integrations'?'audit':visiblePage, state: data, connected
  }), [role, visiblePage, data, connected]);

  const pageContext = { products, crushers, stockpiles, trucks, jetties, vessels, requests, dispatches, trips, measurements, events, inventoryLedger, erpOutbox, sources, role, user, can, product, crusher, stockpile, truck, vessel, jetty, density, scopeStock, scopeJetty, activeTrips, activeTruckIds, allocatedTruckIds, idleTrucks, queuedTrips, demoProgress, demoCompletedTripIds, demoInProgressTripIds, availableM3, transit, displayEvents, search, setSearch, busy, csrf, notify, setModal, act, selectPage, openRequest, openMeasurement };
  if(truckCodeRoute)return <TruckCodeWorkspace/>;
  if (boot) return <div className="boot"><Brand /><Loader2 className="spin" size={24} /><p>{tr("Menghubungkan ruang operasi…")}</p></div>;
  if (!user) return <Login onLogin={d => {
    setUser(d.user);
    setCsrf(d.csrfToken || '');
    setPage(defaultLegacyPage(d.user.role) || 'overview');
  }} />;
  if(CROSS_ROLE_UAT) return <CrossRoleUatPage logout={logout} user={user} csrf={csrf}/>;
  if (role === 'driver') return <DriverLayout logout={logout} user={user} csrf={csrf} />;
  return <div className="app-shell">
  {role === 'stock'
    ? <StockpileLayout {...{mobileNav,setMobileNav,navs:permittedNav,page:visiblePage,selectPage,requests,user,roleName,role,logout}} />
    : <AdminLayout {...{mobileNav,setMobileNav,navs:permittedNav,page:visiblePage,selectPage,requests,user,roleName,role,logout}} />}
  <div className="main-shell"><LegacyTopbar {...{setMobileNav,head,connected,lastSync,refresh,roleName,role,minute}} />
   <main><div className="page-heading"><div><div className="eyebrow">{head[0]} <span>•</span>{tr(" GANDASARI ALFA GRANITAMA")}</div><h1>{head[1]}</h1><p>{head[2]}</p></div><div className="heading-actions">{(role==='stock'&&['home','inventory'].includes(visiblePage)) && <Button variant="secondary" icon={Camera} onClick={openMeasurement}>{tr("Ukur stockpile")}</Button>}{visiblePage==='requests' && role !== 'stock' && <Button icon={Plus} onClick={openRequest}>{tr("Permintaan transfer")}</Button>}{visiblePage === 'master' && <Button icon={Plus} onClick={() => setModal({
              type: 'master',
              entity: 'product'
            })}>{tr("Tambah data")}</Button>}</div></div>
   {!connected && data && <div className="notice error"><WifiOff size={17} />{tr("Menampilkan data terakhir. Perubahan perlu koneksi server; status tidak diperbarui hingga tersambung kembali.")}</div>}
   {!data ? <div className="loading-panel">{loadError?<WifiOff/>:<Loader2 className="spin" />}<h3>{tr(loadError||"Mengambil data operasional…")}</h3><Button variant="secondary" onClick={refresh}>{tr("Coba lagi")}</Button></div> : <>
   {role==='admin' ? <AdminFinalPage page={visiblePage} context={pageContext} contract={pageDataContract} capabilities={capabilities}/> : <>
     {role==='stock' && visiblePage==='home' && <StockpileHomePage context={pageContext} contract={pageDataContract}/>}
     {role==='stock' && visiblePage==='inventory' && <StockpileInventoryPage context={pageContext} contract={pageDataContract}/>}
     {role==='stock' && visiblePage==='pickups' && <StockpilePickupsPage context={pageContext} contract={pageDataContract}/>}
     {role==='stock' && visiblePage==='activity' && <StockpileActivityPage context={pageContext} contract={pageDataContract}/>}
     {visiblePage==='overview' && <OverviewPage context={pageContext} contract={pageDataContract}/>}
     {role!=='stock' && visiblePage==='inventory' && <InventoryPage context={pageContext} contract={pageDataContract}/>}
     {visiblePage==='requests' && <TransfersPage context={pageContext} contract={pageDataContract}/>}
     {visiblePage==='dispatch' && <DispatchPage context={pageContext} contract={pageDataContract}/>}
     {visiblePage==='jetty' && <LegacyJettyPage context={pageContext} contract={pageDataContract}/>}
     {visiblePage==='audit' && <AuditPage context={pageContext} contract={pageDataContract}/>}
   </>}
   </>}
   <footer className="app-footer"><span>{tr("AIMOC Gandasari Alfa Granitama ")}<span className="footer-dot">•</span>{tr(" Operational workspace")}</span><span>{tr("Data tersimpan bersama · revisi ")}{revision ?? '—'}</span></footer>
   </main></div>
  {toast && <div role="status" className={`toast ${toast.type}`}>{toast.type === 'error' ? <CircleHelp size={19} /> : <CheckCircle2 size={19} />}<span>{tr(toast.text)}</span><button onClick={() => setToast(null)} aria-label={tr("Tutup notifikasi")}><X size={16} /></button></div>}
  {modal?.type === 'request' && <RequestModal {...{
      products,
      jetties: scopeJetty,
      vessels,
      busy
    }} initial={modal} onClose={() => setModal(null)} onSubmit={p => act('request.create', p, {
      message: "Permintaan transfer berhasil dibuat."
    })} />}
  {modal?.type === 'measurement' && role==='stock' && <MeasurementModal {...{
      scopeStock,
      products,
      crushers,
      busy,
      csrf,
      notify
    }} initial={modal} onClose={() => setModal(null)} onSubmit={p => mutate('measurement.create', p, {
      message: "Pengukuran disimpan untuk tinjauan Admin."
    })} />}
  {modal?.type === 'approve' && <Modal title={tr("Tinjau pengukuran stockpile")} subtitle={tr("Persetujuan mengubah stok fisik tercatat; reservasi dispatch tetap dilindungi.")} onClose={() => setModal(null)}><div className="confirm-details"><div><span>{tr("Stockpile")}</span><b>{stockpile(modal.record.stockpileId)?.code}</b></div><div><span>{tr("SKU")}</span><b>{product(modal.record.skuId)?.name}</b></div><div><span>{tr("Metode")}</span><b>{statusText[modal.record.method]}</b></div><div><span>{tr("Stok saat ini")}</span><b>{fmt(stockpile(modal.record.stockpileId)?.onHandM3, 2)}{tr(" m³")}</b></div><div><span>{tr("Stok hasil pengukuran")}</span><b className="teal-text">{fmt(modal.record.volumeM3, 2)}{tr(" m³")}</b></div><div><span>{tr("Catatan")}</span><b>{modal.record.notes || '—'}</b></div></div><div className="notice"><ShieldCheck size={17} />{tr("Setujui setelah memeriksa kalibrasi dan bukti lapangan. Volume ini menggantikan stok fisik pada lokasi yang dipilih.")}</div><div className="modal-actions"><Button variant="secondary" onClick={() => setModal(null)}>{tr("Batal")}</Button><Button disabled={busy} icon={Check} onClick={() => act('measurement.approve', {
          measurementId: modal.record.id
        })}>{tr("Setujui pengukuran")}</Button></div></Modal>}
  {modal?.type === 'plan' && <Modal title={modal.record.transferMode==='LAND'?tr("Fleet Capacity & Allocation"):tr("Rencanakan dispatch otomatis")} subtitle={modal.record.code} onClose={() => setModal(null)}><RequestLines request={lookup(requests, modal.record.id) || modal.record} products={products} />{modal.record.transferMode==='LAND'?<><FleetCapacityAllocation request={lookup(requests,modal.record.id)||modal.record} products={products}/><div className="modal-actions"><Button variant="secondary" onClick={() => setModal(null)}>{tr("Tutup")}</Button></div></>:<><div className="confirm-details"><div><span>{tr("Jetty tujuan")}</span><b>{jetty(modal.record.jettyId)?.name}</b></div><div><span>{tr("Kapal tujuan")}</span><b>{vessel(modal.record.vesselId)?.name}</b></div><div><span>{tr("Armada idle saat ini")}</span><b>{idleTrucks.length}{tr(" dari ")}{trucks.length}{tr(" truk")}</b></div><div><span>{tr("Armada sedang bertugas")}</span><b>{activeTruckIds.size}{tr(" truk")}</b></div></div><div className="notice"><ClipboardCheck size={18} /><span>{tr("Sistem akan memilih stockpile dengan SKU dan stok tersedia, mereservasi kapasitas kapal, lalu membagi muatan sesuai kapasitas truk. Pekerjaan tambahan masuk antrean serial.")}</span></div><div className="modal-actions"><Button variant="secondary" onClick={() => setModal(null)}>{tr("Batal")}</Button><Button disabled={busy} icon={Send} onClick={() => act('request.plan', {
          requestId: modal.record.id
        }, {
          message: "Stok dan kapasitas kapal direservasi. Antrean dispatch terbentuk."
        })}>{tr("Buat alokasi & dispatch")}</Button></div></>}</Modal>}
  {modal?.type === 'requestDetail' && <RequestDetail request={lookup(requests, modal.record.id) || modal.record} {...{
      products,
      trips,
      dispatches,
      truck,
      stockpile,
      vessel,
      jetty
    }} onClose={() => setModal(null)} />}
  {modal?.type === 'trip' && <TripDetail trip={lookup(trips, modal.record.id) || modal.record} {...{
      truck,
      stockpile,
      product,
      jetty,
      vessel,
      role,
      user,
      busy
    }} onClose={() => setModal(null)} onAction={(a, p) => act(a, p)} />}
  {modal?.type === 'truck' && <TruckDetail record={modal.record} {...{
      trips,
      product,
      stockpile,
      vessel
    }} onClose={() => setModal(null)} />}
  {modal?.type === 'master' && <MasterModal {...sources} entity={modal.entity} record={modal.record} busy={busy} onClose={() => setModal(null)} onSubmit={(e, p) => act(`master.${e}.save`, p)} />}
 </div>;
}

// The normal application always uses the authenticated, shared operation store.
// LegacyApp remains available to source reviewers, but never owns /driver/tasks.
export default function App() {
  useLanguage();
  const quarryWorkspace=QUARRY_CILEGON_SITE||window.location.pathname.startsWith('/quarry-cilegon');
  const [session,setSession]=useState(null);
  const [booting,setBooting]=useState(true);
  const [logoutError,setLogoutError]=useState('');
  useEffect(()=>{let alive=true;api('/api/me').then(d=>{if(alive)setSession(d);}).catch(()=>{}).finally(()=>{if(alive)setBooting(false);});return()=>{alive=false;};},[]);
  useEffect(()=>{if(quarryWorkspace)document.title='AIMOC Quarry Cilegon · Weighbridge Operations';},[quarryWorkspace]);
  const logout=async()=>{try{await api('/api/logout',{method:'POST',headers:{'X-CSRF-Token':session?.csrfToken||''},body:'{}'});setSession(null);setLogoutError('');}catch(e){setLogoutError(e.message);}};
  if(booting)return <div className="boot"><Brand/><Loader2 className="spin" size={24}/><p>{tr('Menghubungkan ruang operasi…')}</p></div>;
  if(!session?.user)return <>{quarryWorkspace&&<div style={{position:'absolute',zIndex:2,top:16,left:24,color:'#fff',fontSize:12,fontWeight:700,letterSpacing:'0.16em'}}>AIMOC · QUARRY CILEGON</div>}<Login onLogin={d=>{setSession(d);setLogoutError('');}}/></>;
  const props={user:session.user,session,csrf:session.csrfToken||'',logout,logoutError,onUnauthorized:()=>setSession(null)};
  if(quarryWorkspace)return <QuarryCilegonWorkspace key={session.user.id} {...props}/>;
  return <><a className="quarry-cross-site-link" href="/quarry-cilegon" style={{display:'block',padding:'9px 20px',background:'#082e35',color:'#fff',fontSize:12,textAlign:'center',textDecoration:'none'}}>{getLanguage()==='en'?'Quarry Cilegon · Open weighbridge, QR gates and serial trips':'Quarry Cilegon · Buka jembatan timbang, gate QR dan ritase serial'} ↗</a><IntegratedWorkspace key={session.user.id} {...props}/></>;
}
