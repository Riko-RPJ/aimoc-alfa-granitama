import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFleetView, paginateFleet, buildDispatchGroups} from '../src/features/integrated/fleet-dispatch-view.mjs';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction, integratedView} from '../server/integrated-demo-domain.mjs';

const trucks = Array.from({length: 8}, (_, index) => ({id: `truck-${index + 1}`, code: `TRK-${index + 1}`, active: true, bedM3: 30, payloadLimitT: 45}));

test('fleet KPIs count each truck once and combine queued and active assignments', () => {
  const trips = [
    {id: 'q1', truckId: 'truck-1', status: 'queued'},
    {id: 'q-legacy-duplicate', truckId: 'truck-1', status: 'queued'},
    {id: 'active', truckId: 'truck-2', status: 'returning'},
    {id: 'old', truckId: 'truck-3', status: 'returned'},
    {id: 'cancel', truckId: 'truck-4', status: 'cancelled'},
    {id: 'waiting', truckId: null, status: 'waiting_truck'}
  ];
  const before = structuredClone({trucks, trips});
  const result = buildFleetView({trucks: [...trucks, trucks[0]], trips});
  assert.deepEqual(result.summary, {available: 6, allocated: 2, total: 8, unavailable: 0});
  assert.equal(result.rows[0].assignmentStatus, 'allocated');
  assert.equal(result.rows[0].operationalStatus, 'allocated');
  assert.equal(result.rows[1].operationalStatus, 'busy');
  assert.deepEqual({trucks, trips}, before, 'Building a view must not mutate canonical data');
});

test('scoped-out work stays allocated without adding a hidden trip reference', () => {
  const result = buildFleetView({trucks: trucks.slice(0, 3), fleet: [
    {...trucks[0], status: 'busy', activeTripId: null, nextTripId: null},
    {...trucks[1], status: 'allocated', activeTripId: null, nextTripId: null, queuedTrips: 1},
    {...trucks[2], status: 'available'}
  ], trips: []});
  assert.deepEqual(result.summary, {available: 1, allocated: 2, total: 3, unavailable: 0});
  assert.ok(result.rows.every(row => row.assignedTripId === null && row.assignedTrip === null));
});

test('inactive trucks remain in All, never count as available, and retain assignment classification', () => {
  const result = buildFleetView({trucks: [
    {...trucks[0], active: false}, {...trucks[1], active: false}, trucks[2]
  ], trips: [{id: 'retained', truckId: 'truck-2', status: 'in_transit'}]});
  assert.deepEqual(result.summary, {available: 1, allocated: 1, total: 3, unavailable: 1});
  assert.equal(result.rows[1].assignmentStatus, 'allocated');
  assert.equal(result.rows[1].operationalStatus, 'unavailable');
  assert.equal(paginateFleet(result.rows).rows.length, 3);
});

test('default All pagination shows three rows with stable, distinct subsequent pages', () => {
  const {rows} = buildFleetView({trucks});
  const first = paginateFleet(rows), second = paginateFleet(rows, {page: 2}), last = paginateFleet(rows, {page: 3});
  assert.equal(first.filter, 'all'); assert.equal(first.pageCount, 3);
  assert.deepEqual(first.rows.map(row => row.truckId), ['truck-1', 'truck-2', 'truck-3']);
  assert.deepEqual(second.rows.map(row => row.truckId), ['truck-4', 'truck-5', 'truck-6']);
  assert.deepEqual(last.rows.map(row => row.truckId), ['truck-7', 'truck-8']);
  assert.deepEqual([last.start, last.end, last.total], [7, 8, 8]);
});

test('filtering happens before pagination and out-of-range pages are clamped', () => {
  const {rows} = buildFleetView({trucks, trips: trucks.slice(0, 5).map((truck, index) => ({id: `trip-${index}`, truckId: truck.id, status: index % 2 ? 'in_transit' : 'queued'}))});
  const allocated = paginateFleet(rows, {filter: 'allocated', page: 99});
  assert.equal(allocated.page, 2); assert.equal(allocated.pageCount, 2); assert.equal(allocated.total, 5);
  assert.deepEqual(allocated.rows.map(row => row.truckId), ['truck-4', 'truck-5']);
  const available = paginateFleet(rows, {filter: 'available', page: 99});
  assert.equal(available.page, 1); assert.equal(available.rows.length, 3);
  assert.ok(available.rows.every(row => row.assignmentStatus === 'available'));
});

test('empty and invalid pagination inputs stay usable', () => {
  assert.deepEqual(paginateFleet([], {filter: 'unknown', page: NaN, pageSize: Infinity}), {rows: [], page: 1, pageCount: 1, total: 0, pageSize: 3, filter: 'all', start: 0, end: 0});
  assert.equal(paginateFleet(buildFleetView({trucks}).rows, {page: -1}).page, 1);
});

test('live polling recomputes assignments through queue, movement, receipt, and verified return', () => {
  const fleet = [{...trucks[0], status: 'allocated', queuedTrips: 1}];
  assert.equal(buildFleetView({trucks: [trucks[0]], fleet}).summary.allocated, 1);
  for (const status of ['queued', 'start_pending', 'ready_to_load', 'loading', 'weighed', 'in_transit', 'arrived', 'unloaded', 'returning']) {
    const result = buildFleetView({trucks: [trucks[0]], trips: [{id: 'task', truckId: 'truck-1', status}]});
    assert.equal(result.summary.allocated, 1, status);
  }
  const next = buildFleetView({trucks: [trucks[0]], fleet: [{...trucks[0], status: 'available', queuedTrips: 0}], trips: [{id: 'task', truckId: 'truck-1', status: 'returned'}]});
  assert.equal(next.summary.allocated, 0); assert.equal(next.summary.available, 1);
  assert.equal(paginateFleet(next.rows, {filter: 'allocated', page: 2}).page, 1);
});

const dispatches = [{id: 'd1', code: 'DSP-001'}, {id: 'd2', code: 'DSP-002'}, {id: 'private', code: 'DSP-PRIVATE'}];
const tripRows = [{id: 'one', dispatchId: 'd2'}, {id: 'two', dispatchId: 'd1'}, {id: 'three', dispatchId: 'd2'}];

test('All trips are grouped per dispatch while retaining the supplied trip order', () => {
  const before = structuredClone({tripRows, dispatches});
  const {groups, options} = buildDispatchGroups(tripRows, dispatches);
  assert.deepEqual(groups.map(group => [group.dispatchId, group.code, group.trips.map(trip => trip.id)]), [['d2', 'DSP-002', ['one', 'three']], ['d1', 'DSP-001', ['two']]]);
  assert.deepEqual(options, [{id: 'd2', code: 'DSP-002', count: 2}, {id: 'd1', code: 'DSP-001', count: 1}]);
  assert.deepEqual({tripRows, dispatches}, before);
});

test('dispatch filter selects only its trips and never leaks unrelated catalog entries', () => {
  const result = buildDispatchGroups(tripRows, dispatches, {dispatchId: 'd1'});
  assert.deepEqual(result.groups.flatMap(group => group.trips.map(trip => trip.id)), ['two']);
  assert.ok(result.options.every(option => option.id !== 'private'));
  assert.deepEqual(buildDispatchGroups(tripRows, dispatches, {dispatchId: 'private'}).groups, []);
  assert.deepEqual(buildDispatchGroups([], dispatches).options, []);
});

test('search-filtered trips remain grouped without reintroducing nonmatching rows', () => {
  const matching = tripRows.filter(trip => trip.id === 'three');
  const {groups} = buildDispatchGroups(matching, dispatches);
  assert.deepEqual(groups.flatMap(group => group.trips.map(trip => trip.id)), ['three']);
  assert.equal(groups[0].code, 'DSP-002');
});

test('unknown dispatch metadata and historical rows remain visible without fabricated assignments', () => {
  const {groups} = buildDispatchGroups([{id: 'history', dispatchId: 'legacy'}, {id: 'without'}], []);
  assert.equal(groups[0].code, 'legacy'); assert.equal(groups[0].dispatch, null);
  assert.equal(groups[1].code, '—'); assert.equal(groups[1].dispatchId, '__without_dispatch__');
});

test('actual role-scoped domain context keeps global assigned fleet and restricts dispatch options', () => {
  const state = createSeed(), admin = {id: 'view-admin', role: 'admin'};
  const drivers = [{id: 'view-driver-1', role: 'driver', username: 'd1', active: true}, {id: 'view-driver-2', role: 'driver', username: 'd2', active: true}];
  const options = {drivers};
  const created = applyIntegratedAction(state, 'request.create', {transferMode: 'MARINE', destinationLocationId: 'stockpile-location-crusher-2', jettyId: 'jetty-1', vesselId: 'vessel-1', lines: [{skuId: 'split-12', quantity: 80, unit: 't'}]}, admin, options);
  applyIntegratedAction(state, 'request.plan', {requestId: created.entityId}, admin, options);
  const adminView = integratedView(state, admin, options), otherDriver = integratedView(state, {id: 'driver-with-no-work', role: 'driver'}, options);
  const adminFleet = buildFleetView(adminView), scopedFleet = buildFleetView(otherDriver);
  assert.equal(adminFleet.summary.allocated, 2); assert.equal(scopedFleet.summary.allocated, 2);
  assert.deepEqual(scopedFleet.summary, adminFleet.summary);
  assert.equal(otherDriver.trips.length, 0);
  assert.ok(scopedFleet.rows.every(row => row.assignedTripId === null));
  assert.deepEqual(buildDispatchGroups(otherDriver.trips, adminView.dispatches).options, []);
  const own = integratedView(state, drivers[0], options), ownGroups = buildDispatchGroups(own.trips, own.dispatches);
  assert.equal(ownGroups.groups.flatMap(group => group.trips).length, own.trips.length);
  assert.ok(ownGroups.groups.flatMap(group => group.trips).every(trip => trip.assignedDriverUserId === drivers[0].id));
});
