import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyPagesForRole,defaultLegacyPage,legacyPageFromPath,legacyPathForPage,stockpileNavigation,targetNavigation,isStockpilePath,stockpileMeasurementPage} from '../src/app/navigation.js';

const existing = ['overview','home','inventory','pickups','activity','requests','dispatch','jetty','master','audit'].map(x=>[x,x]);

test('role navigation restricts legacy screens while keeping Admin access',()=>{
  assert.equal(legacyPagesForRole('admin',existing).length,7);
  assert.deepEqual(legacyPagesForRole('stock',existing).map(x=>x[0]),['home','inventory','pickups','activity']);
  assert.deepEqual(legacyPagesForRole('jetty',existing).map(x=>x[0]),['overview','requests','dispatch','jetty']);
  assert.equal(legacyPagesForRole('driver',existing).length,0);
});
test('role routes cannot resolve another roles URLs',()=>{
  assert.equal(defaultLegacyPage('stock'),'home');
  assert.equal(legacyPageFromPath('stock','/admin/overview'),null);
  assert.equal(legacyPageFromPath('admin','/stockpile/inventory'),null);
  assert.equal(legacyPageFromPath('stock','/stockpile/inventory'),'inventory');
  assert.equal(legacyPageFromPath('stock','/stockpile/dispatch'),null);
  assert.equal(legacyPageFromPath('stock','/stockpile/transfers'),null);
  assert.equal(legacyPageFromPath('stock','/admin/dispatch'),null);
  assert.equal(legacyPathForPage('stock','jetty'),null);
  assert.equal(legacyPageFromPath('admin',legacyPathForPage('admin','dispatch')),'dispatch');
});
test('desktop and mobile Stockpile navigation share one exact menu definition',()=>{
  assert.deepEqual(stockpileNavigation.map(({id,label})=>[id,label]),[
    ['home','Home'],['inventory','Inventory'],['pickups','Pickups'],['activity','Activity']
  ]);
  assert.deepEqual(stockpileNavigation.map(x=>x.route),targetNavigation.STOCKPILE);
});
test('planned Driver routes are not exposed as running legacy pages',()=>{
  assert.deepEqual(targetNavigation.DRIVER,['/driver/home','/driver/tasks','/driver/history','/driver/profile']);
  assert.equal(defaultLegacyPage('driver'),null);
});
test('Stockpile tablet login matches only the workspace path',()=>{
  for(const path of ['/stockpile','/stockpile/','/stockpile/inventory','/stockpile/add-material']) assert.equal(isStockpilePath(path),true);
  for(const path of ['/','/admin/stockpile','/stockpile-backup']) assert.equal(isStockpilePath(path),false);
});
test('the measurement page accepts a stock operator bookmark only',()=>{
  assert.equal(stockpileMeasurementPage('stock','/stockpile/add-material'),'add-material');
  assert.equal(stockpileMeasurementPage('stock','/stockpile/add-material/'),'add-material');
  for(const role of ['admin','driver','jetty']) assert.equal(stockpileMeasurementPage(role,'/stockpile/add-material'),null);
  assert.equal(stockpileMeasurementPage('stock','/admin/add-material'),null);
  assert.equal(stockpileMeasurementPage('stock','/stockpile/inventory'),null);
});
