import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed,applyAction} from '../server/domain.mjs';

const admin={id:'review-admin',role:'admin'};
const act=(s,action,payload)=>applyAction(s,action,payload,admin);
const request=s=>act(s,'request.create',{
  jettyId:'jetty-1',vesselId:'vessel-1',
  lines:[{skuId:'split-12',quantity:28,unit:'m3'}],
}).entityId;

test('a disabled vessel cannot receive a newly created dispatch',()=>{
  const s=createSeed();
  act(s,'master.vessel.save',{id:'vessel-1',active:false});
  assert.throws(()=>{
    const requestId=request(s);
    act(s,'request.plan',{requestId});
  });
  assert.equal(s.trips.length,0);
  assert.equal(s.stockpiles.reduce((sum,row)=>sum+row.reservedM3,0),0);
});

test('jetty deactivation after request creation is rechecked before dispatch reservation',()=>{
  const s=createSeed(),requestId=request(s);
  act(s,'master.jetty.save',{id:'jetty-1',active:false});
  const before=structuredClone(s);
  assert.throws(()=>act(s,'request.plan',{requestId}));
  assert.deepEqual(s,before);
});

test('a pending survey cannot silently become stock for a different SKU',()=>{
  const s=createSeed();
  const measurementId=applyAction(s,'measurement.create',{
    stockpileId:'stock-1-1',method:'manual',volumeM3:1000,
  },{id:'stock-review',role:'stock',crusherIds:['crusher-1']}).entityId;
  let changed=false;
  try {
    act(s,'master.stockpile.save',{id:'stock-1-1',skuId:'split-12'});
    changed=true;
  }catch(error){assert.equal(error.status,400);}
  if(changed){
    const before=structuredClone(s);
    assert.throws(()=>act(s,'measurement.approve',{measurementId}));
    assert.deepEqual(s,before);
  }else{
    assert.equal(s.stockpiles[0].skuId,'abu-batu');
    assert.equal(s.stockpiles[0].onHandM3,650);
  }
});
