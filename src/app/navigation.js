export const stockpileNavigation = Object.freeze([
  Object.freeze({id:'home',label:'Home',route:'/stockpile/home'}),
  Object.freeze({id:'inventory',label:'Inventory',route:'/stockpile/inventory'}),
  Object.freeze({id:'pickups',label:'Pickups',route:'/stockpile/pickups'}),
  Object.freeze({id:'activity',label:'Activity',route:'/stockpile/activity'}),
]);

export const legacyNavigationByRole = Object.freeze({
  admin: ['overview','inventory','requests','dispatch','jetty','master','audit','access','dispatchPlanning','integrations'],
  stock: stockpileNavigation.map(item=>item.id),
  jetty: ['jetty','requests','dispatch','overview'],
  driver: [],
});
export const targetNavigation = Object.freeze({
  ADMIN: ['/admin/overview','/admin/transfers','/admin/dispatch/planning','/admin/inventory','/admin/master-data','/admin/integrations'],
  STOCKPILE: stockpileNavigation.map(item=>item.route),
  DRIVER: ['/driver/home','/driver/tasks','/driver/history','/driver/profile'],
});
export const legacyPagesForRole = (role,navs) => navs.filter(([id])=>(legacyNavigationByRole[role]||[]).includes(id));
export const defaultLegacyPage = role=>({admin:'overview',stock:'home',jetty:'jetty'}[role]||null);

// Route definitions for existing pages. These are deliberately separate from
// targetNavigation, which is not backed by the current API yet.
export const legacyRouteByRole = Object.freeze({
  admin: {overview:'/admin/overview',inventory:'/admin/inventory',requests:'/admin/transfers',dispatch:'/admin/dispatch',jetty:'/admin/jetty',master:'/admin/master-data',audit:'/admin/audit',access:'/admin/access-control',dispatchPlanning:'/admin/dispatch/planning',dispatchMonitoring:'/admin/dispatch/monitoring',exceptions:'/admin/exceptions',integrations:'/admin/integrations'},
  stock: Object.fromEntries(stockpileNavigation.map(item=>[item.id,item.route])),
  jetty: {jetty:'/legacy-jetty/receiving',requests:'/legacy-jetty/requests',dispatch:'/legacy-jetty/dispatch',overview:'/legacy-jetty/overview'}
});
export function legacyPageFromPath(role,path) {
  return Object.entries(legacyRouteByRole[role]||{}).find(([,route])=>route===path)?.[0] || null;
}
export function legacyPathForPage(role,page) {
  return legacyRouteByRole[role]?.[page] || null;
}

export const isStockpilePath = path => path === '/stockpile' || path.startsWith('/stockpile/');

export function stockpileMeasurementPage(role, path) {
  return role === 'stock' && /^\/stockpile\/add-material\/?$/.test(path) ? 'add-material' : null;
}
