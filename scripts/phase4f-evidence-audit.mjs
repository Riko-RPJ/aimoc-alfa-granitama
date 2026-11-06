import {mkdir,writeFile} from 'node:fs/promises';
import {createEvidenceIntakeTemplate,assessEvidenceManifest} from '../src/contracts/source-evidence-acceptance.js';
import {targetPageContracts} from '../src/contracts/page-contracts.js';
import {API_ROUTE_CONTRACTS,FINAL_API_GAPS,assessFinalApiContract} from '../src/contracts/api-v1-candidate.js';
const template=createEvidenceIntakeTemplate();
const evidence=assessEvidenceManifest(template);
const routes=new Map(API_ROUTE_CONTRACTS.map(r=>[r.method+' '+r.path,r]));
const pages=Object.entries(targetPageContracts).flatMap(([role,tabs])=>Object.entries(tabs).map(([page,def])=>({
 role,page,endpoint:def.endpoint,method:'GET',
 route_candidate:routes.has('GET '+def.endpoint),
 fields:def.fields,required_permissions:def.permissions,
 agreement:routes.has('GET '+def.endpoint)?'CANDIDATE_REQUIRES_DTO_SIGNOFF':'NOT_IMPLEMENTED_OR_NOT_MATCHING'
})));
const counts={total_page_contracts:pages.length,route_candidates:pages.filter(p=>p.route_candidate).length,
 unmapped:pages.filter(p=>!p.route_candidate).length,unresolved_api_gaps:FINAL_API_GAPS.length};
const report={
 generated_at:new Date().toISOString(),source:'REPOSITORY_STATIC_CONTRACT_REVIEW',
 evidence,contract:assessFinalApiContract(),counts,pages,
 final_acceptance_status:'BLOCKED',
 frontend_migration_allowed:false,
 note:'Candidate route match does not mean response DTO field parity or deployment. All approvals are external.'
};
await mkdir('qa/phase4f',{recursive:true});
await writeFile('qa/phase4f/EVIDENCE_INTAKE_TEMPLATE.json',JSON.stringify(template,null,2)+'\n');
await writeFile('qa/phase4f/CONTRACT_ACCEPTANCE_AUDIT.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({counts,evidenceMissing:evidence.missing.length,final:report.final_acceptance_status},null,2));
