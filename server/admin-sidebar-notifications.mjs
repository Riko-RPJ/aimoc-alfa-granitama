const MENUS=['overview','requests','tasks','inventory','receiving','audit','master'];
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);

function pendingCount(rows,{visible=()=>true,status}){
 if(!Array.isArray(rows))return null;
 if(rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))return null;
 const selected=rows.filter(visible),ids=new Map();
 for(const row of selected)if(validId(row.id))ids.set(row.id,(ids.get(row.id)||0)+1);
 const pending=selected.filter(row=>row.status===status);
 if(pending.some(row=>!validId(row.id)||ids.get(row.id)!==1))return null;
 return pending.length;
}

/** Admin submission queues only, computed from the already scoped read projection.
 *  Reading or opening a menu never acknowledges, mutates or approves a record.
 */
export function summarizeAdminSidebarNotifications(view,actor){
 if(actor?.role!=='admin'||!validId(actor.id)||actor.active===false)throw Object.assign(new Error('Akses khusus Admin AIMOC.'),{name:'DomainError',code:'FORBIDDEN',status:403});
 const counts=Object.fromEntries(MENUS.map(menu=>[menu,0]));
 counts.requests=pendingCount(view?.requests,{visible:row=>row.source==='INTEGRATED_DEMO',status:'requested'});
 counts.inventory=pendingCount(view?.measurements,{status:'pending'});
 const availability=Object.fromEntries(MENUS.map(menu=>[menu,counts[menu]!==null]));
 return {version:1,scope:'ADMIN',status:availability.requests&&availability.inventory?'READY':'PARTIAL',counts,availability,supportedMenus:['requests','inventory'],definitions:{requests:'REQUESTS_AWAITING_DISPATCH_PLAN',inventory:'MEASUREMENTS_AWAITING_ADMIN_REVIEW',other:'NO_SUBMISSION_APPROVAL_QUEUE'}};
}
