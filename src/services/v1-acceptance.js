/**
 * Explicit backend acceptance gate for any future frontend v1 canary.
 * This is a UX safety guard, NOT a server-side authorization boundary.
 * Production business permissions remain enforced in the backend.
 */
export const REQUIRED_V1_GATES=Object.freeze([
  'normalized_schema_migration_rehearsed',
  'legacy_balances_reconciled_and_approved',
  'real_weighbridge_source_validated',
  'driver_identity_and_location_scope_verified',
  'voyage_capacity_and_jetty_slots_verified',
  'hold_recovery_cancel_shortfall_approved',
  'real_postgresql_concurrency_passed',
  'outbox_delivery_and_retry_verified',
  'final_api_dto_accepted',
  'browser_and_mobile_end_to_end_passed',
  'security_and_operations_signoff'
]);
export function evaluateV1Readiness(manifest) {
 const blocking=REQUIRED_V1_GATES.filter(key=>manifest?.gates?.[key]!==true);
 if(manifest?.environment!=='production')blocking.unshift('production_environment_not_verified');
 if(manifest?.source!=='SERVER_VERIFIED_ATTESTATION')blocking.unshift('trusted_attestation_missing');
 if(manifest?.contract_version!=='1.0-final')blocking.unshift('final_contract_version_missing');
 if(typeof manifest?.issued_at!=='string'||!Number.isFinite(Date.parse(manifest.issued_at)))
   blocking.unshift('dated_attestation_missing');
 return {accepted:blocking.length===0,blocking,mode:blocking.length?'LEGACY_ONLY':'V1_READ_CANARY_ELIGIBLE'};
}
/** A canary is read-only and must never silently switch existing writes. */
export function createReadGateway({legacyRead,v1Read,acceptance,flag=false}={}){
 if(typeof legacyRead!=='function'||typeof v1Read!=='function')throw Error('READ_FUNCTIONS_REQUIRED');
 const allowed=flag===true&&evaluateV1Readiness(acceptance).accepted;
 return Object.freeze({
  mode:allowed?'V1_READ_CANARY':'LEGACY_ONLY',
  read:async({legacyPath,v1Path})=>{
   if(allowed){
    if(typeof v1Path!=='string'||!v1Path.startsWith('/api/v1/'))
      throw Error('V1_PATH_REQUIRED');
    // Do not return falsified zero or silently reinterpret a NOT_INTEGRATED DTO.
    const response=await v1Read(v1Path);
    if(response?.data_status==='NOT_INTEGRATED')
      return {status:'NOT_INTEGRATED',source:'V1',data:null};
    if(response?.schema_version!=='1.0'||!['READY','EMPTY','STALE'].includes(response?.data_status))
      throw Error('V1_CONTRACT_MISMATCH');
    return {status:response.data_status,source:'V1',data:response.data};
   }
   return {status:'LEGACY',source:'LEGACY',data:await legacyRead(legacyPath)};
  },
  // No mutation dispatch in this gateway.
 });
}
