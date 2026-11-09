import React, { useState, useEffect, useMemo, useRef } from 'react';
import { tr, localize, locale, useLanguage, setLanguage, eventText, eventTypeLabel } from '../../i18n.js';
import { statusText } from '../../domain/legacy-status.js';
import { api } from '../../services/legacy-api.js';
import { Camera, CheckCircle2, ClipboardCheck, Filter, Layers3, Loader2, Package, Search, ShieldCheck, Upload, X } from 'lucide-react';
import { fmt, number, lookup } from '../shared/legacy-utils.js';
import { Empty, Button, Field, Modal, Panel, DataTable } from '../../components/ui/index.jsx';
import {previewMeasurementQuantity} from '../../../shared/measurement-units.mjs';
import './measurement-units.css';

export function InventoryTable({
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
  return <Panel title={tr("Persediaan stockpile")} subtitle={tr("Kode stockpile mengikat sumber crusher dan satu SKU material")} action={<div className="table-tools"><div className="search-field"><Search size={16} /><input aria-label={tr("Cari stockpile atau SKU")} value={search} onChange={e => setSearch(e.target.value)} placeholder={tr("Cari SKU / stockpile")} /></div><select aria-label={tr("Filter crusher")} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{tr("Semua crusher")}</option>{crushers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}><DataTable headers={[tr("Stockpile / crusher"), tr("Produk / SKU"), tr("Stok fisik"), tr("Direservasi"), tr("Tersedia"), tr("Ekuivalen tersedia"), tr("Aksi")]}>{filtered.map(s => <tr key={s.id}><td><span className="table-cell-icon"><Layers3 size={18} /><span><b>{s.code}</b><small>{crusher(s.crusherId)?.name}</small></span></span></td><td><b>{product(s.skuId)?.code}</b><small>{product(s.skuId)?.name} · {product(s.skuId)?.sizeMm}</small></td><td>{fmt(s.onHandM3, 2)}{tr(" m³")}</td><td><span className={s.reservedM3 > 0 ? 'amber-text' : 'muted'}>{fmt(s.reservedM3, 2)}{tr(" m³")}</span></td><td><b className="teal-text">{fmt(number(s.onHandM3) - number(s.reservedM3), 2)}{tr(" m³")}</b></td><td>{fmt((number(s.onHandM3) - number(s.reservedM3)) * number(product(s.skuId)?.densityTPerM3), 2)}{tr(" ton")}</td><td>{role === 'stock' && <button className="icon-btn bordered" onClick={() => setModal({
            type: 'measurement',
            stockpileId: s.id
          })} title={tr("Ukur stockpile")}><Camera size={16} /></button>}</td></tr>)}</DataTable>{!filtered.length && <Empty title={tr("Stockpile tidak ditemukan")} />}</Panel>;
}
export function MeasurementModal({
  scopeStock,
  products,
  crushers,
  busy,
  csrf,
  notify,
  initial = {},
  canUploadEvidence = true,
  onClose,
  onSubmit,
  embedded = false,
  onSaved
}) {
  const [stockpileId, setStockpile] = useState(initial.stockpileId || scopeStock[0]?.id || ''),
    [method, setMethod] = useState(canUploadEvidence ? 'camera_pending' : 'manual'),
    [confirmedSku, setConfirmedSku] = useState(''),
    [quantityValue, setQuantity] = useState(''),
    [quantityUnit, setQuantityUnit] = useState('m3'),
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
  const [step, setStep] = useState(1);
  const language = useLanguage();
  const L = (id, en) => language === "en" ? en : id;
  const submitting = useRef(false);
  const mounted = useRef(true);
  const sourceGeneration = useRef(0);
  const stream = useRef(null),
    video = useRef(null),
    file = useRef(null);
  const selected = lookup(scopeStock, stockpileId),
    sourceProduct = lookup(products, selected?.skuId),
    p = lookup(products, confirmedSku) || sourceProduct,
    c = lookup(crushers, selected?.crusherId);
  const matchingStockpiles = skuId => {
    const product = lookup(products, skuId);
    if (!selected || !c || c.active === false || !product || product.active === false) return [];
    return scopeStock.filter(stock => stock.active !== false && stock.crusherId === selected.crusherId && stock.skuId === skuId);
  };
  const skuCandidates = confirmedSku ? matchingStockpiles(confirmedSku) : [];
  const skuMismatch = Boolean(confirmedSku && !skuCandidates.some(stock => stock.id === stockpileId));
  const estimated = number(geometry.lengthM) * number(geometry.widthM) * number(geometry.heightM) * number(geometry.shapeFactor);
  const densityValid = typeof p?.densityTPerM3 === 'number' && Number.isFinite(p.densityTPerM3) && p.densityTPerM3 > 0 && p.densityTPerM3 <= 5;
  const manualPreview = quantityValue === '' ? null : previewMeasurementQuantity(Number(quantityValue), quantityUnit, p?.densityTPerM3);
  const stopCamera = () => {
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    setCamera(false);
  };
  const changeSource = (nextId, nextSku = '') => {
    if (nextId !== stockpileId) {
      sourceGeneration.current++;
      stopCamera();
      setPhoto(null); setPhotoName(''); setUploaded(null);
      if (file.current) file.current.value = '';
      setQuantity('');
      setGeometry({lengthM:'', widthM:'', heightM:'', shapeFactor:'0.5'});
      setNotes(''); setCameraError('');
    }
    setStockpile(nextId); setConfirmedSku(nextSku); setError('');
  };
  const chooseSku = skuId => {
    const candidates = matchingStockpiles(skuId);
    const next = candidates.find(stock => stock.id === stockpileId) || (candidates.length === 1 ? candidates[0] : null);
    if (next) changeSource(next.id, skuId);
    else { setConfirmedSku(skuId); setError(''); }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sourceGeneration.current++;
      stream.current?.getTracks().forEach(track => track.stop());
    };
  }, []);
  useEffect(() => {
    if (camera && video.current && stream.current) {
      video.current.srcObject = stream.current;
      video.current.play().catch(() => {});
    }
  }, [camera]);
  const openCamera = async () => {
    if (!canUploadEvidence || busy || submitting.current) return;
    const generation = ++sourceGeneration.current;
    setCameraError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kamera browser memerlukan HTTPS dan perangkat yang mendukung.');
      const openedStream = await navigator.mediaDevices.getUserMedia({
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
      if (sourceGeneration.current !== generation) { openedStream.getTracks().forEach(t => t.stop()); return; }
      stream.current = openedStream;
      setCamera(true);
    } catch (e) {
      if (sourceGeneration.current !== generation) return;
      setCameraError(e.name === 'NotAllowedError' ? 'Izin kamera belum diberikan. Izinkan kamera di browser atau unggah foto.' : e.message);
    }
  };
  const takePhoto = () => {
    if (busy || submitting.current) return;
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
  const selectPhoto = e => {
    if (busy || submitting.current) return;
    const f = e.target.files?.[0];
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
    const generation = sourceGeneration.current;
    const r = new FileReader();
    r.onload = () => {
      if (sourceGeneration.current !== generation || submitting.current) return;
      setPhoto(String(r.result));
      setPhotoName(f.name);
      setUploaded(null);
    };
    r.readAsDataURL(f);
  };
  const nextStep = () => {
    setError('');
    if (!selected || !confirmedSku || skuMismatch || selected.skuId !== confirmedSku) {
      setError('SKU yang dikonfirmasi harus sesuai dengan stockpile dan ukuran material.');
      return;
    }
    setStep(2);
  };
  const submit = async e => {
    e.preventDefault();
    if (busy || submitting.current) return;
    if (embedded && step === 1) {
      nextStep();
      return;
    }
    setError('');
    if (!selected || !confirmedSku || skuMismatch || selected.skuId !== confirmedSku) {
      setError('SKU yang dikonfirmasi harus sesuai dengan stockpile dan ukuran material.');
      return;
    }
    if (method === 'camera_pending' && !photo) {
      setError('Ambil atau unggah foto untuk menyimpan bukti kamera.');
      return;
    }
    if (method === 'manual' && !manualPreview?.valid) {
      setError(quantityUnit === 't' && !densityValid ? 'Tonase memerlukan berat jenis SKU yang valid. Hubungi Admin untuk memperbarui master SKU.' : 'Isi hasil survei yang valid dalam satuan yang dipilih.');
      return;
    }
    submitting.current = true;
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
      if (method === 'manual') {
        payload.quantityValue = manualPreview.quantityValue;
        payload.quantityUnit = quantityUnit;
      }
      if (method === 'calibrated_geometry') {
        payload.geometry = Object.fromEntries(Object.entries(geometry).map(([k, v]) => [k, number(v)]));
      }
      const result = await onSubmit(payload);
      if (result && mounted.current) onSaved?.();
    } catch (e) {
      setError(e.message);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };
  const previousStep = event => {
    event.preventDefault();
    sourceGeneration.current++;
    stopCamera();
    setCameraError('');
    setError('');
    setStep(1);
  };
  const close = () => {
    if (submitting.current) return;
    sourceGeneration.current++;
    stopCamera();
    onClose();
  };
  const cameraFields = <div className="camera-column"><div className={`camera-preview ${photo || camera ? 'has-image' : ''}`}>{camera ? <video ref={video} playsInline muted autoPlay /> : photo ? <img src={photo} alt={tr("Foto stockpile yang dipilih operator")} /> : <><Camera size={39} /><strong>{tr("Foto stockpile")}</strong><p>{tr("Ambil bukti kondisi stockpile")}<br />{tr("dengan kamera perangkat Anda.")}</p></>}<span className="camera-chip"><span />{camera ? tr("Kamera perangkat aktif") : photo ? tr("Foto dari operator") : tr("Belum ada kamera terhubung")}</span></div><div className="camera-actions">{camera ? <><Button icon={Camera} disabled={busy || saving} onClick={takePhoto}>{tr("Ambil foto")}</Button><Button variant="secondary" onClick={stopCamera}>{tr("Matikan")}</Button></> : <><Button variant="secondary" icon={Camera} disabled={!canUploadEvidence || busy || saving} onClick={openCamera}>{tr("Buka kamera")}</Button><Button variant="secondary" icon={Upload} disabled={!canUploadEvidence || busy || saving} onClick={() => file.current?.click()}>{tr("Unggah foto")}</Button></>}<input ref={file} data-testid="measurement-evidence-file" type="file" accept="image/jpeg,image/png" capture="environment" hidden disabled={!canUploadEvidence} onChange={selectPhoto} /></div>{!canUploadEvidence && <p className="measurement-camera-role-note">{tr("Bukti kamera diunggah oleh operator stockpile. Admin dapat mencatat hasil survei tanpa foto.")}</p>}{photoName && <p className="photo-name"><CheckCircle2 size={14} />{photoName}</p>}{cameraError && <p className="form-error" role="alert">{tr(cameraError)}</p>}<div className="camera-disclaimer"><ShieldCheck size={17} /><p><b>{tr("Pengukuran kamera 3D belum terhubung.")}</b>{tr(" Foto atau video tanpa skala / data kedalaman tidak cukup untuk mengukur m³. Rekonstruksi fotogrametri atau LiDAR memerlukan integrasi dan kalibrasi lapangan.")}</p></div></div>;
  const sourceFields = <><Field label={tr("Stockpile / sumber crusher")}><select data-testid="measurement-stockpile" disabled={busy || saving} required value={stockpileId} onChange={e => { const next = lookup(scopeStock, e.target.value); changeSource(e.target.value, next?.skuId === confirmedSku ? confirmedSku : ''); }}>{scopeStock.map(s => <option key={s.id} value={s.id}>{s.code} · {lookup(crushers, s.crusherId)?.name} · {lookup(products, s.skuId)?.code}</option>)}</select></Field><Field label={tr("Konfirmasi SKU material yang diukur")}><select data-testid="measurement-sku" disabled={busy || saving} required value={confirmedSku} onChange={e => chooseSku(e.target.value)}><option value="">{tr("Pilih SKU sesuai ukuran batu…")}</option>{products.filter(x => x.active !== false).map(x => <option key={x.id} value={x.id}>{x.code} · {x.name} ({x.sizeMm})</option>)}</select></Field><div className="sku-context" data-testid="measurement-sku-context" aria-live="polite"><span className="sku-context-icon"><Package size={22} /></span><div><small>{confirmedSku ? tr("SKU dipilih dari master Admin") : tr("SKU sesuai master Admin")}</small><b>{p?.code} · {p?.name}</b><small>{tr("Ukuran ")}{p?.sizeMm}{tr(" · berat jenis ")}{fmt(p?.densityTPerM3, 2)}{tr(" t/m³")}</small></div></div><p className="measurement-camera-role-note" data-testid="measurement-auto-source-note">{tr("Stockpile otomatis mengikuti SKU pada crusher yang sama. Hasil ukur dan bukti perlu diisi ulang jika sumber berubah.")}</p>{skuMismatch && <p className="measurement-unit-warning" role="alert" data-testid="measurement-sku-mismatch"><b>{skuCandidates.length === 0 ? tr("Belum ada stockpile aktif untuk SKU ini pada crusher yang sama. Hubungi Admin.") : skuCandidates.length > 1 ? tr("Ada beberapa stockpile untuk SKU ini pada crusher yang sama. Pilih sumber yang akan diukur.") : tr("Pilih stockpile yang sesuai dengan SKU tersebut sebelum menyimpan.")}</b><br />{tr("SKU stockpile")}: {sourceProduct?.code} · {selected?.code}. {tr("Pilihan Anda")}: {p?.code}. {tr("Pilih stockpile yang sesuai dengan SKU tersebut sebelum menyimpan.")}</p>}</>;
  const measurementFields = <><Field label={tr("Metode pencatatan")}><select data-testid="measurement-method" disabled={busy || saving} value={method} onChange={e => {setMethod(e.target.value);setError('');}}><option value="camera_pending" disabled={!canUploadEvidence}>{tr("Bukti kamera — menunggu pengukuran")}</option><option value="manual">{tr("Hasil survei lapangan")}</option><option value="calibrated_geometry">{tr("Estimasi geometri terkalibrasi")}</option></select></Field>
      {method === 'manual' && <div className="measurement-manual-entry">
        <div className="form-grid two"><Field label={tr("Satuan hasil survei")} hint={tr("Nilai dikosongkan saat satuan diganti agar tidak tertukar.")}><select data-testid="measurement-input-unit" value={quantityUnit} onChange={e => {setQuantityUnit(e.target.value);setQuantity('');setError('');}}><option value="m3">{tr("Volume (m³)")}</option><option value="t" disabled={!densityValid}>{tr("Tonase (ton)")}</option></select></Field>
        <Field label={tr(quantityUnit === 't' ? "Tonase hasil survei (ton)" : "Volume hasil survei (m³)")} hint={tr("Isi hasil ukur lapangan yang dapat ditelusuri, bukan perkiraan dari foto tunggal.")}><input data-testid="measurement-input-value" required type="number" min="0" max="1000000000" step="0.000001" value={quantityValue} onChange={e => {setQuantity(e.target.value);setError('');}} placeholder={tr("0,00")} /></Field></div>
        {!densityValid && <p className="measurement-unit-warning" role="note">{tr("Tonase memerlukan berat jenis SKU yang valid. Hubungi Admin untuk memperbarui master SKU.")}</p>}
        <div className="measurement-conversion-preview" data-testid="measurement-conversion-preview" aria-live="polite">
          <small>{tr("Pratinjau hasil survei")}</small>
          {manualPreview?.valid ? <><strong>{fmt(manualPreview.quantityValue,6)} <em>{quantityUnit === 't' ? tr("ton") : 'm³'}</em></strong><div className="measurement-equivalents"><span data-testid="measurement-preview-volume" data-value={manualPreview.volumeM3}>{tr("Volume persediaan")}: <b>{fmt(manualPreview.volumeM3,6)} m³</b></span><span data-testid="measurement-preview-tonnage" data-value={manualPreview.tonnageT??undefined}>{tr("Tonase")}: <b>{manualPreview.tonnageT!==null ? fmt(manualPreview.tonnageT,6)+' '+tr("ton") : '—'}</b></span></div>{densityValid && <span>{tr("Berat jenis SKU")}: {fmt(p.densityTPerM3,6)} t/m³</span>}</> : <span>{quantityValue === '' ? tr("Isi nilai hasil survei untuk melihat ekuivalennya.") : tr("Nilai belum valid untuk dikonversi.")}</span>}
          <p>{tr("Nilai dan satuan asli disimpan. Konversi memakai berat jenis SKU saat pencatatan; stok baru berubah setelah persetujuan Admin.")}</p>
        </div>
      </div>}{method === 'calibrated_geometry' && <><div className="notice compact">{tr("Ukuran nyata diukur di lapangan. V = panjang × lebar × tinggi × faktor bentuk. Hasil berupa estimasi, bukan keluaran AI.")}</div><div className="form-grid two">{[["lengthM", tr("Panjang (m)")], ["widthM", tr("Lebar (m)")], ["heightM", tr("Tinggi (m)")], ["shapeFactor", tr("Faktor bentuk (0–1)")]].map(([key, label]) => <Field key={key} label={label}><input required type="number" min={key === 'shapeFactor' ? '0.01' : '0.01'} max={key === 'shapeFactor' ? '1' : '10000'} step="0.01" value={geometry[key]} onChange={e => setGeometry({
                  ...geometry,
                  [key]: e.target.value
                })} /></Field>)}</div><div className="measurement-result"><small>{tr("Estimasi volume geometri")}</small><strong>{fmt(estimated, 2)} <em>{tr("m³")}</em></strong><span>≈ {fmt(estimated * number(p?.densityTPerM3), 2)}{tr(" ton · belum masuk stok")}</span></div></>}{method === 'camera_pending' && <div className="notice compact"><Camera size={17} /><span>{tr("Hanya bukti foto yang disimpan. Volume dan stok tidak berubah sampai pengukuran terkalibrasi dicatat dan disetujui.")}</span></div>}<Field label={tr("Catatan / referensi kalibrasi")}><textarea rows={3} maxLength={500} required={method !== 'camera_pending'} value={notes} onChange={e => setNotes(e.target.value)} placeholder={method === 'calibrated_geometry' ? tr("Sumber ukuran, alat ukur, geometri tumpukan, tanggal kalibrasi…") : tr("Nomor survei, kondisi stockpile, atau catatan operator…")} /></Field></>;
  const formError = error && <div className="form-error" role="alert">{tr(error)}</div>;
  const submitButton = <Button type="submit" data-testid={embedded ? "stockpile-measurement-submit" : undefined}
    disabled={busy || saving || !selected || !confirmedSku || skuMismatch || (method === 'manual' && !manualPreview?.valid)}
    icon={saving ? Loader2 : ClipboardCheck}>{saving ? tr("Menyimpan…") : tr("Simpan untuk ditinjau")}</Button>;

  if (embedded) return <section className="stock-tablet-panel stockpile-measurement-workspace" data-testid="stockpile-measurement-wizard" data-step={step}>
    <header className="stock-tablet-toolbar">
      <div><h2>{L('Tambah Material','Add Material')}</h2><p>{L('Lengkapi pengajuan pengukuran dalam dua langkah.','Complete the measurement submission in two steps.')}</p></div>
      <Button variant="secondary" data-testid="stockpile-measurement-back" onClick={close} disabled={saving}>{L('Kembali ke menu','Back to menu')}</Button>
    </header>
    <ol className="stock-wizard-steps" aria-label={L('Tahapan pengajuan','Submission steps')}>
      <li aria-current={step === 1 ? 'step' : undefined}><b>1</b>{L('Sumber & material','Source & material')}</li>
      <li aria-current={step === 2 ? 'step' : undefined}><b>2</b>{L('Pengukuran & bukti','Measurement & evidence')}</li>
    </ol>
    <form onSubmit={submit}>
      {step === 1 ? <div className="measurement-form stock-wizard-source">{sourceFields}</div>
        : <div className="measurement-layout stock-wizard-measurement"><div className="measurement-form">{measurementFields}</div>{cameraFields}</div>}
      {formError}
      <footer className="stock-wizard-actions">
        {step === 1 ? <Button key="next" type="submit" data-testid="stockpile-measurement-next" disabled={busy || !selected || !confirmedSku || skuMismatch}>{L('Selanjutnya','Next')}</Button> : <>
          <Button key="previous" variant="secondary" data-testid="stockpile-measurement-previous" disabled={saving} onClick={previousStep}>{L('Sebelumnya','Previous')}</Button>
          {submitButton}
        </>}
      </footer>
    </form>
  </section>;

  return <Modal wide title={tr("Pengukuran & kamera stockpile")} subtitle={tr("Pilih lokasi dan SKU. Bukti kamera dan hasil ukur selalu memiliki sumber yang jelas.")} onClose={close}>
    <form onSubmit={submit}>
      <div className="measurement-layout">{cameraFields}<div className="measurement-form">{sourceFields}{measurementFields}</div></div>
      {formError}
      <div className="modal-actions"><span className="modal-footnote">{tr("Hasil ukur menunggu persetujuan Admin.")}</span>
        <Button variant="secondary" onClick={close} disabled={saving}>{tr("Batal")}</Button>{submitButton}
      </div>
    </form>
  </Modal>;
}
