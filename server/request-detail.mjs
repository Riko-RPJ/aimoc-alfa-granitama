import {integratedView} from './integrated-demo-domain.mjs';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const fail = (message, code, status) => {throw Object.assign(new Error(message), {code, status});};
const text = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const ref = value => validId(value) ? value : null;
const statusOf = trip => String(trip.status || '').toLowerCase();
const historical = trip => ['returned', 'completed', 'cancelled'].includes(statusOf(trip));
const waitingStatuses = new Set(['waiting_truck', 'waiting_driver', 'waiting_assignment', 'awaiting_assignment', 'unassigned']);
const round = value => Math.round(value * 1e6) / 1e6;
const sum = (rows, key) => round(rows.reduce((total, row) => total + (number(row[key]) || 0), 0));
const received = trip => Boolean(trip.receivedAt || trip.unloadedAt || trip.receiptCode);

function totals(trips) {
  const delivered = trips.filter(received), cancelled = trips.filter(trip => statusOf(trip) === 'cancelled');
  const plannedT = sum(trips, 'tonnageT'), plannedM3 = sum(trips, 'volumeM3');
  const deliveredT = sum(delivered, 'tonnageT'), deliveredM3 = sum(delivered, 'volumeM3');
  return {tripCount: trips.length, assignedTruckCount: new Set(trips.filter(trip => trip.qr).map(trip => trip.truckId)).size, assignedTrips: trips.filter(trip => trip.qr).length, waitingTrips: trips.filter(trip => !trip.qr).length, queuedTrips: trips.filter(trip => statusOf(trip) === 'queued').length, activeTrips: trips.filter(trip => !historical(trip) && statusOf(trip) !== 'queued' && !waitingStatuses.has(statusOf(trip))).length, completedTrips: trips.filter(trip => ['returned', 'completed'].includes(statusOf(trip))).length, cancelledTrips: cancelled.length, receivedTrips: delivered.length, plannedT, plannedM3, deliveredT, deliveredM3, remainingT: round(Math.max(0, plannedT - deliveredT - sum(cancelled.filter(trip => !received(trip)), 'tonnageT'))), remainingM3: round(Math.max(0, plannedM3 - deliveredM3 - sum(cancelled.filter(trip => !received(trip)), 'volumeM3')))};
}

function driverInfo(trip, drivers) {
  const id = ref(trip.assignedDriverUserId);
  if (!id) return null;
  const user = drivers.find(driver => driver?.id === id && driver.role === 'driver');
  return {id, name: text(user?.name || user?.displayName || user?.username || trip.driverName || id), username: text(user?.username, 80), active: typeof user?.active === 'boolean' ? user.active : null};
}

function locationFields(record) {
  return {destination: text(record.destination), destinationId: ref(record.destinationId), destinationLocationId: ref(record.destinationLocationId), destinationLocationCode: text(record.destinationLocationCode, 64), destinationLocationName: text(record.destinationLocationName), jettyId: ref(record.jettyId), vesselId: ref(record.vesselId)};
}

/**
 * A read projection only. Authorization is inherited from integratedView;
 * global fleet metrics, raw users, ERP payloads and arbitrary row fields never
 * cross this boundary. QR values are assignment references, not credentials.
 */
export function requestDetail(state, actor, {requestId, drivers = []} = {}) {
  if (!validId(requestId)) fail('ID permintaan tidak valid.', 'INVALID_REQUEST_ID', 400);
  const catalog = Array.isArray(drivers) ? drivers : [];
  const view = integratedView(state, actor, {drivers: catalog});
  const canonicalRequest = view.requests.find(request => request.id === requestId);
  if (!canonicalRequest) fail('Permintaan tidak ditemukan.', 'NOT_FOUND', 404);
  const selectedDispatches = view.dispatches.filter(dispatch => dispatch.requestId === requestId);
  const dispatchIds = new Set(selectedDispatches.map(dispatch => dispatch.id));
  const rawTrips = view.trips.filter(trip => trip.requestId === requestId).sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || a.id.localeCompare(b.id));
  const trips = rawTrips.map(trip => {
    const truck = view.trucks.find(row => row.id === trip.truckId);
    const product = view.products.find(row => row.id === trip.skuId);
    const driver = driverInfo(trip, catalog);
    const dispatchId = validId(trip.dispatchId) && dispatchIds.has(trip.dispatchId) ? trip.dispatchId : null;
    let waitingReason = null;
    if (waitingStatuses.has(statusOf(trip))) waitingReason = statusOf(trip).toUpperCase();
    else if (!validId(trip.id) || !dispatchId) waitingReason = 'DISPATCH_REFERENCE_INVALID';
    else if (!validId(trip.truckId) || !truck) waitingReason = 'TRUCK_NOT_ASSIGNED';
    else if (!driver) waitingReason = 'DRIVER_NOT_ASSIGNED';
    const qr = waitingReason ? null : {value: JSON.stringify({v: 1, type: 'AIMOC_ASSIGNMENT_REFERENCE', requestId, dispatchId, tripId: trip.id, truckId: truck.id}), isAuthorization: false, physicalScan: false, historical: historical(trip)};
    const row = {id: ref(trip.id), code: text(trip.code, 64), requestId, dispatchId, truckId: truck && validId(trip.truckId) ? truck.id : null, truckCode: text(truck?.code, 64), plate: text(truck?.plate, 80), assignedDriverUserId: driver?.id || null, assignedDriver: driver, status: text(trip.status, 64), sequence: number(trip.sequence), skuId: ref(trip.skuId), skuCode: text(product?.code, 64), skuName: text(product?.name), volumeM3: number(trip.volumeM3), tonnageT: number(trip.tonnageT), ...locationFields(trip), sourceStockpileId: ref(trip.stockpileId), sourceStockpileCode: text(trip.sourceStockpileCode, 64), sourceCrusherCode: text(trip.sourceCrusherCode, 64), destinationStockpileId: ref(trip.destinationStockpileId), destinationStockpileCode: text(trip.destinationStockpileCode, 64), destinationCrusherCode: text(trip.destinationCrusherCode, 64), jettyCode: text(view.jetties.find(row => row.id === trip.jettyId)?.code, 64), vesselName: text(view.vessels.find(row => row.id === trip.vesselId)?.name), createdAt: text(trip.createdAt, 40), estimatedStartAt: text(trip.estimatedStartAt, 40), estimatedReturnAt: text(trip.estimatedReturnAt, 40), startedAt: text(trip.startedAt, 40), departedAt: text(trip.departedAt, 40), arrivedAt: text(trip.arrivedAt, 40), receivedAt: text(trip.receivedAt, 40), unloadedAt: text(trip.unloadedAt, 40), returnedAt: text(trip.returnedAt, 40), receiptCode: text(trip.receiptCode, 64), historical: historical(trip), qr, waitingReason};
    row.displayStatus = text(trip.displayStatus || trip.status, 64);
    row.quantitySource = text(trip.quantitySource, 64);
    if (trip.driverScan && typeof trip.driverScan === 'object' && !Array.isArray(trip.driverScan)) {
      const scan = trip.driverScan;
      row.driverScan = {mode:text(scan.mode,64),phase:text(scan.phase,64),origin:text(scan.origin,64),nextStage:[1,2].includes(scan.nextStage)?scan.nextStage:null,canScan:scan.canScan===true,reason:text(scan.reason),firstScannedAt:text(scan.firstScannedAt,40),secondScannedAt:text(scan.secondScannedAt,40),quantityBasis:text(scan.quantityBasis,64),measurementPending:typeof scan.measurementPending==='boolean'?scan.measurementPending:null};
    }
    if (validId(trip.assignmentId)) row.assignmentId = trip.assignmentId;
    return row;
  });
  const truckAssignments = [];
  for (const trip of trips.filter(trip => trip.qr)) {
    let group = truckAssignments.find(group => group.truckId === trip.truckId);
    if (!group) {
      const truck = view.trucks.find(row => row.id === trip.truckId);
      group = {truckId: trip.truckId, truckCode: trip.truckCode, plate: trip.plate, active: typeof truck?.active === 'boolean' ? truck.active : null, bedM3: number(truck?.bedM3), payloadLimitT: number(truck?.payloadLimitT), assignedDriver: null, assignedDrivers: [], tripIds: [], trips: []};
      truckAssignments.push(group);
    }
    group.tripIds.push(trip.id); group.trips.push(trip);
    if (!group.assignedDrivers.some(driver => driver.id === trip.assignedDriver.id)) group.assignedDrivers.push(trip.assignedDriver);
  }
  for (const group of truckAssignments) {group.assignedDriver = group.assignedDrivers.length === 1 ? group.assignedDrivers[0] : null; group.summary = totals(group.trips);}
  const summary = totals(trips);
  const dispatches = selectedDispatches.map(dispatch => {
    const selected = trips.filter(trip => trip.dispatchId === dispatch.id);
    return {id: ref(dispatch.id), code: text(dispatch.code, 64), requestId, status: text(dispatch.status, 64), transferMode: text(dispatch.transferMode || canonicalRequest.transferMode, 16), createdAt: text(dispatch.createdAt, 40), ...locationFields(dispatch), tripIds: selected.map(trip => trip.id), summary: totals(selected)};
  });
  const lines = (canonicalRequest.lines || []).map(line => {
    const product = view.products.find(product => product.id === line.skuId);
    return {skuId: ref(line.skuId), skuCode: text(product?.code, 64), skuName: text(product?.name), quantity: number(line.quantity), unit: text(line.unit, 8), volumeM3: number(line.volumeM3), tonnageT: number(line.tonnageT)};
  });
  const request = {id: requestId, code: text(canonicalRequest.code, 64), status: text(canonicalRequest.status, 64), transferMode: text(canonicalRequest.transferMode, 16), deliveryStatus: text(canonicalRequest.deliveryStatus, 32), ...locationFields(canonicalRequest), createdAt: text(canonicalRequest.createdAt, 40), plannedAt: text(canonicalRequest.plannedAt, 40), lines, deliveredT: summary.deliveredT, deliveredM3: summary.deliveredM3, remainingT: summary.remainingT, remainingM3: summary.remainingM3, scoped: actor.role !== 'admin'};
  return {source: 'INTEGRATED_DEMO', request, dispatches, trips, truckAssignments, waitingLoads: trips.filter(trip => !trip.qr), summary, scoped: actor.role !== 'admin'};
}
