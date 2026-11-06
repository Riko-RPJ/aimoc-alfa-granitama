const nonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Only format canonical numbers. Missing/null/string values are not zero stock. */
export const stockMetric = value => nonNegative(value) ? value : null;

/** Suppress an older SKU's data immediately, including the render before an effect runs. */
export function skuStockPresentation({skuId, summary, loading = false, error = null, stale = false} = {}) {
  if (!skuId) return {state: 'unselected'};
  if (error) return {state: 'error', errorCode: error.code || 'STOCK_FETCH_FAILED'};
  if (!summary || summary.skuId !== skuId) return {state: loading ? 'loading' : 'unavailable'};
  const metrics = {
    physicalTonnes: stockMetric(summary.physicalTonnes),
    physicalM3: stockMetric(summary.physicalM3),
    reservedTonnes: stockMetric(summary.reservedTonnes),
    availableTonnes: stockMetric(summary.availableTonnes),
    sourceEligibleAvailableTonnes: stockMetric(summary.sourceEligibleAvailableTonnes),
  };
  const densityTPerM3 = typeof summary.densityTPerM3 === 'number' && Number.isFinite(summary.densityTPerM3) && summary.densityTPerM3 > 0 ? summary.densityTPerM3 : null;
  const knownPhysical = ['READY', 'INVALID_DATA'].includes(summary.status) && metrics.physicalTonnes !== null && metrics.physicalM3 !== null && densityTPerM3 !== null;
  return {
    state: knownPhysical ? stale ? 'stale' : summary.status === 'INVALID_DATA' ? 'warning' : 'ready' : 'unavailable',
    skuCode: typeof summary.skuCode === 'string' ? summary.skuCode : '',
    ...metrics,
    densityTPerM3,
    stockpileCount: Number.isSafeInteger(summary.stockpileCount) && summary.stockpileCount >= 0 ? summary.stockpileCount : null,
    sourceEligibilityStatus: summary.sourceEligibilityStatus,
    sourceEligibleAvailableTonnes: summary.sourceEligibilityStatus === 'READY' ? metrics.sourceEligibleAvailableTonnes : null,
    issues: Array.isArray(summary.issues) ? summary.issues : [],
    dataWarning: summary.status === 'INVALID_DATA',
    updating: Boolean(loading),
  };
}

/** Validate transport/schema without hiding a single SKU's explicitly invalid-data state. */
export function validateSkuStockResponse(value) {
  const valid = value && value.source === 'CANONICAL_STOCK_LEDGER' &&
    value.measurementBasis === 'DENSITY_CONVERTED_VOLUME' && value.scope === 'GLOBAL_SKU_TOTALS' &&
    Number.isSafeInteger(value.revision) && value.revision > 0 && Array.isArray(value.items) &&
    value.items.every(item => item && typeof item.skuId === 'string' && item.skuId && ['READY', 'INVALID_DATA'].includes(item.status)) &&
    new Set(value.items.map(item => item.skuId)).size === value.items.length;
  if (!valid) throw Object.assign(new Error('Invalid canonical SKU stock response.'), {code: 'INVALID_STOCK_RESPONSE'});
  return value;
}
