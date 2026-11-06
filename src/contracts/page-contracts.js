import { legacyNavigationByRole } from '../app/navigation.js';

/**
 * Frontend page-data contract revision 1.0.
 * These declarations are TARGET CONTRACTS, not evidence of deployed endpoints.
 * Required field lists describe response DTO requirements; they do not assert
 * that the existing /api/state snapshot already supplies those fields.
 */
export const PAGE_CONTRACT_VERSION = '1.0';
export const DATA_STATE = Object.freeze({
  LOADING: 'LOADING',
  READY: 'READY',
  EMPTY: 'EMPTY',
  STALE: 'STALE',
  ERROR: 'ERROR',
  FORBIDDEN: 'FORBIDDEN',
  NOT_INTEGRATED: 'NOT_INTEGRATED',
});

const definition = (endpoint, fields, permissions, events = []) =>
  Object.freeze({ endpoint, fields: Object.freeze(fields), permissions: Object.freeze(permissions), events: Object.freeze(events) });

export const targetPageContracts = Object.freeze({
  ADMIN: Object.freeze({
    overview: definition('/api/v1/operations/overview',
      ['as_of', 'active_dispatches', 'active_trips', 'needs_attention', 'inventory_summary', 'fleet_summary'], ['operations.read'], ['TRIP_DEPARTED', 'EXCEPTION_OPENED']),
    transfers: definition('/api/v1/transfer-requests',
      ['id', 'code', 'mode', 'status', 'lines', 'destination_id', 'destination_allocations', 'created_at'], ['transfer.read'], ['TRANSFER_REQUEST_UPDATED']),
    landFleetAllocation: definition('/api/v1/transfer-requests/{requestId}/fleet-allocation',
      ['request_id', 'requested_quantity', 'available_trucks', 'eligible_trucks', 'recommended_trucks', 'estimated_trips', 'busy_trucks', 'trucks', 'lines', 'assigned_driver_id', 'status', 'reasons'], ['dispatch.plan']),
    dispatchPlanning: definition('/api/v1/dispatches',
      ['id', 'mode', 'status', 'allocation_id', 'source_stockpile_id', 'voyage_id', 'planned_quantity_t'], ['dispatch.plan'], ['DISPATCH_READY']),
    dispatchMonitoring: definition('/api/v1/dispatches',
      ['id', 'mode', 'status', 'trips', 'sequence_eligibility', 'active_resource_claims'], ['dispatch.read'], ['TRIP_UNLOADED_VERIFIED', 'MARINE_SEQUENCE_RELEASED']),
    inventory: definition('/api/v1/inventory',
      ['stockpile_id', 'sku_id', 'on_hand_t', 'reserved_t', 'available_t', 'as_of'], ['inventory.read'], ['INVENTORY_DISCREPANCY_OPENED']),
    exceptions: definition('/api/v1/exceptions',
      ['id', 'status', 'severity', 'reference_id', 'recovery_action'], ['exception.read'], ['EXCEPTION_OPENED']),
    masterData: definition('/api/v1/master-data',
      ['skus', 'locations', 'stockpiles', 'trucks', 'drivers', 'vessels', 'voyages'], ['master.read'], ['MASTER_UPDATED']),
    auditIntegration: definition('/api/v1/operational-events',
      ['event_id', 'event_type', 'aggregate_id', 'occurred_at', 'source_system'], ['audit.read'], ['INTEGRATION_EVENT_UPDATED']),
  }),
  STOCKPILE: Object.freeze({
    home: definition('/api/v1/stockpile/me/pickups',
      ['location_id', 'expected_pickups', 'stock_summary', 'as_of'], ['stockpile.home.read'], ['TRIP_ASSIGNED']),
    inventory: definition('/api/v1/inventory',
      ['stockpile_id', 'sku_id', 'on_hand_t', 'reserved_t', 'available_t', 'as_of'], ['stockpile.inventory.read'], ['INVENTORY_DISCREPANCY_OPENED']),
    pickups: definition('/api/v1/stockpile/me/pickups',
      ['trip_id', 'truck_identifier', 'sku_id', 'planned_quantity_t', 'status'], ['stockpile.pickups.read'], ['TRIP_TARE_CONFIRMED']),
    activity: definition('/api/v1/stockpile/me/receipts',
      ['trip_id', 'destination_location_id', 'receipt_status', 'received_quantity_t'], ['stockpile.activity.read'], ['TRIP_UNLOADED_VERIFIED']),
  }),
  DRIVER: Object.freeze({
    home: definition('/api/v1/driver/me/active-trip',
      ['trip_id', 'assignment_id', 'truck_id', 'current_state', 'next_action', 'source_location_id', 'destination_location_id'], ['driver.trip.read.self'], ['TRIP_ASSIGNED']),
    tasks: definition('/api/v1/driver/trips/{tripId}/checklist',
      ['trip_id', 'checklist_items', 'responses', 'completion_status'], ['driver.checklist.read.self'], ['TRIP_CHECKLIST_UPDATED']),
    history: definition('/api/v1/driver/me/trips',
      ['trip_id', 'dispatch_id', 'final_state', 'started_at', 'returned_available_at'], ['driver.trip.read.self'], ['TRIP_RETURNED_AVAILABLE']),
    profile: definition('/api/v1/session',
      ['user_id', 'role', 'driver_id', 'permissions'], ['session.read']),
  }),
});

/**
 * Legacy snapshot bridge: only fields that are actually present in the
 * existing /api/state can be projected. Unknown ≠ zero; missing
 * measurements/evidence are reported as null and NOT_INTEGRATED.
 */
const asRows = (state, name) => Array.isArray(state?.[name]) ? state[name] : [];
const finiteOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
};
const realQuantity = value => finiteOrNull(value);
const legacyRole = role => role === 'STOCKPILE' ? 'stock' : role === 'ADMIN' ? 'admin' : role;
export const visibleLegacyPages = role => [...(legacyNavigationByRole[legacyRole(role)] || [])];

/**
 * @param {{role: string, page: string, state?: object|null, connected?: boolean}} input
 */
export function legacyPageDataContract({ role, page, state = null, connected = true }) {
  const allowed = visibleLegacyPages(role);
  if (role === 'driver' || role === 'DRIVER') {
    return {
      version: PAGE_CONTRACT_VERSION, role, page, source: 'NOT_CONNECTED',
      dataState: DATA_STATE.NOT_INTEGRATED, records: [],
      marineSequenceEligibility: null, truckResourceClaims: null,
    };
  }
  if (!allowed.includes(page)) {
    return { version: PAGE_CONTRACT_VERSION, role, page, source: 'LEGACY_STATE',
      dataState: DATA_STATE.FORBIDDEN, records: [] };
  }
  if (!state) {
    return { version: PAGE_CONTRACT_VERSION, role, page, source: 'LEGACY_STATE',
      dataState: DATA_STATE.LOADING, records: [] };
  }
  const stockpiles = asRows(state, 'stockpiles');
  const trips = asRows(state, 'trips');
  let records = [];
  switch (page) {
    case 'inventory':
      records = stockpiles.map(x => {
        const onHandM3 = realQuantity(x.onHandM3);
        const reservedM3 = realQuantity(x.reservedM3);
        return {
          stockpileId: x.id,
          skuId: x.skuId,
          sourceCrusherId: x.crusherId,
          onHandM3,
          reservedM3,
          availableM3: onHandM3 === null || reservedM3 === null ? null : onHandM3 - reservedM3,
          // v1 target uses verified tonnage; legacy stores m3. Never cast m3 to ton.
          onHandT: null, reservedT: null, availableT: null,
          unit: 'm3', source: 'LEGACY_SNAPSHOT',
        };
      });
      break;
    case 'overview':
      records = [{
        asOf: state.updatedAt ?? null,
        stockpileCount: stockpiles.length,
        tripCount: trips.length,
        actualVerifiedNetT: null,
        verifiedWeighbridgeSource: null,
      }];
      break;
    case 'home':
      records = [{
        asOf: state.updatedAt ?? null,
        stockpileCount: stockpiles.length,
        pickupCount: trips.length,
        actualVerifiedNetT: null,
        verifiedWeighbridgeSource: null,
      }];
      break;
    case 'pickups':
      records = trips.map(x => ({
        id: x.id, status: x.status, truckId: x.truckId, stockpileId: x.stockpileId,
        plannedVolumeM3: realQuantity(x.volumeM3), plannedTonnageT: realQuantity(x.tonnageT),
        actualVerifiedNetT: null,
      }));
      break;
    case 'activity':
      records = [
        ...asRows(state, 'events').map(x => ({id:x.id,kind:'event',occurredAt:x.at ?? null})),
        ...asRows(state, 'inventoryLedger').map(x => ({id:x.id,kind:'inventory',occurredAt:x.at ?? null})),
      ];
      break;
    case 'requests':
      records = asRows(state, 'requests').map(x => ({
        id: x.id, code: x.code, status: x.status, lines: x.lines ?? [],
        destinationAllocations: null,
        transportMode: null,
      }));
      break;
    case 'dispatch':
      records = asRows(state, 'dispatches').map(x => ({
        id: x.id, code: x.code ?? null, status: x.status ?? null,
        transportMode: null, marineSequenceEligibility: null,
        unloadEvidence: null, activeResourceClaims: null,
      }));
      break;
    case 'jetty':
      records = asRows(state, 'jetties').map(x => ({
        id: x.id, code: x.code, name: x.name,
        receivingPermission: null, isLegacyRole: true,
      }));
      break;
    case 'master':
      records = [
        ...asRows(state, 'products').map(x => ({ id: x.id, kind: 'sku', code: x.code })),
        ...asRows(state, 'trucks').map(x => ({ id: x.id, kind: 'truck', code: x.code })),
      ];
      break;
    case 'audit':
      records = asRows(state, 'events').map(x => ({
        id: x.id ?? null, eventType: x.type ?? x.action ?? null,
        occurredAt: x.createdAt ?? x.timestamp ?? null,
      }));
      break;
    default:
      records = [];
  }
  return {
    version: PAGE_CONTRACT_VERSION, role, page, source: 'LEGACY_STATE',
    dataState: !connected ? DATA_STATE.STALE : records.length ? DATA_STATE.READY : DATA_STATE.EMPTY,
    records,
    marineSequenceEligibility: null,
    truckResourceClaims: null,
  };
}
