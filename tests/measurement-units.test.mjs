import test from 'node:test';
import assert from 'node:assert/strict';
import {previewMeasurementQuantity} from '../shared/measurement-units.mjs';
import {applyAction,createSeed,publicState} from '../server/domain.mjs';

const admin={id:'survey-admin',role:'admin'},stock={id:'survey-stock',role:'stock',crusherIds:['crusher-1']};
const pileId='stock-1-3'; // split-12, density 1.5 t/m3
const create=(state,payload={},actor=admin)=>{
 const r=applyAction(state,'measurement.create',{stockpileId:pileId,skuId:'split-12',method:'manual',notes:'Synthetic field survey reference',...payload},actor);
 return state.measurements.find(m=>m.id===r.entityId);
};

test('survey unit conversion retains original 150 tonnes and derives 100 m3',()=>{
 assert.deepEqual(previewMeasurementQuantity(150,'t',1.5),{valid:true,errorCode:null,quantityValue:150,quantityUnit:'t',volumeM3:100,tonnageT:150,densityTPerM3Snapshot:1.5});
 assert.equal(previewMeasurementQuantity(100,'m3',1.5).tonnageT,150);
 assert.equal(previewMeasurementQuantity(0,'t',1.5).volumeM3,0);
});

test('six-decimal conversion uses exact scaled arithmetic and bounded rounding',()=>{
 const r=previewMeasurementQuantity(1,'t',1.3);assert.equal(r.volumeM3,0.769231);assert.equal(r.quantityValue,1);assert.equal(r.tonnageT,1);
 assert.equal(previewMeasurementQuantity(0.123456,'m3',1.234567).tonnageT,0.152415);
 assert.equal(previewMeasurementQuantity(0.000001,'t',5).valid,false,'Positive tonnes cannot disappear into zero canonical volume');
});

test('invalid quantities, units, precision, density and overflowing conversion are refused',()=>{
 for(const value of ['',null,undefined,false,true,'100',' ',NaN,Infinity,-1,1000000001,0.1234567])assert.equal(previewMeasurementQuantity(value,'t',1.5).valid,false,String(value));
 for(const unit of ['kg','ton','m³','',null])assert.equal(previewMeasurementQuantity(10,unit,1.5).errorCode,'INVALID_MEASUREMENT_UNIT');
 for(const density of [0,-1,6,null,undefined,NaN,Infinity,'1.5'])assert.equal(previewMeasurementQuantity(10,'t',density).errorCode,'INVALID_MEASUREMENT_DENSITY');
 assert.equal(previewMeasurementQuantity(1000000000,'t',0.000001).valid,false);
});

test('m3 remains a valid original unit without inventing tonnes when density is unavailable',()=>{
 const r=previewMeasurementQuantity(100,'m3',null);assert.equal(r.valid,true);assert.equal(r.volumeM3,100);assert.equal(r.tonnageT,null);assert.equal(r.densityTPerM3Snapshot,null);
});

test('Admin and Stock retain original units while creation never changes inventory',()=>{
 const s=createSeed(),before=structuredClone(s.stockpiles);
 const a=create(s,{quantityValue:150,quantityUnit:'t'}),b=create(s,{quantityValue:120,quantityUnit:'m3'},stock);
 assert.deepEqual({quantityValue:a.quantityValue,quantityUnit:a.quantityUnit,volumeM3:a.volumeM3,tonnageT:a.tonnageT,density:a.densityTPerM3Snapshot},{quantityValue:150,quantityUnit:'t',volumeM3:100,tonnageT:150,density:1.5});
 assert.equal(b.quantityValue,120);assert.equal(b.quantityUnit,'m3');assert.equal(b.tonnageT,180);assert.equal(a.status,'pending');assert.deepEqual(s.stockpiles,before);
});

test('legacy volume-only submission remains m3 and historical records are not reinterpreted',()=>{
 const s=createSeed(),old={id:'historic',stockpileId:pileId,crusherId:'crusher-1',skuId:'split-12',method:'manual',volumeM3:77,status:'pending',stockLedgerSequence:0};s.measurements.push(old);
 const m=create(s,{volumeM3:90},stock);assert.equal(m.quantityValue,90);assert.equal(m.quantityUnit,'m3');assert.equal(m.tonnageT,135);
 assert.deepEqual(s.measurements[0],old);assert.equal('quantityUnit' in publicState(s,admin).measurements[0],false);
});

test('mixed or client-derived manual quantities are rejected before writing any measurement',()=>{
 for(const payload of [{quantityValue:150,quantityUnit:'t',volumeM3:999},{quantityValue:150,quantityUnit:'t',tonnageT:150},{quantityValue:150,quantityUnit:'t',densityTPerM3Snapshot:1.5},{quantityValue:150,quantityUnit:'t',densityTPerM3:1.5},{quantityValue:150,quantityUnit:'t',conversionBasis:'CLIENT'},{volumeM3:100,unit:'t'},{quantityValue:1},{quantityUnit:'m3'},{quantityValue:150,quantityUnit:'kg'}]){
  const s=createSeed(),before=structuredClone(s);assert.throws(()=>create(s,payload));assert.deepEqual(s,before);
 }
});

test('snapshot and canonical volume survive subsequent master density changes through approval',()=>{
 const s=createSeed(),m=create(s,{quantityValue:150,quantityUnit:'t'});s.products.find(p=>p.id==='split-12').densityTPerM3=2;
 applyAction(s,'measurement.approve',{measurementId:m.id},admin);
 assert.equal(s.stockpiles.find(p=>p.id===pileId).onHandM3,100);assert.equal(m.quantityValue,150);assert.equal(m.tonnageT,150);assert.equal(m.densityTPerM3Snapshot,1.5);
 const payload=s.erpOutbox.at(-1).payload;assert.equal(payload.quantityValue,150);assert.equal(payload.quantityUnit,'t');assert.equal(payload.volumeM3,100);assert.equal(payload.densityTPerM3Snapshot,1.5);assert.equal(payload.tonnageT,150);
 assert.equal(s.inventoryLedger.at(-1).volumeM3,100-820);
});

test('Stock scope, verifier role, stale ledger and reservation protections remain enforced',()=>{
 const s=createSeed();assert.throws(()=>create(s,{quantityValue:150,quantityUnit:'t'},{...stock,crusherIds:['crusher-2']}),e=>e.status===403);
 assert.throws(()=>create(s,{quantityValue:150,quantityUnit:'t'},{id:'jetty',role:'jetty'}),e=>e.status===403);
 assert.throws(()=>create(s,{quantityValue:150,quantityUnit:'t'},{id:'driver',role:'driver'}),e=>e.status===401);
 const m=create(s,{quantityValue:150,quantityUnit:'t'},stock);
 assert.throws(()=>applyAction(s,'measurement.approve',{measurementId:m.id},stock),e=>e.status===403);
 s.stockpiles.find(p=>p.id===pileId).reservedM3=101;
 assert.throws(()=>applyAction(s,'measurement.approve',{measurementId:m.id},admin),e=>e.code==='RESERVED_STOCK');
 s.stockpiles.find(p=>p.id===pileId).reservedM3=0;s.inventoryLedger.push({stockpileId:pileId,volumeM3:-1});
 assert.throws(()=>applyAction(s,'measurement.approve',{measurementId:m.id},admin),e=>e.code==='STALE_MEASUREMENT');assert.equal(m.status,'pending');
});

test('tonnes require density; camera and geometry cannot smuggle survey-unit quantities',()=>{
 const s=createSeed();s.products.find(p=>p.id==='split-12').densityTPerM3=null;
 assert.throws(()=>create(s,{quantityValue:150,quantityUnit:'t'}),e=>e.code==='INVALID_MEASUREMENT_DENSITY');
 const m=create(s,{quantityValue:100,quantityUnit:'m3'});assert.equal(m.tonnageT,null);assert.equal(m.volumeM3,100);
 assert.throws(()=>create(s,{method:'camera_pending',quantityValue:150,quantityUnit:'t'},stock),e=>e.code==='INVALID_MEASUREMENT_UNIT');
 assert.throws(()=>create(s,{method:'calibrated_geometry',quantityValue:150,quantityUnit:'t',geometry:{lengthM:10,widthM:10,heightM:1}}),e=>e.code==='INVALID_MEASUREMENT_UNIT');
 assert.throws(()=>create(s,{method:'camera_pending',evidenceId:'photo'}),e=>e.status===403);
});
