import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFleetView, paginateFleet, buildDispatchGroups,buildDispatchTruckRows,paginateDispatchTruckRows} from '../src/features/integrated/fleet-dispatch-view.mjs';
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

test('dispatch summary groups serial trips by truck and paginates five trucks per dispatch',()=>{
 const trips=Array.from({length:7},(_,index)=>({id:`t${index}`,truckId:`truck-${index}`,sequence:index+1,status:'queued'}));
 trips.push({id:'t0-second',truckId:'truck-0',sequence:8,status:'queued'});
 const rows=buildDispatchTruckRows(trips),first=paginateDispatchTruckRows(rows,1),second=paginateDispatchTruckRows(rows,2);
 assert.equal(rows.length,7);assert.equal(rows[0].total,2);assert.equal(rows[0].progress,1);
 assert.equal(first.rows.length,5);assert.equal(first.pageCount,2);assert.equal(second.rows.length,2);
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

test('canonical allocation overrides malformed visible execution hints and prestart without a start time', () => {
  const visible = [
    {id: 'prestart', truckId: 'truck-1', status: 'start_pending', qrScannedAt: '2026-11-07T01:00:00Z', weighingEvents: [{type: 'TARE', status: 'PENDING'}]},
    {id: 'stale-execution', truckId: 'truck-2', status: 'loading', startedAt: '2026-11-07T00:00:00Z'},
    {id: 'stale-assignment', truckId: 'truck-3', status: 'queued'}
  ];
  const fleet = [
    {...trucks[0], status: 'allocated', activeTripId: null, nextTripId: 'prestart', queuedTrips: 1, serialTripsRemaining: 1, dispatchId: 'd1', dispatchIds: ['d1'], bindingStatus: 'DISPATCH'},
    {...trucks[1], status: 'allocated', activeTripId: null, nextTripId: null, queuedTrips: 1, serialTripsRemaining: 1, dispatchId: 'd2', dispatchIds: ['d2'], bindingStatus: 'DISPATCH'},
    {...trucks[2], status: 'available', activeTripId: null, nextTripId: null, queuedTrips: 0, serialTripsRemaining: 0, dispatchId: null, dispatchIds: [], bindingStatus: 'NONE'}
  ];
  const result = buildFleetView({trucks: trucks.slice(0, 3), fleet, trips: visible});
  assert.deepEqual(result.rows.map(row => row.operationalStatus), ['allocated', 'allocated', 'available']);
  assert.deepEqual(result.summary, {available: 1, allocated: 2, total: 3, unavailable: 0});
  assert.equal(result.operationalSummary.busy, 0);
  assert.equal(result.operationalSummary.allocated, 2);
  assert.equal(result.rows[0].activeTripId, null);
  assert.equal(result.rows[0].nextTripId, 'prestart');
  assert.equal(result.rows[0].nextTrip.id, 'prestart');
  assert.equal(result.rows[0].bindingStatus, 'DISPATCH');
  assert.equal(result.rows[2].assignedTripId, null, 'Stale visible rows must not recreate a released canonical assignment');
});

test('a hidden current trip never becomes a visible queued tail and canonical queue counts remain global', () => {
  const queued = {id: 'visible-tail', truckId: 'truck-1', status: 'queued', dispatchId: 'visible-dispatch'};
  const result = buildFleetView({trucks: [trucks[0]], fleet: [{
    ...trucks[0], status: 'busy', activeTripId: null, nextTripId: queued.id,
    queuedTrips: 2, serialTripsRemaining: 3, dispatchId: 'visible-dispatch',
    dispatchIds: ['visible-dispatch'], bindingStatus: 'DISPATCH'
  }], trips: [queued]});
  const row = result.rows[0];
  assert.equal(row.operationalStatus, 'busy');
  assert.equal(row.activeTripId, null);
  assert.equal(row.activeTrip, null);
  assert.equal(row.assignedTrip, null, 'A scoped-out executing assignment must stay unidentified');
  assert.equal(row.assignedTripId, null);
  assert.equal(row.nextTripId, queued.id);
  assert.equal(row.nextTrip.id, queued.id);
  assert.equal(row.queuedTrips, 2);
  assert.equal(row.serialTripsRemaining, 3);
  assert.deepEqual(row.dispatchIds, ['visible-dispatch']);
  assert.deepEqual(result.summary, {available: 0, allocated: 1, total: 1, unavailable: 0});
  assert.equal(result.operationalSummary.busy, 1);
});

test('unknown or missing authoritative fleet status fails closed instead of advertising a truck as available', () => {
  for (const fleet of [
    [{...trucks[0], status: 'unexpected-status', activeTripId: null, nextTripId: null, queuedTrips: 0}],
    [{...trucks[0], activeTripId: null, nextTripId: null, queuedTrips: 0}],
    []
  ]) {
    const result = buildFleetView({trucks: [trucks[0]], fleet, trips: []});
    assert.equal(result.rows[0].operationalStatus, 'unknown');
    assert.equal(result.rows[0].assignmentStatus, 'unavailable');
    assert.equal(result.summary.available, 0);
    assert.equal(result.operationalSummary.unknown, 1);
    assert.equal(paginateFleet(result.rows, {filter: 'available'}).total, 0);
  }
  assert.equal(buildFleetView({trucks: [trucks[0]], trips: []}).summary.available, 1, 'Legacy-only callers retain their explicit compatibility path');
});

test('actual three-trip serial queue stays allocated between own returns and releases only after its final trip', () => {
  const state = createSeed(), admin = {id: 'serial-view-admin', role: 'admin'};
  const driver = {id: 'serial-view-driver', role: 'driver', username: 'serial-driver', active: true}, options = {drivers: [driver]};
  state.products.find(product => product.id === 'split-12').densityTPerM3 = 2;
  for (const pile of state.stockpiles.filter(pile => pile.skuId === 'split-12')) pile.onHandM3 = pile.crusherId === 'crusher-1' ? 200 : 0;
  state.trucks = [{...state.trucks[0], bedM3: 30, payloadLimitT: 40}];
  const action = (name, payload, actor = admin) => applyIntegratedAction(state, name, payload, actor, options);
  const request = quantity => action('request.create', {transferMode: 'MARINE', destinationLocationId: 'stockpile-location-crusher-2', jettyId: 'jetty-1', vesselId: 'vessel-1', lines: [{skuId: 'split-12', quantity, unit: 't'}]}).entityId;
  const view = (actor = admin) => buildFleetView(integratedView(state, actor, options));
  const requestId = request(120); action('request.plan', {requestId});
  const serial = state.trips.filter(trip => trip.requestId === requestId).sort((a, b) => a.sequence - b.sequence);
  assert.equal(serial.length, 3);
  assert.ok(serial.every(trip => trip.truckId === state.trucks[0].id && trip.assignedDriverUserId === driver.id));
  const waitingRequestId = request(20); action('request.plan', {requestId: waitingRequestId});
  const waits = () => state.trips.filter(trip => trip.requestId === waitingRequestId);
  assert.ok(waits().every(trip => trip.status === 'waiting_truck' && trip.truckId === null));
  let fleet = view(), row = fleet.rows[0];
  assert.equal(row.operationalStatus, 'allocated');
  assert.equal(row.serialTripsRemaining, 3);
  assert.equal(row.queuedTrips, 3);
  assert.equal(row.activeTripId, null);
  assert.equal(row.nextTripId, serial[0].id);
  assert.equal(row.dispatchId, serial[0].dispatchId);
  const stock = {id: 'serial-origin-stock', role: 'stock', crusherIds: [serial[0].crusherId]};
  const jetty = {id: 'serial-receiving-jetty', role: 'jetty', jettyIds: ['jetty-1']};
  action('trip.qr', {tripId: serial[1].id});
  action('trip.tare', {tripId: serial[1].id, weightT: 20}, stock);
  assert.equal(view().rows[0].operationalStatus, 'allocated', 'Future QR/tare proof alone cannot count as execution');
  assert.throws(() => action('trip.start', {tripId: serial[1].id}, driver), error => error.code === 'QUEUE_ORDER');
  const finish = (trip, remainingAfter) => {
    const current = state.trips.find(item => item.id === trip.id);
    if (!current.qrScannedAt) action('trip.qr', {tripId: trip.id});
    if (!current.weighingEvents.some(event => event.type === 'TARE')) action('trip.tare', {tripId: trip.id, weightT: 20}, stock);
    assert.equal(view().rows[0].operationalStatus, 'allocated');
    action('trip.start', {tripId: trip.id}, driver);
    const busy = view().rows[0];
    assert.equal(busy.operationalStatus, 'busy');
    assert.equal(busy.activeTripId, trip.id);
    assert.equal(busy.activeTrip.id, trip.id);
    assert.equal(busy.serialTripsRemaining, remainingAfter + 1);
    const hidden = view({id: 'serial-unrelated-jetty', role: 'jetty', jettyIds: ['jetty-2']}).rows[0];
    assert.equal(hidden.operationalStatus, 'busy');
    assert.equal(hidden.activeTripId, null); assert.equal(hidden.nextTripId, null);
    assert.equal(hidden.assignedTrip, null); assert.deepEqual(hidden.dispatchIds, []);
    action('trip.loading', {tripId: trip.id}, stock);
    action('trip.gross', {tripId: trip.id, weightT: 20 + current.tonnageT}, stock);
    action('trip.depart', {tripId: trip.id}, stock);
    action('trip.arrive', {tripId: trip.id}, jetty);
    action('trip.receive', {tripId: trip.id}, jetty);
    action('trip.return_start', {tripId: trip.id}, driver);
    assert.equal(view().rows[0].operationalStatus, 'busy', 'Receiving alone never releases the assignment');
    action('trip.return', {tripId: trip.id}, stock);
  };
  for (const [index, trip] of serial.entries()) {
    finish(trip, serial.length - index - 1);
    row = view().rows[0];
    assert.equal(row.operationalStatus, 'allocated');
    assert.equal(row.activeTripId, null);
    if (index < serial.length - 1) {
      assert.equal(row.serialTripsRemaining, serial.length - index - 1);
      assert.equal(row.nextTripId, serial[index + 1].id);
      assert.equal(row.dispatchId, serial[0].dispatchId);
      assert.ok(waits().every(waiting => waiting.status === 'waiting_truck' && waiting.truckId === null));
    } else {
      assert.equal(state.requests.find(item => item.id === requestId).status, 'completed');
      assert.equal(waits().length, 1);
      assert.equal(waits()[0].status, 'queued');
      assert.equal(row.dispatchId, waits()[0].dispatchId, 'The next dispatch receives the truck only after its own previous queue ends');
      assert.equal(row.nextTripId, waits()[0].id);
      assert.equal(row.serialTripsRemaining, 1);
    }
  }
  finish(waits()[0], 0);
  fleet = view(); row = fleet.rows[0];
  assert.deepEqual(fleet.summary, {available: 1, allocated: 0, total: 1, unavailable: 0});
  assert.equal(row.operationalStatus, 'available');
  assert.equal(row.bindingStatus, 'NONE');
  assert.equal(row.serialTripsRemaining, 0); assert.equal(row.queuedTrips, 0);
  assert.equal(row.activeTripId, null); assert.equal(row.nextTripId, null);
  assert.equal(row.assignedTrip, null); assert.deepEqual(row.dispatchIds, []);
  assert.equal(state.vessels.find(vessel => vessel.id === 'vessel-1').loadedT, 140);
  assert.equal(state.stockpiles.find(pile => pile.id === 'stock-1-3').reservedM3, 0);
});
