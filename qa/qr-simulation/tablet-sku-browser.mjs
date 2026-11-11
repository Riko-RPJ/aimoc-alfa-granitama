import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createHandler} from '../../server/handler.mjs';
import {fixture} from '../../tests/driver-two-scan-http-fixture.mjs';

assert.ok(!process.env.DATABASE_URL && !process.env.AIMOC_STAGING_DATABASE_URL, 'Use synthetic browser QA only');
const dist = fileURLToPath(new URL('../../dist', import.meta.url));
await fs.access(path.join(dist, 'index.html'));

const cleanups = [];
try {
  const f = await fixture({after: close => cleanups.push(close)}, {mode:'LAND', quantity:80, secondRequest:false});
  const [first, second] = f.tripsA;
  assert.equal(f.tripsA.length, 2);
  assert.equal(first.truckId, second.truckId);
  assert.equal(first.stockpileId, second.stockpileId);
  assert.equal(first.destinationStockpileId, second.destinationStockpileId);
  const survey = await f.call('/api/action', 'POST', {
    action:'measurement.create', requestId:randomUUID(),
    payload:{stockpileId:first.destinationStockpileId, skuId:first.skuId, method:'manual', quantityValue:15, quantityUnit:'m3'},
  });
  assert.equal(survey.status, 200);
  const measurementId = survey.body.result.entityId;
  const {document} = await f.state();
  const measurement = document.measurements.find(row => row.id === measurementId);
  // Represent a pending survey left by a version that allowed a different SKU.
  measurement.skuId = 'abu-batu';
  await f.db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1', [JSON.stringify(document)]);

  const types = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml',
    '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.woff2':'font/woff2'};
  const api = createHandler(f.db);
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) return api(req, res);
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const asset = path.resolve(dist, '.' + pathname);
      const filename = path.extname(pathname) && asset.startsWith(dist + path.sep) ? asset : path.join(dist, 'index.html');
      const data = await fs.readFile(filename);
      res.writeHead(200, {'Content-Type':types[path.extname(filename)] || 'application/octet-stream'});
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({channel:'chrome', headless:true});
  cleanups.push(() => browser.close());
  const errors = [];
  async function open(actor, url) {
    const context = await browser.newContext({baseURL:origin, viewport:{width:390,height:844}, serviceWorkers:'block'});
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addCookies([{name:'alfa_session', value:f.actors[actor].cookie.slice('alfa_session='.length), url:origin}]);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    return page;
  }

  const driver = await open('qa-driver-a', '/driver/overview');
  await driver.getByRole('button', {name:/Scan QR dispatch/i}).click();
  const sent = [];
  async function scan(trip, stage) {
    const active = driver.locator(`[data-testid="driver-assignment-qr"][data-trip-id="${trip.id}"][data-scan-stage="${stage}"]`);
    const response = driver.waitForResponse(result => {
      const request = result.request();
      if (request.method() !== 'POST' || new URL(result.url()).pathname !== '/api/v1/demo/actions') return false;
      const {action, payload} = request.postDataJSON();
      return action === 'trip.driver_scan' && payload.tripId === trip.id && payload.expectedStage === stage;
    });
    await active.getByTestId('driver-record-scan').click();
    const result = await response;
    assert.equal(result.status(), 200, JSON.stringify(await result.json()));
    sent.push(result.request().postDataJSON().payload);
  }
  await scan(first, 1);
  const beforeApproval = await f.state();
  const admin = await open('admin', '/admin/inventory');
  await admin.getByRole('row').filter({hasText:measurement.code}).getByRole('button', {name:/Tinjau pengukuran|Review measurement/}).click();
  const approval = admin.waitForResponse(result => result.request().method() === 'POST' &&
    new URL(result.url()).pathname === '/api/action' && result.request().postDataJSON().action === 'measurement.approve');
  await admin.getByRole('button', {name:/Setujui pengukuran|Approve measurement/}).click();
  const rejected = await approval;
  assert.equal(rejected.status(), 409);
  assert.equal((await rejected.json()).error, 'STALE_MEASUREMENT');
  assert.deepEqual(await f.state(), beforeApproval, 'Rejected survey must leave inventory and revision intact');

  await scan(first, 2);
  await scan(second, 1);
  await scan(second, 2);
  assert.deepEqual(sent.map(row => row.expectedStage), [1,2,1,2]);
  assert.equal(new Set(sent.map(row => row.qrValue)).size, 1);
  const after = (await f.state()).document;
  assert.equal(after.requests.find(row => row.id === f.requestA).status, 'completed');
  assert.ok(after.trips.filter(row => row.requestId === f.requestA).every(row => row.status === 'returned'));
  const stock = (state, id) => state.stockpiles.find(row => row.id === id);
  const volume = first.volumeM3 + second.volumeM3;
  const source = stock(after, first.stockpileId);
  const receiving = stock(after, first.destinationStockpileId);
  assert.equal(source.skuId, first.skuId);
  assert.equal(receiving.skuId, first.skuId);
  assert.ok(Math.abs(stock(document, first.stockpileId).onHandM3 - source.onHandM3 - volume) < 0.000002);
  assert.ok(Math.abs(receiving.onHandM3 - stock(document, first.destinationStockpileId).onHandM3 - volume) < 0.000002);
  assert.equal(source.reservedM3, 0);
  assert.equal(after.inventoryLedger.length, 4);
  assert.equal(after.erpOutbox.length, 4);
  assert.deepEqual(errors, []);
  console.log('Tablet browser: stale SKU approval rejected, two serial trips returned, four ledger and four NetSuite outbox entries.');
} finally {
  for (const close of cleanups.reverse()) await close();
}
