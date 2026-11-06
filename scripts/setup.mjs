import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDatabase,createEmbeddedDatabase,migrate} from '../server/database.mjs';
import {passwordHash} from '../server/auth.mjs';
import {createSeed} from '../server/seed.mjs';

export async function bootstrap(db,accessPath) {
  const seed=createSeed();await migrate(db,seed);
  const users=[
    {username:'admin',displayName:'Admin AIMOC',role:'admin',crusherIds:[],jettyIds:[]},
    {username:'stock1',displayName:'Operator Stockpile 01',role:'stock',crusherIds:[seed.crushers[0].id],jettyIds:[]},
    {username:'stock2',displayName:'Operator Stockpile 02',role:'stock',crusherIds:[seed.crushers[1].id],jettyIds:[]},
    {username:'jetty1',displayName:'Operator Jetty 01',role:'jetty',crusherIds:[],jettyIds:[seed.jetties[0].id]},
    {username:'jetty2',displayName:'Operator Jetty 02',role:'jetty',crusherIds:[],jettyIds:[seed.jetties[1].id]}
  ];
  const created=[];
  for(const u of users){
    if((await db.query('SELECT id FROM aimoc_alfa_ops.users WHERE username=$1',[u.username])).rows.length)continue;
    const password='AG-'+randomBytes(12).toString('base64url')+'!';
    await db.query('INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role,crusher_ids,jetty_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),u.username,u.displayName,await passwordHash(password),u.role,u.crusherIds,u.jettyIds]);
    created.push({...u,password});
  }
  if(created.length&&accessPath){await mkdir(path.dirname(accessPath),{recursive:true});await writeFile(accessPath,JSON.stringify({app:'AIMOC Alfa Granitama',createdAt:new Date().toISOString(),users:created},null,2),{mode:0o600});}
  return {migrated:true,usersCreated:created.length,existingUsersPreserved:users.length-created.length};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const db=process.env.AIMOC_LOCAL_DB==='true'?await createEmbeddedDatabase('.local/database'):createDatabase();
 try{console.log(JSON.stringify(await bootstrap(db,process.env.ACCESS_FILE||'.local/access.json')));}catch(e){console.error(JSON.stringify({error:e.code||'SETUP_FAILED'}));process.exitCode=1;}finally{await db.close();}
}
