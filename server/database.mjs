import pg from 'pg';
import {readFile} from 'node:fs/promises';

export function createDatabase(url=process.env.DATABASE_URL) {
  if(!url) throw new Error('DATABASE_NOT_CONFIGURED');
  const pool=new pg.Pool({connectionString:url,max:3,idleTimeoutMillis:10000,connectionTimeoutMillis:15000});
  pool.on('error',()=>{});
  return {query:(...args)=>pool.query(...args),transaction:async fn=>{
    const c=await pool.connect();
    try {await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout='20000ms'");const v=await fn(c);await c.query('COMMIT');return v;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  },close:()=>pool.end()};
}
export async function migrate(db,seed) {
  const sql=await readFile(new URL('./schema.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.query(statement);
  await db.query('INSERT INTO aimoc_alfa_ops.operation(id,document) VALUES (1,$1::jsonb) ON CONFLICT(id) DO NOTHING',[JSON.stringify(seed)]);
}
export async function createEmbeddedDatabase(path) {
  const {PGlite}=await import('@electric-sql/pglite'); const db=new PGlite(path);
  return {query:(...args)=>db.query(...args),transaction:fn=>db.transaction(fn),close:()=>db.close()};
}
