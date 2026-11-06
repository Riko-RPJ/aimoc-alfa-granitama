/**
 * API Contract v1.0 CANDIDATE — not a production-vetted OpenAPI release.
 * A source must provide independently verified measured values; unknown is
 * null/NOT_INTEGRATED, never an inferred zero or "Healthy".
 */
export const API_CANDIDATE_VERSION='1.0-candidate';
export const API_ENVELOPE_STATUS=Object.freeze(['READY','EMPTY','STALE','NOT_INTEGRATED']);
export const API_UNITS=Object.freeze({mass:'t',legacyVolume:'m3',timestamps:'ISO-8601 UTC'});
export const API_ROUTE_CONTRACTS=Object.freeze([
 {id:'session',method:'GET',path:'/api/v1/session',roles:['admin','stock','jetty','driver'],family:'identity'},
 {id:'inventory-read',method:'GET',path:'/api/v1/inventory',roles:['admin','stock'],family:'inventory',required:['items','unit','verified_tonnage_available']},
 {id:'overview-read',method:'GET',path:'/api/v1/operations/overview',roles:['admin'],family:'overview',required:['as_of','active_dispatches','active_trips','needs_attention']},
 {id:'dispatch-read',method:'GET',path:'/api/v1/dispatches',roles:['admin','stock'],family:'dispatch',required:['items','next_cursor']},
 {id:'planning-options',method:'GET',path:'/api/v1/dispatch/planning-options',roles:['admin'],family:'dispatch',required:['accounts','trucks','drivers','requirements']},
 {id:'dispatch-create',method:'POST',path:'/api/v1/dispatches',roles:['admin'],family:'dispatch'},
 {id:'trip-monitoring',method:'GET',path:'/api/v1/trips',roles:['admin','stock','jetty'],family:'trips',required:['items','next_cursor']},
 {id:'stockpile-pickups',method:'GET',path:'/api/v1/stockpile/me/pickups',roles:['stock'],family:'stockpile',required:['items','accept_pickup_precondition']},

 {id:'driver-active',method:'GET',path:'/api/v1/driver/me/active-trip',roles:['driver'],family:'driver',required:['data_status','trip']},
 {id:'driver-history',method:'GET',path:'/api/v1/driver/me/trips',roles:['driver'],family:'driver',required:['data_status','items']},
 {id:'trip-detail',method:'GET',path:'/api/v1/trips/{tripId}',roles:['admin','stock','jetty','driver'],family:'trips',
  required:['trip_id','dispatch_id','assignment_id','driver_id','truck_id','status','source_stockpile_id','sku_id','inventory','crusher_destination','contract_integrity','tare_t','gross_t','actual_net_t','unloaded_verified_at','returned_available_at']},

 {id:'assign-loading-point',method:'POST',path:'/api/v1/dispatches/{dispatchId}/assign-loading-point',roles:['admin'],family:'crusher-location'},
 {id:'assign-driver',method:'POST',path:'/api/v1/trips/{tripId}/assign-driver',roles:['admin'],family:'driver'},
 {id:'reserve',method:'POST',path:'/api/v1/dispatches/{dispatchId}/reserve',roles:['admin'],family:'inventory'},
 {id:'start',method:'POST',path:'/api/v1/trips/{tripId}/start',roles:['admin'],family:'dispatch'},
 {id:'hold',method:'POST',path:'/api/v1/trips/{tripId}/hold',roles:['admin'],family:'exceptions'},
 {id:'resolve-hold',method:'POST',path:'/api/v1/trips/{tripId}/resolve-hold',roles:['admin'],family:'exceptions'},
 {id:'accept-pickup',method:'POST',path:'/api/v1/trips/{tripId}/accept-pickup',roles:['stock'],family:'stockpile'},
 {id:'loading',method:'POST',path:'/api/v1/trips/{tripId}/loading',roles:['admin','stock'],family:'weighing'},
 {id:'depart',method:'POST',path:'/api/v1/trips/{tripId}/depart',roles:['admin','stock'],family:'inventory'},
 {id:'arrive',method:'POST',path:'/api/v1/trips/{tripId}/arrive',roles:['admin','stock','jetty'],family:'custody'},
 {id:'receive',method:'POST',path:'/api/v1/trips/{tripId}/receive',roles:['admin','stock','jetty'],family:'custody'},
 {id:'finalize-unload',method:'POST',path:'/api/v1/trips/{tripId}/finalize-unload',roles:['admin','stock','jetty'],family:'custody'},
 {id:'driver-checklist',method:'POST',path:'/api/v1/trips/{tripId}/checklist',roles:['driver'],family:'driver'},
 {id:'driver-return',method:'POST',path:'/api/v1/trips/{tripId}/return-start',roles:['driver'],family:'driver'},
 {id:'return-evidence',method:'POST',path:'/api/v1/trips/{tripId}/verify-return-evidence',roles:['admin','stock'],family:'driver'},
 {id:'return-complete',method:'POST',path:'/api/v1/trips/{tripId}/complete-return',roles:['admin','stock'],family:'driver'},
 {id:'weighbridge',method:'POST',path:'/api/v1/integrations/weighbridge/events',roles:['m2m'],family:'weighbridge'}
]);
export const FINAL_API_GAPS=Object.freeze([
 {id:'API-001',description:'Legacy /api/v1/dispatches DTO lacks target allocation, mode, voyage and verified sequence evidence'},
 {id:'API-002',description:'Target multi-line Transfer Requests and destination allocation DTO are not fully implemented'},
 {id:'API-003',description:'Target Driver tasks/checklist and authenticated production assignment lifecycle missing'},
 {id:'API-004',description:'Weighbridge vendor-native protocol, trust chain, fault evidence and managed secret rotation not validated'},
 {id:'API-005',description:'Full inventory reconciliation and opening proof must be independently signed and imported'},
 {id:'API-006',description:'Exceptions shortfall, cancellation, skip/override, recovery DTO missing'},
 {id:'API-007',description:'Outbox publisher, SSE, cache invalidation and historical pagination need integration'},
 {id:'API-008',description:'Voyage completion, jetty cargo handoff and final destination custody DTO missing'},
 {id:'API-009',description:'Normalized production schema migration and rollback not approved'},
 {id:'API-010',description:'Final comprehensive OpenAPI 3.1 schema review, signed client-server contract and security acceptance pending'}
]);
export function validateApiEnvelope(value,{resource,requiredDataFields=[]}={}){
 const errors=[];
 if(!value||typeof value!=='object'||Array.isArray(value))return {valid:false,errors:['ENVELOPE_OBJECT_REQUIRED']};
 if(value.schema_version!=='1.0')errors.push('VERSION_MISMATCH');
 if(!API_ENVELOPE_STATUS.includes(value.data_status))errors.push('INVALID_DATA_STATUS');
 if(typeof value.resource!=='string'||!value.resource)errors.push('RESOURCE_MISSING');
 if(resource&&value.resource!==resource)errors.push('RESOURCE_MISMATCH');
 if(!['LEGACY_SNAPSHOT','V1_STAGING','NOT_INTEGRATED','LOCAL_UAT'].includes(value.source))errors.push('UNKNOWN_PROVENANCE');
 if(!Object.hasOwn(value,'data'))errors.push('DATA_FIELD_MISSING');
 if(value.data_status==='NOT_INTEGRATED'&&value.data!==null)errors.push('NOT_INTEGRATED_MUST_BE_NULL');
 if(value.data_status==='READY'&&(value.data===null||typeof value.data!=='object'))errors.push('READY_DATA_REQUIRED');
 if(value.data_status==='READY')for(const field of requiredDataFields){
  if(!Object.hasOwn(value.data,field))errors.push('FIELD_MISSING:'+field);
 }
 return {valid:errors.length===0,errors};
}
export function assessFinalApiContract(){
 // No feature flag or client input may override missing independent evidence.
 return {contract_version:API_CANDIDATE_VERSION,accepted:false,
  production_cutover_allowed:false,frontend_migration_allowed:false,
  unresolved:FINAL_API_GAPS};
}
