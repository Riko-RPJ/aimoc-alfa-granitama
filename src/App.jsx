import { tr, localize, locale, useLanguage, getLanguage, setLanguage, apiErrorSource, eventText, eventTypeLabel } from "./i18n.js";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowDownToLine, ArrowRight, ArrowUpRight, BarChart3, Bell, Box, Camera, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, ClipboardCheck, ClipboardList, Clock3, Download, Factory, FileText, Filter, Layers3, LayoutDashboard, Loader2, LogOut, MapPin, Menu, Package, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck, Ship, Truck, Upload, Users, Video, Wifi, WifiOff, X } from 'lucide-react';
const fmt = (v, d = 0) => new Intl.NumberFormat(locale(), {
  maximumFractionDigits: d,
  minimumFractionDigits: 0
}).format(Number(v) || 0);
const stamp = v => v ? new Date(v).toLocaleString(locale(), {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit'
}) : '—';
const minute = v => v ? new Date(v).toLocaleTimeString(locale(), {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
}) : tr("Belum tersinkron");
const number = v => Number(v) || 0;
const arr = (s, key) => Array.isArray(s?.[key]) ? s[key] : [];
const sum = (xs, key) => xs.reduce((v, x) => v + number(typeof key === 'function' ? key(x) : x[key]), 0);
const lookup = (xs, id) => xs.find(x => x.id === id);
const statusText = localize({
  needs_calibration: 'Perlu pengukuran',
  unavailable: 'Nonaktif',
  requested: 'Permintaan baru',
  planned: 'Terencana',
  in_progress: 'Dalam proses',
  completed: 'Selesai',
  queued: 'Antrean serial',
  loading: 'Muat stockpile',
  in_transit: 'Dalam perjalanan',
  arrived: 'Tiba di jetty',
  unloaded: 'Bongkar selesai',
  returned: 'Kembali / selesai',
  waiting: 'Menunggu sandar',
  closed: 'Ditutup',
  pending: 'Perlu persetujuan',
  approved: 'Disetujui',
  camera_pending: 'Bukti kamera',
  awaiting_configuration: 'Menunggu konfigurasi',
  manual: 'Survei lapangan',
  calibrated_geometry: 'Estimasi geometri',
  available: 'Tersedia',
  idle: 'Idle'
});
const roleName = localize({
  admin: 'Administrator',
  stock: 'Operator stockpile',
  jetty: 'Operator jetty'
});
const navs = [['overview', 'Ringkasan operasi', LayoutDashboard], ['inventory', 'Stock inventory', Layers3], ['requests', 'Permintaan transfer', ClipboardList], ['dispatch', 'Dispatch & armada', Truck], ['jetty', 'Operasi jetty', Ship], ['master', 'Master data', Settings2], ['audit', 'Audit & NetSuite', FileText]];
const meta = localize({
  overview: ['OVERVIEW', 'Ringkasan operasi', 'Satu pandangan untuk stok, armada, dan muatan kapal.'],
  inventory: ['STOCK OPERATIONS', 'Stock inventory', 'Stok per SKU, crusher dan lokasi — dengan jejak pengukuran.'],
  requests: ['TRANSFER CONTROL', 'Permintaan transfer', 'Tetapkan kebutuhan material dan tujuan sebelum dispatch.'],
  dispatch: ['FLEET OPERATIONS', 'Dispatch & armada', 'Penugasan serial. Satu truk, satu pekerjaan aktif.'],
  jetty: ['JETTY OPERATIONS', 'Penerimaan & loading', 'Pastikan setiap ritase diterima oleh jetty dan kapal yang tepat.'],
  master: ['ADMINISTRATION', 'Master data', 'Atur produk, crusher, stockpile, armada, dan kapasitas muat aman.'],
  audit: ['TRACEABILITY', 'Audit & Oracle NetSuite', 'Telusuri perubahan stok dan dokumen yang menunggu integrasi ERP.']
});
async function api(path, opts = {}) {
  let r = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers: {
      ...(opts.body ? {
        'Content-Type': 'application/json'
      } : {}),
      ...opts.headers
    }
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error('Server tidak memberikan respons yang valid.');
  }
  if (!r.ok) {
    const e = new Error(apiErrorSource(data));
    e.status = r.status;
    throw e;
  }
  return data;
}
function Badge({
  status,
  children,
  tone
}) {
  return <span className={`badge ${tone || (['returned', 'completed', 'approved', 'loading'].includes(status) ? 'green' : ['queued', 'waiting', 'pending', 'requested', 'awaiting_configuration'].includes(status) ? 'amber' : ['in_transit', 'in_progress', 'arrived', 'planned'].includes(status) ? 'blue' : 'neutral')}`}>{children || statusText[status] || status || '—'}</span>;
}
function LanguageSwitcher({compact=false}) {
  const language=useLanguage();
  return <div className={`language-switch ${compact?'compact':''}`} role="group" aria-label={tr('Bahasa aplikasi')}>
    <button type="button" data-language="id" aria-label="Bahasa Indonesia" title="Bahasa Indonesia" aria-pressed={language==='id'} onClick={()=>setLanguage('id')}>ID</button>
    <button type="button" data-language="en" aria-label="English" title="English" aria-pressed={language==='en'} onClick={()=>setLanguage('en')}>EN</button>
  </div>;
}
function Empty({
  icon: Icon = Box,
  title = tr("Belum ada data"),
  text = tr("Data operasional akan muncul di sini setelah dicatat.")
}) {
  return <div className="empty"><Icon size={30} /><strong>{title}</strong><p>{text}</p></div>;
}
function Brand({
  light = false
}) {
  return <div className={`brand ${light ? 'light' : ''}`}><div className="aimoc-crop"><img className="aimoc-logo" src="/brand/aimoc-logo.webp" alt={tr("AIMOC")} onError={e => {
        e.currentTarget.style.display = 'none';
        e.currentTarget.parentNode.nextSibling.style.display = 'block';
      }} /></div><b className="brand-fallback" style={{
      display: 'none'
    }}>{tr("AIMOC")}<span>●</span></b><span className="brand-sub">{tr("ALFA GRANITAMA")}</span></div>;
}
function BrandPartners() {
  return <div className="partners"><img src="/brand/gandasari-logo.png" alt={tr("Gandasari Group")} onError={e => {
      e.currentTarget.style.display = 'none';
      e.currentTarget.nextSibling.style.display = 'block';
    }} /><b style={{
      display: 'none'
    }}>{tr("GANDASARI ")}<small>{tr("GROUP")}</small></b><span /><img src="/brand/alfa-granitama-logo.png" alt={tr("PT Alfa Granitama")} onError={e => {
      e.currentTarget.style.display = 'none';
      e.currentTarget.nextSibling.style.display = 'block';
    }} /><b style={{
      display: 'none'
    }}>{tr("ALFA ")}<small>{tr("GRANITAMA")}</small></b></div>;
}
function Button({
  children,
  icon: Icon,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled = false,
  ...rest
}) {
  return <button type={type} className={`btn ${variant}`} disabled={disabled} onClick={onClick} {...rest}>{Icon && <Icon size={16} />} {children}</button>;
}
function Field({
  label,
  children,
  hint
}) {
  return <label className="field"><span>{tr(label)}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false
}) {
  const ref = useRef();
  useEffect(() => {
    const old = document.activeElement;
    ref.current?.focus();
    const key = e => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        let nodes = ref.current?.querySelectorAll('button:not(:disabled),input,select,textarea,[tabindex="0"]');
        let a = [...(nodes || [])].filter(x => x.offsetParent !== null);
        if (!a.length) return;
        let first = a[0],
          last = a[a.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      old?.focus?.();
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><div className="modal-heading-tools"><LanguageSwitcher compact /><button className="icon-btn" onClick={onClose} aria-label={tr("Tutup")}><X size={21} /></button></div></div>{children}</section></div>;
}
function StatCard({
  label,
  value,
  unit,
  caption,
  icon: Icon,
  tone = 'teal',
  trend
}) {
  return <article className="stat-card"><div className="stat-top"><span>{tr(label)}</span><span className={`stat-icon ${tone}`}><Icon size={20} /></span></div><div className="stat-number">{value}<small>{unit}</small></div><div className="stat-caption">{trend && <span className="stat-trend"><ArrowUpRight size={13} />{trend}</span>}{caption}</div></article>;
}
function Panel({
  title,
  subtitle,
  action,
  children,
  className = ''
}) {
  return <section className={`panel ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>{children}</section>;
}
function DataTable({
  headers,
  children
}) {
  return <div className="table-wrap"><table><thead><tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}
function ProgressBar({
  value,
  max,
  color
}) {
  let p = max ? Math.min(100, Math.max(0, number(value) / number(max) * 100)) : 0;
  return <div className="progress-track"><span style={{
      width: `${p}%`,
      background: color
    }} /></div>;
}
function RequestLines({
  request,
  products
}) {
  return <div className="line-summary">{request.lines.map((l, i) => <span key={i}>{lookup(products, l.skuId)?.code || l.skuId}<b>{fmt(l.quantity, 2)} {l.unit === 't' ? 'ton' : 'm³'}</b></span>)}</div>;
}
export default function App() {
  useLanguage();
  const [user, setUser] = useState(null),
    [csrf, setCsrf] = useState(''),
    [boot, setBoot] = useState(true),
    [data, setData] = useState(null),
    [revision, setRevision] = useState(null),
    [lastSync, setLastSync] = useState(null),
    [connected, setConnected] = useState(false),
    [page, setPage] = useState('overview'),
    [mobileNav, setMobileNav] = useState(false),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState(null),
    [modal, setModal] = useState(null),
    [search, setSearch] = useState('');
  const latestRevision = useRef(-1),
    pollRef = useRef(false);
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
    if (!user) return;
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
  const mutate = async (action, payload, {
    close = true,
    message = "Perubahan berhasil disimpan."
  } = {}) => {
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
  const activeTrips = trips.filter(t => !['queued', 'returned'].includes(t.status));
  const activeTruckIds = new Set(trucks.filter(t => t.status === 'busy' || t.activeTripId || activeTrips.some(x => x.truckId === t.id)).map(t => t.id));
  const idleTrucks = trucks.filter(t => t.active !== false && (t.status === 'available' || !t.status && !activeTruckIds.has(t.id)));
  const queuedTrips = trips.filter(t => t.status === 'queued');
  const availableM3 = sum(stockpiles, x => Math.max(0, number(x.onHandM3) - number(x.reservedM3)));
  const transit = trips.filter(t => ['in_transit', 'arrived'].includes(t.status));
  const displayEvents = [...events].reverse().slice(0, 6);
  const permittedNav = navs.filter(([id]) => (id !== 'master' || can) && (id !== 'audit' || can));
  const selectPage = id => {
    setPage(id);
    setMobileNav(false);
    setSearch('');
  };
  const openMeasurement = () => setModal({
    type: 'measurement'
  });
  const openRequest = () => setModal({
    type: 'request'
  });
  const head = meta[page] || meta.overview;
  if (boot) return <div className="boot"><Brand /><Loader2 className="spin" size={24} /><p>{tr("Menghubungkan ruang operasi…")}</p></div>;
  if (!user) return <Login onLogin={d => {
    setUser(d.user);
    setCsrf(d.csrfToken || '');
    setPage(d.user.role === 'jetty' ? 'jetty' : d.user.role === 'stock' ? 'inventory' : 'overview');
  }} />;
  return <div className="app-shell">
  {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
  <aside className={`sidebar ${mobileNav ? 'open' : ''}`}><div className="sidebar-logo"><Brand light /><button className="mobile-only icon-btn" onClick={() => setMobileNav(false)} aria-label={tr("Tutup menu")}><X size={20} /></button></div><div className="workspace-label"><span className="workspace-icon"><Factory size={18} /></span><div><strong>{tr("Gandasari Operations")}</strong><small>{tr("PT Alfa Granitama")}</small></div><ChevronDown size={15} /></div><div className="nav-section-label">{tr("WORKSPACE")}</div><nav aria-label={tr("Menu utama")}>{permittedNav.map(([id, label, Icon]) => <button key={id} onClick={() => selectPage(id)} className={page === id ? 'selected' : ''}><Icon size={18} /><span>{tr(label)}</span>{id === 'requests' && requests.filter(x => x.status === 'requested').length > 0 && <i>{requests.filter(x => x.status === 'requested').length}</i>}</button>)}</nav><div className="sidebar-bottom"><div className="environment"><span /><div><strong>{tr("Prototipe operasional")}</strong><small>{tr("Data awal contoh · tersimpan bersama")}</small></div></div><div className="sidebar-user"><span className="avatar">{(user.name || user.displayName || user.username || tr("A")).slice(0, 2).toUpperCase()}</span><div><strong>{user.name || user.displayName || user.username}</strong><small>{roleName[role]}</small></div><button onClick={logout} title={tr("Keluar")} className="icon-btn"><LogOut size={17} /></button></div></div></aside>
  <div className="main-shell"><header className="topbar"><div className="topbar-left"><button className="mobile-only icon-btn" onClick={() => setMobileNav(true)} aria-label={tr("Buka menu")}><Menu size={22} /></button><span className="breadcrumb">{tr("Operations ")}<ChevronRight size={14} /><b>{head[1]}</b></span></div><div className="topbar-right"><LanguageSwitcher compact /><span className={`sync-state ${connected ? 'online' : 'offline'}`}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}<span>{connected ? tr("Tersinkron") : tr("Koneksi terputus")}</span><small>{minute(lastSync)}</small></span><button className="icon-btn" onClick={refresh} aria-label={tr("Muat ulang data")} title={tr("Muat ulang")}><RefreshCw size={17} /></button><div className="topbar-divider" /><span className="role-chip"><ShieldCheck size={14} />{roleName[role]}</span></div></header>
   <main><div className="page-heading"><div><div className="eyebrow">{head[0]} <span>•</span>{tr(" GANDASARI ALFA GRANITAMA")}</div><h1>{head[1]}</h1><p>{head[2]}</p></div><div className="heading-actions">{['overview', 'inventory'].includes(page) && role !== 'jetty' && <Button variant="secondary" icon={Camera} onClick={openMeasurement}>{tr("Ukur stockpile")}</Button>}{['overview', 'requests'].includes(page) && role !== 'stock' && <Button icon={Plus} onClick={openRequest}>{tr("Permintaan transfer")}</Button>}{page === 'master' && <Button icon={Plus} onClick={() => setModal({
              type: 'master',
              entity: 'product'
            })}>{tr("Tambah data")}</Button>}</div></div>
   {!connected && data && <div className="notice error"><WifiOff size={17} />{tr("Menampilkan data terakhir. Perubahan perlu koneksi server; status tidak diperbarui hingga tersambung kembali.")}</div>}
   {!data ? <div className="loading-panel"><Loader2 className="spin" /><h3>{tr("Mengambil data operasional…")}</h3><Button variant="secondary" onClick={refresh}>{tr("Coba lagi")}</Button></div> : <>
   {page === 'overview' && <><div className="stats-grid"><StatCard label={tr("STOK TERSEDIA")} value={fmt(availableM3)} unit={tr("m³")} icon={Layers3} caption={tr("{0} ton ekuivalen · setelah reservasi", fmt(sum(stockpiles, x => (number(x.onHandM3) - number(x.reservedM3)) * density(x.skuId))))} /><StatCard label={tr("ARMADA TERSEDIA")} value={idleTrucks.length} unit={tr("/ {0} truk", trucks.filter(x => x.active !== false).length)} icon={Truck} tone="blue" caption={tr("{0} aktif · {1} ritase dalam antrean", activeTruckIds.size, queuedTrips.length)} /><StatCard label={tr("MATERIAL DALAM PERJALANAN")} value={fmt(sum(transit, "tonnageT"), 1)} unit={tr("ton")} icon={ArrowUpRight} tone="amber" caption={tr("{0} ritase menuju jetty", transit.length)} /><StatCard label={tr("TERKONFIRMASI KE KAPAL")} value={fmt(sum(trips.filter(x => ['unloaded', 'returned'].includes(x.status)), "tonnageT"), 1)} unit={tr("ton")} icon={Ship} tone="purple" caption={tr("{0} ritase telah dibongkar", trips.filter(x => ['unloaded', 'returned'].includes(x.status)).length)} /></div>
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
   </>}
   {page === 'inventory' && <><div className="stats-grid three"><StatCard label={tr("STOK FISIK TERCATAT")} value={fmt(sum(scopeStock, "onHandM3"))} unit={tr("m³")} icon={Layers3} caption={tr("{0} stockpile · {1} crusher terdaftar", scopeStock.length, crushers.length)} /><StatCard label={tr("STOK DIRESERVASI")} value={fmt(sum(scopeStock, "reservedM3"))} unit={tr("m³")} icon={ClipboardCheck} tone="amber" caption={tr("Terikat ke dispatch yang belum dimuat")} /><StatCard label={tr("MENUNGGU VALIDASI")} value={measurements.filter(m => m.status === 'pending').length} unit={tr("pengukuran")} icon={Camera} tone="blue" caption={tr("Persetujuan Admin sebelum mengubah stok")} /></div><InventoryTable {...{
              scopeStock,
              products,
              crushers,
              search,
              setSearch,
              role,
              setModal,
              product,
              crusher
            }} /><Panel title={tr("Pengukuran & bukti stockpile")} subtitle={tr("Foto tunggal tidak otomatis menghasilkan volume. Estimasi terkalibrasi harus diperiksa Admin.")} action={role !== 'jetty' && <Button variant="secondary" icon={Plus} onClick={openMeasurement}>{tr("Catat pengukuran")}</Button>}><DataTable headers={[tr("Waktu / referensi"), tr("Stockpile & SKU"), tr("Metode"), tr("Volume usulan"), tr("Status"), tr("Aksi")]}>{[...measurements].reverse().map(m => <tr key={m.id}><td><b>{m.code || m.id.slice(0, 12)}</b><small>{stamp(m.createdAt)}</small></td><td><b>{stockpile(m.stockpileId)?.code}</b><small>{product(m.skuId)?.name}</small></td><td>{statusText[m.method] || m.method}{m.evidenceName && <small>{m.evidenceName}</small>}</td><td>{m.volumeM3 != null ? `${fmt(m.volumeM3, 2)} m³` : <span className="muted">{tr("Belum diukur")}</span>}</td><td><Badge status={m.status} /></td><td><div className="row-actions">{m.evidenceId && <a className="text-btn" href={`/api/evidence/${m.evidenceId}`} target="_blank" rel="noreferrer">{tr("Lihat foto")}</a>}{can && m.status === 'pending' && m.method !== 'camera_pending' && <Button variant="secondary" disabled={busy} onClick={() => setModal({
                        type: 'approve',
                        record: m
                      })}>{tr("Tinjau & setujui")}</Button>}</div></td></tr>)}</DataTable>{!measurements.length && <Empty icon={Camera} title={tr("Belum ada pengukuran")} text={tr("Ambil foto, catat hasil survei atau ajukan estimasi geometri terkalibrasi.")} />}</Panel></>}
   {page === 'requests' && <><div className="stats-grid three"><StatCard label={tr("PERMINTAAN TERBUKA")} value={requests.filter(x => !['completed'].includes(x.status)).length} unit={tr("request")} icon={ClipboardList} caption={tr("{0} belum direncanakan", requests.filter(x => x.status === 'requested').length)} /><StatCard label={tr("DISPATCH TERBENTUK")} value={dispatches.length} unit={tr("dispatch")} icon={Send} tone="blue" caption={tr("Alokasi stockpile per SKU dan tujuan")} /><StatCard label={tr("RENCANA RITASE")} value={trips.length} unit={tr("ritase")} icon={Truck} tone="amber" caption={tr("{0} antre · {1} sedang berjalan", queuedTrips.length, activeTrips.length)} /></div><Panel title={tr("Permintaan stock transfer")} subtitle={tr("Satu permintaan dapat berisi beberapa SKU. Reservasi mencegah stok dan kapasitas kapal dipakai dua kali.")} action={role !== 'stock' && <Button icon={Plus} onClick={openRequest}>{tr("Buat permintaan")}</Button>}><DataTable headers={[tr("Request / tujuan"), tr("Material diminta"), tr("Jetty & kapal"), tr("Status"), tr("Aksi")]}>{[...requests].reverse().map(r => <tr key={r.id}><td><button className="table-link" onClick={() => setModal({
                      type: 'requestDetail',
                      record: r
                    })}>{r.code}</button><small>{r.destination || tr("Transfer internal")} · {stamp(r.createdAt)}</small></td><td><RequestLines request={r} products={products} /></td><td><b>{jetty(r.jettyId)?.name}</b><small>{vessel(r.vesselId)?.name}</small></td><td><Badge status={r.status} /></td><td>{r.status === 'requested' && can ? <Button variant="secondary" icon={Send} disabled={busy} onClick={() => setModal({
                      type: 'plan',
                      record: r
                    })}>{tr("Alokasi otomatis")}</Button> : <button className="text-btn" onClick={() => setModal({
                      type: 'requestDetail',
                      record: r
                    })}>{tr("Lihat detail ")}<ChevronRight size={14} /></button>}</td></tr>)}</DataTable>{!requests.length && <Empty icon={ClipboardList} title={tr("Belum ada permintaan transfer")} text={tr("Operator jetty atau Admin membuat permintaan SKU, kuantitas dan kapal tujuan.")} />}</Panel><div className="process-strip"><div><span>01</span><b>{tr("Permintaan")}</b><small>{tr("SKU + kuantitas + kapal")}</small></div><ArrowRight /><div><span>02</span><b>{tr("Reservasi")}</b><small>{tr("Stok & kapasitas aman")}</small></div><ArrowRight /><div><span>03</span><b>{tr("Dispatch serial")}</b><small>{tr("Armada tersedia / kembali")}</small></div><ArrowRight /><div><span>04</span><b>{tr("Konfirmasi jetty")}</b><small>{tr("Ritase diterima & dibongkar")}</small></div></div></>}
   {page === 'dispatch' && <><div className="stats-grid four"><StatCard label={tr("TRUK IDLE")} value={idleTrucks.length} unit={tr("truk")} icon={Truck} caption={tr("Tidak memiliki ritase aktif")} /><StatCard label={tr("SEDANG TRANSFER")} value={activeTruckIds.size} unit={tr("truk")} icon={ArrowUpRight} tone="blue" caption={tr("Muat, perjalanan, tiba atau kembali")} /><StatCard label={tr("ANTREAN SERIAL")} value={queuedTrips.length} unit={tr("ritase")} icon={Clock3} tone="amber" caption={tr("Dijalankan setelah ritase sebelumnya selesai")} /><StatCard label={tr("RITASE SELESAI")} value={trips.filter(x => x.status === 'returned').length} unit={tr("ritase")} icon={CheckCircle2} tone="purple" caption={tr("Bongkar terkonfirmasi dan truk kembali")} /></div><FleetBoard {...{
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
            }} /><Panel title={tr("Dispatch per sumber stockpile")} subtitle={tr("Tujuan setiap dispatch dikunci ke jetty dan kapal pada permintaan asal")}><DataTable headers={[tr("Dispatch / permintaan"), tr("Sumber stockpile"), tr("SKU"), tr("Rencana"), tr("Tujuan kapal"), tr("Status")]}>{[...dispatches].reverse().map(d => <tr key={d.id}><td><b>{d.code}</b><small>{lookup(requests, d.requestId)?.code}</small></td><td><b>{stockpile(d.stockpileId)?.code}</b><small>{crusher(stockpile(d.stockpileId)?.crusherId)?.name}</small></td><td>{product(d.skuId)?.code}</td><td><b>{fmt(d.volumeM3, 2)}{tr(" m³")}</b><small>{fmt(d.tonnageT, 2)}{tr(" ton · ")}{trips.filter(t => t.dispatchId === d.id).length}{tr(" ritase")}</small></td><td>{vessel(d.vesselId)?.name}<small>{jetty(d.jettyId)?.name}</small></td><td><Badge status={d.status} /></td></tr>)}</DataTable>{!dispatches.length && <Empty icon={Send} title={tr("Belum ada dispatch")} text={tr("Rencanakan permintaan transfer untuk membentuk alokasi stok dan antrean truk.")} />}</Panel></>}
   {page === 'jetty' && <><div className="notice"><MapPin size={17} />{tr("Tujuan terikat sejak permintaan transfer. Operator mengonfirmasi kedatangan dan bongkar hanya pada jetty yang menjadi kewenangannya.")}</div><div className="jetty-layout">{scopeJetty.map(j => <Panel key={j.id} title={j.name} subtitle={tr("{0} · {1} kapal terdaftar", j.code, vessels.filter(v => v.jettyId === j.id).length)} action={<Badge tone="blue">{trips.filter(t => t.jettyId === j.id && ['in_transit', 'arrived'].includes(t.status)).length}{tr(" ritase menuju / tiba")}</Badge>}>{vessels.filter(v => v.jettyId === j.id).map(v => <div className="vessel-card" key={v.id}><div className="vessel-card-header"><span className="vessel-symbol"><Ship size={27} /></span><div><h3>{v.name}</h3><small>{v.code}</small></div><Badge status={v.status}>{v.status === 'loading' ? tr("Sedang loading") : statusText[v.status] || v.status}</Badge></div><div className="capacity-metrics"><div><small>{tr("Terkonfirmasi muat")}</small><strong>{fmt(v.loadedT, 1)} <em>{tr("ton")}</em></strong></div><div><small>{tr("Direservasi")}</small><strong>{fmt(v.reservedT, 1)} <em>{tr("ton")}</em></strong></div><div><small>{tr("Sisa belum terikat")}</small><strong className="teal-text">{fmt(Math.max(0, number(v.payloadLimitT) - number(v.loadedT) - number(v.reservedT)), 1)} <em>{tr("ton")}</em></strong></div></div><div className="vessel-capacity-track"><span style={{
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
            }} jettyMode /><div className="notice"><Ship size={18} /><span>{tr("Batas kargo aman diisi Admin berdasarkan dokumen operasi kapal. DWT katalog mencakup beban lain dan tidak digunakan langsung sebagai kapasitas material.")}</span></div></>}
   {page === 'master' && can && <MasterData {...sources} setModal={setModal} csrf={csrf} notify={notify} />}
   {page === 'audit' && <><div className="erp-banner"><span className="erp-logo">{tr("N")}</span><div><h2>{tr("Oracle NetSuite")}</h2><p>{tr("Event operasional sudah tercatat. Konektor ERP menunggu account sandbox, mapping dan otorisasi.")}</p></div><Badge tone="amber">{tr("Belum tersambung ke ERP")}</Badge></div><Panel title={tr("Antrean dokumen ERP")} subtitle={tr("Intent tersimpan bukan bukti posting ERP. Tidak ada dokumen yang ditandai terkirim tanpa acknowledgement NetSuite.")}><DataTable headers={[tr("Referensi"), tr("Jenis event"), tr("Waktu"), tr("Status"), tr("Keterangan")]}>{[...erpOutbox].reverse().map(e => <tr key={e.id}><td><b>{e.code || e.reference || e.id.slice(0, 12)}</b></td><td>{eventTypeLabel(e.type || e.eventType || "Transfer inventory")}</td><td>{stamp(e.createdAt)}</td><td><Badge status={e.status || 'awaiting_configuration'} /></td><td>{tr(e.message || e.reason || "Menunggu konfigurasi & mapping Oracle NetSuite")}</td></tr>)}</DataTable>{!erpOutbox.length && <Empty icon={FileText} title={tr("Belum ada event untuk ERP")} text={tr("Konfirmasi pergerakan material akan membentuk intent integrasi yang dapat ditelusuri.")} />}</Panel><Panel title={tr("Jejak audit")} subtitle={tr("Perubahan stok, reservasi, dispatch dan konfirmasi operator")}><EventList events={[...events].reverse()} full /></Panel><Panel title={tr("Ledger inventory")} subtitle={tr("Pencatatan kuantitas sumber dan perpindahan yang sudah dikonfirmasi")}><DataTable headers={[tr("Waktu"), tr("Jenis"), tr("Stockpile"), tr("Volume"), tr("Referensi")]}>{[...inventoryLedger].reverse().map(e => <tr key={e.id}><td>{stamp(e.createdAt || e.timestamp || e.at)}</td><td>{eventTypeLabel(e.type || e.kind)}</td><td>{stockpile(e.stockpileId)?.code || '—'}</td><td>{fmt(e.volumeM3 ?? e.deltaM3 ?? e.quantityM3, 2)}{tr(" m³")}</td><td>{e.reference || e.referenceId || e.tripId || e.measurementId || '—'}</td></tr>)}</DataTable>{!inventoryLedger.length && <Empty title={tr("Belum ada pergerakan stok")} />}</Panel></>}
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
  {modal?.type === 'measurement' && <MeasurementModal {...{
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
  {modal?.type === 'plan' && <Modal title={tr("Rencanakan dispatch otomatis")} subtitle={modal.record.code} onClose={() => setModal(null)}><RequestLines request={lookup(requests, modal.record.id) || modal.record} products={products} /><div className="confirm-details"><div><span>{tr("Jetty tujuan")}</span><b>{jetty(modal.record.jettyId)?.name}</b></div><div><span>{tr("Kapal tujuan")}</span><b>{vessel(modal.record.vesselId)?.name}</b></div><div><span>{tr("Armada idle saat ini")}</span><b>{idleTrucks.length}{tr(" dari ")}{trucks.length}{tr(" truk")}</b></div><div><span>{tr("Armada sedang bertugas")}</span><b>{activeTruckIds.size}{tr(" truk")}</b></div></div><div className="notice"><ClipboardCheck size={18} /><span>{tr("Sistem akan memilih stockpile dengan SKU dan stok tersedia, mereservasi kapasitas kapal, lalu membagi muatan sesuai kapasitas truk. Pekerjaan tambahan masuk antrean serial.")}</span></div><div className="modal-actions"><Button variant="secondary" onClick={() => setModal(null)}>{tr("Batal")}</Button><Button disabled={busy} icon={Send} onClick={() => act('request.plan', {
          requestId: modal.record.id
        }, {
          message: "Stok dan kapasitas kapal direservasi. Antrean dispatch terbentuk."
        })}>{tr("Buat alokasi & dispatch")}</Button></div></Modal>}
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
function Login({
  onLogin
}) {
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submit = async e => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      onLogin(await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password
        })
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return <div className="login-shell"><div className="login-story"><Brand light /><div className="login-story-copy"><span className="eyebrow">{tr("CONNECTED QUARRY OPERATIONS")}</span><h1>{tr("Dari crusher.")}<br />{tr("Ke kapal.")}<br /><em>{tr("Dalam satu kendali.")}</em></h1><p>{tr("Stok yang terlacak. Dispatch yang terarah.")}<br />{tr("Setiap ritase sampai ke tujuan yang benar.")}</p></div><div className="login-flow"><div><Factory size={30} /><span>{tr("CRUSHER")}</span></div><i /><div><Truck size={30} /><span>{tr("DISPATCH")}</span></div><i /><div><Ship size={30} /><span>{tr("JETTY")}</span></div></div><div className="login-story-footer"><span>{tr("GANDASARI GROUP")}</span><span>{tr("PT ALFA GRANITAMA")}</span></div></div><div className="login-form-wrap"><div className="login-language"><LanguageSwitcher /></div><BrandPartners /><form className="login-form" onSubmit={submit}><span className="eyebrow">{tr("AIMOC OPERATIONS")}</span><h2>{tr("Selamat datang kembali")}</h2><p>{tr("Masuk ke ruang operasi sesuai peran Anda.")}</p><Field label={tr("Username")}><input autoComplete="username" autoFocus required value={username} onChange={e => setUsername(e.target.value)} placeholder={tr("Username akun Anda")} /></Field><Field label={tr("Password")}><input autoComplete="current-password" required type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={tr("Masukkan password")} /></Field>{error && <div className="form-error" role="alert">{tr(error)}</div>}<Button type="submit" disabled={busy} icon={busy ? Loader2 : ArrowRight}>{busy ? tr("Menghubungkan…") : tr("Masuk ke aplikasi")}</Button><div className="login-assurance"><ShieldCheck size={17} /><span>{tr("Akses berbasis peran")}<br /><small>{tr("Admin · Operator stockpile · Operator jetty")}</small></span></div></form><p className="login-bottom">{tr("AIMOC Gandasari Alfa Granitama · Operational prototype")}</p></div></div>;
}
function FlowMap({
  crushers,
  stockpiles,
  activeTrips,
  vessels,
  jetties
}) {
  return <div className="flow-map"><div className="flow-map-nodes source">{crushers.slice(0, 3).map((c, i) => <div className="flow-node" key={c.id}><span className="node-icon"><Factory size={24} /></span><div><b>{c.name}</b><small>{fmt(sum(stockpiles.filter(s => s.crusherId === c.id), "onHandM3"))}{tr(" m³ tercatat")}</small></div><span className="node-status" /></div>)}</div><div className="flow-map-path"><div className="flow-line" /><div className="flow-truck"><Truck size={24} /></div><span>{activeTrips.length}{tr(" ritase aktif")}</span><small>{tr("Penugasan serial")}</small><div className="flow-line right" /></div><div className="flow-map-nodes dest">{jetties.slice(0, 3).map(j => <div className="flow-node" key={j.id}><span className="node-icon blue"><Ship size={25} /></span><div><b>{j.name}</b><small>{vessels.filter(v => v.jettyId === j.id && v.status !== 'closed').length}{tr(" kapal loading / menunggu")}</small></div></div>)}</div></div>;
}
function VesselMini({
  v,
  jetty
}) {
  return <div className="vessel-mini"><div className="vessel-mini-top"><span className="mini-ship"><Ship size={19} /></span><div><b>{v.name}</b><small>{jetty?.name} · {v.status === 'loading' ? tr("Sedang loading") : statusText[v.status] || v.status}</small></div><strong>{fmt(number(v.loadedT) + number(v.reservedT))}<small> / {fmt(v.payloadLimitT)}{tr(" t")}</small></strong></div><div className="vessel-capacity-track"><span style={{
        width: `${Math.min(100, number(v.loadedT) / number(v.payloadLimitT) * 100)}%`
      }} /><i style={{
        width: `${Math.min(100, number(v.reservedT) / number(v.payloadLimitT) * 100)}%`
      }} /></div><div className="vessel-mini-foot"><span>{fmt(v.loadedT)}{tr(" t muat")}</span><span>{fmt(v.reservedT)}{tr(" t reservasi")}</span></div></div>;
}
function EventList({
  events,
  full = false
}) {
  return events.length ? <div className={`events ${full ? 'full' : ''}`}>{events.map((e, i) => <div className="event" key={e.id || i}><span className="event-mark"><Check size={12} /></span><div><strong>{eventText(e)}</strong><small>{e.actorName || e.actor?.name || e.userName || e.actorId || tr("Pengguna")} {e.reference && <>· {e.reference}</>}</small></div><time>{stamp(e.createdAt || e.timestamp || e.at)}</time></div>)}</div> : <Empty icon={Activity} title={tr("Belum ada aksi operasional")} text={tr("Aksi operator dan Admin akan tercatat setelah disimpan.")} />;
}
function InventoryTable({
  scopeStock,
  products,
  crushers,
  search,
  setSearch,
  role,
  setModal,
  product,
  crusher
}) {
  const [filter, setFilter] = useState('all');
  const filtered = scopeStock.filter(s => (filter === 'all' || s.crusherId === filter) && `${s.code} ${product(s.skuId)?.name} ${product(s.skuId)?.code}`.toLowerCase().includes(search.toLowerCase()));
  return <Panel title={tr("Persediaan stockpile")} subtitle={tr("Kode stockpile mengikat sumber crusher dan satu SKU material")} action={<div className="table-tools"><div className="search-field"><Search size={16} /><input aria-label={tr("Cari stockpile atau SKU")} value={search} onChange={e => setSearch(e.target.value)} placeholder={tr("Cari SKU / stockpile")} /></div><select aria-label={tr("Filter crusher")} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{tr("Semua crusher")}</option>{crushers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}><DataTable headers={[tr("Stockpile / crusher"), tr("Produk / SKU"), tr("Stok fisik"), tr("Direservasi"), tr("Tersedia"), tr("Ekuivalen tersedia"), tr("Aksi")]}>{filtered.map(s => <tr key={s.id}><td><span className="table-cell-icon"><Layers3 size={18} /><span><b>{s.code}</b><small>{crusher(s.crusherId)?.name}</small></span></span></td><td><b>{product(s.skuId)?.code}</b><small>{product(s.skuId)?.name} · {product(s.skuId)?.sizeMm}</small></td><td>{fmt(s.onHandM3, 2)}{tr(" m³")}</td><td><span className={s.reservedM3 > 0 ? 'amber-text' : 'muted'}>{fmt(s.reservedM3, 2)}{tr(" m³")}</span></td><td><b className="teal-text">{fmt(number(s.onHandM3) - number(s.reservedM3), 2)}{tr(" m³")}</b></td><td>{fmt((number(s.onHandM3) - number(s.reservedM3)) * number(product(s.skuId)?.densityTPerM3), 2)}{tr(" ton")}</td><td>{role !== 'jetty' && <button className="icon-btn bordered" onClick={() => setModal({
            type: 'measurement',
            stockpileId: s.id
          })} title={tr("Ukur stockpile")}><Camera size={16} /></button>}</td></tr>)}</DataTable>{!filtered.length && <Empty title={tr("Stockpile tidak ditemukan")} />}</Panel>;
}
function RequestModal({
  products,
  jetties,
  vessels,
  initial,
  busy,
  onClose,
  onSubmit
}) {
  const [jettyId, setJetty] = useState(initial.jettyId || jetties[0]?.id || ''),
    [vesselId, setVessel] = useState(initial.vesselId || ''),
    [destination, setDestination] = useState('Stockpile Marunda'),
    [lines, setLines] = useState([{
      skuId: products[0]?.id || '',
      quantity: '',
      unit: 'm3'
    }]);
  const ships = vessels.filter(v => v.jettyId === jettyId && v.status !== 'closed');
  useEffect(() => {
    if (!ships.some(v => v.id === vesselId)) setVessel(ships[0]?.id || '');
  }, [jettyId, vessels.length]);
  const update = (i, key, v) => setLines(lines.map((l, j) => j === i ? {
    ...l,
    [key]: v
  } : l));
  const totalT = sum(lines, l => l.unit === 't' ? number(l.quantity) : number(l.quantity) * number(lookup(products, l.skuId)?.densityTPerM3));
  const selected = lookup(vessels, vesselId),
    remaining = selected ? number(selected.payloadLimitT) - number(selected.loadedT) - number(selected.reservedT) : 0;
  return <Modal wide title={tr("Buat permintaan stock transfer")} subtitle={tr("Tetapkan tujuan kapal, SKU dan kuantitas. Admin akan membentuk dispatch berdasarkan stok tersedia.")} onClose={onClose}><form onSubmit={e => {
      e.preventDefault();
      onSubmit({
        jettyId,
        vesselId,
        destination,
        lines: lines.map(l => ({
          ...l,
          quantity: number(l.quantity)
        }))
      });
    }}><div className="form-grid three"><Field label={tr("Jetty tujuan")}><select required value={jettyId} onChange={e => setJetty(e.target.value)}>{jetties.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}</select></Field><Field label={tr("Kapal tujuan")}><select required value={vesselId} onChange={e => setVessel(e.target.value)}>{ships.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field><Field label={tr("Lokasi penerima / tujuan")}><input required maxLength={100} value={destination} onChange={e => setDestination(e.target.value)} /></Field></div><div className="form-section-label">{tr("Material yang diminta ")}<small>{tr("Maksimal satu baris per SKU")}</small></div><div className="request-lines">{lines.map((l, i) => <div className="request-line" key={i}><span className="line-number">{String(i + 1).padStart(2, '0')}</span><Field label={tr("Produk / SKU")}><select required value={l.skuId} onChange={e => update(i, "skuId", e.target.value)}>{products.filter(p => p.active !== false).map(p => <option key={p.id} value={p.id}>{p.code} · {p.name} ({p.sizeMm})</option>)}</select></Field><Field label={tr("Kuantitas")}><input required type="number" min="0.01" max="1000000" step="0.01" value={l.quantity} onChange={e => update(i, 'quantity', e.target.value)} placeholder={tr("0")} /></Field><Field label={tr("Satuan")}><select value={l.unit} onChange={e => update(i, 'unit', e.target.value)}><option value="m3">{tr("m³")}</option><option value="t">{tr("ton")}</option></select></Field><button type="button" className="icon-btn" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => i !== j))} aria-label={tr("Hapus SKU {0}", i + 1)}><X size={17} /></button></div>)}</div><Button variant="ghost" icon={Plus} disabled={lines.length >= 6} onClick={() => setLines([...lines, {
        skuId: products.find(p => !lines.some(l => l.skuId === p.id))?.id || products[0]?.id,
        quantity: '',
        unit: 'm3'
      }])}>{tr("Tambah SKU")}</Button><div className="request-summary"><div><small>{tr("Total permintaan ekuivalen")}</small><strong>{fmt(totalT, 2)} <em>{tr("ton")}</em></strong></div><div><small>{tr("Kapasitas kapal belum terikat")}</small><strong>{fmt(remaining, 2)} <em>{tr("ton")}</em></strong></div></div>{totalT > remaining && <div className="notice error">{tr("Kebutuhan melebihi kapasitas kapal yang belum terikat. Sesuaikan kuantitas atau pilih kapal lain.")}</div>}<div className="modal-actions"><Button variant="secondary" onClick={onClose}>{tr("Batal")}</Button><Button type="submit" disabled={busy || !ships.length || !products.length || totalT > remaining} icon={ClipboardList}>{tr("Simpan permintaan")}</Button></div></form></Modal>;
}
function FleetBoard({
  trucks,
  trips,
  products,
  stockpiles,
  vessels,
  setModal
}) {
  const [filter, setFilter] = useState('all');
  return <Panel title={tr("Ketersediaan armada")} subtitle={tr("Truk tersedia setelah kembali. ETA mengikuti waktu siklus rencana; bukan posisi GPS.")} action={<div className="segmented small">{[['all', tr("Semua")], ['idle', tr("Idle")], ['active', tr("Aktif")]].map(([id, t]) => <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{t}</button>)}</div>}><div className="fleet-grid">{trucks.filter(t => {
        let active = t.status === 'busy' || !!t.activeTripId || trips.some(x => x.truckId === t.id && !['queued', 'returned'].includes(x.status));
        return filter === 'all' || (filter === 'active' ? active : !active);
      }).map(t => {
        let assigned = trips.filter(x => x.truckId === t.id && x.status !== 'returned'),
          active = assigned.find(x => x.status !== 'queued'),
          queued = assigned.filter(x => x.status === 'queued'),
          next = active || queued[0];
        return <button key={t.id} className={`fleet-card ${active ? 'active' : ''}`} onClick={() => setModal({
          type: 'truck',
          record: t
        })}><div className="fleet-card-top"><span className="truck-icon"><Truck size={25} /></span><Badge status={active?.status || (t.status === 'busy' ? 'in_progress' : t.active === false ? 'unavailable' : 'idle')} /></div><h3>{t.code}</h3><small>{t.plate} · {fmt(t.bedM3)}{tr(" m³ / ")}{fmt(t.payloadLimitT)}{tr(" t")}</small><div className="fleet-card-task">{next ? <><b>{lookup(products, next.skuId)?.code} → {lookup(vessels, next.vesselId)?.name}</b><span>{active ? tr("Ritase aktif") : tr("Penugasan berikutnya")} · {fmt(next.volumeM3, 1)}{tr(" m³")}</span></> : <span>{t.status === 'busy' ? tr("Bertugas pada lokasi lain") : t.active === false ? tr("Armada nonaktif") : tr("Tersedia untuk penugasan")}</span>}</div>{t.status === 'busy' && t.estimatedAvailableAt && <small className="fleet-eta">{tr("Estimasi tersedia ")}{stamp(t.estimatedAvailableAt)}</small>}<div className="fleet-card-bottom"><span><Clock3 size={13} />{t.queuedTrips ?? queued.length}{tr(" ritase antre")}</span><ChevronRight size={15} /></div></button>;
      })}</div>{!trucks.length && <Empty icon={Truck} title={tr("Belum ada armada")} />}</Panel>;
}
function TripTable({
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
  jettyMode = false
}) {
  const [status, setStatus] = useState(jettyMode ? 'receiving' : 'active');
  let filtered = trips.filter(t => status === 'all' || status === 'active' ? !['returned'].includes(t.status) || status === 'all' : status === 'receiving' ? ['in_transit', 'arrived', 'unloaded'].includes(t.status) : t.status === status);
  return <Panel title={jettyMode ? tr("Antrean penerimaan ritase") : tr("Ritase & penugasan")} subtitle={jettyMode ? tr("Konfirmasi tiba lalu bongkar pada kapal yang tercantum.") : tr("Muatan dan tujuan terikat ke dispatch; truk dapat memiliki beberapa tugas serial.")} action={<select aria-label={tr("Filter status ritase")} value={status} onChange={e => setStatus(e.target.value)}><option value="active">{tr("Belum selesai")}</option>{jettyMode && <option value="receiving">{tr("Penerimaan jetty")}</option>}<option value="queued">{tr("Antrean serial")}</option><option value="in_transit">{tr("Dalam perjalanan")}</option><option value="arrived">{tr("Tiba di jetty")}</option><option value="unloaded">{tr("Bongkar selesai")}</option><option value="returned">{tr("Kembali / selesai")}</option><option value="all">{tr("Semua status")}</option></select>}><DataTable headers={[tr("Ritase / truk"), tr("SKU & muatan"), tr("Stockpile asal"), tr("Jetty & kapal tujuan"), tr("Status"), tr("Aksi")]}>{filtered.map(t => <tr key={t.id}><td><button className="table-link" onClick={() => setModal({
            type: 'trip',
            record: t
          })}>{t.code}</button><small>{truck(t.truckId)?.code} · {truck(t.truckId)?.plate}</small></td><td><b>{product(t.skuId)?.code} · {fmt(t.volumeM3, 2)}{tr(" m³")}</b><small>{fmt(t.tonnageT, 2)}{tr(" ton")}</small></td><td>{stockpile(t.stockpileId)?.code}</td><td><b>{vessel(t.vesselId)?.name}</b><small>{jetty(t.jettyId)?.name}</small></td><td><Badge status={t.status} /></td><td><TripAction trip={t} {...{
            role,
            user,
            busy
          }} onClick={() => setModal({
            type: 'trip',
            record: t
          })} /></td></tr>)}</DataTable>{!filtered.length && <Empty icon={Truck} title={tr("Tidak ada ritase pada status ini")} text={tr("Penugasan muncul setelah permintaan transfer direncanakan.")} />}</Panel>;
}
function tripAction(t, role, user) {
  const stock = role === 'admin' || role === 'stock' && (!user.crusherIds?.length || user.crusherIds.includes(t.crusherId));
  const jet = role === 'admin' || role === 'jetty' && (!user.jettyIds?.length || user.jettyIds.includes(t.jettyId));
  if (t.status === 'queued' && stock) return ['trip.start', tr("Mulai muat")];
  if (t.status === 'loading' && stock) return ['trip.depart', tr("Konfirmasi berangkat")];
  if (t.status === 'in_transit' && jet) return ['trip.arrive', tr("Konfirmasi tiba")];
  if (t.status === 'arrived' && jet) return ['trip.unload', tr("Konfirmasi bongkar")];
  if (t.status === 'unloaded' && (stock || jet)) return ['trip.return', tr("Truk kembali")];
  return null;
}
function TripAction({
  trip,
  role,
  user,
  busy,
  onClick
}) {
  const a = tripAction(trip, role, user);
  return <button className={`text-btn ${a ? '' : 'muted'}`} disabled={busy} onClick={onClick}>{a?.[1] || tr("Lihat detail")} <ChevronRight size={14} /></button>;
}
function TripDetail({
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
function RequestDetail({
  request,
  products,
  trips,
  dispatches,
  truck,
  stockpile,
  vessel,
  jetty,
  onClose
}) {
  let these = trips.filter(t => t.requestId === request.id),
    done = these.filter(t => ['unloaded', 'returned'].includes(t.status)),
    target = sum(request.lines, "tonnageT");
  return <Modal wide title={tr("Permintaan {0}", request.code)} subtitle={tr("{0} → {1} · {2}", jetty(request.jettyId)?.name, vessel(request.vesselId)?.name, request.destination)} onClose={onClose}><div className="detail-status"><Badge status={request.status} /><span>{done.length}{tr(" dari ")}{these.length}{tr(" ritase dibongkar")}</span></div><RequestLines request={request} products={products} /><div className="request-summary"><div><small>{tr("Tonase permintaan")}</small><strong>{fmt(target, 2)} <em>{tr("ton")}</em></strong></div><div><small>{tr("Telah dibongkar")}</small><strong>{fmt(sum(done, "tonnageT"), 2)} <em>{tr("ton")}</em></strong></div><div><small>{tr("Remaining transfer")}</small><strong>{fmt(Math.max(0, target - sum(done, "tonnageT")), 2)} <em>{tr("ton")}</em></strong></div></div><ProgressBar value={sum(done, "tonnageT")} max={target} /><h3 className="detail-section-title">{tr("Alokasi & ritase")}</h3><DataTable headers={[tr("Ritase / truk"), tr("Asal stockpile"), tr("Volume"), tr("Status")]}>{these.map(t => <tr key={t.id}><td><b>{t.code}</b><small>{truck(t.truckId)?.code}</small></td><td>{stockpile(t.stockpileId)?.code}</td><td>{fmt(t.volumeM3, 2)}{tr(" m³ / ")}{fmt(t.tonnageT, 2)}{tr(" t")}</td><td><Badge status={t.status} /></td></tr>)}</DataTable>{!these.length && <Empty icon={Send} title={tr("Belum direncanakan")} text={tr("Admin dapat membuat alokasi otomatis setelah stok dan kapasitas kapal tersedia.")} />}<div className="modal-actions"><Button variant="secondary" onClick={onClose}>{tr("Tutup")}</Button></div></Modal>;
}
function TruckDetail({
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
function MeasurementModal({
  scopeStock,
  products,
  crushers,
  busy,
  csrf,
  notify,
  initial,
  onClose,
  onSubmit
}) {
  const [stockpileId, setStockpile] = useState(initial.stockpileId || scopeStock[0]?.id || ''),
    [method, setMethod] = useState('camera_pending'),
    [confirmedSku, setConfirmedSku] = useState(''),
    [volumeM3, setVolume] = useState(''),
    [geometry, setGeometry] = useState({
      lengthM: '',
      widthM: '',
      heightM: '',
      shapeFactor: '0.5'
    }),
    [notes, setNotes] = useState(''),
    [photo, setPhoto] = useState(null),
    [photoName, setPhotoName] = useState(''),
    [camera, setCamera] = useState(false),
    [cameraError, setCameraError] = useState(''),
    [saving, setSaving] = useState(false),
    [uploaded, setUploaded] = useState(null),
    [error, setError] = useState('');
  const stream = useRef(null),
    video = useRef(null),
    file = useRef(null);
  const selected = lookup(scopeStock, stockpileId),
    p = lookup(products, selected?.skuId),
    c = lookup(crushers, selected?.crusherId);
  const estimated = number(geometry.lengthM) * number(geometry.widthM) * number(geometry.heightM) * number(geometry.shapeFactor);
  const stopCamera = () => {
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    setCamera(false);
  };
  useEffect(() => () => {
    stream.current?.getTracks().forEach(t => t.stop());
  }, []);
  useEffect(() => {
    if (camera && video.current && stream.current) {
      video.current.srcObject = stream.current;
      video.current.play().catch(() => {});
    }
  }, [camera]);
  const openCamera = async () => {
    setCameraError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kamera browser memerlukan HTTPS dan perangkat yang mendukung.');
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: {
            ideal: 'environment'
          },
          width: {
            ideal: 1280
          },
          height: {
            ideal: 720
          }
        },
        audio: false
      });
      setCamera(true);
    } catch (e) {
      setCameraError(e.name === 'NotAllowedError' ? 'Izin kamera belum diberikan. Izinkan kamera di browser atau unggah foto.' : e.message);
    }
  };
  const takePhoto = () => {
    const v = video.current;
    if (!v?.videoWidth) return;
    const cn = document.createElement('canvas'),
      scale = Math.min(1, 1280 / v.videoWidth);
    cn.width = v.videoWidth * scale;
    cn.height = v.videoHeight * scale;
    cn.getContext('2d').drawImage(v, 0, 0, cn.width, cn.height);
    setPhoto(cn.toDataURL('image/jpeg', 0.82));
    setPhotoName(`stockpile-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
    setUploaded(null);
    stopCamera();
  };
  const selectPhoto = async e => {
    let f = e.target.files?.[0];
    if (!f) return;
    setError('');
    if (!['image/jpeg', 'image/png'].includes(f.type)) {
      setError('Gunakan foto JPG atau PNG.');
      return;
    }
    if (f.size > 2 * 1024 * 1024) {
      setError('Ukuran foto maksimal 2 MB.');
      return;
    }
    let r = new FileReader();
    r.onload = () => {
      setPhoto(String(r.result));
      setPhotoName(f.name);
      setUploaded(null);
    };
    r.readAsDataURL(f);
  };
  const submit = async e => {
    e.preventDefault();
    setError('');
    if (confirmedSku !== selected?.skuId) {
      setError('SKU yang dikonfirmasi harus sesuai dengan stockpile dan ukuran material.');
      return;
    }
    if (method === 'camera_pending' && !photo) {
      setError('Ambil atau unggah foto untuk menyimpan bukti kamera.');
      return;
    }
    setSaving(true);
    try {
      let evidence = uploaded;
      if (photo && !evidence) {
        evidence = await api('/api/evidence', {
          method: 'POST',
          headers: {
            'X-CSRF-Token': csrf
          },
          body: JSON.stringify({
            dataUrl: photo,
            name: photoName
          })
        });
        setUploaded(evidence);
      }
      const payload = {
        stockpileId,
        skuId: selected.skuId,
        method,
        notes,
        evidenceId: evidence?.id,
        evidenceName: photoName || undefined
      };
      if (method === 'manual') payload.volumeM3 = number(volumeM3);
      if (method === 'calibrated_geometry') {
        payload.geometry = Object.fromEntries(Object.entries(geometry).map(([k, v]) => [k, number(v)]));
        payload.volumeM3 = estimated;
      }
      await onSubmit(payload);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };
  return <Modal wide title={tr("Pengukuran & kamera stockpile")} subtitle={tr("Pilih lokasi dan SKU. Bukti kamera dan hasil ukur selalu memiliki sumber yang jelas.")} onClose={() => {
    stopCamera();
    onClose();
  }}><form onSubmit={submit}><div className="measurement-layout"><div className="camera-column"><div className={`camera-preview ${photo || camera ? 'has-image' : ''}`}>{camera ? <video ref={video} playsInline muted autoPlay /> : photo ? <img src={photo} alt={tr("Foto stockpile yang dipilih operator")} /> : <><Camera size={39} /><strong>{tr("Foto stockpile")}</strong><p>{tr("Ambil bukti kondisi stockpile")}<br />{tr("dengan kamera perangkat Anda.")}</p></>}<span className="camera-chip"><span />{camera ? tr("Kamera perangkat aktif") : photo ? tr("Foto dari operator") : tr("Belum ada kamera terhubung")}</span></div><div className="camera-actions">{camera ? <><Button icon={Camera} onClick={takePhoto}>{tr("Ambil foto")}</Button><Button variant="secondary" onClick={stopCamera}>{tr("Matikan")}</Button></> : <><Button variant="secondary" icon={Camera} onClick={openCamera}>{tr("Buka kamera")}</Button><Button variant="secondary" icon={Upload} onClick={() => file.current?.click()}>{tr("Unggah foto")}</Button></>}<input ref={file} type="file" accept="image/jpeg,image/png" capture="environment" hidden onChange={selectPhoto} /></div>{photoName && <p className="photo-name"><CheckCircle2 size={14} />{photoName}</p>}{cameraError && <p className="form-error" role="alert">{tr(cameraError)}</p>}<div className="camera-disclaimer"><ShieldCheck size={17} /><p><b>{tr("Pengukuran kamera 3D belum terhubung.")}</b>{tr(" Foto atau video tanpa skala / data kedalaman tidak cukup untuk mengukur m³. Rekonstruksi fotogrametri atau LiDAR memerlukan integrasi dan kalibrasi lapangan.")}</p></div></div><div className="measurement-form"><Field label={tr("Stockpile / sumber crusher")}><select required value={stockpileId} onChange={e => {
              setStockpile(e.target.value);
              setConfirmedSku('');
            }}>{scopeStock.map(s => <option key={s.id} value={s.id}>{s.code} · {lookup(crushers, s.crusherId)?.name}</option>)}</select></Field><Field label={tr("Konfirmasi SKU material yang diukur")}><select required value={confirmedSku} onChange={e => setConfirmedSku(e.target.value)}><option value="">{tr("Pilih SKU sesuai ukuran batu…")}</option>{products.filter(x => x.active !== false).map(x => <option key={x.id} value={x.id}>{x.code} · {x.name} ({x.sizeMm})</option>)}</select></Field><div className="sku-context"><span className="sku-context-icon"><Package size={22} /></span><div><small>{tr("SKU sesuai master Admin")}</small><b>{p?.code} · {p?.name}</b><small>{tr("Ukuran ")}{p?.sizeMm}{tr(" · berat jenis ")}{fmt(p?.densityTPerM3, 2)}{tr(" t/m³")}</small></div></div><Field label={tr("Metode pencatatan")}><select value={method} onChange={e => setMethod(e.target.value)}><option value="camera_pending">{tr("Bukti kamera — menunggu pengukuran")}</option><option value="manual">{tr("Hasil survei lapangan (m³)")}</option><option value="calibrated_geometry">{tr("Estimasi geometri terkalibrasi")}</option></select></Field>{method === 'manual' && <Field label={tr("Volume hasil survei (m³)")} hint={tr("Isi hasil ukur lapangan yang dapat ditelusuri, bukan perkiraan dari foto tunggal.")}><input required type="number" min="0" max="10000000" step="0.01" value={volumeM3} onChange={e => setVolume(e.target.value)} placeholder={tr("0,00")} /></Field>}{method === 'calibrated_geometry' && <><div className="notice compact">{tr("Ukuran nyata diukur di lapangan. V = panjang × lebar × tinggi × faktor bentuk. Hasil berupa estimasi, bukan keluaran AI.")}</div><div className="form-grid two">{[["lengthM", tr("Panjang (m)")], ["widthM", tr("Lebar (m)")], ["heightM", tr("Tinggi (m)")], ["shapeFactor", tr("Faktor bentuk (0–1)")]].map(([key, label]) => <Field key={key} label={label}><input required type="number" min={key === 'shapeFactor' ? '0.01' : '0.01'} max={key === 'shapeFactor' ? '1' : '10000'} step="0.01" value={geometry[key]} onChange={e => setGeometry({
                  ...geometry,
                  [key]: e.target.value
                })} /></Field>)}</div><div className="measurement-result"><small>{tr("Estimasi volume geometri")}</small><strong>{fmt(estimated, 2)} <em>{tr("m³")}</em></strong><span>≈ {fmt(estimated * number(p?.densityTPerM3), 2)}{tr(" ton · belum masuk stok")}</span></div></>}{method === 'camera_pending' && <div className="notice compact"><Camera size={17} /><span>{tr("Hanya bukti foto yang disimpan. Volume dan stok tidak berubah sampai pengukuran terkalibrasi dicatat dan disetujui.")}</span></div>}<Field label={tr("Catatan / referensi kalibrasi")}><textarea rows={3} maxLength={500} required={method !== 'camera_pending'} value={notes} onChange={e => setNotes(e.target.value)} placeholder={method === 'calibrated_geometry' ? tr("Sumber ukuran, alat ukur, geometri tumpukan, tanggal kalibrasi…") : tr("Nomor survei, kondisi stockpile, atau catatan operator…")} /></Field></div></div>{error && <div className="form-error" role="alert">{tr(error)}</div>}<div className="modal-actions"><span className="modal-footnote">{tr("Hasil ukur menunggu persetujuan Admin.")}</span><Button variant="secondary" onClick={() => {
          stopCamera();
          onClose();
        }}>{tr("Batal")}</Button><Button type="submit" disabled={busy || saving || !selected} icon={saving ? Loader2 : ClipboardCheck}>{saving ? tr("Menyimpan…") : tr("Simpan untuk ditinjau")}</Button></div></form></Modal>;
}
function MasterData({
  products,
  crushers,
  stockpiles,
  trucks,
  jetties,
  vessels,
  setModal,
  csrf,
  notify
}) {
  const [tab, setTab] = useState('product');
  const definitions = [['product', tr("Produk / SKU"), Package], ['crusher', tr("Crusher"), Factory], ['stockpile', tr("Stockpile"), Layers3], ['truck', tr("Armada"), Truck], ['jetty', tr("Jetty"), MapPin], ['vessel', tr("Kapal"), Ship], ['user', tr("Akun pengguna"), Users]];
  return <><div className="tabs">{definitions.map(([id, label, Icon]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}</div>{tab === 'user' ? <UserManagement {...{
      crushers,
      jetties,
      csrf,
      notify
    }} /> : <Panel title={definitions.find(x => x[0] === tab)?.[1]} subtitle={tab === 'crusher' ? tr("Setiap crusher dapat dipetakan hingga 6 SKU melalui master stockpile.") : tab === 'vessel' ? tr("Tetapkan batas kargo aman terpisah dari DWT katalog dan status loading / menunggu.") : tr("Data ini menjadi acuan input operator dan perencanaan dispatch.")} action={<Button icon={Plus} onClick={() => setModal({
      type: 'master',
      entity: tab
    })}>{tr("Tambah ")}{definitions.find(x => x[0] === tab)?.[1]}</Button>}>
 {tab === 'product' && <DataTable headers={[tr("Kode SKU"), tr("Nama produk"), tr("Ukuran batu"), tr("Berat jenis"), tr("Status"), tr("Aksi")]}>{products.map(p => <tr key={p.id}><td><b>{p.code}</b></td><td>{p.name}</td><td>{p.sizeMm}</td><td>{fmt(p.densityTPerM3, 2)}{tr(" t/m³")}</td><td><Badge tone={p.active !== false ? 'green' : 'neutral'}>{p.active !== false ? tr("Aktif") : tr("Nonaktif")}</Badge></td><td><button className="text-btn" onClick={() => setModal({
              type: 'master',
              entity: tab,
              record: p
            })}>{tr("Edit ")}<ChevronRight size={14} /></button></td></tr>)}</DataTable>}
 {tab === 'crusher' && <DataTable headers={[tr("Kode crusher"), tr("Nama"), tr("SKU terpetakan"), tr("Lokasi stockpile"), tr("Status"), tr("Aksi")]}>{crushers.map(c => <tr key={c.id}><td><b>{c.code}</b></td><td>{c.name}</td><td>{new Set(stockpiles.filter(s => s.crusherId === c.id).map(s => s.skuId)).size}{tr(" / 6 SKU")}</td><td>{stockpiles.filter(s => s.crusherId === c.id).length}{tr(" stockpile")}</td><td><Badge tone={c.active !== false ? 'green' : 'neutral'}>{c.active !== false ? tr("Aktif") : tr("Nonaktif")}</Badge></td><td><button className="text-btn" onClick={() => setModal({
              type: 'master',
              entity: tab,
              record: c
            })}>{tr("Edit ")}<ChevronRight size={14} /></button></td></tr>)}</DataTable>}
 {tab === 'stockpile' && <DataTable headers={[tr("Kode stockpile"), tr("Crusher"), tr("Produk / SKU"), tr("Stok fisik"), tr("Reservasi"), tr("Aksi")]}>{stockpiles.map(s => <tr key={s.id}><td><b>{s.code}</b></td><td>{lookup(crushers, s.crusherId)?.name}</td><td>{lookup(products, s.skuId)?.code}</td><td>{fmt(s.onHandM3, 2)}{tr(" m³")}</td><td>{fmt(s.reservedM3, 2)}{tr(" m³")}</td><td><button className="text-btn" onClick={() => setModal({
              type: 'master',
              entity: tab,
              record: s
            })}>{tr("Edit ")}<ChevronRight size={14} /></button></td></tr>)}</DataTable>}
 {tab === 'truck' && <DataTable headers={[tr("Kode truk"), tr("Nomor polisi"), tr("Volume bak"), tr("Batas payload"), tr("Siklus rencana"), tr("Aksi")]}>{trucks.map(t => <tr key={t.id}><td><b>{t.code}</b></td><td>{t.plate}</td><td>{fmt(t.bedM3)}{tr(" m³")}</td><td>{fmt(t.payloadLimitT)}{tr(" ton")}</td><td>{fmt(t.cycleMinutes)}{tr(" menit")}</td><td><button className="text-btn" onClick={() => setModal({
              type: 'master',
              entity: tab,
              record: t
            })}>{tr("Edit ")}<ChevronRight size={14} /></button></td></tr>)}</DataTable>}
 {tab === 'jetty' && <DataTable headers={[tr("Kode jetty"), tr("Nama"), tr("Kapal terdaftar"), tr("Status"), tr("Aksi")]}>{jetties.map(j => <tr key={j.id}><td><b>{j.code}</b></td><td>{j.name}</td><td>{vessels.filter(v => v.jettyId === j.id).length}{tr(" kapal")}</td><td><Badge tone={j.active !== false ? 'green' : 'neutral'}>{j.active !== false ? tr("Aktif") : tr("Nonaktif")}</Badge></td><td><button className="text-btn" onClick={() => setModal({
              type: 'master',
              entity: tab,
              record: j
            })}>{tr("Edit ")}<ChevronRight size={14} /></button></td></tr>)}</DataTable>}
 {tab === 'vessel' && <DataTable headers={[tr("Kapal"), tr("Jetty"), tr("Batas kargo aman"), tr("Muat / reservasi"), tr("Status"), tr("Aksi")]}>{vessels.map(v => <tr key={v.id}><td><b>{v.name}</b><small>{v.code}</small></td><td>{lookup(jetties, v.jettyId)?.name}</td><td>{fmt(v.payloadLimitT)}{tr(" ton")}</td><td>{fmt(v.loadedT)} / {fmt(v.reservedT)}{tr(" ton")}</td><td><Badge status={v.status}>{v.status === 'loading' ? tr("Sedang loading") : statusText[v.status] || v.status}</Badge></td><td><button className="text-btn" onClick={() => setModal({
              type: 'master',
              entity: tab,
              record: v
            })}>{tr("Edit ")}<ChevronRight size={14} /></button></td></tr>)}</DataTable>}
 </Panel>}<div className="notice"><ShieldCheck size={18} /><span>{tr("Density mengonversi m³ ↔ ton untuk perencanaan. Volume bak dan payload adalah batas yang terpisah. Kuantitas aktual memerlukan validasi alat ukur di lapangan.")}</span></div></>;
}
function MasterModal({
  entity,
  record,
  products,
  crushers,
  jetties,
  busy,
  onClose,
  onSubmit
}) {
  const defaults = {
    product: {
      code: '',
      name: '',
      sizeMm: '',
      densityTPerM3: '1.5',
      active: true
    },
    crusher: {
      code: '',
      name: '',
      active: true
    },
    stockpile: {
      code: '',
      crusherId: crushers[0]?.id,
      skuId: products[0]?.id,
      onHandM3: 0,
      active: true
    },
    truck: {
      code: '',
      plate: '',
      bedM3: 30,
      payloadLimitT: 45,
      cycleMinutes: 30,
      active: true
    },
    jetty: {
      code: '',
      name: '',
      active: true
    },
    vessel: {
      code: '',
      name: '',
      jettyId: jetties[0]?.id,
      payloadLimitT: 7500,
      status: 'waiting'
    }
  };
  const [form, setForm] = useState({
    ...defaults[entity],
    ...record
  });
  const labels = {
    product: tr("Produk / SKU"),
    crusher: tr("Crusher"),
    stockpile: tr("Stockpile"),
    truck: tr("Armada truk"),
    jetty: tr("Jetty"),
    vessel: tr("Kapal / tongkang")
  };
  const set = (k, v) => setForm({
    ...form,
    [k]: v
  });
  const common = (key, label, type = 'text', extra = {}) => <Field key={key} label={label}><input required type={type} value={form[key] ?? ''} onChange={e => set(key, type === 'number' ? e.target.value : e.target.value)} maxLength={type === 'text' ? 100 : undefined} {...extra} /></Field>;
  const submit = e => {
    e.preventDefault();
    let payload = {
      ...form
    };
    ["densityTPerM3", "onHandM3", "bedM3", "payloadLimitT", "cycleMinutes"].forEach(k => {
      if (k in payload) payload[k] = number(payload[k]);
    });
    onSubmit(entity, payload);
  };
  return <Modal title={tr("{0} {1}", record ? tr("Edit") : tr("Tambah"), labels[entity])} subtitle={tr("Perubahan master menjadi acuan bersama Admin dan operator.")} onClose={onClose}><form onSubmit={submit}><div className="form-grid two">{common('code', tr("Kode {0}", labels[entity]))}{['product', 'crusher', 'jetty', 'vessel'].includes(entity) && common('name', tr("Nama"))}{entity === 'product' && <>{common("sizeMm", tr("Ukuran batu (mm / rentang)"))}{common("densityTPerM3", tr("Berat jenis (t/m³)"), 'number', {
            min: 0.01,
            max: 5,
            step: 0.01
          })}</>}{entity === 'stockpile' && <><Field label={tr("Crusher sumber")}><select required value={form.crusherId} onChange={e => set("crusherId", e.target.value)}>{crushers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label={tr("Produk / SKU")}><select required value={form.skuId} onChange={e => set("skuId", e.target.value)}>{products.map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></Field>{common("onHandM3", tr("Stok fisik awal / tercatat (m³)"), 'number', {
            min: 0,
            max: 10000000,
            step: 0.01,
            readOnly: !!record
          })}</>}{entity === 'truck' && <>{common('plate', tr("Nomor polisi"))}{common("bedM3", tr("Volume bak (m³)"), 'number', {
            min: 1,
            max: 100,
            step: 0.1
          })}{common("payloadLimitT", tr("Batas payload (ton)"), 'number', {
            min: 1,
            max: 200,
            step: 0.1
          })}{common("cycleMinutes", tr("Siklus rencana (menit)"), 'number', {
            min: 1,
            max: 1440,
            step: 1
          })}</>}{entity === 'vessel' && <><Field label={tr("Jetty penempatan")}><select required value={form.jettyId} onChange={e => set("jettyId", e.target.value)}>{jetties.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}</select></Field>{common("payloadLimitT", tr("Batas kargo aman (ton)"), 'number', {
            min: 1,
            max: 100000,
            step: 0.1
          })}<Field label={tr("Status kapal")}><select value={form.status} onChange={e => set('status', e.target.value)}><option value="waiting">{tr("Menunggu loading")}</option><option value="loading">{tr("Sedang loading")}</option><option value="closed">{tr("Ditutup")}</option></select></Field></>}{entity !== 'vessel' && <Field label={tr("Status master")}><select value={form.active !== false ? 'true' : 'false'} onChange={e => set('active', e.target.value === 'true')}><option value="true">{tr("Aktif")}</option><option value="false">{tr("Nonaktif")}</option></select></Field>}</div>{entity === 'vessel' && <div className="notice compact">{tr("Isi batas kargo material yang disetujui operator kapal. DWT katalog bukan kapasitas material otomatis. Kapal yang menunggu tidak dapat menerima konfirmasi bongkar.")}</div>}{entity === 'stockpile' && <div className="notice compact">{tr("Satu stockpile terkait satu SKU. Setiap crusher dibatasi hingga enam SKU unik. Perubahan stok tetap harus melindungi reservasi.")}</div>}<div className="modal-actions"><Button variant="secondary" onClick={onClose}>{tr("Batal")}</Button><Button type="submit" disabled={busy} icon={Check}>{tr("Simpan master")}</Button></div></form></Modal>;
}
function UserManagement({
  crushers,
  jetties,
  csrf,
  notify
}) {
  const [users, setUsers] = useState([]),
    [loading, setLoading] = useState(true),
    [adding, setAdding] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [form, setForm] = useState({
      username: '',
      displayName: '',
      password: '',
      role: 'stock',
      crusherIds: [],
      jettyIds: []
    });
  const load = () => api('/api/users').then(d => setUsers(d.users || [])).catch(e => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);
  const submit = async e => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/users', {
        method: 'POST',
        headers: {
          'X-CSRF-Token': csrf
        },
        body: JSON.stringify(form)
      });
      setAdding(false);
      setForm({
        username: '',
        displayName: '',
        password: '',
        role: 'stock',
        crusherIds: [],
        jettyIds: []
      });
      await load();
      notify('Akun operator berhasil dibuat.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return <Panel title={tr("Akun & kewenangan operator")} subtitle={tr("Akun memiliki peran dan cakupan crusher / jetty. Password tidak ditampilkan kembali.")} action={<Button icon={Plus} onClick={() => setAdding(true)}>{tr("Buat akun")}</Button>}>{error && !adding && <div className="form-error">{tr(error)}</div>}<DataTable headers={[tr("Nama pengguna"), tr("Username"), tr("Peran"), tr("Cakupan lokasi"), tr("Status")]}>{users.map(u => <tr key={u.id}><td><b>{u.displayName || u.name}</b></td><td>{u.username}</td><td>{roleName[u.role]}</td><td>{u.role === 'admin' ? tr("Semua lokasi") : u.role === 'stock' ? (u.crusherIds || []).map(id => lookup(crushers, id)?.name || id).join(', ') : (u.jettyIds || []).map(id => lookup(jetties, id)?.name || id).join(', ')}</td><td><Badge tone={u.active !== false ? 'green' : 'neutral'}>{u.active !== false ? tr("Aktif") : tr("Nonaktif")}</Badge></td></tr>)}</DataTable>{loading && <div className="inline-loading"><Loader2 className="spin" size={17} />{tr("Mengambil akun…")}</div>}{adding && <Modal title={tr("Buat akun pengguna")} subtitle={tr("Berikan password melalui saluran pribadi kepada pemilik akun.")} onClose={() => setAdding(false)}><form onSubmit={submit}><div className="form-grid two"><Field label={tr("Username")}><input required autoComplete="off" pattern="[a-zA-Z0-9._@-]+" value={form.username} onChange={e => setForm({
              ...form,
              username: e.target.value
            })} /></Field><Field label={tr("Nama tampilan")}><input required value={form.displayName} onChange={e => setForm({
              ...form,
              displayName: e.target.value
            })} /></Field><Field label={tr("Password")} hint={tr("Minimal 12 karakter.")}><input required autoComplete="new-password" type="password" minLength={12} value={form.password} onChange={e => setForm({
              ...form,
              password: e.target.value
            })} /></Field><Field label={tr("Peran")}><select value={form.role} onChange={e => setForm({
              ...form,
              role: e.target.value,
              crusherIds: [],
              jettyIds: []
            })}><option value="stock">{tr("Operator stockpile")}</option><option value="jetty">{tr("Operator jetty")}</option><option value="admin">{tr("Administrator")}</option></select></Field></div>{form.role !== 'admin' && <fieldset className="scope-checks"><legend>{tr("Cakupan ")}{form.role === 'stock' ? 'crusher' : 'jetty'}</legend>{(form.role === 'stock' ? crushers : jetties).map(row => {
            const key = form.role === 'stock' ? "crusherIds" : "jettyIds";
            return <label key={row.id}><input type="checkbox" checked={form[key].includes(row.id)} onChange={e => setForm({
                ...form,
                [key]: e.target.checked ? [...form[key], row.id] : form[key].filter(id => id !== row.id)
              })} />{row.name}</label>;
          })}</fieldset>}{error && <div className="form-error" role="alert">{tr(error)}</div>}<div className="modal-actions"><Button variant="secondary" onClick={() => setAdding(false)}>{tr("Batal")}</Button><Button type="submit" disabled={busy || form.role === 'stock' && !form.crusherIds.length || form.role === 'jetty' && !form.jettyIds.length} icon={Users}>{tr("Buat akun")}</Button></div></form></Modal>}</Panel>;
}
