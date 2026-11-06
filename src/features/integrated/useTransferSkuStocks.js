import {useCallback, useEffect, useRef, useState} from 'react';
import {validateSkuStockResponse} from './transfer-sku-stock-view.mjs';

/** Canonical context revisions drive refresh, so each request reads the same live inventory. */
export function useTransferSkuStocks({mode = 'MARINE', destinationCrusherId = '', revision, enabled = true} = {}) {
  const transferMode = String(mode).toUpperCase();
  const destination = transferMode === 'LAND' ? String(destinationCrusherId || '') : '';
  const key = `${transferMode}:${destination}`;
  const [snapshot, setSnapshot] = useState({key: '', data: null, loading: false, error: null});
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const refresh = useCallback(() => setRetry(n => n + 1), []);

  useEffect(() => {
    const current = ++sequence.current;
    if (!enabled) { setSnapshot({key, data: null, loading: false, error: null}); return; }
    if (!['MARINE', 'LAND'].includes(transferMode)) {
      setSnapshot({key, data: null, loading: false, error: {code: 'INVALID_STOCK_REQUEST'}});
      return;
    }
    const abort = new AbortController();
    setSnapshot(previous => ({key, data: previous.key === key ? previous.data : null, loading: true, error: null}));
    const params = new URLSearchParams({transferMode});
    if (destination) params.set('destinationCrusherId', destination);
    (async () => {
      try {
        const response = await fetch(`/api/v1/demo/sku-stock?${params}`, {credentials: 'same-origin', cache: 'no-store', signal: abort.signal});
        if (!response.ok) throw Object.assign(new Error('SKU stock request failed.'), {code: response.status === 401 ? 'AUTH_REQUIRED' : 'STOCK_FETCH_FAILED', status: response.status});
        let data;
        try { data = await response.json(); } catch { throw Object.assign(new Error('Invalid stock response.'), {code: 'INVALID_STOCK_RESPONSE'}); }
        validateSkuStockResponse(data);
        if (!abort.signal.aborted && current === sequence.current) setSnapshot({key, data, loading: false, error: null});
      } catch (error) {
        if (abort.signal.aborted || current !== sequence.current) return;
        setSnapshot(previous => ({key, data: previous.key === key ? previous.data : null, loading: false, error: {code: error.code || 'STOCK_FETCH_FAILED', status: error.status}}));
      }
    })();
    return () => abort.abort();
  }, [key, transferMode, destination, revision, retry, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const recover = () => refresh();
    window.addEventListener('online', recover);
    return () => window.removeEventListener('online', recover);
  }, [enabled, refresh]);

  const matches = snapshot.key === key;
  const data = enabled && matches ? snapshot.data : null;
  const stale = Boolean(data && Number.isSafeInteger(revision) && data.revision < revision);
  return {
    items: data?.items || [],
    loading: Boolean(enabled && (!matches || snapshot.loading)),
    error: enabled && matches ? snapshot.error : null,
    stale,
    revision: data?.revision ?? null,
    updatedAt: data?.updatedAt ?? null,
    refresh,
  };
}
