import test from 'node:test';
import assert from 'node:assert/strict';
import {API_ROUTE_CONTRACTS,API_UNITS,FINAL_API_GAPS,validateApiEnvelope,assessFinalApiContract} from '../src/contracts/api-v1-candidate.js';
import {targetPageContracts} from '../src/contracts/page-contracts.js';

test('candidate DTO contract distinguishes unknown from verified zero',()=>{
 assert.equal(API_UNITS.mass,'t');assert.equal(API_UNITS.legacyVolume,'m3');
 assert.equal(validateApiEnvelope({schema_version:'1.0',resource:'inventory',source:'V1_STAGING',data_status:'NOT_INTEGRATED',data:null}).valid,true);
 const fail=validateApiEnvelope({schema_version:'1.0',resource:'inventory',source:'V1_STAGING',data_status:'NOT_INTEGRATED',data:{items:[]}});
 assert.ok(fail.errors.includes('NOT_INTEGRATED_MUST_BE_NULL'));
 const missing=validateApiEnvelope({schema_version:'1.0',resource:'trip',source:'V1_STAGING',data_status:'READY',data:{trip_id:'t1'}},{requiredDataFields:['trip_id','actual_net_t']});
 assert.ok(missing.errors.includes('FIELD_MISSING:actual_net_t'));
 const valid=validateApiEnvelope({schema_version:'1.0',resource:'trip',source:'V1_STAGING',data_status:'READY',data:{trip_id:'t1',actual_net_t:null}},{requiredDataFields:['trip_id','actual_net_t']});
 assert.equal(valid.valid,true);
});
test('candidate has explicit source roles, no automatic final acceptance',()=>{
 assert.ok(API_ROUTE_CONTRACTS.some(x=>x.id==='weighbridge'&&x.roles.includes('m2m')));
 assert.ok(API_ROUTE_CONTRACTS.some(x=>x.id==='return-evidence'&&!x.roles.includes('driver')));
 assert.ok(API_ROUTE_CONTRACTS.some(x=>x.id==='driver-active'&&x.roles.length===1));
 const gate=assessFinalApiContract();
 assert.equal(gate.accepted,false);
 assert.equal(gate.frontend_migration_allowed,false);
 assert.ok(FINAL_API_GAPS.length>=8);
});
test('target frontend contracts expose rollout gaps rather than silently pretending compatibility',()=>{
 const target=new Set(Object.values(targetPageContracts).flatMap(group=>Object.values(group).map(x=>x.endpoint)));
 const declared=new Set(API_ROUTE_CONTRACTS.map(x=>x.path));
 const unmatched=[...target].filter(x=>!declared.has(x));
 assert.ok(unmatched.includes('/api/v1/transfer-requests'));
 assert.ok(unmatched.includes('/api/v1/stockpile/me/receipts'));
 assert.ok(unmatched.includes('/api/v1/driver/trips/{tripId}/checklist'));
});
