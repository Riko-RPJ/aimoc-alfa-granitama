const one=async(c,sql,args=[]) => (await c.query(sql,args)).rows[0];

/** Queued assignments reserve a place in line, never an occupied truck/driver. */
export async function requireFleetQueueTurn(c,trip){
  const assignments=await one(c,"SELECT to_regclass('aimoc_execution_v1.trip_driver_assignments') AS oid");
  if(!assignments?.oid)return; // Pre-4G isolated service fixtures have no assignment queue.
  // These authoritative master locks serialize competing starts for either resource.
  await c.query('SELECT id FROM aimoc_execution_v1.driver_profiles WHERE id=$1 FOR UPDATE',[trip.driver_id]);
  await c.query('SELECT truck_id FROM aimoc_execution_v1.fleet_vehicle_specs WHERE truck_id=$1 FOR UPDATE',[trip.truck_id]);
  const assignment=await one(c,`SELECT * FROM aimoc_execution_v1.trip_driver_assignments
    WHERE trip_id=$1 AND driver_id=$2 AND truck_id=$3 AND status='ASSIGNED'`,
    [trip.id,trip.driver_id,trip.truck_id]);
  if(!assignment)throw Object.assign(new Error('Matching active Driver and truck assignment required'),{code:'DRIVER_ASSIGNMENT_REQUIRED',status:409});
  const earlier=await one(c,`SELECT t.id FROM aimoc_execution_v1.trip_driver_assignments a
    JOIN aimoc_execution_v1.trips t ON t.id=a.trip_id
    WHERE a.status='ASSIGNED' AND t.status NOT IN ('RETURNED_AVAILABLE','CANCELLED')
      AND (a.truck_id=$1 OR a.driver_id=$2) AND t.id<>$3
      AND (a.assigned_at,t.dispatch_id,t.sequence_no,t.id)<
        (SELECT current_a.assigned_at,current_t.dispatch_id,current_t.sequence_no,current_t.id
          FROM aimoc_execution_v1.trip_driver_assignments current_a
          JOIN aimoc_execution_v1.trips current_t ON current_t.id=current_a.trip_id
          WHERE current_t.id=$3)
    ORDER BY a.assigned_at,t.dispatch_id,t.sequence_no,t.id LIMIT 1`,
    [trip.truck_id,trip.driver_id,trip.id]);
  if(earlier)throw Object.assign(new Error('Earlier truck or Driver assignment must return before this queued trip starts'),
    {code:'FLEET_QUEUE_NOT_READY',status:409});
}
