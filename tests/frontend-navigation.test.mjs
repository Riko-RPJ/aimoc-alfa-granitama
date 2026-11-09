import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {legacyPagesForRole,defaultLegacyPage,legacyPageFromPath,legacyPathForPage,stockpileNavigation,targetNavigation} from '../src/app/navigation.js';

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
test('Stockpile login design is selected only by the Stockpile route',async()=>{
  const source=await readFile(new URL('../src/features/auth/index.jsx',import.meta.url),'utf8');
  assert.match(source,/pathname\.startsWith\('\/stockpile'\)/);
  assert.match(source,/if \(!window\.location\.pathname.*return <div className="login-shell">/);
  assert.match(source,/selectTheme\('light'\)/);
  assert.match(source,/selectTheme\('dark'\)/);
  assert.match(source,/aimoc\.stockpile\.theme/);
  assert.match(source,/placeholder="Masukkan username Stockpile"/);
  assert.match(source,/JSON\.stringify\(\{ username, password \}\)/);
});
test('Stockpile landing exposes exactly two backend-integrated tasks',async()=>{
  const source=await readFile(new URL('../src/features/pages/stockpile/StockpileMenuPage.jsx',import.meta.url),'utf8');
  for(const label of ['Tambah Stockpile','Data Material']) assert.match(source,new RegExp(label));
  for(const removed of ['Ringkasan Operasional','Pengiriman & Ritase','Penerimaan Kembali','Riwayat & Status ERP']) assert.doesNotMatch(source,new RegExp(removed.replace('&','\\&')));
  assert.equal((source.match(/^  \['/gm)||[]).length,2);
  assert.match(source,/Kembali ke login/);
  assert.match(source,/selectTheme\('light'\)/);
  assert.match(source,/selectTheme\('dark'\)/);
  assert.match(source,/context\.openMeasurement\(\)/);
  const workspace=await readFile(new URL('../src/features/integrated/IntegratedWorkspace.jsx',import.meta.url),'utf8');
  assert.match(workspace,/openMeasurement:.*\/stockpile\/add-material/);
  assert.match(workspace,/role==='stock'/);
  assert.match(workspace,/<StockpileMenuPage logout=\{logout\} context=\{context\}/);
  assert.match(workspace,/scopeStock=\{scopeStock\}/);
  assert.match(workspace,/legacy:true,close:false/);
  assert.match(source,/\['pending','needs_calibration'\]\.includes\(row\.status\)/);
  assert.match(source,/pageSize=6/);
  assert.match(source,/Filter status/);
  assert.match(source,/context\.scopeStock\.map/);
  assert.match(source,/row\.status!=='approved'/);
  assert.match(source,/officialStock:true/);
});
test('Stockpile material form is a dedicated two-step page',async()=>{
  const source=await readFile(new URL('../src/features/inventory/index.jsx',import.meta.url),'utf8');
  assert.match(source,/stockpile-measurement-workspace/);
  assert.match(source,/Sumber & material/);
  assert.match(source,/Pengukuran & bukti/);
  assert.match(source,/setStep\(2\)/);
  assert.match(source,/setStep\(1\)/);
  assert.match(source,/tr\("Submit"\)/);
});
