import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed,publicState} from '../server/domain.mjs';
import {DATA_STATE,legacyPageDataContract,targetPageContracts,visibleLegacyPages} from '../src/contracts/page-contracts.js';

test('target contracts are role-specific and have explicit sources and permissions', () => {
  assert.equal(targetPageContracts.DRIVER.home.endpoint,'/api/v1/driver/me/active-trip');
  assert.ok(targetPageContracts.ADMIN.dispatchMonitoring.fields.includes('sequence_eligibility'));
  assert.ok(targetPageContracts.STOCKPILE.inventory.permissions.includes('stockpile.inventory.read'));
  assert.ok(targetPageContracts.STOCKPILE.pickups.permissions.includes('stockpile.pickups.read'));
  assert.equal(visibleLegacyPages('driver').length,0);
});
test('Driver has no fabricated trip records while backend is unavailable',()=>{
  const contract=legacyPageDataContract({role:'driver',page:'home',state:{trips:[{id:'fake'}]}});
  assert.equal(contract.dataState,DATA_STATE.NOT_INTEGRATED);
  assert.deepEqual(contract.records,[]);
});
test('cannot read legacy page outside role scope',()=>{
  assert.equal(legacyPageDataContract({role:'stock',page:'master',state:{products:[]}}).dataState,DATA_STATE.FORBIDDEN);
});
test('empty, loading, stale are distinct from zero',()=>{
  const loading=legacyPageDataContract({role:'admin',page:'inventory'});
  assert.equal(loading.dataState,DATA_STATE.LOADING);
  const empty=legacyPageDataContract({role:'admin',page:'inventory',state:{stockpiles:[]}});
  assert.equal(empty.dataState,DATA_STATE.EMPTY);
  const stale=legacyPageDataContract({role:'admin',page:'inventory',state:{stockpiles:[]},connected:false});
  assert.equal(stale.dataState,DATA_STATE.STALE);
  const missing=legacyPageDataContract({role:'admin',page:'inventory',state:{stockpiles:[{id:'x',skuId:'s'}]}});
  assert.equal(missing.records[0].onHandM3,null);
  assert.equal(missing.records[0].availableM3,null);
});
test('legacy stockpile quantity does not become fabricated weighed tonnage',()=>{
  const state=createSeed();
  const stock=publicState(state,{id:'qa',role:'stock',crusherIds:[state.crushers[0].id]});
  const contract=legacyPageDataContract({role:'stock',page:'inventory',state:stock});
  assert.equal(contract.records.length,stock.stockpiles.length);
  assert.ok(contract.records.every(r=>r.onHandT===null&&r.availableT===null));
  assert.ok(contract.records.every(r=>r.sourceCrusherId===state.crushers[0].id));
});
test('legacy dispatch cannot imply Marine Option B readiness or verified unloading',()=>{
  const contract=legacyPageDataContract({role:'admin',page:'dispatch',state:{dispatches:[{id:'d1',status:'active'}]}});
  assert.equal(contract.records[0].marineSequenceEligibility,null);
  assert.equal(contract.records[0].activeResourceClaims,null);
  assert.equal(contract.records[0].unloadEvidence,null);
});
