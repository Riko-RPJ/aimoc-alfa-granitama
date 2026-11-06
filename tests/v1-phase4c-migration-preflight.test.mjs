import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createSeed} from '../server/seed.mjs';
import {inspectLegacyMigration,analyzeLegacyDatabase} from '../server/v1/migration-preflight.mjs';

test('migration preflight blocks conversion of unverified legacy m3 to tonnes',()=>{
 const old=createSeed();
 const result=inspectLegacyMigration({state:old,revision:3,updatedAt:'2026-11-06T00:00:00Z'});
 assert.equal(result.production_ready,false);
 assert.equal(result.automated_backfill_authorized,false);
 assert.ok(result.findings.some(x=>x.id==='MIG-001'&&x.level==='BLOCKING'));
 assert.ok(result.findings.some(x=>x.id==='MIG-003'&&x.level==='BLOCKING'));
 assert.equal(result.legacy_revision,3);
 assert.equal(result.counts.stockpiles,old.stockpiles.length);
 assert.equal(result.counts.trips,old.trips.length);
});
test('migration preflight catches invalid master refs and duplicates without rewriting records',()=>{
 const old=createSeed();
 const stock=old.stockpiles[0];
 old.stockpiles.push({...stock});
 old.stockpiles.push({...stock,id:'orphan',skuId:'unknown-sku',crusherId:'unknown-crusher'});
 const result=inspectLegacyMigration({state:old,revision:1});
 assert.ok(result.duplicate_identity_issues.stockpiles.includes(stock.id));
 assert.ok(result.referential_issues.some(x=>x.kind==='UNKNOWN_SKU'));
 assert.ok(result.referential_issues.some(x=>x.kind==='UNKNOWN_CRUSHER'));
});
test('preflight SELECT against ephemeral legacy database leaves revision unchanged',async()=>{
 const db=await createEmbeddedDatabase();
 try{
  await bootstrap(db);
  const previous=(await db.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision;
  const report=await analyzeLegacyDatabase(db);
  const current=(await db.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision;
  assert.equal(current,previous);
  assert.equal(report.production_ready,false);
 }finally{await db.close();}
});
