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
test('Driver omits its redundant single-item workspace navigation',async()=>{
  const source=await readFile(new URL('../src/features/integrated/IntegratedWorkspace.jsx',import.meta.url),'utf8');
  assert.match(source,/role!=='driver'&&<WorkspaceNavigation/);
});
test('Driver starts with one active QR and reveals backend load details only after scan',async()=>{
  const workspace=await readFile(new URL('../src/features/integrated/IntegratedWorkspace.jsx',import.meta.url),'utf8');
  const qr=await readFile(new URL('../src/features/integrated/DriverAssignmentQrModal.jsx',import.meta.url),'utf8');
  assert.match(workspace,/className="ig-driver-qr-toggle"/);
  assert.match(workspace,/Sembunyikan QR/);
  assert.match(workspace,/DriverAssignmentQrModal embedded/);
  assert.match(workspace,/driverCurrentTrip/);
  for(const text of ["L('Tugas Baru','New Assignment')","L('Keluar','Sign out')",'driverCompletion.tonnes','driverCompletion.volume'])assert.ok(workspace.includes(text),`Missing Driver completion control: ${text}`);
  assert.doesNotMatch(workspace,/DriverDailySummary summary=/);
  assert.doesNotMatch(workspace,/Scan QR Dispatch/);
  assert.match(qr,/driver-dispatch-qr-panel/);
  assert.match(qr,/scanned&&<>/);
  assert.match(workspace,/qrVisible=\{driverQrVisible\}/);
  assert.match(workspace,/driver-all-tasks-completed/);
  assert.match(qr,/\(!embedded\|\|qrVisible\)&&<section/);
  assert.doesNotMatch(qr,/previousProof/);
  assert.match(qr,/!embedded&&<Button variant="secondary"/);
  for(const field of ["L('Scan','Scan')","L('Selesai','Complete')",'Kode dump truk','Plat / internal kendaraan','Nama Driver','Berat truk sebelum diisi muatan','Menunggu data TARE','Total material yang akan diisi','Kode material','Lokasi muat','Berat bersih muatan WIM'])assert.ok(qr.includes(field),`Missing Driver detail label: ${field}`);
  assert.doesNotMatch(qr,/Tipe indeks truk/);
  assert.match(workspace,/Total ritase diselesaikan/);
  assert.match(workspace,/Total muatan di-load/);
});
test('Stockpile login design is selected only by the Stockpile route',async()=>{
  const source=await readFile(new URL('../src/features/auth/index.jsx',import.meta.url),'utf8');
  assert.match(source,/if \(requiredRole !== 'stock'\)/);
  assert.match(source,/driver-login/);
  assert.match(source,/selectTheme\('light'\)/);
  assert.match(source,/selectTheme\('dark'\)/);
  assert.match(source,/aimoc\.stockpile\.theme/);
  assert.match(source,/placeholder="Masukkan username Stockpile"/);
  assert.match(source,/JSON\.stringify\(\{ username, password \}\)/);
  assert.match(source,/data\.user\?\.role!==requiredRole/);
  assert.match(source,/Anda harus login sebagai/);
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
  assert.match(source,/\['pending','needs_calibration'\]\.includes\(row\.status\)/);
  assert.match(source,/pageSize=6/);
  assert.match(source,/Filter status/);
  assert.match(source,/context\.scopeStock\.map/);
  assert.match(source,/row\.status!=='approved'/);
  assert.match(source,/officialStock:true/);
  assert.match(source,/volumeM3\*material\.densityTPerM3/);
  assert.match(source,/MaterialQuantity/);
});
test('Stockpile material form is a dedicated two-step page',async()=>{
  const source=await readFile(new URL('../src/features/inventory/index.jsx',import.meta.url),'utf8');
  assert.match(source,/stockpile-measurement-workspace/);
  assert.match(source,/\[step, setStep\] = useState\(1\)/);
  assert.match(source,/Sumber & material/);
  assert.match(source,/Pengukuran & bukti/);
  assert.match(source,/setStep\(2\)/);
  assert.match(source,/setStep\(1\)/);
  assert.match(source,/tr\("Submit"\)/);
});
test('active Integrated workspace renders the scoped Stockpile tablet experience',async()=>{
  const source=await readFile(new URL('../src/features/integrated/IntegratedWorkspace.jsx',import.meta.url),'utf8');
  assert.match(source,/import \{StockpileMenuPage\}/);
  assert.match(source,/if\(role==='stock'\)/);
  assert.match(source,/allowedCrusherIds\.has\(row\.crusherId\)/);
  assert.match(source,/stockIds\.has\(row\.stockpileId\)/);
  assert.match(source,/data-testid="stockpile-tablet-workspace"/);
  assert.match(source,/act\('measurement\.create',payload,\{legacy:true\}\)/);
  assert.match(source,/window\.location\.pathname==='\/stockpile\/add-material'/);
  assert.match(source,/history\.pushState\(\{\},'',\'\/stockpile\/add-material\'\);setModal\(\{type:'measurement'\}\)/);
  assert.match(source,/setModal\(window\.location\.pathname==='\/stockpile\/add-material'\?\{type:'measurement'\}:null\)/);
});
test('active app requires the role selected by the login URL',async()=>{
  const source=await readFile(new URL('../src/App.jsx',import.meta.url),'utf8');
  assert.match(source,/path\.startsWith\('\/stockpile'\)\?'stock'/);
  assert.match(source,/path\.startsWith\('\/driver'\)\?'driver'/);
  assert.match(source,/:'admin';/);
  assert.match(source,/session\.user\.role!==requiredRole/);
  assert.match(source,/<Login requiredRole=\{requiredRole\}/);
});
