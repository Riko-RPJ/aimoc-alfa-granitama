import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction, integratedView} from '../server/integrated-demo-domain.mjs';
import {driverAssignmentQr} from '../server/driver-assignment-qr.mjs';
import {driverAssignmentIdentity, selectDriverAssignmentQr} from '../src/features/integrated/driver-assignment-qr.mjs';

function fixture() {
  const state = createSeed(), admin = {id: 'qr-ui-admin', role: 'admin'}, driver = {id: 'qr-ui-driver', username: 'qr-ui-driver', role: 'driver', active: true}, options = {drivers: [driver]};
  state.trucks = [{...state.trucks[0], bedM3: 30, payloadLimitT: 40}];
  const requestId = applyIntegratedAction(state, 'request.create', {transferMode: 'MARINE', destinationLocationId: 'stockpile-location-crusher-2', jettyId: 'jetty-1', vesselId: 'vessel-1', lines: [{skuId: 'split-12', quantity: 80, unit: 't'}]}, admin, options).requestId;
  applyIntegratedAction(state, 'request.plan', {requestId}, admin, options);
  const expected = integratedView(state, driver, options).trips[0];
  return {expected, driver, data: driverAssignmentQr(state, driver, {tripId: expected.id, drivers: options.drivers})};
}

test('Driver QR frontend accepts the real server DTO only for the exact current assignment without mutating either snapshot', () => {
  const {data, expected, driver} = fixture(), before = structuredClone({data, expected});
  const selected = selectDriverAssignmentQr(data, expected, driver.id);
  assert.equal(selected.trip.id, expected.id); assert.equal(selected.qr.value, data.qr.value);
  assert.equal(selected.canOpenTask, true); assert.equal(selected.historical, false);
  assert.equal(selectDriverAssignmentQr(data, expected, 'another-driver'), null);
  assert.deepEqual({data, expected}, before);
});

test('Driver QR frontend rejects source, request, dispatch, trip, truck, Driver and SKU binding mismatches', () => {
  const {data, expected, driver} = fixture();
  for (const key of ['requestId', 'dispatchId', 'tripId', 'truckId', 'sourceStockpileId', 'sourceCrusherId', 'skuId', 'assignedDriverUserId']) {
    const changed = structuredClone(data); changed.binding[key] = 'mismatched-' + key;
    assert.equal(selectDriverAssignmentQr(changed, expected, driver.id), null, key);
  }
  for (const change of [{truckId: 'another-truck'}, {assignedDriverUserId: 'another-driver'}, {requestId: 'another-request'}, {stockpileId: 'another-source'}, {crusherId: 'another-crusher'}, {skuId: 'another-sku'}, {status: 'waiting_truck'}]) {
    assert.equal(selectDriverAssignmentQr(data, {...expected, ...change}, driver.id), null, JSON.stringify(change));
  }
  for (const change of [{source: 'LEGACY'}, {scanRecorded: true}, {authorizationGranted: true}, {qrReferenceOnly: false}]) assert.equal(selectDriverAssignmentQr({...data, ...change}, expected, driver.id), null);
});

test('Driver QR frontend rejects malformed, augmented or authorization QR data and incomplete allocation', () => {
  const {data, expected, driver} = fixture();
  for (const value of ['not-json', JSON.stringify({...JSON.parse(data.qr.value), token: 'synthetic-untrusted-field'}), JSON.stringify({...JSON.parse(data.qr.value), truckId: 'wrong-truck'})]) {
    const changed = structuredClone(data); changed.qr.value = value; changed.trip.qr.value = value;
    assert.equal(selectDriverAssignmentQr(changed, expected, driver.id), null);
  }
  for (const flags of [{isAuthorization: true}, {physicalScan: true}]) {
    const changed = structuredClone(data); Object.assign(changed.qr, flags); Object.assign(changed.trip.qr, flags);
    assert.equal(selectDriverAssignmentQr(changed, expected, driver.id), null);
  }
  for (const change of [{status: 'waiting_truck'}, {truckId: null}, {assignedDriverUserId: null}, {assignedDriver: null}]) {
    const changed = structuredClone(data); Object.assign(changed.trip, change);
    assert.equal(selectDriverAssignmentQr(changed, expected, driver.id), null);
  }
});

test('terminal QR remains an archive reference and every assignment field invalidates the modal identity', () => {
  const {data, expected, driver} = fixture();
  for (const status of ['returned', 'completed', 'cancelled']) {
    const changed = structuredClone(data); changed.trip.status = status; changed.historical = false; changed.qr.historical = false; changed.canOpenTask = true;
    const selected = selectDriverAssignmentQr(changed, expected, driver.id);
    assert.equal(selected.historical, true); assert.equal(selected.canOpenTask, false);
  }
  const identity = driverAssignmentIdentity(expected, driver.id);
  for (const key of ['requestId', 'dispatchId', 'id', 'truckId', 'assignedDriverUserId', 'stockpileId', 'crusherId', 'skuId']) assert.notEqual(driverAssignmentIdentity({...expected, [key]: 'changed-' + key}, driver.id), identity, key);
  assert.notEqual(driverAssignmentIdentity(expected, 'changed-driver'), identity);
});
