import React, {useId} from 'react';
import {AlertCircle, Layers3, Loader2, RefreshCw} from 'lucide-react';
import {skuStockPresentation} from './transfer-sku-stock-view.mjs';
import './transfer-sku-stock.css';

const defaultCopy = id => id;

/** Aggregate inventory for a selected SKU, independent of the requested quantity. */
export function TransferSkuStock({L = defaultCopy, skuId, summary, loading = false, error = null, stale = false, locale = 'id-ID', onRetry}) {
  const labelId = useId();
  const view = skuStockPresentation({skuId, summary, loading, error, stale});
  const fmt = value => value === null || value === undefined ? '—' : new Intl.NumberFormat(locale, {maximumFractionDigits: 2}).format(value);
  const usable = ['ready', 'stale', 'warning'].includes(view.state);
  const metric = (name, value) => <span data-testid={name} data-value={value ?? undefined}>{fmt(value)}{value !== null && value !== undefined && <span className="sku-stock-unit"> t</span>}</span>;
  const issue = view.state === 'unselected' ? L('Pilih SKU untuk melihat total stok fisik.', 'Select an SKU to view its total physical stock.') :
    view.state === 'loading' ? L('Mengambil total stok SKU…', 'Loading SKU stock totals…') :
    view.state === 'error' && view.errorCode === 'AUTH_REQUIRED' ? L('Sesi berakhir. Masuk kembali untuk melihat stok.', 'Your session has expired. Sign in again to view stock.') :
    view.state === 'error' ? L('Data stok belum dapat dimuat. Coba muat ulang.', 'Stock data could not be loaded. Try refreshing.') :
    view.state === 'unavailable' ? L('Total tonase belum tersedia. Periksa data stockpile dan berat jenis SKU.', 'Total tonnage is unavailable. Check stockpile data and the SKU density.') : null;
  return <section className={`sku-stock sku-stock-${view.state}`} data-testid="transfer-sku-stock" data-sku-id={skuId || ''} data-state={view.state} aria-labelledby={labelId} aria-busy={loading}>
    <div className="sku-stock-heading"><span><Layers3 size={15} aria-hidden="true"/><b id={labelId}>{L('Total stok fisik SKU', 'Total physical SKU stock')}</b>{view.skuCode && <span className="sku-stock-code">{view.skuCode}</span>}</span>{loading && usable && <span className="sku-stock-updating"><Loader2 size={13} className="spin" aria-hidden="true"/>{L('Memperbarui', 'Updating')}</span>}</div>
    {usable ? <>
      <div className="sku-stock-body">
        <div className="sku-stock-physical"><strong>{metric('sku-physical-tonnes', view.physicalTonnes)}</strong><small><span data-testid="sku-physical-volume" data-value={view.physicalM3}>{fmt(view.physicalM3)} m³</span>{view.stockpileCount !== null && <> · {view.stockpileCount} stockpile</>}</small></div>
        <dl className="sku-stock-stats">
          <div><dt>{L('Direservasi', 'Reserved')}</dt><dd>{metric('sku-reserved-tonnes', view.reservedTonnes)}</dd></div>
          <div><dt>{L('Stok bebas', 'Unreserved stock')}</dt><dd>{metric('sku-available-tonnes', view.availableTonnes)}</dd></div>
          <div className="sku-stock-dispatch"><dt>{L('Tersedia untuk dispatch', 'Available for dispatch')}</dt><dd>{metric('sku-dispatchable-tonnes', view.sourceEligibleAvailableTonnes)}</dd></div>
        </dl>
      </div>
      <p className="sku-stock-basis">{L('Tonase = volume stok tercatat × berat jenis SKU', 'Tonnes = recorded stock volume × SKU density')} ({fmt(view.densityTPerM3)} t/m³).</p>
      <p className="sku-stock-eligibility">{view.sourceEligibilityStatus === 'DESTINATION_REQUIRED' ? L('Pilih tujuan LAND untuk menghitung stok sumber yang dapat dikirim.', 'Select the LAND destination to calculate dispatchable source stock.') : view.sourceEligibilityStatus === 'INVALID_DATA' ? L('Stok untuk dispatch belum dapat dihitung. Periksa data sumber dan tujuan.', 'Dispatchable stock is unavailable. Check source and destination data.') : L('Dispatch memakai sumber aktif setelah reservasi; stok area penerima LAND dikecualikan.', 'Dispatch uses active sources after reservations; LAND receiving-area stock is excluded.')}</p>
      {view.state === 'stale' && <p className="sku-stock-warning-note" role="status"><AlertCircle size={14} aria-hidden="true"/>{L('Menampilkan data stok terakhir; pembaruan sedang ditunggu.', 'Showing the last stock snapshot while awaiting an update.')}</p>}
      {view.dataWarning && <p className="sku-stock-warning-note" role="status"><AlertCircle size={14} aria-hidden="true"/>{L('Data reservasi atau sumber perlu diperiksa. Nilai yang belum valid ditampilkan —.', 'Reservation or source data needs review. Unavailable values are shown as —.')}</p>}
    </> : <div className="sku-stock-message" role="status">{view.state === 'loading' ? <Loader2 className="spin" size={17} aria-hidden="true"/> : <AlertCircle size={17} aria-hidden="true"/>}<span>{issue}</span>{onRetry && ['error', 'unavailable'].includes(view.state) && <button type="button" className="sku-stock-retry" onClick={onRetry}><RefreshCw size={13} aria-hidden="true"/>{L('Muat ulang stok', 'Refresh stock')}</button>}</div>}
  </section>;
}
