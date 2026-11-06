import test from 'node:test';
import assert from 'node:assert/strict';
import {skuStockPresentation, stockMetric, validateSkuStockResponse} from '../src/features/integrated/transfer-sku-stock-view.mjs';

const row = {skuId: 'split-12', skuCode: 'SP-12', status: 'READY', sourceEligibilityStatus: 'READY', densityTPerM3: 1.5, physicalM3: 500, physicalTonnes: 750, reservedTonnes: 150, availableTonnes: 600, sourceEligibleAvailableTonnes: 300, stockpileCount: 2};

test('selected SKU shows authoritative physical total independently of reserved and source-eligible stock', () => {
  const view = skuStockPresentation({skuId: row.skuId, summary: row});
  assert.equal(view.state, 'ready');
  assert.equal(view.physicalTonnes, 750);
  assert.equal(view.reservedTonnes, 150);
  assert.equal(view.availableTonnes, 600);
  assert.equal(view.sourceEligibleAvailableTonnes, 300);
});

test('changing SKU never displays the previous SKU totals while awaiting its data', () => {
  const view = skuStockPresentation({skuId: 'abu-batu', summary: row, loading: true});
  assert.equal(view.state, 'loading');
  assert.equal(view.physicalTonnes, undefined);
  assert.equal(skuStockPresentation({skuId: 'abu-batu', summary: row}).state, 'unavailable');
  assert.equal(skuStockPresentation({summary: row}).state, 'unselected');
});

test('genuine zero differs from null, missing, non-numeric or invalid inventory', () => {
  for (const value of [null, undefined, '', '0', false, NaN, Infinity, -1]) assert.equal(stockMetric(value), null);
  assert.equal(stockMetric(0), 0);
  const zero = skuStockPresentation({skuId: row.skuId, summary: {...row, physicalM3: 0, physicalTonnes: 0, reservedTonnes: 0, availableTonnes: 0, sourceEligibleAvailableTonnes: 0, stockpileCount: 0}});
  assert.equal(zero.state, 'ready');assert.equal(zero.physicalTonnes, 0);
  assert.equal(skuStockPresentation({skuId: row.skuId, summary: {...row, status: 'INVALID_DATA', densityTPerM3: null, physicalTonnes: null}}).state, 'unavailable');
});

test('LAND destination requirement hides only dispatchable quantity, keeping physical stock visible', () => {
  const view = skuStockPresentation({skuId: row.skuId, summary: {...row, sourceEligibilityStatus: 'DESTINATION_REQUIRED', sourceEligibleAvailableTonnes: null}});
  assert.equal(view.state, 'ready');assert.equal(view.physicalTonnes, 750);
  assert.equal(view.sourceEligibleAvailableTonnes, null);
});

test('invalid reservations preserve a known physical total but never manufacture free stock', () => {
  const view = skuStockPresentation({skuId: row.skuId, summary: {...row, status: 'INVALID_DATA', reservedTonnes: 900, availableTonnes: null, sourceEligibleAvailableTonnes: null, sourceEligibilityStatus: 'INVALID_DATA', issues: ['INVALID_RESERVATION_BALANCE']}});
  assert.equal(view.state, 'warning');assert.equal(view.physicalTonnes, 750);assert.equal(view.dataWarning, true);
  assert.equal(view.availableTonnes, null);assert.equal(view.sourceEligibleAvailableTonnes, null);
});

test('fetch errors and stale snapshots cannot masquerade as fresh stock', () => {
  assert.equal(skuStockPresentation({skuId: row.skuId, summary: row, stale: true}).state, 'stale');
  const error = skuStockPresentation({skuId: row.skuId, summary: row, error: {code: 'AUTH_REQUIRED'}});
  assert.equal(error.state, 'error');assert.equal(error.errorCode, 'AUTH_REQUIRED');assert.equal(error.physicalTonnes, undefined);
});

test('transport schema rejects a legacy response or duplicate SKU identities but retains explicit per-SKU invalid states', () => {
  const response = {source: 'CANONICAL_STOCK_LEDGER', measurementBasis: 'DENSITY_CONVERTED_VOLUME', scope: 'GLOBAL_SKU_TOTALS', revision: 15, items: [row]};
  assert.equal(validateSkuStockResponse(response), response);
  assert.throws(() => validateSkuStockResponse({state: {stockpiles: []}}), e => e.code === 'INVALID_STOCK_RESPONSE');
  assert.throws(() => validateSkuStockResponse({...response, items: [row, {...row}]}), e => e.code === 'INVALID_STOCK_RESPONSE');
  assert.throws(() => validateSkuStockResponse({...response, revision: 0}), e => e.code === 'INVALID_STOCK_RESPONSE');
  assert.doesNotThrow(() => validateSkuStockResponse({...response, items: [{...row, status: 'INVALID_DATA', physicalTonnes: null}]}));
});
