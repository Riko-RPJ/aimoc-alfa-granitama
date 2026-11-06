import test from 'node:test';
import assert from 'node:assert/strict';
import {assessEvidenceManifest,createEvidenceIntakeTemplate,EVIDENCE_REQUIREMENTS} from '../src/contracts/source-evidence-acceptance.js';
test('empty authoritative evidence never allows final contract freeze or frontend cutover',()=>{
 const manifest=createEvidenceIntakeTemplate();
 const report=assessEvidenceManifest(manifest);
 const expected=Object.values(EVIDENCE_REQUIREMENTS).reduce((a,k)=>a+k.length,0);
 assert.equal(report.missing.length,expected);
 assert.equal(report.final_api_locked,false);
 assert.equal(report.frontend_migration_allowed,false);
});
test('plausible self-declared approvals cannot be automatically promoted to verified field evidence',()=>{
 const manifest=createEvidenceIntakeTemplate();
 for(const group of Object.values(manifest))for(const entry of Object.values(group)){
  Object.assign(entry,{status:'APPROVED',classification:'FIELD_VERIFIED',
   source_ref:'signed-ref-123',sha256:'f'.repeat(64),observed_at:'2026-11-06T00:00:00Z',
   prepared_by:'preparer-a',approved_by:'approver-b',approved_at:'2026-11-06T01:00:00Z',
   provenance:'vendor-export',verification_method:'manual signature review'});
 }
 const report=assessEvidenceManifest(manifest);
 assert.equal(report.source_evidence_claims_complete,true);
 assert.equal(report.independently_verified,false);
 assert.equal(report.final_api_locked,false);
 assert.equal(report.frontend_migration_allowed,false);
 assert.equal(report.verdict,'MANUAL_AUTHENTICITY_REVIEW_REQUIRED');
});
test('approval by same actor and synthetic fixture are rejected',()=>{
 const manifest=createEvidenceIntakeTemplate();
 manifest.inventory.physical_measurement={status:'APPROVED',classification:'UAT_SYNTHETIC',
  source_ref:'fixture-test',sha256:'a'.repeat(64),observed_at:'2026-11-06T00:00:00Z',
  prepared_by:'same',approved_by:'same',approved_at:'2026-11-06T00:00:00Z',
  provenance:'test-fixture',verification_method:'simulated'};
 const result=assessEvidenceManifest(manifest);
 assert.ok(result.untrusted.includes('inventory.physical_measurement'));
 assert.equal(result.final_api_locked,false);
});
