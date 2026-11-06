import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed, applyAction} from '../server/domain.mjs';
import {applyIntegratedAction, integratedView} from '../server/integrated-demo-domain.mjs';
import {legacyOperationFingerprint, previewLegacyDemoCancellation, applyLegacyDemoCancellation} from '../server/legacy-demo-reconciliation.mjs';

const admin = {id: 'synthetic-release-admin', role: 'admin'};
const driver = {id: 'synthetic-release-driver', role: 'driver', active: true};

function fixture() {
  const state = createSeed();
  const act = (action, payload) => applyAction(state, action, payload, admin);
  const request = (skuId, quantity, unit = 't') => act('request.create', {transferMode: 'MARINE', jettyId: 'jetty-1', vesselId: 'vessel-1', destination: 'Published UAT synthetic stockpile', lines: [{skuId, quantity, unit}]}).entityId;
  const returnedRequestId = request('split-12', 24, 'm3');
  act('request.plan', {requestId: returnedRequestId});
  const returnedTrip = state.trips[0];
  for (const action of ['start', 'depart', 'arrive', 'unload', 'return']) act(`trip.${action}`, {tripId: returnedTrip.id, ...(action === 'depart' ? {tareT: 20, grossT: 56} : {})});
  const requestId = request('abu-batu', 1000);
  act('request.plan', {requestId});
  const selected = state.trips.filter(trip => trip.requestId === requestId);
  act('trip.start', {tripId: selected[0].id});
  for (let n = 0; n < 3; n++) request('split-23', 20 + n);
  const options = {tripIds: selected.map(trip => trip.id), expectedTripCount: 23, expectedRequestId: requestId, expectedFingerprint: legacyOperationFingerprint(state), batchId: 'release-2026-11-07-test', reason: 'Cancel unexecuted published UAT jobs before integrated demo cutover.', confirmedDemoOnly: true, noHardware: true, sidecarsAbsent: true};
  return {state, options, selected, returnedTrip, returnedRequestId, requestId};
}

test('preview is read-only and cancellation releases only allowlisted UAT reservations, preserving complete history', () => {
  const {state, options, returnedTrip, returnedRequestId, requestId} = fixture();
  assert.equal(state.trips.length, 24);
  const before = structuredClone(state);
  const preview = previewLegacyDemoCancellation(state, options, admin);
  assert.deepEqual(state, before);
  assert.equal(preview.cancelledTrips, 23);
  assert.deepEqual(preview.priorStatuses, {queued: 22, loading: 1});
  assert.deepEqual(preview.releases.stockpiles, [{id: 'stock-2-1', volumeM3: 666.666667}]);
  assert.deepEqual(preview.releases.vessels, [{id: 'vessel-1', tonnageT: 1000.000001}]);
  const report = applyLegacyDemoCancellation(state, options, admin);
  assert.equal(report.replayed, false);
  assert.equal(report.auditIds.length, 25);
  assert.equal(state.trips.length, before.trips.length);
  assert.equal(state.requests.length, before.requests.length);
  assert.equal(state.dispatches.length, before.dispatches.length);
  assert.deepEqual(state.inventoryLedger, before.inventoryLedger);
  assert.deepEqual(state.erpOutbox, before.erpOutbox);
  assert.deepEqual(state.events.slice(0, before.events.length), before.events);
  assert.deepEqual(state.trips.find(trip => trip.id === returnedTrip.id), before.trips.find(trip => trip.id === returnedTrip.id));
  assert.deepEqual(state.requests.filter(request => request.id !== requestId), before.requests.filter(request => request.id !== requestId));
  assert.equal(state.requests.find(request => request.id === returnedRequestId).status, 'completed');
  assert.equal(state.requests.find(request => request.id === requestId).status, 'cancelled');
  assert.equal(state.dispatches.find(dispatch => dispatch.requestId === requestId).status, 'cancelled');
  assert.ok(state.trips.filter(trip => options.tripIds.includes(trip.id)).every(trip => trip.status === 'cancelled' && !trip.returnedAt && !trip.receiptCode && trip.legacyReconciliation.noPhysicalMovementRecorded));
  assert.equal(state.trips.find(trip => options.tripIds.includes(trip.id) && trip.legacyReconciliation.priorStatus === 'loading').startedAt, before.trips.find(trip => trip.status === 'loading').startedAt);
  for (const stock of state.stockpiles) assert.equal(stock.onHandM3, before.stockpiles.find(row => row.id === stock.id).onHandM3);
  for (const vessel of state.vessels) assert.equal(vessel.loadedT, before.vessels.find(row => row.id === vessel.id).loadedT);
  assert.equal(state.stockpiles.find(stock => stock.id === 'stock-2-1').reservedM3, 0);
  assert.equal(state.vessels[0].reservedT, 0);
  assert.equal(state.vessels[0].loadedT, 36);
  assert.ok(report.afterBalances.every(balance => balance.reserved === 0));
  assert.ok(integratedView(state, admin, {drivers: [driver]}).fleet.every(truck => truck.status === 'available'));
});

test('same batch is idempotent after fingerprint changes; altered reason/allowlist/actor conflicts', () => {
  const {state, options} = fixture();
  const first = applyLegacyDemoCancellation(state, options, admin);
  const after = structuredClone(state);
  assert.notEqual(legacyOperationFingerprint(state), options.expectedFingerprint);
  const second = applyLegacyDemoCancellation(state, options, admin);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.auditIds, first.auditIds);
  assert.deepEqual(state, after);
  for (const changes of [{reason: 'Different cancellation scope'}, {tripIds: options.tripIds.slice(1), expectedTripCount: 22}]) assert.throws(() => applyLegacyDemoCancellation(state, {...options, ...changes}, admin), error => error.code === 'RECONCILIATION_CONFLICT');
  assert.throws(() => applyLegacyDemoCancellation(state, options, {...admin, id: 'other-admin'}), error => error.code === 'RECONCILIATION_CONFLICT');
  assert.deepEqual(state, after);
});

test('fingerprint, exact count/whole allowlist and no-hardware UAT provenance are mandatory', () => {
  const {state, options} = fixture();
  const before = structuredClone(state);
  const variants = [
    {...options, expectedFingerprint: '0'.repeat(64)},
    {...options, tripIds: options.tripIds.slice(1), expectedTripCount: 22},
    {...options, tripIds: [...options.tripIds, options.tripIds[0]], expectedTripCount: 24},
    {...options, expectedTripCount: 22},
    {...options, expectedRequestId: 'not-the-reviewed-request'},
    {...options, confirmedDemoOnly: false},
    {...options, noHardware: false},
    {...options, sidecarsAbsent: false},
  ];
  for (const variant of variants) { assert.throws(() => applyLegacyDemoCancellation(state, variant, admin)); assert.deepEqual(state, before); }
  assert.throws(() => applyLegacyDemoCancellation(state, options, {id: 'stock-test', role: 'stock'}), error => error.code === 'FORBIDDEN');
  const production = {...structuredClone(state), dataMode: 'PRODUCTION'};
  assert.throws(() => applyLegacyDemoCancellation(production, {...options, expectedFingerprint: legacyOperationFingerprint(production)}, admin), error => error.code === 'DEMO_PROVENANCE_REQUIRED');
});

test('unknown status, recorded weights, movement timestamps, QR, ledger or ERP intent all hold without mutation', () => {
  for (const mutate of [
    state => {state.trips[1].status = 'unknown';},
    state => {state.trips[1].status = 'in_transit';},
    state => {state.trips[1].tareT = 20;},
    state => {state.trips[1].qrScannedAt = new Date().toISOString();},
    state => {state.trips[1].departedAt = new Date().toISOString();},
    state => {state.trips[1].receiptCode = 'RCV-SYNTHETIC';},
    state => {state.trips[1].weighingEvents = [{type: 'TARE', weightT: 20}];},
    state => {state.events.push({id: 'proof-test', entityId: state.trips[1].id, type: 'trip.depart'});},
    state => {state.inventoryLedger.push({id: 'proof-test', referenceId: state.trips[1].id, type: 'transfer_departed', volumeM3: -28});},
    state => {state.erpOutbox.push({id: 'proof-test', entityId: state.trips[1].id, type: 'stock_transfer_departed'});},
  ]) {
    const {state, options} = fixture(); mutate(state);
    const before = structuredClone(state);
    assert.throws(() => applyLegacyDemoCancellation(state, {...options, expectedFingerprint: legacyOperationFingerprint(state)}, admin));
    assert.deepEqual(state, before);
  }
});

test('cumulative reservation audit protects unrelated integrated jobs and rejects balance drift', () => {
  const {state, options} = fixture();
  const integratedRequest = applyIntegratedAction(state, 'request.create', {transferMode: 'MARINE', destinationLocationId: 'stockpile-location-crusher-2', jettyId: 'jetty-2', vesselId: 'vessel-3', destination: 'Unrelated integrated reservation', lines: [{skuId: 'split-23', quantity: 10, unit: 't'}]}, admin, {drivers: [driver]});
  // All fleet is reserved by the legacy batch; a dedicated synthetic truck
  // demonstrates another owner's reservation that cancellation must not release.
  state.trucks.push({id: 'dedicated-truck', code: 'DT-999', active: true, bedM3: 30, payloadLimitT: 40, cycleMinutes: 30});
  applyIntegratedAction(state, 'request.plan', {requestId: integratedRequest.entityId, assignments: [{truckId: 'dedicated-truck', driverUserId: driver.id}]}, admin, {drivers: [driver]});
  const current = {...options, expectedFingerprint: legacyOperationFingerprint(state)};
  const otherTrip = state.trips.find(trip => trip.source === 'INTEGRATED_DEMO');
  const otherStockId = otherTrip.stockpileId;
  const reservedBefore = state.stockpiles.find(stock => stock.id === otherStockId).reservedM3;
  const otherTripBefore = structuredClone(otherTrip), otherRequestBefore = structuredClone(state.requests.find(request => request.id === integratedRequest.entityId));
  const drifted = structuredClone(state); drifted.stockpiles.find(stock => stock.id === otherStockId).reservedM3 += 1;
  const driftedBefore = structuredClone(drifted);
  assert.throws(() => applyLegacyDemoCancellation(drifted, {...current, expectedFingerprint: legacyOperationFingerprint(drifted)}, admin), error => error.code === 'RECONCILIATION_HOLD');
  assert.deepEqual(drifted, driftedBefore);
  applyLegacyDemoCancellation(state, current, admin);
  assert.equal(state.stockpiles.find(stock => stock.id === otherStockId).reservedM3, reservedBefore);
  assert.equal(state.vessels.find(vessel => vessel.id === 'vessel-3').reservedT, 10);
  assert.deepEqual(state.trips.find(trip => trip.id === otherTrip.id), otherTripBefore);
  assert.deepEqual(state.requests.find(request => request.id === integratedRequest.entityId), otherRequestBefore);
});
