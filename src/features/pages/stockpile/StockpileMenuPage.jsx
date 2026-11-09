import React, {useState} from 'react';
import {ArrowRight, Layers3, Plus} from 'lucide-react';
import {Button, Field, Modal} from '../../../components/ui/index.jsx';
import {MeasurementValues} from '../../inventory/MeasurementValues.jsx';

export function StockpileMenuPage({L, onAdd, onRecords, canAdd}) {
  return <section className="stock-tablet-panel" data-testid="stockpile-menu" aria-label={L('Menu operator stockpile','Stockpile operator menu')}>
    <header><h2>{L('Operasi material','Material operations')}</h2><p>{L('Catat hasil ukur atau periksa pengajuan dan persediaan resmi.','Record a measurement or review submissions and official inventory.')}</p></header>
    <div className="stock-tablet-menu">
      <button type="button" onClick={onAdd} disabled={!canAdd} data-testid="stockpile-add-material">
        <Plus size={30}/><strong>{L('Tambah Material','Add Material')}</strong>
        <span>{L('Pilih sumber dan SKU, lalu catat hasil ukur atau bukti foto.','Select a source and SKU, then record a measurement or photo evidence.')}</span>
        <ArrowRight size={20}/>
      </button>
      <button type="button" onClick={onRecords} data-testid="stockpile-material-records">
        <Layers3 size={30}/><strong>{L('Data Material','Material Records')}</strong>
        <span>{L('Lihat status pengajuan dan stok fisik yang sudah tercatat.','See submission status and recorded physical stock.')}</span>
        <ArrowRight size={20}/>
      </button>
    </div>
  </section>;
}

const pageSize = 6;

export function StockpileMaterialSubmissions({measurements, L, fmt, date, pile, product, onAdd, canAdd}) {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const statuses = {
    pending: L('Menunggu persetujuan','Awaiting approval'),
    needs_calibration: L('Perlu kalibrasi','Needs calibration'),
    approved: L('Disetujui','Approved')
  };
  const methods = {
    manual: L('Hasil survei lapangan','Field survey result'),
    calibrated_geometry: L('Estimasi geometri terkalibrasi','Calibrated geometry estimate'),
    camera_pending: L('Bukti kamera','Camera evidence')
  };
  const rows = measurements.filter(row => filter === 'all' || row.status === filter)
    .sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const selected = measurements.find(row => row.id === selectedId);
  return <section className="stock-tablet-panel" data-testid="stockpile-material-submissions">
    <header className="stock-tablet-toolbar">
      <div><h2>{L('Pengajuan pengukuran','Measurement submissions')}</h2><p>{L('Pengajuan menunggu tinjauan. Stok resmi berubah setelah pengukuran disetujui Admin.','Submissions await review. Official inventory changes after Admin approval.')}</p></div>
      <Button icon={Plus} onClick={onAdd} disabled={!canAdd}>{L('Tambah Material','Add Material')}</Button>
    </header>
    <Field label={L('Filter status','Filter status')}>
      <select data-testid="stockpile-material-status" value={filter} onChange={e => {setFilter(e.target.value); setPage(1);}}>
        <option value="all">{L('Semua status','All statuses')}</option>
        {Object.entries(statuses).map(([status,label]) => <option key={status} value={status}>{label}</option>)}
      </select>
    </Field>
    {rows.length ? <div className="stock-record-list">
      {rows.slice((currentPage-1)*pageSize, currentPage*pageSize).map(row => <article key={row.id} className="stock-record">
        <div><b>{row.code}</b><small>{pile(row.stockpileId)?.code || row.stockpileId} · {product(row.skuId)?.code || row.skuId}</small><small>{row.createdAt ? date(row.createdAt) : '—'}</small></div>
        <div><span className="stock-record-status" data-status={row.status}>{statuses[row.status] || row.status}</span><small>{methods[row.method] || row.method}</small></div>
        <Button variant="secondary" data-testid="stockpile-material-detail" data-measurement-id={row.id} onClick={() => setSelectedId(row.id)}>{L('Detail','Details')}</Button>
      </article>)}
    </div> : <p className="stock-record-empty">{L('Belum ada pengajuan sesuai filter.','No submissions match this filter.')}</p>}
    {pageCount > 1 && <div className="stock-record-pagination">
      <Button variant="secondary" disabled={currentPage === 1} onClick={() => setPage(currentPage-1)}>{L('Sebelumnya','Previous')}</Button>
      <span>{L('Halaman','Page')} {currentPage} / {pageCount}</span>
      <Button variant="secondary" disabled={currentPage === pageCount} onClick={() => setPage(currentPage+1)}>{L('Berikutnya','Next')}</Button>
    </div>}
    {selected && <Modal title={selected.code} subtitle={statuses[selected.status] || selected.status} onClose={() => setSelectedId(null)}>
      <div className="stock-record-detail" data-testid="stockpile-material-detail-dialog">
        <p><strong>{pile(selected.stockpileId)?.code || selected.stockpileId}</strong> · {product(selected.skuId)?.code || selected.skuId}</p>
        <p>{methods[selected.method] || selected.method}</p>
        <MeasurementValues measurement={selected} {...{L,fmt}}/>
        {selected.notes && <p>{selected.notes}</p>}
        {selected.evidenceId && <a href={`/api/evidence/${encodeURIComponent(selected.evidenceId)}`} target="_blank" rel="noreferrer">{L('Lihat bukti foto','View photo evidence')}</a>}
      </div>
    </Modal>}
  </section>;
}
