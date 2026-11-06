const fail=(message,code)=>{throw Object.assign(new Error(message),{status:409,code});};

/** Operation-row lock also serializes scope assignment with managed-area deletion. */
export async function guardLocationOperatorReferences(db,state,action,payload){
 if(action!=='master.stockpileLocation.delete')return;
 const location=(state.stockpileLocations||[]).find(row=>row.id===payload?.id);
 const area=(state.crushers||[]).find(row=>row.id===location?.receivingCrusherId);
 if(area?.kind!=='RECEIVING_AREA'||area.managedBy!=='STOCKPILE_LOCATION')return;
 const assigned=(await db.query("SELECT id FROM aimoc_alfa_ops.users WHERE role='stock' AND $1=ANY(crusher_ids) LIMIT 1",[area.id])).rows;
 if(assigned.length)fail('Area lokasi masih ditugaskan kepada operator. Cakupan akun harus diselesaikan sebelum lokasi dapat dihapus.','LOCATION_OPERATOR_IN_USE');
}
