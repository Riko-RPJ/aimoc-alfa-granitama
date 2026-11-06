import {readFile} from 'node:fs/promises';
export async function extendExecutionPhase4D(db){
 const sql=await readFile(new URL('./execution-phase4d.sql',import.meta.url),'utf8');
 for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.query(statement);
}
