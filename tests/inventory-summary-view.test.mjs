import test from 'node:test';
import assert from 'node:assert/strict';
import {buildInventorySummary} from '../src/features/integrated/inventory-summary-view.mjs';
import {createSeed} from '../server/seed.mjs';
import {summarizeSkuStocks} from '../server/sku-stock-summary.mjs';
import {integratedView} from '../server/integrated-demo-domain.mjs';

const products=[{id:'a',code:'A',name:'Split A',densityTPerM3:1.5,active:true},{id:'b',code:'B',name:'Split B',densityTPerM3:1.65,active:true},{id:'zero',code:'ZERO',name:'No stock',densityTPerM3:1.5,active:true}];
const pile=(id,skuId,onHandM3,reservedM3=0,extra={})=>({id,code:id,skuId,onHandM3,reservedM3,active:true,...extra});

test('SKU totals aggregate across stockpiles and keep reservations inside physical stock',()=>{
 const stockpiles=[pile('one','a',30,5),pile('two','a',20,7),pile('three','b',8,1)];
 const before=structuredClone({products,stockpiles});
 const summary=buildInventorySummary({products,stockpiles}),a=summary.skuRows.find(row=>row.skuId==='a');
 assert.deepEqual([a.physicalM3,a.physicalTonnes,a.reservedM3,a.reservedTonnes,a.availableM3,a.availableTonnes],[50,75,12,18,38,57]);
 assert.equal(a.stockpileCount,2);assert.equal(a.withStockCount,2);
 assert.deepEqual(summary.counts,{total:3,withStock:3,empty:0,knownStocked:3,knownEmpty:0,needsReview:0,unknownSku:0});
 assert.deepEqual({products,stockpiles},before,'A display projection must never mutate the canonical ledger');
});

test('empty classification uses physical balance, not whether an SKU was assigned',()=>{
 const summary=buildInventorySummary({products,stockpiles:[pile('filled','a',2),pile('assigned-but-empty','a',0),pile('unassigned-empty',null,0)]});
 assert.equal(summary.counts.total,3);assert.equal(summary.counts.withStock,1);assert.equal(summary.counts.empty,2);
 assert.equal(summary.skuRows.find(row=>row.skuId==='a').stockpileCount,2);
 assert.equal(summary.skuRows.find(row=>row.skuId==='zero').physicalM3,0);
 assert.equal(summary.skuRows.find(row=>row.skuId==='zero').physicalTonnes,0);
});

test('inactive stockpiles still contribute recorded physical balances',()=>{
 const result=buildInventorySummary({products,stockpiles:[pile('active','a',2,1),pile('inactive','a',3,0,{active:false})]});
 assert.equal(result.counts.withStock,2);assert.equal(result.skuRows[0].physicalM3,5);assert.equal(result.skuRows[0].availableM3,4);
});

test('six-decimal accumulation and density conversion match the canonical server for every SKU',()=>{
 const state=createSeed();state.stockpiles[0].onHandM3=300000.666667;state.stockpiles[0].reservedM3=33.333333;
 state.stockpiles[6].onHandM3=0.333334;state.stockpiles[6].reservedM3=0.111111;
 const browser=buildInventorySummary(state),server=summarizeSkuStocks(state,{id:'admin-view',role:'admin',active:true});
 for(const actual of browser.skuRows){
  const expected=server.items.find(row=>row.skuId===actual.skuId);assert.ok(expected);
  for(const key of ['physicalM3','physicalTonnes','reservedM3','reservedTonnes','availableM3','availableTonnes','stockpileCount'])assert.equal(actual[key],expected[key],actual.skuCode+' '+key);
 }
});

test('a missing density hides only tonnage and preserves physical volume and full/empty counts',()=>{
 const result=buildInventorySummary({products:[{id:'a',code:'A'}],stockpiles:[pile('one','a',10,2)]}),row=result.skuRows[0];
 assert.equal(result.counts.withStock,1);assert.equal(row.physicalM3,10);assert.equal(row.reservedM3,2);assert.equal(row.availableM3,8);
 assert.equal(row.physicalTonnes,null);assert.equal(row.reservedTonnes,null);assert.equal(row.availableTonnes,null);assert.ok(row.issues.includes('DENSITY_UNAVAILABLE'));
});

test('positive stock with an unknown or missing SKU is shown for review, never called empty',()=>{
 const result=buildInventorySummary({products,stockpiles:[pile('known','a',5),pile('unknown','ghost',7),pile('without',null,9)]});
 assert.deepEqual([result.counts.total,result.counts.knownStocked,result.counts.knownEmpty,result.counts.needsReview,result.counts.unknownSku],[3,1,0,2,2]);
 assert.equal(result.counts.withStock,null);assert.equal(result.counts.empty,null);
 for(const id of ['ghost','__unassigned_sku__']){const row=result.skuRows.find(row=>row.skuId===id);assert.ok(row.physicalM3>0);assert.equal(row.physicalTonnes,null);assert.ok(row.issues.includes('UNKNOWN_SKU'));}
});

test('missing or redacted balances do not become false zero quantities or empty bins',()=>{
 const result=buildInventorySummary({products,stockpiles:[{id:'redacted',skuId:'a'},pile('known','a',5,1)]}),row=result.skuRows[0];
 assert.equal(result.counts.total,2);assert.equal(result.counts.withStock,null);assert.equal(result.counts.empty,null);assert.equal(result.counts.needsReview,1);
 assert.equal(row.physicalM3,null);assert.equal(row.physicalTonnes,null);assert.equal(row.reservedM3,null);assert.equal(row.availableM3,null);
});

test('permission-restricted empty context cannot imply zero stock for the company-wide SKU catalog',()=>{
 const result=buildInventorySummary({products,stockpiles:[],inventoryVisible:false});
 assert.equal(result.counts.total,0,'Only accessible inventory metadata is counted');
 assert.equal(result.counts.withStock,null);assert.equal(result.counts.empty,null);
 assert.ok(result.skuRows.every(row=>row.physicalM3===null&&row.physicalTonnes===null&&row.reservedM3===null&&row.availableM3===null&&row.stockpileCount===null));
 assert.ok(result.skuRows.every(row=>row.issues.includes('BALANCE_RESTRICTED')));
});

test('real domain Stock scope limits all summaries and Jetty scope remains explicitly restricted',()=>{
 const state=createSeed(),stock=integratedView(state,{id:'stock',role:'stock',crusherIds:['crusher-1']}),jetty=integratedView(state,{id:'jetty',role:'jetty',jettyIds:['jetty-1']});
 const stockSummary=buildInventorySummary(stock);
 assert.equal(stockSummary.counts.total,6);assert.equal(stockSummary.counts.withStock,6);
 assert.equal(stockSummary.skuRows[0].physicalM3,state.stockpiles[0].onHandM3);
 assert.deepEqual(jetty.stockpiles,[]);
 const jettySummary=buildInventorySummary({...jetty,inventoryVisible:false});
 assert.ok(jettySummary.skuRows.every(row=>row.physicalM3===null));
});

test('invalid or excessive reservations preserve physical values but suppress free stock',()=>{
 const result=buildInventorySummary({products,stockpiles:[pile('one','a',0,2)]}),row=result.skuRows[0];
 assert.equal(result.counts.empty,1);assert.equal(row.physicalM3,0);assert.equal(row.reservedM3,2);assert.equal(row.availableM3,null);assert.equal(row.availableTonnes,null);
 assert.ok(row.issues.includes('RESERVATION_EXCEEDS_ON_HAND'));
 const absent=buildInventorySummary({products,stockpiles:[{id:'missing',skuId:'a',onHandM3:5}]}).skuRows[0];
 assert.equal(absent.physicalM3,5);assert.equal(absent.reservedM3,null);assert.equal(absent.availableM3,null);
});

test('duplicate IDs are counted once and marked ambiguous instead of doubling recorded quantities',()=>{
 const result=buildInventorySummary({products,stockpiles:[pile('same','a',3),pile('same','a',7)]});
 assert.equal(result.counts.total,1);assert.equal(result.counts.needsReview,1);assert.equal(result.skuRows[0].stockpileCount,1);assert.equal(result.skuRows[0].physicalM3,null);
 assert.ok(result.issues.includes('DUPLICATE_STOCKPILE_ID'));
});

test('negative, string and non-finite balances remain unavailable without hiding valid zero SKUs',()=>{
 for(const onHandM3 of [-1,'12',NaN,Infinity,null]){
  const result=buildInventorySummary({products,stockpiles:[pile('invalid','a',onHandM3)]});
  assert.equal(result.counts.needsReview,1);assert.equal(result.counts.empty,null);assert.equal(result.skuRows[0].physicalM3,null);
  assert.equal(result.skuRows.find(row=>row.skuId==='zero').physicalM3,0);
 }
});
