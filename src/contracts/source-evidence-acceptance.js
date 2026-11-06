/**
 * Phase 4F source-evidence acceptance. Never confuses a fixture,
 * design specification, or unapproved claim with operational proof.
 * The manifest describes references: no passwords, keys or personal IDs.
 */
export const EVIDENCE_REQUIREMENTS=Object.freeze({
 inventory:Object.freeze([
  'stockpile_sku_mapping','physical_measurement','mass_unit_t',
  'measurement_method','measurement_time','evidence_digest',
  'independent_stock_approval','opening_ledger_reconciliation'
 ]),
 weighbridge:Object.freeze([
  'vendor_protocol_manual','device_identity','real_redacted_event_examples',
  'qr_tare_gross_semantics','calibration_record','source_authentication',
  'retry_and_offline_policy','independent_vendor_approval'
 ]),
 driver:Object.freeze([
  'authoritative_identity_provider','driver_registry_mapping',
  'assignment_source','role_and_location_scope','deprovision_policy',
  'independent_identity_approval'
 ]),
 api:Object.freeze([
  'page_to_endpoint_matrix','dto_schema_review','nullable_and_unit_semantics',
  'state_and_exception_matrix','auth_and_idempotency_review',
  'frontend_backend_owner_signoff','integration_uat_proof'
 ])
});
const cleanString=x=>typeof x==='string'&&x.trim().length>0;
const iso=x=>cleanString(x)&&Number.isFinite(Date.parse(x))&&/Z$|[+-]\d{2}:\d{2}$/.test(x);
const sha256=x=>typeof x==='string'&&/^[0-9a-f]{64}$/i.test(x);
const approvedRecord=record=>{
 if(!record||typeof record!=='object')return false;
 if(record.classification!=='FIELD_VERIFIED'||record.status!=='APPROVED')return false;
 if(!cleanString(record.source_ref)||!sha256(record.sha256)||!iso(record.observed_at))return false;
 if(!cleanString(record.approved_by)||!iso(record.approved_at))return false;
 if(!cleanString(record.prepared_by)||record.prepared_by===record.approved_by)return false;
 if(!cleanString(record.provenance)||!cleanString(record.verification_method))return false;
 if(!['internal-system','signed-document','vendor-export','measured-record'].includes(record.provenance))
   return false;
 return true;
};
/**
 * Returns a review of claimed evidence only. Cannot assert that a real source,
 * signature, physical tonnage, or named approver was authenticated.
 */
export function assessEvidenceManifest(manifest){
 const missing=[],untrusted=[];
 for(const [area,keys] of Object.entries(EVIDENCE_REQUIREMENTS)){
  for(const key of keys){
   const item=manifest?.[area]?.[key];
   if(!item||item.status==='MISSING')missing.push(area+'.'+key);
   else if(!approvedRecord(item))untrusted.push(area+'.'+key);
  }
 }
 const declaredReady=missing.length===0&&untrusted.length===0;
 return {
  source_evidence_claims_complete:declaredReady,
  independently_verified:false,
  final_api_locked:false,
  frontend_migration_allowed:false,
  production_cutover_allowed:false,
  missing,untrusted,
  verdict:declaredReady?'MANUAL_AUTHENTICITY_REVIEW_REQUIRED':'EVIDENCE_INCOMPLETE',
  explanation:'Self-declared references cannot substitute for actual file authentication, signed operational approval and owner validation.'
 };
}
export function createEvidenceIntakeTemplate(){
 return Object.fromEntries(Object.entries(EVIDENCE_REQUIREMENTS).map(([area,keys])=>[
  area,Object.fromEntries(keys.map(key=>[key,{
   status:'MISSING',classification:'UNVERIFIED',
   source_ref:null,sha256:null,observed_at:null,provenance:null,
   verification_method:null,prepared_by:null,approved_by:null,approved_at:null
  }]))
 ]));
}
