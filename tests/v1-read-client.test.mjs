import test from 'node:test';
import assert from 'node:assert/strict';
import {readV1,V1ReadError} from '../src/services/v1-read-client.js';

test('v1 client validates read envelope and never assumes not integrated is zero',async()=>{
  const fetchImpl=async()=>({ok:true,status:200,json:async()=>({
    schema_version:'1.0',resource:'exceptions',data_status:'NOT_INTEGRATED',data:null
  })});
  const data=await readV1('/api/v1/exceptions',{fetchImpl});
  assert.equal(data.data_status,'NOT_INTEGRATED');assert.equal(data.data,null);
});
test('v1 client disallows absolute or legacy API URLs',async()=>{
  await assert.rejects(()=>readV1('https://example.invalid/api/v1/inventory'),e=>e.code==='INVALID_API_PATH');
  await assert.rejects(()=>readV1('/api/action'),e=>e.code==='INVALID_API_PATH');
});
test('v1 client maps auth/permission errors and rejects incompatible contracts',async()=>{
  await assert.rejects(()=>readV1('/api/v1/inventory',{fetchImpl:async()=>({
    ok:false,status:403,json:async()=>({error:'FORBIDDEN_SCOPE',message:'Denied'})
  })}),e=>e instanceof V1ReadError&&e.status===403&&e.code==='FORBIDDEN_SCOPE');
  await assert.rejects(()=>readV1('/api/v1/inventory',{fetchImpl:async()=>({
    ok:true,status:200,json:async()=>({data_status:'READY',data:{items:[]}})
  })}),e=>e.code==='CONTRACT_MISMATCH');
});
