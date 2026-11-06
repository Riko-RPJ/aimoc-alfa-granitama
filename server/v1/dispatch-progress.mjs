import {randomUUID} from 'node:crypto';
const one=async(c,sql,args=[]) => (await c.query(sql,args)).rows[0];

/** Called with the parent's dispatch row locked, inside the receipt/unload/return transaction. */
export async function refreshDispatchProgress(c,dispatchId){
  const custody=await one(c,"SELECT to_regclass('aimoc_execution_v1.cargo_custody') AS oid");
  if(!custody?.oid)return null; // No quantity evidence in the earlier execution-only schema.
  const d=await one(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1 FOR UPDATE',[dispatchId]);
  if(!d||!['ACTIVE','DELIVERY_COMPLETED'].includes(d.status))return d?.status??null;
  const proof=await one(c,`SELECT count(*)::int AS trips,
    bool_and(COALESCE(t.status IN ('UNLOADED_VERIFIED','RETURNING','RETURNED_AVAILABLE')
      AND t.unloaded_verified_at IS NOT NULL AND cargo.status='RECEIVED'
      AND cargo.shipped_t=cargo.received_t AND cargo.received_t>0
      AND cargo.received_t=(SELECT COALESCE(SUM(r.received_t),0) FROM aimoc_execution_v1.receipts r
        WHERE r.trip_id=t.id AND r.status='VERIFIED' AND r.verified_at IS NOT NULL),false)) AS delivered,
    bool_and(t.status='RETURNED_AVAILABLE' AND t.returned_available_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM aimoc_execution_v1.resource_claims claim
        WHERE claim.trip_id=t.id AND claim.released_at IS NULL)) AS returned,
    COALESCE(SUM(cargo.received_t),0) AS received_t,
    COALESCE(SUM(cargo.received_t),0)>=$2::numeric AS quantity_fulfilled
    FROM aimoc_execution_v1.trips t LEFT JOIN aimoc_execution_v1.cargo_custody cargo ON cargo.trip_id=t.id
    WHERE t.dispatch_id=$1`,[dispatchId,d.planned_quantity_t]);
  // A fully delivered but underloaded plan remains ACTIVE, with its shortfall visible.
  if(!proof.trips||proof.delivered!==true||!proof.quantity_fulfilled)return d.status;
  const next=proof.returned?'CLOSED':'DELIVERY_COMPLETED';
  if(next!==d.status){
    await c.query('UPDATE aimoc_execution_v1.dispatches SET status=$1 WHERE id=$2',[next,dispatchId]);
    await c.query(`INSERT INTO aimoc_execution_v1.integration_outbox(id,aggregate_id,event_type,payload)
      VALUES($1,$2,$3,$4::jsonb)`,[randomUUID(),dispatchId,'DISPATCH_'+next,
      JSON.stringify({dispatch_id:dispatchId,status:next,verified_received_t:proof.received_t})]);
  }
  return next;
}
