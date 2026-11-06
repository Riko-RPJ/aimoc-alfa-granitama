import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateLoadingCapacity} from '../server/uat-wim-tare-calculation.mjs';

const calculate=overrides=>calculateLoadingCapacity({
  approvedGvwT:'60.000000',
  tareT:'12.000000',
  approvedPayloadT:'45.000000',
  remainingPlannedT:'40.000000',
  ...overrides,
});

test('calculates an exact six-decimal loading limit for each governing boundary',()=>{
  assert.deepEqual(calculate(),{
    gvwAvailableT:'48.000000',loadingLimitT:'40.000000',limitedBy:'REMAINING_PLANNED',
  });
  assert.deepEqual(calculate({approvedGvwT:'50',tareT:'12',approvedPayloadT:'45',remainingPlannedT:'40'}),{
    gvwAvailableT:'38.000000',loadingLimitT:'38.000000',limitedBy:'GVW',
  });
  assert.deepEqual(calculate({approvedPayloadT:'39.999999',remainingPlannedT:'40'}),{
    gvwAvailableT:'48.000000',loadingLimitT:'39.999999',limitedBy:'PAYLOAD',
  });
});

test('uses scaled integers without floating-point drift and permits zero remaining plan',()=>{
  assert.deepEqual(calculate({approvedGvwT:'0.300000',tareT:'0.100000',approvedPayloadT:'0.200001',remainingPlannedT:'0.200000'}),{
    gvwAvailableT:'0.200000',loadingLimitT:'0.200000',limitedBy:'GVW',
  });
  assert.deepEqual(calculate({remainingPlannedT:'0'}),{
    gvwAvailableT:'48.000000',loadingLimitT:'0.000000',limitedBy:'REMAINING_PLANNED',
  });
});

test('breaks equal limits deterministically in GVW, payload, remaining-plan order',()=>{
  assert.equal(calculate({approvedGvwT:'52',tareT:'12',approvedPayloadT:'40',remainingPlannedT:'40'}).limitedBy,'GVW');
  assert.equal(calculate({approvedPayloadT:'40',remainingPlannedT:'40'}).limitedBy,'PAYLOAD');
});

test('rejects missing Tare and capacity master values with stable error codes',()=>{
  assert.throws(()=>calculate({tareT:undefined}),error=>error.status===422&&error.code==='UAT_TARE_MISSING');
  for(const field of ['approvedGvwT','approvedPayloadT','remainingPlannedT']){
    assert.throws(()=>calculate({[field]:undefined}),error=>error.status===422&&error.code==='UAT_CAPACITY_MISSING');
  }
  assert.throws(()=>calculateLoadingCapacity(),error=>error.status===422&&error.code==='UAT_CAPACITY_MISSING');
});

test('rejects invalid exact-decimal inputs and non-positive capacities',()=>{
  for(const value of ['12.0000001','1e1','12,5','NaN','Infinity','-1',' 12','01.0',12]){
    assert.throws(()=>calculate({tareT:value}),error=>error.status===422&&error.code==='UAT_TARE_INVALID');
  }
  for(const [field,value] of [
    ['approvedGvwT','0'],['approvedPayloadT','0'],['remainingPlannedT','-0.1'],
    ['approvedGvwT','60.0000001'],['remainingPlannedT','1e1'],
  ]){
    assert.throws(()=>calculate({[field]:value}),error=>error.status===422&&error.code==='UAT_CAPACITY_INVALID');
  }
});

test('rejects Tare equal to or greater than approved GVW',()=>{
  assert.throws(()=>calculate({tareT:'60'}),error=>error.status===422&&error.code==='UAT_TARE_INVALID');
  assert.throws(()=>calculate({tareT:'60.000001'}),error=>error.status===422&&error.code==='UAT_TARE_INVALID');
});
