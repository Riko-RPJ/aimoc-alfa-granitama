const list = value => Array.isArray(value) ? value : [];
const terminal = new Set(['returned', 'cancelled', 'completed']);
const executionStatuses = new Set(['ready_to_load','loading','weighed','in_transit','arrived','unloaded','returning']);
const canonicalStatuses = new Set(['available','allocated','busy','unavailable']);
const bindingStatuses = new Set(['NONE','DISPATCH','CONFLICT','LEGACY_HOLD']);
const open = trip => !!trip?.truckId && !terminal.has(trip.status);
const executing = trip => open(trip) && (!!trip.startedAt || executionStatuses.has(trip.status));
const unstarted = trip => open(trip) && (trip.status === 'queued' || trip.status === 'start_pending' && !trip.startedAt);
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** Canonical global operational state wins over role-scoped trip observations.
 * Allocated KPI means any retained claim (queued, executing, or held). The
 * separate operational summary and row status distinguish Allocated from Busy.
 * Legacy inference is restricted to callers without any global fleet/status DTO.
 */
export function buildFleetView(input = {}) {
  const {trucks = [], fleet = [], trips = []} = input;
  const hasProjection = Object.hasOwn(input, 'fleet');
  const fleetById = new Map(list(fleet).map(truck => [truck.truckId || truck.id, truck]));
  const truckById = new Map();
  for (const truck of [...list(trucks), ...list(fleet)]) {
    const id = truck.truckId || truck.id;
    if (id && !truckById.has(id)) truckById.set(id, truck);
  }
  const rows = [...truckById].map(([truckId, master]) => {
    const projection = fleetById.get(truckId), global = projection || master;
    const truck = {...master, ...global};
    const visible = list(trips).filter(trip => trip.truckId === truckId && open(trip)).sort((a,b) => (Number(a.sequence)||0)-(Number(b.sequence)||0));
    const legacy = !hasProjection && !projection && !Object.hasOwn(master, 'status');
    const active = master.active !== false && global.active !== false;
    const known = canonicalStatuses.has(global.status);
    const claimed = !!global.dispatchId || list(global.dispatchIds).length > 0 || !!global.activeTripId || !!global.nextTripId || count(global.serialTripsRemaining) > 0 || count(global.queuedTrips) > 0 || ['DISPATCH','CONFLICT','LEGACY_HOLD'].includes(global.bindingStatus);
    let operationalStatus, assigned;
    if (known) {
      operationalStatus = global.status;
      assigned = global.status === 'allocated' || global.status === 'busy' || global.status === 'unavailable' && claimed;
    } else if (legacy) {
      assigned = claimed || visible.length > 0;
      operationalStatus = !active ? 'unavailable' : assigned ? visible.some(executing) ? 'busy' : 'allocated' : 'available';
    } else {
      operationalStatus = 'unknown';
      assigned = claimed || visible.length > 0;
    }
    const assignmentStatus = assigned ? 'allocated' : operationalStatus === 'available' ? 'available' : 'unavailable';
    const findVisible = id => id ? visible.find(trip => trip.id === id) || null : null;
    const activeTripId = global.activeTripId || (legacy ? visible.find(executing)?.id : null) || null;
    const nextTripId = global.nextTripId || (legacy ? visible.find(unstarted)?.id : null) || null;
    const activeTrip = findVisible(activeTripId), nextTrip = findVisible(nextTripId);
    const assignedTrip = operationalStatus === 'busy' ? activeTrip : operationalStatus === 'allocated' ? nextTrip : legacy ? activeTrip || nextTrip : null;
    const dispatchIds = Array.isArray(global.dispatchIds) ? [...global.dispatchIds] : legacy ? [...new Set(visible.map(trip=>trip.dispatchId).filter(Boolean))] : [];
    const dispatchId = global.dispatchId || (legacy && dispatchIds.length === 1 ? dispatchIds[0] : null) || null;
    const bindingStatus = bindingStatuses.has(global.bindingStatus) ? global.bindingStatus : legacy ? dispatchIds.length > 1 ? 'CONFLICT' : dispatchId ? 'DISPATCH' : assigned ? 'LEGACY_HOLD' : 'NONE' : 'UNKNOWN';
    const queuedTrips = count(global.queuedTrips) ?? (legacy ? visible.filter(unstarted).length : null);
    const serialTripsRemaining = count(global.serialTripsRemaining) ?? (legacy ? visible.length : null);
    return {truckId, truck, active, assignmentStatus, operationalStatus, assignedTrip, assignedTripId: assignedTrip?.id || null, activeTrip, nextTrip, activeTripId, nextTripId, queuedTrips, serialTripsRemaining, dispatchId, dispatchIds, bindingStatus};
  });
  const summary = {available: 0, allocated: 0, total: rows.length, unavailable: 0};
  const operationalSummary = {available:0, allocated:0, busy:0, unavailable:0, unknown:0, total:rows.length};
  for (const row of rows) { summary[row.assignmentStatus]++; operationalSummary[row.operationalStatus]++; }
  return {rows, summary, operationalSummary};
}

/** Pagination applies after filtering; clamping also handles a live status change. */
export function paginateFleet(rows, {filter = 'all', page = 1, pageSize = 3} = {}) {
  const selectedFilter = ['available', 'allocated'].includes(filter) ? filter : 'all';
  const selected = list(rows).filter(row => selectedFilter === 'all' || row.assignmentStatus === selectedFilter);
  const size = Number.isFinite(Number(pageSize)) ? Math.max(1, Math.floor(Number(pageSize))) : 3;
  const pageCount = Math.max(1, Math.ceil(selected.length / size));
  const current = Number.isFinite(Number(page)) ? Math.min(pageCount, Math.max(1, Math.floor(Number(page)))) : 1;
  const offset = (current - 1) * size;
  return {rows: selected.slice(offset, offset + size), page: current, pageCount, total: selected.length, pageSize: size, filter: selectedFilter, start: selected.length ? offset + 1 : 0, end: Math.min(offset + size, selected.length)};
}

/** Call with role-accessible trips. Extra dispatch metadata never adds options. */
export function buildDispatchGroups(trips, dispatches, {dispatchId = 'all'} = {}) {
  const metadata = new Map(list(dispatches).map(dispatch => [dispatch.id, dispatch]));
  const groupsById = new Map();
  for (const trip of list(trips)) {
    const id = trip.dispatchId || '__without_dispatch__';
    if (!groupsById.has(id)) {
      const dispatch = metadata.get(trip.dispatchId) || null;
      groupsById.set(id, {dispatchId: id, dispatch, code: dispatch?.code || trip.dispatchId || '—', trips: []});
    }
    groupsById.get(id).trips.push(trip);
  }
  const allGroups = [...groupsById.values()];
  return {groups: allGroups.filter(group => dispatchId === 'all' || group.dispatchId === dispatchId), options: allGroups.map(group => ({id: group.dispatchId, code: group.code, count: group.trips.length}))};
}
