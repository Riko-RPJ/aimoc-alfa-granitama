import {readFile} from 'node:fs/promises';
const raw=await readFile('.local/staging.env','utf8');
const line=raw.split(/\r?\n/).find(x=>x.startsWith('AIMOC_STAGING_DATABASE_URL='));
const url=line?.slice('AIMOC_STAGING_DATABASE_URL='.length).trim();
if(!url||process.env.DATABASE_URL)throw Error('LOCAL_STAGING_REQUIRES_SEPARATE_LOCAL_LEGACY_DATABASE');
const parsed=new URL(url);
if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.pathname!=='/aimoc_execution_staging_uat')
 throw Error('REFUSING_NONLOCAL_OR_NONISOLATED_STAGING_URL');
process.env.AIMOC_STAGING_DATABASE_URL=url;
process.env.AIMOC_LOCAL_TRUCK_CODE_UAT='1';
await import('./local.mjs');
