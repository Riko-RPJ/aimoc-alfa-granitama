import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeSkuStocks} from '../server/sku-stock-summary.mjs';

const admin = {id: 'admin-test', role: 'admin'};
const jetty = {id: 'jetty-test', role: 'jetty', jettyIds: ['j1']};
const item = (state, options = {}, actor = admin, skuId = 'sku-a') => summarizeSkuStocks(state, actor, options).items.find(row => row.skuId === skuId);
function fixture() {
  return {
    products: [{id: 'sku-a', code: 'SKU-A', densityTPerM3: 1.5, active: true}, {id: 'sku-b', code: 'SKU-B', densityTPerM3: 2, active: true}],
    crushers: [{id: 'a', active: true}, {id: 'b', active: true}],
    jetties: [{id: 'j1', active: true}, {id: 'j2', active: true}],
    stockpiles: [
      {id: 'a1', skuId: 'sku-a', crusherId: 'a', onHandM3: 100, reservedM3: 20, active: true},
      {id: 'b1', skuId: 'sku-a', crusherId: 'b', onHandM3: 50, reservedM3: 10, active: true},
      {id: 'other', skuId: 'sku-b', crusherId: 'a', onHandM3: 999, reservedM3: 0, active: true}
    ]
  };
}

test('physical totals sum all matching SKU stockpiles; reservations remain part of physical stock', () => {
  const state = fixture(), before = structuredClone(state), result = item(state);
  assert.equal(result.skuCode, 'SKU-A');
  assert.equal(result.physicalM3, 150);assert.equal(result.physicalTonnes, 225);
  assert.equal(result.reservedM3, 30);assert.equal(result.reservedTonnes, 45);
  assert.equal(result.availableM3, 120);assert.equal(result.availableTonnes, 180);
  assert.equal(result.sourceEligibleAvailableTonnes, 180);assert.equal(result.stockpileCount, 2);
  assert.equal(result.status, 'READY');assert.deepEqual(result.issues, []);
  assert.deepEqual(state, before);
  const envelope = summarizeSkuStocks(state, admin);
  assert.equal(envelope.measurementBasis, 'DENSITY_CONVERTED_VOLUME');
  assert.equal(envelope.source, 'CANONICAL_STOCK_LEDGER');
  assert.equal(envelope.items.find(row => row.skuId === 'sku-b').physicalTonnes, 1998);
});

test('inactive physical stock is retained but excluded from dispatch-eligible availability', () => {
  const state = fixture();state.crushers.push({id: 'inactive', active: false});
  state.stockpiles.push({id: 'offline-pile', skuId: 'sku-a', crusherId: 'a', onHandM3: 25, reservedM3: 0, active: false}, {id: 'offline-crusher-pile', skuId: 'sku-a', crusherId: 'inactive', onHandM3: 10, reservedM3: 0, active: true});
  const result = item(state);
  assert.equal(result.physicalTonnes, 277.5);assert.equal(result.availableTonnes, 232.5);
  assert.equal(result.sourceEligibleAvailableTonnes, 180);assert.equal(result.eligibleStockpileCount, 2);
  state.products[0].active = false;
  const inactive = item(state);assert.equal(inactive.physicalTonnes, 277.5);assert.equal(inactive.sourceEligibleAvailableTonnes, 0);assert.equal(inactive.requestable, false);
});

test('LAND excludes receiving inventory from source availability without changing physical SKU totals', () => {
  const state = fixture();
  const result = item(state, {transferMode: 'LAND', destinationCrusherId: 'b'});
  assert.equal(result.physicalTonnes, 225);assert.equal(result.availableTonnes, 180);
  assert.equal(result.sourceEligibleAvailableM3, 80);assert.equal(result.sourceEligibleAvailableTonnes, 120);
  assert.equal(result.eligibleStockpileCount, 1);
  assert.equal(item(state, {transferMode: 'LAND', destinationCrusherId: 'a'}).sourceEligibleAvailableTonnes, 60);
  const pending = item(state, {transferMode: 'LAND'});
  assert.equal(pending.physicalTonnes, 225);assert.equal(pending.sourceEligibleAvailableTonnes, null);assert.equal(pending.sourceEligibilityStatus, 'DESTINATION_REQUIRED');
  assert.throws(() => item(state, {transferMode: 'LAND', destinationCrusherId: 'unknown'}), error => error.code === 'INVALID_DESTINATION');
  assert.throws(() => item(state, {transferMode: 'INVALID'}), error => error.code === 'TRANSFER_MODE_INVALID');
});

test('only Admin and an assigned active MARINE Jetty actor receive global aggregate data', () => {
  const state = fixture();assert.equal(item(state, {}, jetty).physicalTonnes, 225);
  for (const actor of [null, {id: 'stock', role: 'stock', crusherIds: ['a']}, {id: 'driver', role: 'driver'}, {id: 'jetty', role: 'jetty', jettyIds: []}, {id: 'jetty', role: 'jetty', jettyIds: ['missing']}, {...admin, active: false}]) assert.throws(() => summarizeSkuStocks(state, actor), error => error.status === 403);
  assert.throws(() => item(state, {transferMode: 'LAND', destinationCrusherId: 'b'}, jetty), error => error.status === 403);
  state.jetties[0].active = false;
  assert.throws(() => item(state, {}, jetty), error => error.status === 403);
  const serialized = JSON.stringify(summarizeSkuStocks(fixture(), jetty));
  assert.ok(!serialized.includes('"a1"'));assert.ok(!serialized.includes('"b1"'));
});

test('a known SKU with no stock is a valid zero; unknown SKU has no fabricated row', () => {
  const state = fixture();state.stockpiles = state.stockpiles.filter(row => row.skuId !== 'sku-a');
  const result = item(state);
  assert.equal(result.physicalTonnes, 0);assert.equal(result.reservedTonnes, 0);assert.equal(result.availableTonnes, 0);assert.equal(result.sourceEligibleAvailableTonnes, 0);assert.equal(result.status, 'READY');
  assert.equal(item(state, {}, admin, 'unknown'), undefined);
  state.stockpiles.push({id: 'orphan', skuId: 'unknown', crusherId: 'a', onHandM3: 100, reservedM3: 0, active: true});
  assert.equal(summarizeSkuStocks(state, admin).unmappedStockpileCount, 1);
  assert.equal(item(state).physicalTonnes, 0);
});

test('invalid or missing density reports unavailable tonnes without replacing physical volume with zero', () => {
  for (const density of [undefined, null, 0, -1, Infinity, NaN, true, '1.5', 0.00000000001, 6]) {
    const state = fixture();state.products[0].densityTPerM3 = density;
    const result = item(state);
    assert.equal(result.physicalM3, 150);assert.equal(result.physicalTonnes, null);assert.equal(result.reservedTonnes, null);assert.equal(result.availableTonnes, null);assert.equal(result.sourceEligibleAvailableTonnes, null);assert.equal(result.densityTPerM3, null);assert.equal(result.status, 'INVALID_DATA');assert.ok(result.issues.includes('INVALID_DENSITY'));
  }
});

test('invalid balances and ambiguous identities fail closed instead of inflating stock', () => {
  const badVolume = fixture();badVolume.stockpiles[0].onHandM3 = -10;assert.equal(item(badVolume).physicalTonnes, null);assert.ok(item(badVolume).issues.includes('INVALID_ON_HAND'));
  const badReservation = fixture();badReservation.stockpiles[0].reservedM3 = 101;
  assert.equal(item(badReservation).physicalTonnes, 225);assert.equal(item(badReservation).availableTonnes, null);assert.equal(item(badReservation).sourceEligibleAvailableTonnes, null);
  const code = fixture();code.products[1].code = ' sku-a ';assert.equal(item(code).physicalTonnes, null);assert.ok(item(code).issues.includes('DUPLICATE_OR_MISSING_SKU_CODE'));
  const duplicateId = fixture();duplicateId.products.push({...duplicateId.products[0]});assert.equal(summarizeSkuStocks(duplicateId, admin).items.length, 2);assert.equal(item(duplicateId).physicalTonnes, null);
  const duplicatePile = fixture();duplicatePile.stockpiles.push({...duplicatePile.stockpiles[0]});assert.equal(item(duplicatePile).physicalTonnes, null);assert.ok(item(duplicatePile).issues.includes('DUPLICATE_OR_MISSING_STOCKPILE_ID'));
  const missingSource = fixture();missingSource.stockpiles[0].crusherId = 'unknown';assert.equal(item(missingSource).physicalTonnes, 225);assert.equal(item(missingSource).sourceEligibleAvailableTonnes, null);
});

test('tonnage rounding occurs after aggregation and decimal inputs do not drift', () => {
  const state = fixture();state.products[0].densityTPerM3 = 0.333333;
  state.stockpiles = Array.from({length: 3}, (_, i) => ({id: 'tiny-' + i, skuId: 'sku-a', crusherId: 'a', onHandM3: 0.000001, reservedM3: 0, active: true}));
  const tiny = item(state);assert.equal(tiny.physicalM3, 0.000003);assert.equal(tiny.physicalTonnes, 0.000001);
  state.products[0].densityTPerM3 = 1.5;state.stockpiles[0].onHandM3 = 0.1 + 0.2;state.stockpiles = state.stockpiles.slice(0, 1);
  assert.equal(item(state).physicalM3, 0.3);assert.equal(item(state).physicalTonnes, 0.45);
});
