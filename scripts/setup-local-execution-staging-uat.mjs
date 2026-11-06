import {createHash} from 'node:crypto';
import {createDatabase,createEmbeddedDatabase} from '../server/database.mjs';
import {proposeDriverBinding,verifyDriverBinding} from '../server/v1/phase4e-driver-identity.mjs';
import {prepareOpeningBalance,approveOpeningBalance} from '../server/v1/phase4e-inventory-reconciliation.mjs';
const url=process.env.AIMOC_STAGING_DATABASE_URL;
if(process.env.AIMOC_STAGING_UAT_FIXTURES!=='1'||!url)throw Error('EXPLICIT_LOCAL_UAT_OPT_IN_REQUIRED');
const parsed=new URL(url);
if(!['127.0.0.1','localhost'].includes(parsed.hostname)||
   parsed.pathname!=='/aimoc_execution_staging_uat'||process.env.DATABASE_URL)
 throw Error('REFUSING_NONLOCAL_OR_NONISOLATED_DATABASE');
const db=createDatabase(url),legacy=await createEmbeddedDatabase('.local/database');
try{
 const identities=(await legacy.query("SELECT username,id,role FROM aimoc_alfa_ops.users WHERE username IN ('driver1','driver2','stock1','admin')")).rows;
 const user=name=>identities.find(x=>x.username===name);
 for(const name of ['driver1','driver2','stock1','admin'])if(!user(name))throw Error('MISSING_LOCAL_UAT_ACCOUNT_'+name);
 const q=(sql,args=[])=>db.query(sql,args);
 const exists=async(sql,args=[])=>!!(await q(sql,args)).rows[0];
 await q("INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t,reserved_t) VALUES('crusher-1','split-12',0,0) ON CONFLICT DO NOTHING");
 for(const [truck,cap] of [['uat-truck-001','45'],['uat-truck-002','40']])
  await q('INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES($1,$2) ON CONFLICT DO NOTHING',[truck,cap]);
 await q("INSERT INTO aimoc_execution_v1.crusher_location_refs(crusher_id,crusher_name,source_stockpile_id,zone,status) VALUES('uat-crusher-1','UAT_SIMULATED Crusher','crusher-1','UAT_ONLY','ACTIVE') ON CONFLICT DO NOTHING");
 await q("INSERT INTO aimoc_execution_v1.loading_point_refs(loading_point_id,crusher_id,loading_point_name,verification_status) VALUES('uat-loading-1','uat-crusher-1','UAT_SIMULATED Loading','UNVERIFIED') ON CONFLICT DO NOTHING");
 await q('INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
  ['uat-driver-1',user('driver1').id,'UAT_SIMULATED · Driver 1']);
 await q('INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
  ['uat-driver-2',user('driver2').id,'UAT_SIMULATED · Driver 2 (PENDING)']);
 if(!await exists("SELECT 1 FROM aimoc_execution_v1.driver_identity_bindings WHERE driver_id='uat-driver-1'")){
  await proposeDriverBinding(db,{actorId:'uat-provisioner',driverId:'uat-driver-1',
    userId:user('driver1').id,credentialAuthority:'UAT_SIMULATED_IDP',
    identityEvidenceRef:'uat:simulated:localdriver1'});
  await verifyDriverBinding(db,{actorId:'uat-independent-reviewer',driverId:'uat-driver-1',
    verifiedIdentityRef:'uat:simulated:localdriver1'});
 }
 if(!await exists("SELECT 1 FROM aimoc_execution_v1.driver_identity_bindings WHERE driver_id='uat-driver-2'"))
  await proposeDriverBinding(db,{actorId:'uat-provisioner',driverId:'uat-driver-2',
    userId:user('driver2').id,credentialAuthority:'UAT_SIMULATED_IDP',
    identityEvidenceRef:'uat:simulated:localdriver2'});
 await q("INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission) VALUES($1,'crusher-1','stockpile.loading.confirm') ON CONFLICT DO NOTHING",[user('stock1').id]);
 await q("INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission) VALUES($1,'crusher-1','stockpile.departure.confirm') ON CONFLICT DO NOTHING",[user('admin').id]);
 if(!await exists("SELECT 1 FROM aimoc_execution_v1.inventory_opening_reconciliations WHERE location_id='crusher-1' AND sku_id='split-12'")){
  const opening=await prepareOpeningBalance(db,{actorId:user('stock1').id,locationId:'crusher-1',skuId:'split-12',
    measuredT:'100.000000',measurementRef:'uat:simulated:opening:sp12',
    measuredAt:new Date(Date.now()-10000).toISOString(),
    evidenceDigest:createHash('sha256').update('UAT_SIMULATED_NOT_PHYSICAL_STOCK').digest('hex')});
  await approveOpeningBalance(db,{actorId:user('admin').id,reconciliationId:opening.reconciliation_id});
 }
 const r=(await q("SELECT (SELECT count(*)::int FROM aimoc_execution_v1.driver_identity_bindings WHERE status='ACTIVE' AND credential_authority='UAT_SIMULATED_IDP') AS active, (SELECT count(*)::int FROM aimoc_execution_v1.driver_identity_bindings WHERE status='PENDING' AND credential_authority='UAT_SIMULATED_IDP') AS pending, (SELECT count(*)::int FROM aimoc_execution_v1.fleet_vehicle_specs WHERE truck_id LIKE 'uat-%') AS trucks, (SELECT count(*)::int FROM aimoc_execution_v1.inventory_opening_reconciliations WHERE status='APPROVED' AND measurement_ref LIKE 'uat:%') AS openings")).rows[0];
 console.log(JSON.stringify({environment:'LOCAL_UAT_SIMULATED_ONLY',database:parsed.pathname,counts:r,wim:'NOT_CONNECTED',production_identity:'NOT_VERIFIED'},null,2));
}finally{await db.close();await legacy.close();}
