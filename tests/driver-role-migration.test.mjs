import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmbeddedDatabase,migrate} from '../server/database.mjs';
import {createSeed} from '../server/seed.mjs';
import {bootstrap} from '../scripts/setup.mjs';

test('Driver role migration preserves existing accounts and operation document and can be repeated',async()=>{
  const db=await createEmbeddedDatabase();
  try{
    await bootstrap(db);
    // Reproduce the constraint shipped before this fix, with existing accounts.
    await db.query('ALTER TABLE aimoc_alfa_ops.users DROP CONSTRAINT users_role_check');
    await db.query("ALTER TABLE aimoc_alfa_ops.users ADD CONSTRAINT users_role_check CHECK(role IN ('admin','stock','jetty'))");
    await db.query("UPDATE aimoc_alfa_ops.operation SET document=jsonb_set(document,'{migrationMarker}', '\"existing-data\"'::jsonb), revision=71 WHERE id=1");
    const before=(await db.query('SELECT id,username,password_hash,role FROM aimoc_alfa_ops.users ORDER BY id')).rows;
    await migrate(db,createSeed());
    await migrate(db,createSeed());
    assert.deepEqual((await db.query('SELECT id,username,password_hash,role FROM aimoc_alfa_ops.users ORDER BY id')).rows,before);
    const stored=(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
    assert.equal(stored.document.migrationMarker,'existing-data');assert.equal(Number(stored.revision),71);
    await db.query("INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role) VALUES('migration-test-driver','migration-test-driver','Synthetic driver','non-login-test-placeholder','driver')");
    assert.equal((await db.query("SELECT role FROM aimoc_alfa_ops.users WHERE id='migration-test-driver'")).rows[0].role,'driver');
  }finally{await db.close();}
});
