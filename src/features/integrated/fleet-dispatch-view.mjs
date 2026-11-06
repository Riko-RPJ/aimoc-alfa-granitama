const list = value => Array.isArray(value) ? value : [];
const terminal = new Set(['returned', 'cancelled']);
const open = trip => !!trip?.truckId && !terminal.has(trip.status);

/**
 * Fleet occupancy is global in the server context, even when trip details are
 * role-scoped. Never infer that a truck is free merely because its trip is hidden.
 * "Allocated" includes both queued assignments and work in progress until return.
 */
export function buildFleetView({trucks = [], fleet = [], trips = []} = {}) {
  const fleetById = new Map(list(fleet).map(truck => [truck.truckId || truck.id, truck]));
  const truckById = new Map();
  for (const truck of [...list(trucks), ...list(fleet)]) {
    const id = truck.truckId || truck.id;
    if (id && !truckById.has(id)) truckById.set(id, truck);
  }
  const assignments = new Map();
  for (const trip of list(trips).filter(open)) {
    const previous = assignments.get(trip.truckId);
    if (!previous || previous.status === 'queued' && trip.status !== 'queued') assignments.set(trip.truckId, trip);
  }
  const rows = [...truckById].map(([truckId, master]) => {
    const global = fleetById.get(truckId) || master;
    const truck = {...master, ...global};
    const assignedTrip = assignments.get(truckId) || null;
    const active = master.active !== false && global.active !== false;
    const queuedTrips = Math.max(0, Number(global.queuedTrips) || 0);
    const assigned = !!assignedTrip || ['busy', 'allocated'].includes(global.status) || !!global.busy || !!global.activeTripId || !!global.nextTripId || queuedTrips > 0;
    const busy = global.status === 'busy' || !!global.busy || !!global.activeTripId || !!assignedTrip && assignedTrip.status !== 'queued';
    const assignmentStatus = assigned ? 'allocated' : active && global.status !== 'unavailable' ? 'available' : 'unavailable';
    const operationalStatus = !active || global.status === 'unavailable' ? 'unavailable' : assigned ? busy ? 'busy' : 'allocated' : 'available';
    return {truckId, truck, active, assignmentStatus, operationalStatus, assignedTrip, assignedTripId: assignedTrip?.id || null, queuedTrips};
  });
  const summary = {available: 0, allocated: 0, total: rows.length, unavailable: 0};
  for (const row of rows) summary[row.assignmentStatus]++;
  return {rows, summary};
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
