import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {passwordHash} from '../server/auth.mjs';

/** LOCAL PGlite-only Driver UI UAT. Never call with a DATABASE_URL-backed DB. */
export async function provisionLocalDriverUat(db,{localOnly=false,accessPath='.local/driver-access.json'}={}) {
  if(!localOnly||process.env.DATABASE_URL)throw new Error('LOCAL_DRIVER_UAT_REQUIRES_EMBEDDED_DB');
  const users=[{username:'driver1',displayName:'Driver UAT 01'},{username:'driver2',displayName:'Driver UAT 02'}];
  const created=[];
  await db.transaction(async c=>{
    await c.query('ALTER TABLE aimoc_alfa_ops.users DROP CONSTRAINT IF EXISTS users_role_check');
    await c.query("ALTER TABLE aimoc_alfa_ops.users ADD CONSTRAINT users_role_check CHECK(role IN ('admin','stock','jetty','driver'))");
    for(const u of users){
      const existing=(await c.query('SELECT role,active FROM aimoc_alfa_ops.users WHERE username=$1',[u.username])).rows[0];
      if(existing){
        if(existing.role!=='driver'||!existing.active)throw new Error('DRIVER_UAT_IDENTITY_CONFLICT');
        continue;
      }
      const password='UAT-'+randomBytes(18).toString('base64url')+'!';
      await c.query("INSERT INTO aimoc_alfa_ops.users (id,username,display_name,password_hash,role,crusher_ids,jetty_ids) VALUES($1,$2,$3,$4,'driver',ARRAY[]::text[],ARRAY[]::text[])",
        [randomUUID(),u.username,u.displayName,await passwordHash(password)]);
      created.push({...u,role:'driver',password});
    }
  });
  if(created.length){
    let previous=[];
    try{
      const existing=JSON.parse(await readFile(accessPath,'utf8'));
      previous=Array.isArray(existing.users)?existing.users:[];
    }catch(e){if(e.code!=='ENOENT')throw new Error('DRIVER_ACCESS_FILE_INVALID');}
    await mkdir(path.dirname(accessPath),{recursive:true});
    await writeFile(accessPath,JSON.stringify({
      app:'AIMOC local Driver UI UAT only',
      notice:'No real assignments, operational evidence or v1 command permissions',
      users:[...previous.filter(x=>!created.some(y=>x.username===y.username)),...created]
    },null,2),{mode:0o600});
  }
  return {created:created.length,existing:users.length-created.length,accountNames:users.map(x=>x.username)};
}
