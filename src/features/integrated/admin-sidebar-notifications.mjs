export const ADMIN_MENU_IDS=Object.freeze(['overview','requests','tasks','inventory','receiving','audit','master']);

/** Validate the Admin projection; never reconstruct pending queues from page records. */
export function adminSidebarBadge(summary,menuId,{stale=false}={}){
 if(!ADMIN_MENU_IDS.includes(menuId))return {state:'unavailable',count:null};
 const known=summary?.version===1&&summary?.scope==='ADMIN'&&['READY','PARTIAL'].includes(summary?.status);
 const count=summary?.counts?.[menuId];
 if(!known||summary?.availability?.[menuId]!==true||!Number.isSafeInteger(count)||count<0)return {state:'unavailable',count:null};
 if(stale)return {state:'stale',count:null};
 return {state:'ready',count};
}
