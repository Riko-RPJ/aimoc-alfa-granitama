import test from 'node:test';
import assert from 'node:assert/strict';
import {REQUIRED_V1_GATES,evaluateV1Readiness,createReadGateway} from '../src/services/v1-acceptance.js';

test('Phase 4D: incomplete backend cannot activate frontend canary',async()=>{
 const status=evaluateV1Readiness({environment:'staging',gates:{}});
 assert.equal(status.accepted,false);
 assert.ok(status.blocking.includes('final_api_dto_accepted'));
 let legacy=0,canary=0;
 const gateway=createReadGateway({legacyRead:async()=>{legacy++;return {stockpiles:[]};},
   v1Read:async()=>{canary++;return {schema_version:'1.0',data_status:'READY',data:{items:[]}};},
   flag:true,acceptance:{environment:'staging',gates:{}}});
 assert.equal(gateway.mode,'LEGACY_ONLY');
 const result=await gateway.read({legacyPath:'/api/state',v1Path:'/api/v1/inventory'});
 assert.equal(result.source,'LEGACY');
 assert.equal(legacy,1);assert.equal(canary,0);
 assert.equal(Object.hasOwn(gateway,'write'),false);
});
test('canary requires every attested gate and is still only a read interface',async()=>{
 const manifest={environment:'production',source:'SERVER_VERIFIED_ATTESTATION',
  contract_version:'1.0-final',issued_at:'2026-11-06T10:00:00Z',
  gates:Object.fromEntries(REQUIRED_V1_GATES.map(k=>[k,true]))};
 assert.equal(evaluateV1Readiness(manifest).accepted,true);
 const gateway=createReadGateway({legacyRead:async()=>{throw Error('legacy should not run');},
  v1Read:async()=>({schema_version:'1.0',data_status:'NOT_INTEGRATED',data:null}),flag:true,
  acceptance:manifest});
 assert.equal(gateway.mode,'V1_READ_CANARY');
 const out=await gateway.read({legacyPath:'/api/state',v1Path:'/api/v1/inventory'});
 assert.equal(out.source,'V1');assert.equal(out.status,'NOT_INTEGRATED');assert.equal(out.data,null);
});
test('any revoked signoff, absent provenance or wrong DTO rejects migration',async()=>{
 const manifest={environment:'production',source:'SERVER_VERIFIED_ATTESTATION',
  contract_version:'1.0-final',issued_at:'2026-11-06T10:00:00Z',
  gates:Object.fromEntries(REQUIRED_V1_GATES.map(k=>[k,true]))};
 const revoked=structuredClone(manifest);revoked.gates['security_and_operations_signoff']=false;
 assert.equal(evaluateV1Readiness(revoked).accepted,false);
 const gw=createReadGateway({legacyRead:async()=>null,v1Read:async()=>({data_status:'READY'}),flag:true,
  acceptance:manifest});
 await assert.rejects(()=>gw.read({legacyPath:'/api/state',v1Path:'/api/v1/inventory'}),/V1_CONTRACT_MISMATCH/);
});
