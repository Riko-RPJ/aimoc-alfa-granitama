import {createDatabase} from '../server/database.mjs';
import {createIsolatedExecutionSchema,startLandTrip} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {extendUnifiedOperationalSchema} from '../server/v1/phase4g-schema.mjs';
import {assignDispatchLoadingPoint,bindTripDriverAssignment,getUnifiedDispatchContext,auditUnifiedOperationalIntegrity} from '../server/v1/unified-operational-contract.mjs';
import {reserveDispatchInventory} from '../server/v1/phase4b-inventory.mjs';
const name=process.env.AIMOC_REHEARSAL_DB;
if(process.env.DATABASE_URL||!/^aimoc_rehearsal_[0-9a-f]{12}$/.test(name||''))throw Error('ONLY_EPHEMERAL_LOCAL_PG');
const db=createDatabase('postgresql:///'+name+'?host=/tmp');
try{
 await createIsolatedExecutionSchema(db);await extendIsolatedExecutionSchema(db);await extendUnifiedOperationalSchema(db);
 const q=(sql,args=[])=>db.query(sql,args);
 await q("INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t) VALUES('stock1','sku1',100)");
 await q("INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES('driver1','user1','Test Driver')");
 await q("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck1',50)");
 await q("INSERT INTO aimoc_execution_v1.crusher_location_refs(crusher_id,crusher_name,source_stockpile_id,status) VALUES('crusher1','Crusher 1','stock1','ACTIVE')");
 await q("INSERT INTO aimoc_execution_v1.loading_point_refs(loading_point_id,crusher_id,loading_point_name,verification_status) VALUES('point1','crusher1','Loading UAT','UNVERIFIED')");
 await q("INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t) VALUES('dispatch1','LAND','PLANNED','stock1','customer1','sku1',40)");
 await q("INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t) VALUES('trip1','dispatch1',1,'QUEUED','truck1','driver1',40)");
 await assignDispatchLoadingPoint(db,{actorId:'admin',dispatchId:'dispatch1',crusherId:'crusher1',loadingPointId:'point1',idempotencyKey:'assign-point-idem'});
 await bindTripDriverAssignment(db,{actorId:'admin',tripId:'trip1',assignmentId:'assign1',idempotencyKey:'assign-driver-idem'});
 await reserveDispatchInventory(db,{actorId:'admin',dispatchId:'dispatch1',idempotencyKey:'reserve-trip-idem'});
 await startLandTrip(db,{actorId:'admin',tripId:'trip1',idempotencyKey:'start-trip-idem'});
 const dto=await getUnifiedDispatchContext(db,{dispatchId:'dispatch1'});
 const integrity=await auditUnifiedOperationalIntegrity(db);
 if(integrity.status!=='PASS'||dto.trips[0].assignment_id!=='assign1'||dto.trips[0].inventory.reserved_t!=='40.000000')
  throw Error('UNIFIED_CONTRACT_PG_REHEARSAL_FAILED');
 let wrongPairRejected=false;
 try{await q("UPDATE aimoc_execution_v1.dispatch_loading_assignments SET source_stockpile_id='wrong-stock' WHERE dispatch_id='dispatch1'")}
 catch(e){wrongPairRejected=e.code==='23503'}
 if(!wrongPairRejected)throw Error('COMPOSITE_FOREIGN_KEY_NOT_ENFORCED');
 console.log(JSON.stringify({database:'temporary PostgreSQL',integrity:integrity.status,trip_count:dto.trip_count,
  assignment_id:dto.trips[0].assignment_id,dispatch_id:dto.dispatch_id,
  location_status:dto.trips[0].crusher_destination.location_status,
  reservation_t:dto.trips[0].inventory.reserved_t,direct_sql_mismatch_rejected:wrongPairRejected,
  live_navigation:false},null,2));
}finally{await db.close()}
