import React, { useState, useEffect, useMemo, useRef } from 'react';
import { tr, localize, locale, useLanguage, setLanguage, eventText, eventTypeLabel } from '../../i18n.js';
import { statusText } from '../../domain/legacy-status.js';
import { api } from '../../services/legacy-api.js';
import { ClipboardList, Plus, Send, X } from 'lucide-react';
import { fmt, number, sum, lookup } from '../shared/legacy-utils.js';
import { Badge, Empty, Button, Field, Modal, DataTable, ProgressBar } from '../../components/ui/index.jsx';

export function RequestLines({
  request,
  products
}) {
  return <div className="line-summary">{request.lines.map((l, i) => <span key={i}>{lookup(products, l.skuId)?.code || l.skuId}<b>{fmt(l.quantity, 2)} {l.unit === 't' ? 'ton' : 'm³'}</b></span>)}</div>;
}

export function RequestModal({
  products,
  jetties,
  vessels,
  initial,
  busy,
  onClose,
  onSubmit
}) {
  const [transferMode,setTransferMode]=useState('MARINE');
  const [destinationId,setDestinationId]=useState('');
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
  const totalT = transferMode==='MARINE'?sum(lines, l => l.unit === 't' ? number(l.quantity) : number(l.quantity) * number(lookup(products, l.skuId)?.densityTPerM3)):null;
  const requestedByUnit=['m3','t'].map(unit=>({unit,quantity:sum(lines.filter(line=>line.unit===unit),line=>number(line.quantity))})).filter(x=>x.quantity>0);
  const selected = lookup(vessels, vesselId),
    remaining = selected ? number(selected.payloadLimitT) - number(selected.loadedT) - number(selected.reservedT) : 0;
  return <Modal wide title={tr("Buat permintaan stock transfer")} subtitle="Pilih LAND atau MARINE. Permintaan LAND disimpan untuk perencanaan, bukan dispatch otomatis." onClose={onClose}><form onSubmit={e => {
      e.preventDefault();
      onSubmit(transferMode==='LAND'?{
        transferMode:'LAND',destinationId,destination,
        lines:lines.map(l=>({...l,quantity:number(l.quantity)}))
      }:{
        transferMode:'MARINE',jettyId,vesselId,destination,
        lines:lines.map(l=>({...l,quantity:number(l.quantity)}))
      });
    }}><div className="form-section-label">Transfer Mode</div>
      <div role="group" aria-label="Transfer Mode" style={{display:'flex',gap:10,marginBottom:16}}>
       <button type="button" aria-pressed={transferMode==='LAND'} className={'btn '+(transferMode==='LAND'?'primary':'secondary')} onClick={()=>{setTransferMode('LAND');setDestination('');}}>LAND · Jalur Darat</button>
       <button type="button" aria-pressed={transferMode==='MARINE'} className={'btn '+(transferMode==='MARINE'?'primary':'secondary')} onClick={()=>{setTransferMode('MARINE');setDestination('Stockpile Marunda');}}>MARINE · Jalur Laut</button>
      </div>
      {transferMode==='LAND'?<div className="form-grid three">
       <Field label="Destination ID"><input required pattern="[a-zA-Z0-9_-]{2,100}" maxLength={100} value={destinationId} onChange={e=>setDestinationId(e.target.value)} placeholder="ID tujuan terdaftar"/></Field>
       <Field label="Receiving Location"><input required maxLength={160} value={destination} onChange={e=>setDestination(e.target.value)} placeholder="Nama lokasi penerima"/></Field>
       <div className="notice">LAND: Jetty dan Vessel tidak diperlukan. Request disimpan tanpa reservasi atau dispatch; identitas destination harus diverifikasi sebelum planning.</div>
      </div>:<div className="form-grid three"><Field label={tr("Jetty tujuan")}><select required value={jettyId} onChange={e => setJetty(e.target.value)}>{jetties.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}</select></Field><Field label={tr("Kapal tujuan")}><select required value={vesselId} onChange={e => setVessel(e.target.value)}>{ships.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field><Field label={tr("Lokasi penerima / tujuan")}><input required maxLength={100} value={destination} onChange={e => setDestination(e.target.value)} /></Field></div>}<div className="form-section-label">{tr("Material yang diminta ")}<small>{tr("Maksimal satu baris per SKU")}</small></div><div className="request-lines">{lines.map((l, i) => <div className="request-line" key={i}><span className="line-number">{String(i + 1).padStart(2, '0')}</span><Field label={tr("Produk / SKU")}><select required value={l.skuId} onChange={e => update(i, "skuId", e.target.value)}>{products.filter(p => p.active !== false).map(p => <option key={p.id} value={p.id}>{p.code} · {p.name} ({p.sizeMm})</option>)}</select></Field><Field label={tr("Kuantitas")}><input required type="number" min="0.01" max="1000000" step="0.01" value={l.quantity} onChange={e => update(i, 'quantity', e.target.value)} placeholder={tr("0")} /></Field><Field label={tr("Satuan")}><select value={l.unit} onChange={e => update(i, 'unit', e.target.value)}><option value="m3">{tr("m³")}</option><option value="t">{tr("ton")}</option></select></Field><button type="button" className="icon-btn" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => i !== j))} aria-label={tr("Hapus SKU {0}", i + 1)}><X size={17} /></button></div>)}</div><Button variant="ghost" icon={Plus} disabled={lines.length >= 6} onClick={() => setLines([...lines, {
        skuId: products.find(p => !lines.some(l => l.skuId === p.id))?.id || products[0]?.id,
        quantity: '',
        unit: 'm3'
      }])}>{tr("Tambah SKU")}</Button><div className="request-summary"><div><small>{tr("Total requested quantity · grouped by unit")}</small><strong>{requestedByUnit.map(x=>`${fmt(x.quantity,2)} ${x.unit==='t'?tr("ton"):tr("m³")}`).join(' · ')||'—'}</strong></div>{transferMode==="MARINE"&&<><div><small>{tr("Total permintaan ekuivalen")}</small><strong>{fmt(totalT,2)} {tr("ton")}</strong></div><div><small>{tr("Kapasitas kapal belum terikat")}</small><strong>{fmt(remaining, 2)} <em>{tr("ton")}</em></strong></div></>}</div>{transferMode==="MARINE"&&totalT > remaining && <div className="notice error">{tr("Kebutuhan melebihi kapasitas kapal yang belum terikat. Sesuaikan kuantitas atau pilih kapal lain.")}</div>}<div className="modal-actions"><Button variant="secondary" onClick={onClose}>{tr("Batal")}</Button><Button type="submit" disabled={busy || !products.length || (transferMode==="MARINE"&&(!ships.length || totalT > remaining))} icon={ClipboardList}>{tr("Simpan permintaan")}</Button></div></form></Modal>;
}

export function RequestDetail({
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
    target = request.transferMode==="LAND"?null:sum(request.lines, "tonnageT");
  const dispatchById=new Map(dispatches.filter(d=>d.requestId===request.id).map(d=>[d.id,d]));
  const requestDispatch=dispatchById.get(request.dispatchId)||[...dispatchById.values()][0];
  return <Modal wide title={tr("Permintaan {0}", request.code)} subtitle={request.transferMode==="LAND"?("LAND · "+request.destination+" · "+(request.destinationId||"")):tr("{0} → {1} · {2}", jetty(request.jettyId)?.name, vessel(request.vesselId)?.name, request.destination)} onClose={onClose}><div className="detail-status"><Badge status={request.status} /><span>{requestDispatch?.code||request.dispatchId||'—'} · {done.length}{tr(" dari ")}{these.length}{tr(" ritase dibongkar")}</span></div><RequestLines request={request} products={products} /><div className="request-summary"><div><small>{tr("Tonase permintaan")}</small><strong>{target===null?"Belum diverifikasi":fmt(target, 2)+" ton"}</strong></div><div><small>{tr("Telah dibongkar")}</small><strong>{fmt(sum(done, "tonnageT"), 2)} <em>{tr("ton")}</em></strong></div><div><small>{tr("Remaining transfer")}</small><strong>{target===null?"—":fmt(Math.max(0, target - sum(done, "tonnageT")), 2)} <em>{tr("ton")}</em></strong></div></div>{target!==null&&<ProgressBar value={sum(done, "tonnageT")} max={target} />}<h3 className="detail-section-title">{tr("Alokasi & ritase")}</h3><DataTable headers={[tr("Dispatch ID"), tr("Ritase / truk"), tr("Asal stockpile"), tr("Volume"), tr("Status")]}>{these.map(t => <tr key={t.id}><td><b>{dispatchById.get(t.dispatchId)?.code||t.dispatchId||'—'}</b></td><td><b>{t.code}</b><small>{truck(t.truckId)?.code}</small></td><td>{stockpile(t.stockpileId)?.code}</td><td>{fmt(t.volumeM3, 2)}{tr(" m³ / ")}{fmt(t.tonnageT, 2)}{tr(" t")}</td><td><Badge status={t.status} /></td></tr>)}</DataTable>{!these.length && <Empty icon={Send} title={tr("Belum direncanakan")} text={tr("Admin dapat membuat alokasi otomatis setelah stok dan kapasitas kapal tersedia.")} />}<div className="modal-actions"><Button variant="secondary" onClick={onClose}>{tr("Tutup")}</Button></div></Modal>;
}
