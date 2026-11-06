import {randomUUID,createHash} from 'node:crypto';
import {reconcilePendingWeighbridgeEventsInTransaction} from './phase4b-weighbridge.mjs';
import {refreshDispatchProgress} from './dispatch-progress.mjs';
const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const row=async(c,sql,args=[]) => (await c.query(sql,args)).rows[0];
const sum=xs=>xs.reduce((a,x)=>a+Number(x),0);
const fixed=n=>Number(n).toFixed(6);
const positive=x=>typeof x==='string'&&/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(x)&&Number(x)>0;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function idempotent(c,actorId,key,command,payload,fn){
  if(!actorId||typeof key!=='string'||key.length<6||key.length>120)fail('IDEMPOTENCY_REQUIRED','Stable idempotency key required',400);
  await c.query('INSERT INTO aimoc_execution_v1.idempotency_locks(actor_id,idempotency_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[actorId,key]);
  await c.query('SELECT 1 FROM aimoc_execution_v1.idempotency_locks WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actorId,key]);
  const digest=hash([command,payload]);
  const prior=await row(c,'SELECT command_hash,result FROM aimoc_execution_v1.command_receipts WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actorId,key]);
  if(prior){
    if(prior.command_hash!==digest)fail('IDEMPOTENCY_KEY_REUSED','Duplicate key with different payload');
    return {...prior.result,replayed:true};
  }
  const result=await fn();
  await c.query('INSERT INTO aimoc_execution_v1.command_receipts(actor_id,idempotency_key,command_hash,result) VALUES($1,$2,$3,$4::jsonb)',
    [actorId,key,digest,JSON.stringify(result)]);
  return result;
}
async function permission(c,actorId,locationId,perm){
  const ok=await row(c,'SELECT 1 AS ok FROM aimoc_execution_v1.operator_permissions WHERE actor_id=$1 AND location_id=$2 AND permission=$3',[actorId,locationId,perm]);
  if(!ok)fail('FORBIDDEN_SCOPE','Operator lacks independently authorized location permission',403);
}
async function outbox(c,aggregate,event_type,payload){
  await c.query('INSERT INTO aimoc_execution_v1.integration_outbox(id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)',
    [randomUUID(),aggregate,event_type,JSON.stringify(payload)]);
}
/** Stock reservation is a commitment; it must not change on-hand. */
export async function reserveDispatchInventory(db,{actorId,idempotencyKey,dispatchId}){
  return db.transaction(async c=>idempotent(c,actorId,idempotencyKey,'reserveDispatchInventory',{dispatchId},async()=>{
    const d=await row(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1 FOR UPDATE',[dispatchId]);
    if(!d||d.status!=='PLANNED')fail('DISPATCH_NOT_PLANNED','Only planned dispatch can reserve stock');
    if(!d.destination_location_id)fail('DESTINATION_REQUIRED','Explicit destination custody required');
    const unified=await row(c,"SELECT to_regclass('aimoc_execution_v1.dispatch_loading_assignments') AS name");
    if(unified?.name){
      const assign=await row(c,'SELECT source_stockpile_id FROM aimoc_execution_v1.dispatch_loading_assignments WHERE dispatch_id=$1',[d.id]);
      if(!assign||assign.source_stockpile_id!==d.source_stockpile_id)
       fail('LOADING_POINT_ASSIGNMENT_REQUIRED','Validated crusher/loading point assignment is required');
      const driverAssignments=(await c.query(`SELECT t.id FROM aimoc_execution_v1.trips t
       LEFT JOIN aimoc_execution_v1.trip_driver_assignments a ON a.trip_id=t.id AND a.driver_id=t.driver_id AND a.truck_id=t.truck_id AND a.status='ASSIGNED'
       WHERE t.dispatch_id=$1 AND a.assignment_id IS NULL`,[d.id])).rows;
      if(driverAssignments.length)fail('DRIVER_ASSIGNMENT_REQUIRED','Every Trip must have a matching Driver+Truck assignment');
    }

    const existing=await row(c,'SELECT id FROM aimoc_execution_v1.inventory_reservations WHERE dispatch_id=$1',[dispatchId]);
    if(existing)fail('RESERVATION_EXISTS','Dispatch already reserved');
    const trips=(await c.query('SELECT * FROM aimoc_execution_v1.trips WHERE dispatch_id=$1 ORDER BY sequence_no FOR UPDATE',[dispatchId])).rows;
    if(!trips.length||trips.some(t=>t.status!=='QUEUED')||
        Math.abs(sum(trips.map(x=>x.planned_quantity_t))-Number(d.planned_quantity_t))>0.000001)
      fail('TRIP_QUANTITY_MISMATCH','Planned trip sum must match dispatch quantity');
    const amount=fixed(d.planned_quantity_t);
    const reconciliationTable=await row(c,"SELECT to_regclass('aimoc_execution_v1.inventory_opening_reconciliations') AS oid");
    if(reconciliationTable?.oid){
      const opening=await row(c,"SELECT measured_t FROM aimoc_execution_v1.inventory_opening_reconciliations WHERE location_id=$1 AND sku_id=$2 AND status='APPROVED'",[d.source_stockpile_id,d.sku_id]);
      if(!opening)fail('VERIFIED_OPENING_MISSING','Independent source inventory opening approval is required');
      const movement=await row(c,"SELECT COALESCE(SUM(delta_on_hand_t),0) AS net_movement FROM aimoc_execution_v1.inventory_journal WHERE location_id=$1 AND sku_id=$2",[d.source_stockpile_id,d.sku_id]);
      const current=await row(c,'SELECT on_hand_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id=$2 FOR UPDATE',[d.source_stockpile_id,d.sku_id]);
      if(!current||Math.abs(Number(opening.measured_t)+Number(movement.net_movement)-Number(current.on_hand_t))>0.000001)
        fail('INVENTORY_JOURNAL_MISMATCH','Opening plus journal must equal current physical inventory');
    }
    const capacitySchema=await row(c,"SELECT to_regclass('aimoc_execution_v1.voyage_capacity') AS oid");
    if(capacitySchema?.oid && d.mode==='MARINE'){
      const voyage=await row(c,'SELECT * FROM aimoc_execution_v1.voyage_capacity WHERE voyage_id=$1 FOR UPDATE',[d.voyage_id]);
      if(!voyage||voyage.status!=='READY')fail('VOYAGE_NOT_READY','Voyage is not ready for reserved cargo');
      const window=await row(c,'SELECT * FROM aimoc_execution_v1.jetty_windows WHERE id=$1',[d.jetty_window_id]);
      if(!window||window.voyage_id!==d.voyage_id||window.jetty_id!==d.destination_location_id||window.status!=='READY')
        fail('JETTY_SLOT_NOT_READY','Approved receiving slot is required');
      if(Number(voyage.capacity_t)-Number(voyage.reserved_t)+0.000001<Number(amount))
        fail('VOYAGE_CAPACITY_EXCEEDED','Voyage cargo capacity is insufficient');
      // The voyage row is locked across all dispatches sharing this voyage.
      await c.query('UPDATE aimoc_execution_v1.voyage_capacity SET reserved_t=reserved_t+$1 WHERE voyage_id=$2',[amount,d.voyage_id]);
      await c.query('INSERT INTO aimoc_execution_v1.voyage_dispatch_allocations(dispatch_id,voyage_id,allocated_t) VALUES($1,$2,$3)',[d.id,d.voyage_id,amount]);
    }
    const account=await row(c,'SELECT * FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id=$2 FOR UPDATE',[d.source_stockpile_id,d.sku_id]);
    if(!account||Number(account.on_hand_t)-Number(account.reserved_t)+0.000001<Number(amount))
      fail('STOCK_INSUFFICIENT','Available stock is not enough');
    await c.query('UPDATE aimoc_execution_v1.inventory_accounts SET reserved_t=reserved_t+$1 WHERE location_id=$2 AND sku_id=$3',
      [amount,d.source_stockpile_id,d.sku_id]);
    const rid=randomUUID();
    await c.query(`INSERT INTO aimoc_execution_v1.inventory_reservations
      (id,dispatch_id,source_stockpile_id,sku_id,reserved_t,status) VALUES($1,$2,$3,$4,$5,'ACTIVE')`,
      [rid,dispatchId,d.source_stockpile_id,d.sku_id,amount]);
    for(const t of trips){
      await c.query('INSERT INTO aimoc_execution_v1.trip_reservation_allocations(trip_id,reservation_id,reserved_t) VALUES($1,$2,$3)',
        [t.id,rid,t.planned_quantity_t]);
    }
    await c.query(`UPDATE aimoc_execution_v1.dispatches SET status='READY' WHERE id=$1`,[d.id]);
    await outbox(c,dispatchId,'DISPATCH_READY',{dispatch_id:d.id,reserved_quantity_t:amount});
    return {dispatch_id:d.id,status:'READY',reserved_quantity_t:amount,inventory_on_hand_unchanged:true};
  }));
}
/** Loading confirmation is an operator command, never a Driver self-report. */
export async function confirmTripLoading(db,{actorId,idempotencyKey,tripId}){
  return db.transaction(async c=>idempotent(c,actorId,idempotencyKey,'confirmTripLoading',{tripId},async()=>{
    const trip=await row(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
    if(!trip||trip.status!=='TARE_CONFIRMED')fail('TARE_NOT_CONFIRMED','Verified tare must precede loading');
    const d=await row(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1',[trip.dispatch_id]);
    await permission(c,actorId,d.source_stockpile_id,'stockpile.loading.confirm');
    await c.query(`UPDATE aimoc_execution_v1.trips SET status='LOADING' WHERE id=$1`,[trip.id]);
    await outbox(c,trip.id,'TRIP_LOADING_CONFIRMED',{trip_id:trip.id,actor_id:actorId});
    await reconcilePendingWeighbridgeEventsInTransaction(c,{tripId:trip.id});
    const current=await row(c,'SELECT status FROM aimoc_execution_v1.trips WHERE id=$1',[trip.id]);
    return {trip_id:trip.id,status:current.status};
  }));
}
/** Physical departure debits source and transfers actual verified tonnage into custody. */
export async function departVerifiedTrip(db,{actorId,idempotencyKey,tripId}){
  return db.transaction(async c=>idempotent(c,actorId,idempotencyKey,'departVerifiedTrip',{tripId},async()=>{
    const trip=await row(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
    if(!trip||trip.status!=='GROSS_CONFIRMED'||trip.actual_net_t===null)
      fail('WEIGHING_NOT_VERIFIED','QR, tare, loading and gross required');
    const d=await row(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1 FOR UPDATE',[trip.dispatch_id]);
    if(!d.destination_location_id||d.destination_location_id===d.source_stockpile_id)
      fail('INVALID_DESTINATION','Destination custody must differ from source');
    await permission(c,actorId,d.source_stockpile_id,'stockpile.departure.confirm');
    const allocation=await row(c,'SELECT * FROM aimoc_execution_v1.trip_reservation_allocations WHERE trip_id=$1 FOR UPDATE',[trip.id]);
    if(!allocation||Number(allocation.consumed_t)!==0||Number(trip.actual_net_t)>Number(allocation.reserved_t)+0.000001)
      fail('RESERVATION_MISMATCH','Trip allocation missing, already used, or under-reserved');
    const account=await row(c,'SELECT * FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id=$2 FOR UPDATE',[d.source_stockpile_id,d.sku_id]);
    if(!account||Number(account.on_hand_t)+0.000001<Number(trip.actual_net_t)||
       Number(account.reserved_t)+0.000001<Number(allocation.reserved_t))
      fail('STOCK_CONFLICT','Balance and reservation must cover departure');
    const qty=fixed(trip.actual_net_t);
    await c.query(`UPDATE aimoc_execution_v1.inventory_accounts
      SET on_hand_t=on_hand_t-$1,reserved_t=reserved_t-$2 WHERE location_id=$3 AND sku_id=$4`,
      [qty,allocation.reserved_t,d.source_stockpile_id,d.sku_id]);
    await c.query('UPDATE aimoc_execution_v1.trip_reservation_allocations SET consumed_t=$1 WHERE trip_id=$2',
      [qty,trip.id]);
    const pending=await row(c,`SELECT count(*)::int AS count FROM aimoc_execution_v1.trip_reservation_allocations a
      JOIN aimoc_execution_v1.trips t ON t.id=a.trip_id
      WHERE t.dispatch_id=$1 AND a.consumed_t=0`,[d.id]);
    if(pending.count===0){
      await c.query(`UPDATE aimoc_execution_v1.inventory_reservations SET status='CONSUMED' WHERE id=$1`,[allocation.reservation_id]);
    }
    await c.query(`INSERT INTO aimoc_execution_v1.cargo_custody
      (trip_id,source_location_id,destination_location_id,sku_id,shipped_t,status)
      VALUES($1,$2,$3,$4,$5,'IN_TRANSIT')`,[trip.id,d.source_stockpile_id,d.destination_location_id,d.sku_id,qty]);
    const reference='departure:'+trip.id;
    await c.query(`INSERT INTO aimoc_execution_v1.inventory_journal
      (id,trip_id,location_id,sku_id,movement_type,delta_on_hand_t,reference_event_id)
      VALUES($1,$2,$3,$4,'SOURCE_DEPARTURE',-($5::numeric),$6)`,
      [randomUUID(),trip.id,d.source_stockpile_id,d.sku_id,qty,reference]);
    await c.query(`UPDATE aimoc_execution_v1.trips SET status='IN_TRANSIT',departed_at=now() WHERE id=$1`,[trip.id]);
    await outbox(c,trip.id,'TRIP_DEPARTED',{trip_id:trip.id,actual_net_t:qty,actor_id:actorId,source_location_id:d.source_stockpile_id,
      destination_location_id:d.destination_location_id});
    return {trip_id:trip.id,status:'IN_TRANSIT',actual_net_t:qty,reservation_consumed_t:qty};
  }));
}

export async function confirmTripArrival(db,{actorId,idempotencyKey,tripId}){
  return db.transaction(async c=>idempotent(c,actorId,idempotencyKey,'confirmTripArrival',{tripId},async()=>{
    const trip=await row(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
    if(!trip||trip.status!=='IN_TRANSIT')fail('TRIP_NOT_IN_TRANSIT','Departure must occur before arrival');
    const cargo=await row(c,'SELECT * FROM aimoc_execution_v1.cargo_custody WHERE trip_id=$1 FOR UPDATE',[trip.id]);
    if(!cargo||cargo.status!=='IN_TRANSIT')fail('CARGO_MISSING','In-transit custody record required');
    const scheduleSchema=await row(c,"SELECT to_regclass('aimoc_execution_v1.voyage_capacity') AS oid");
    if(scheduleSchema?.oid){
      const d=await row(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1',[trip.dispatch_id]);
      if(d.mode==='MARINE'){
        const voyage=await row(c,'SELECT status FROM aimoc_execution_v1.voyage_capacity WHERE voyage_id=$1',[d.voyage_id]);
        const slot=await row(c,'SELECT * FROM aimoc_execution_v1.jetty_windows WHERE id=$1',[d.jetty_window_id]);
        if(!voyage||voyage.status!=='READY'||!slot||slot.status!=='READY'||
           slot.jetty_id!==cargo.destination_location_id||
           Date.now()<Date.parse(slot.starts_at)||Date.now()>Date.parse(slot.ends_at))
          fail('JETTY_WINDOW_NOT_ACTIVE','Jetty receipt window is not currently authorized');
      }
    }
    await permission(c,actorId,cargo.destination_location_id,'receiving.verify');
    await c.query(`UPDATE aimoc_execution_v1.cargo_custody SET status='ARRIVED' WHERE trip_id=$1`,[trip.id]);
    await c.query(`UPDATE aimoc_execution_v1.trips SET status='ARRIVED',arrived_at=now() WHERE id=$1`,[trip.id]);
    await outbox(c,trip.id,'TRIP_ARRIVED',{trip_id:trip.id,destination_location_id:cargo.destination_location_id});
    return {trip_id:trip.id,status:'ARRIVED'};
  }));
}
/** Independent receiving; partial receipts never produce final settlement. */
export async function verifyDestinationReceipt(db,{actorId,idempotencyKey,tripId,receivedT,externalReceiptId}){
  if(!positive(receivedT))fail('INVALID_RECEIPT_QUANTITY','Positive decimal received quantity required',400);
  if(typeof externalReceiptId!=='string'||externalReceiptId.length<3||externalReceiptId.length>100)
    fail('INVALID_RECEIPT_ID','Unique receiver-side receipt reference required',400);
  return db.transaction(async c=>idempotent(c,actorId,idempotencyKey,'verifyDestinationReceipt',
    {tripId,receivedT,externalReceiptId},async()=>{
    const trip=await row(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
    if(!trip||trip.status!=='ARRIVED')fail('TRIP_NOT_ARRIVED','Physical arrival required for receipt');
    const d=await row(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1 FOR UPDATE',[trip.dispatch_id]);
    const cargo=await row(c,'SELECT * FROM aimoc_execution_v1.cargo_custody WHERE trip_id=$1 FOR UPDATE',[trip.id]);
    if(!cargo||!['ARRIVED','PARTIAL'].includes(cargo.status))
      fail('CARGO_NOT_RECEIVABLE','Cargo not awaiting receipt');
    await permission(c,actorId,cargo.destination_location_id,'receiving.verify');
    // Receiving cannot be performed by the same actor who confirmed source departure.
    const departed=await row(c,`SELECT o.payload->>'actor_id' AS actor_id FROM aimoc_execution_v1.integration_outbox o
      WHERE o.aggregate_id=$1 AND o.event_type='TRIP_DEPARTED' ORDER BY created_at DESC LIMIT 1`,[trip.id]);
    if(departed?.actor_id===actorId)fail('SEPARATION_OF_DUTIES','Sender cannot self-verify receiver',403);
    const qty=Number(receivedT),left=Number(cargo.shipped_t)-Number(cargo.received_t);
    if(qty>left+0.000001)fail('RECEIPT_EXCEEDS_CARGO','Receipt larger than remaining physical custody');
    const destination=await row(c,'SELECT * FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id=$2 FOR UPDATE',
      [cargo.destination_location_id,cargo.sku_id]);
    if(!destination)fail('DESTINATION_INVENTORY_MISSING','Destination custody inventory account required');
    const receiptId=randomUUID(),stamp=new Date().toISOString();
    await c.query(`INSERT INTO aimoc_execution_v1.receipts
      (id,trip_id,status,receiving_actor_id,verified_at,source_event_id,received_t,destination_location_id)
      VALUES($1,$2,'VERIFIED',$3,$4,$5,$6,$7)`,
      [receiptId,trip.id,actorId,stamp,externalReceiptId,receivedT,cargo.destination_location_id]);
    await c.query('UPDATE aimoc_execution_v1.inventory_accounts SET on_hand_t=on_hand_t+$1 WHERE location_id=$2 AND sku_id=$3',
      [receivedT,cargo.destination_location_id,cargo.sku_id]);
    await c.query(`INSERT INTO aimoc_execution_v1.inventory_journal
      (id,trip_id,location_id,sku_id,movement_type,delta_on_hand_t,reference_event_id)
      VALUES($1,$2,$3,$4,'DESTINATION_RECEIPT',$5,$6)`,
      [randomUUID(),trip.id,cargo.destination_location_id,cargo.sku_id,receivedT,'receipt:'+externalReceiptId]);
    const total=Math.round((Number(cargo.received_t)+qty)*1e6)/1e6;
    const complete=Math.abs(total-Number(cargo.shipped_t))<0.000001;
    await c.query('UPDATE aimoc_execution_v1.cargo_custody SET received_t=$1,status=$2 WHERE trip_id=$3',
      [total.toFixed(6),complete?'RECEIVED':'PARTIAL',trip.id]);
    if(complete){
      await c.query(`INSERT INTO aimoc_execution_v1.unload_settlements
        (id,trip_id,receipt_id,status,verified_at,authorized_actor_id)
        VALUES($1,$2,$3,'VERIFIED',$4,$5)`,
        [randomUUID(),trip.id,receiptId,stamp,actorId]);
      if(d.mode==='LAND'){
        await c.query(`UPDATE aimoc_execution_v1.trips SET status='UNLOADED_VERIFIED',unloaded_verified_at=now() WHERE id=$1`,[trip.id]);
      }
    }
    await outbox(c,trip.id,complete?'TRIP_RECEIPT_FINAL':'TRIP_RECEIPT_PARTIAL',
      {trip_id:trip.id,receipt_id:receiptId,received_t:receivedT,remaining_t:fixed(Number(cargo.shipped_t)-total),
       final:complete,destination_location_id:cargo.destination_location_id,receiving_actor_id:actorId});
    const dispatchStatus=await refreshDispatchProgress(c,d.id);
    return {trip_id:trip.id,receipt_id:receiptId,received_t:receivedT,final:complete,
      remaining_t:fixed(Number(cargo.shipped_t)-total),sequence_released:false,dispatch_status:dispatchStatus};
  }));
}
