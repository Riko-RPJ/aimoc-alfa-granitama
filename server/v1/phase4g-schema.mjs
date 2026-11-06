import {readFile} from 'node:fs/promises';
/**
 * Explicit staging/test migration only. Before a live migration, existing
 * records MUST be reconciled against trusted Driver, fleet, and stock keys.
 */
export async function extendUnifiedOperationalSchema(db){
 const sql=await readFile(new URL('./execution-phase4g.sql',import.meta.url),'utf8');
 for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.query(statement);
}
