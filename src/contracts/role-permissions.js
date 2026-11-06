/**
 * Current legacy capabilities, separated from not-yet-active target workflows.
 * These permissions describe the live /api/action handler, NOT permission to
 * execute Phase 4B-4F target commands.
 */
export const ROLE_PERMISSIONS=Object.freeze({
 admin:Object.freeze([
  'operations.read','inventory.read','inventory.measure.approve',
  'transfer.read','transfer.create','dispatch.read','dispatch.plan',
  'trip.read','trip.start.scoped','trip.depart.scoped','trip.return.scoped','jetty.read','master.read','master.write','audit.read','users.manage'
 ]),
 stock:Object.freeze([
  'stockpile.home.read','stockpile.inventory.read','stockpile.inventory.activity.record',
  'stockpile.pickups.read','stockpile.pickups.loading.confirm',
  'stockpile.pickups.return.confirm','stockpile.activity.read'
 ]),
 jetty:Object.freeze([
  'operations.read.scoped','transfer.read.scoped','transfer.create.scoped',
  'dispatch.read.scoped','trip.read.scoped','trip.arrive.scoped','trip.unload.scoped'
 ]),
 driver:Object.freeze(['session.read','driver.shell.read'])
});
const ACTION_PERMISSION=Object.freeze({
 'request.create':'transfer.create',
 'request.plan':'dispatch.plan',
 'measurement.create':'inventory.measure.create',
 'measurement.approve':'inventory.measure.approve',
 'trip.start':'trip.start.scoped',
 'trip.depart':'trip.depart.scoped',
 'trip.arrive':'trip.arrive.scoped',
 'trip.unload':'trip.unload.scoped',
 'trip.return':'trip.return.scoped'
});
const STOCK_ACTION_PERMISSION=Object.freeze({
 'measurement.create':'stockpile.inventory.activity.record',
 'trip.start':'stockpile.pickups.loading.confirm',
 'trip.return':'stockpile.pickups.return.confirm'
});
export const TARGET_ADMIN_CAPABILITIES=Object.freeze([
 {id:'operations',label:'Operations Overview',permission:'operations.read',state:'LEGACY_ACTIVE',page:'overview'},
 {id:'inventory',label:'Inventory & Measurements',permission:'inventory.read',state:'LEGACY_ACTIVE',page:'inventory'},
 {id:'transfers',label:'Transfer Requests',permission:'transfer.read',state:'LEGACY_ACTIVE',page:'requests'},
 {id:'dispatch',label:'Dispatch & Fleet',permission:'dispatch.read',state:'LEGACY_ACTIVE',page:'dispatch'},
 {id:'jetty',label:'Jetty Operations (legacy)',permission:'jetty.read',state:'LEGACY_ACTIVE',page:'jetty'},
 {id:'master',label:'Master Data & User Access',permission:'master.read',state:'LEGACY_ACTIVE',page:'master'},
 {id:'audit',label:'Audit & ERP Outbox',permission:'audit.read',state:'LEGACY_ACTIVE',page:'audit'},
 {id:'land-allocation',label:'Land Destination Allocations',permission:'dispatch.land.plan',state:'NOT_INTEGRATED'},
 {id:'driver-assignment',label:'Driver Assignment & Tasks',permission:'driver.assign',state:'NOT_INTEGRATED'},
 {id:'weighbridge',label:'Verified Weighbridge Events',permission:'weighbridge.read',state:'NOT_INTEGRATED'},
 {id:'reconciliation',label:'Verified Inventory Reconciliation',permission:'inventory.reconcile',state:'NOT_INTEGRATED'},
 {id:'exceptions',label:'HOLD, Recovery & Exceptions',permission:'exception.manage',state:'NOT_INTEGRATED'},
 {id:'voyage',label:'Voyage Capacity & Scheduling',permission:'voyage.manage',state:'NOT_INTEGRATED'}
]);
export function permissionsForRole(role){return [...(ROLE_PERMISSIONS[role]||[])];}
export function canPerform(role,permission){
 const grants=ROLE_PERMISSIONS[role]||[];
 if(grants.includes(permission))return true;
 if(role==='admin'&&permission.endsWith('.scoped'))return grants.includes(permission)||grants.includes(permission.slice(0,-7));
 if(role==='jetty'&&permission==='transfer.create')return grants.includes('transfer.create.scoped');
 return false;
}
export function permissionForLegacyAction(action,role){
 if(typeof action!=='string')return null;
 if(action.startsWith('master.')&&action.endsWith('.save'))return 'master.write';
 if(role==='stock'&&STOCK_ACTION_PERMISSION[action])return STOCK_ACTION_PERMISSION[action];
 return ACTION_PERMISSION[action]||null;
}
export function authorizeLegacyAction(role,action){
 const permission=permissionForLegacyAction(action,role);
 if(!permission)return {allowed:false,permission:null,reason:'UNKNOWN_OR_UNINTEGRATED_ACTION'};
 if(role==='admin'){
  // Legacy compatibility: Admin can perform stock-truck trip start/depart/return,
  // as the existing legacy backend permits. This is NOT target-v1 physical proof.
  if(permission==='trip.arrive.scoped'||permission==='trip.unload.scoped')
    return {allowed:false,permission,reason:'JETTY_VERIFIER_REQUIRED'};
  return {allowed:canPerform(role,permission),permission};
 }
 return {allowed:canPerform(role,permission),permission,reason:'FORBIDDEN_SCOPE'};
}
