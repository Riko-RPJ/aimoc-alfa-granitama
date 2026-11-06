import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {passwordHash,checkPassword} from '../server/auth.mjs';

if(process.env.DATABASE_URL||process.env.AIMOC_ALLOW_PRODUCTION_ACCOUNT==='1')throw Error('LOCAL_UAT_ONLY');
const db=await createEmbeddedDatabase('.local/database');
const username='driver.dt001';
const file='.local/driver-dt001-access.json';
try{
 const legacy=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0]?.document;
 const truck=legacy?.trucks?.find(x=>x.code==='DT-001');
 if(!truck||truck.id!=='truck-1')throw Error('DT_001_MASTER_NOT_FOUND_OR_CHANGED');
 const exists=(await db.query('SELECT id,role,active FROM aimoc_alfa_ops.users WHERE username=$1',[username])).rows[0];
 if(exists){
  if(exists.role!=='driver'||!exists.active)throw Error('USERNAME_CONFLICT');
  const current=JSON.parse(await readFile(file,'utf8'));
  const valid=await db.query('SELECT password_hash FROM aimoc_alfa_ops.users WHERE username=$1',[username]);
  if(!await checkPassword(current.password,valid.rows[0].password_hash))throw Error('LOCAL_CREDENTIAL_MISMATCH');
  console.log(JSON.stringify({result:'EXISTING_VERIFIED_LOGIN',username,truck_code:'DT-001',credential_file:file}));
 }else{
  const password='UAT-'+randomBytes(20).toString('base64url')+'!';
  await db.query("INSERT INTO aimoc_alfa_ops.users (id,username,display_name,password_hash,role,crusher_ids,jetty_ids) VALUES($1,$2,$3,$4,'driver',ARRAY[]::text[],ARRAY[]::text[])",[
   randomUUID(),username,'Driver UAT · DT-001',await passwordHash(password)]);
  await mkdir('.local',{recursive:true});
  await writeFile(file,JSON.stringify({environment:'LOCAL_UAT_ONLY',username,password,role:'driver',truck_code:'DT-001',truck_id:truck.id,
   assignment_status:'NOT_ASSIGNED',identity_status:'NOT_INDEPENDENTLY_VERIFIED'},null,2),{mode:0o600});
  console.log(JSON.stringify({result:'CREATED',username,password,truck_code:'DT-001',assignment_status:'NOT_ASSIGNED',credential_file:file}));
 }
}finally{await db.close()}
