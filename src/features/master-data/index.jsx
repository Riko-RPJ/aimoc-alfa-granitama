import React, { useState, useEffect, useMemo, useRef } from 'react';
import { tr, localize, locale, useLanguage, setLanguage, eventText, eventTypeLabel } from '../../i18n.js';
import { statusText } from '../../domain/legacy-status.js';
import { api } from '../../services/legacy-api.js';
import { Check, ChevronRight, Factory, Layers3, Loader2, MapPin, Package, Plus, ShieldCheck, Ship, Trash2, Truck, Users, X } from 'lucide-react';
import { fmt, number, lookup, roleName } from '../shared/legacy-utils.js';
import { Badge, Button, Field, Modal, Panel, DataTable } from '../../components/ui/index.jsx';
import {CrusherLocationMaster} from './CrusherLocationMaster.jsx';

export function MasterData({
  products,
  crushers,
  stockpiles,
  trucks,
  jetties,
  vessels,
  setModal,
  csrf,
  notify,
  onDelete
}) {
  const [tab, setTab] = useState('product');
  const definitions = [['product', tr("Produk / SKU"), Package], ['crusher', tr("Crusher"), Factory], ['crusher-location','Crusher Locations',MapPin], ['stockpile', tr("Stockpile"), Layers3], ['truck', tr("Armada"), Truck], ['jetty', tr("Jetty"), MapPin], ['vessel', tr("Kapal"), Ship], ['user', tr("Akun pengguna"), Users]];
  const actions = record => <div className="row-actions"><button className="text-btn" onClick={() => setModal({type:'master',entity:tab,record})}>{tr("Edit ")}<ChevronRight size={14}/></button><button className="text-btn danger" onClick={() => window.confirm(tr("Hapus master {0}? Tindakan ini tidak dapat dibatalkan.",record.code||record.name)) && onDelete(tab,record.id)}><Trash2 size={13}/>{tr("Hapus")}</button></div>;
  return <><div className="tabs">{definitions.map(([id, label, Icon]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}</div>{tab === 'crusher-location' ? <CrusherLocationMaster crushers={crushers} csrf={csrf} notify={notify}/> : tab === 'user' ? <UserManagement {...{
      crushers,
      jetties,
      csrf,
      notify
    }} /> : <Panel title={definitions.find(x => x[0] === tab)?.[1]} subtitle={tab === 'crusher' ? tr("Setiap crusher dapat dipetakan hingga 6 SKU melalui master stockpile.") : tab === 'vessel' ? tr("Tetapkan batas kargo aman terpisah dari DWT katalog dan status loading / menunggu.") : tr("Data ini menjadi acuan input operator dan perencanaan dispatch.")} action={<Button icon={Plus} onClick={() => setModal({
      type: 'master',
      entity: tab
    })}>{tr("Tambah ")}{definitions.find(x => x[0] === tab)?.[1]}</Button>}>
 {tab === 'product' && <DataTable headers={[tr("Kode SKU"), tr("Nama produk"), tr("Ukuran batu"), tr("Berat jenis"), tr("Status"), tr("Aksi")]}>{products.map(p => <tr key={p.id}><td><b>{p.code}</b></td><td>{p.name}</td><td>{p.sizeMm}</td><td>{fmt(p.densityTPerM3, 2)}{tr(" t/m³")}</td><td><Badge tone={p.active !== false ? 'green' : 'neutral'}>{p.active !== false ? tr("Aktif") : tr("Nonaktif")}</Badge></td><td>{actions(p)}</td></tr>)}</DataTable>}
 {tab === 'crusher' && <DataTable headers={[tr("Kode crusher"), tr("Nama"), tr("SKU terpetakan"), tr("Lokasi stockpile"), tr("Status"), tr("Aksi")]}>{crushers.map(c => <tr key={c.id}><td><b>{c.code}</b></td><td>{c.name}</td><td>{new Set(stockpiles.filter(s => s.crusherId === c.id).map(s => s.skuId)).size}{tr(" / 6 SKU")}</td><td>{stockpiles.filter(s => s.crusherId === c.id).length}{tr(" stockpile")}</td><td><Badge tone={c.active !== false ? 'green' : 'neutral'}>{c.active !== false ? tr("Aktif") : tr("Nonaktif")}</Badge></td><td>{actions(c)}</td></tr>)}</DataTable>}
 {tab === 'stockpile' && <DataTable headers={[tr("Kode stockpile"), tr("Crusher"), tr("Produk / SKU"), tr("Stok fisik"), tr("Reservasi"), tr("Aksi")]}>{stockpiles.map(s => <tr key={s.id}><td><b>{s.code}</b></td><td>{lookup(crushers, s.crusherId)?.name}</td><td>{lookup(products, s.skuId)?.code}</td><td>{fmt(s.onHandM3, 2)}{tr(" m³")}</td><td>{fmt(s.reservedM3, 2)}{tr(" m³")}</td><td>{actions(s)}</td></tr>)}</DataTable>}
 {tab === 'truck' && <DataTable headers={[tr("Kode truk"), tr("Nomor polisi"), tr("Volume bak"), tr("Batas payload"), tr("Siklus rencana"), tr("Aksi")]}>{trucks.map(t => <tr key={t.id}><td><b>{t.code}</b></td><td>{t.plate}</td><td>{fmt(t.bedM3)}{tr(" m³")}</td><td>{fmt(t.payloadLimitT)}{tr(" ton")}</td><td>{fmt(t.cycleMinutes)}{tr(" menit")}</td><td>{actions(t)}</td></tr>)}</DataTable>}
 {tab === 'jetty' && <DataTable headers={[tr("Kode jetty"), tr("Nama"), tr("Kapal terdaftar"), tr("Status"), tr("Aksi")]}>{jetties.map(j => <tr key={j.id}><td><b>{j.code}</b></td><td>{j.name}</td><td>{vessels.filter(v => v.jettyId === j.id).length}{tr(" kapal")}</td><td><Badge tone={j.active !== false ? 'green' : 'neutral'}>{j.active !== false ? tr("Aktif") : tr("Nonaktif")}</Badge></td><td>{actions(j)}</td></tr>)}</DataTable>}
 {tab === 'vessel' && <DataTable headers={[tr("Kapal"), tr("Jetty"), tr("Batas kargo aman"), tr("Muat / reservasi"), tr("Status"), tr("Aksi")]}>{vessels.map(v => <tr key={v.id}><td><b>{v.name}</b><small>{v.code}</small></td><td>{lookup(jetties, v.jettyId)?.name}</td><td>{fmt(v.payloadLimitT)}{tr(" ton")}</td><td>{fmt(v.loadedT)} / {fmt(v.reservedT)}{tr(" ton")}</td><td><Badge status={v.status}>{v.status === 'loading' ? tr("Sedang loading") : statusText[v.status] || v.status}</Badge></td><td>{actions(v)}</td></tr>)}</DataTable>}
 </Panel>}<div className="notice"><ShieldCheck size={18} /><span>{tr("Density mengonversi m³ ↔ ton untuk perencanaan. Volume bak dan payload adalah batas yang terpisah. Kuantitas aktual memerlukan validasi alat ukur di lapangan.")}</span></div></>;
}

export function MasterModal({
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

export function UserManagement({
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
  return <Panel title={tr("Akun & kewenangan operator")} subtitle={tr("Akun memiliki peran dan cakupan crusher / jetty. Password tidak ditampilkan kembali.")} action={<Button icon={Plus} onClick={() => setAdding(true)}>{tr("Buat akun")}</Button>}>{error && !adding && <div className="form-error">{tr(error)}</div>}<DataTable headers={[tr("Nama pengguna"), tr("Username"), tr("Peran"), tr("Cakupan lokasi"), tr("Status")]}>{users.map(u => <tr key={u.id}><td><b>{u.displayName || u.name}</b></td><td>{u.username}</td><td>{roleName[u.role]||u.role}</td><td>{u.role === 'admin' ? tr("Semua lokasi") : u.role === 'driver' ? tr("Sesuai penugasan ritase") : u.role === 'stock' ? (u.crusherIds || []).map(id => lookup(crushers, id)?.name || id).join(', ') : (u.jettyIds || []).map(id => lookup(jetties, id)?.name || id).join(', ')}</td><td><Badge tone={u.active !== false ? 'green' : 'neutral'}>{u.active !== false ? tr("Aktif") : tr("Nonaktif")}</Badge></td></tr>)}</DataTable>{loading && <div className="inline-loading"><Loader2 className="spin" size={17} />{tr("Mengambil akun…")}</div>}{adding && <Modal title={tr("Buat akun pengguna")} subtitle={tr("Berikan password melalui saluran pribadi kepada pemilik akun.")} onClose={() => setAdding(false)}><form onSubmit={submit}><div className="form-grid two"><Field label={tr("Username")}><input required autoComplete="off" pattern="[a-zA-Z0-9._@-]+" value={form.username} onChange={e => setForm({
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
            })}><option value="stock">{tr("Operator stockpile")}</option><option value="jetty">{tr("Operator jetty")}</option><option value="admin">{tr("Administrator")}</option><option value="driver">{tr("Pengemudi")}</option></select></Field></div>{['stock','jetty'].includes(form.role) && <fieldset className="scope-checks"><legend>{tr("Cakupan ")}{form.role === 'stock' ? 'crusher' : 'jetty'}</legend>{(form.role === 'stock' ? crushers : jetties).map(row => {
            const key = form.role === 'stock' ? "crusherIds" : "jettyIds";
            return <label key={row.id}><input type="checkbox" checked={form[key].includes(row.id)} onChange={e => setForm({
                ...form,
                [key]: e.target.checked ? [...form[key], row.id] : form[key].filter(id => id !== row.id)
              })} />{row.name}</label>;
          })}</fieldset>}{error && <div className="form-error" role="alert">{tr(error)}</div>}<div className="modal-actions"><Button variant="secondary" onClick={() => setAdding(false)}>{tr("Batal")}</Button><Button type="submit" disabled={busy || form.role === 'stock' && !form.crusherIds.length || form.role === 'jetty' && !form.jettyIds.length} icon={Users}>{tr("Buat akun")}</Button></div></form></Modal>}</Panel>;
}
