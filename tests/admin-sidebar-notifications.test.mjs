import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../server/seed.mjs';
import {applyAction,publicState} from '../server/domain.mjs';
import {applyIntegratedAction,integratedView} from '../server/integrated-demo-domain.mjs';
import {summarizeAdminSidebarNotifications} from '../server/admin-sidebar-notifications.mjs';

const admin={id:'sidebar-admin',role:'admin'},stock={id:'sidebar-stock',role:'stock',crusherIds:['crusher-1']},driver={id:'sidebar-driver',role:'driver',active:true},options={drivers:[driver]};
const menus=['overview','requests','tasks','inventory','receiving','audit','master'];
const request=(id,status='requested',extra={})=>({id,status,source:'INTEGRATED_DEMO',lines:[],...extra});

test('Admin submission counts match exact visible Plan and Review statuses, including Quarry requests',()=>{
 const view={requests:[request('normal'),request('quarry','requested',{workflow:'QUARRY_CILEGON'}),request('land','requested',{transferMode:'LAND'}),...['planned','in_progress','completed','cancelled','rejected'].map(status=>request('request-'+status,status)),request('legacy-hidden','requested',{source:'LEGACY'}),request('unknown-hidden','requested',{source:undefined})],measurements:['pending','needs_calibration','approved','rejected','cancelled','completed'].map(status=>({id:'measure-'+status,status}))};
 const before=structuredClone(view),result=summarizeAdminSidebarNotifications(view,admin);
 assert.deepEqual(result.counts,{overview:0,requests:3,tasks:0,inventory:1,receiving:0,audit:0,master:0});
 assert.equal(result.status,'READY');assert.equal(result.scope,'ADMIN');assert.equal(result.version,1);
 assert.deepEqual(result.supportedMenus,['requests','inventory']);assert.ok(menus.every(menu=>result.availability[menu]===true));assert.deepEqual(view,before);
});

test('empty known queues return valid zeros; malformed or ambiguous pending data stays unavailable instead of false zero',()=>{
 const empty=summarizeAdminSidebarNotifications({requests:[],measurements:[]},admin);assert.equal(empty.status,'READY');assert.ok(Object.values(empty.counts).every(count=>count===0));
 const missing=summarizeAdminSidebarNotifications({measurements:[]},admin);assert.equal(missing.counts.requests,null);assert.equal(missing.availability.requests,false);assert.equal(missing.counts.inventory,0);assert.equal(missing.status,'PARTIAL');
 const badMeasurement=summarizeAdminSidebarNotifications({requests:[],measurements:[{id:'measurement',status:'pending'},{id:'measurement',status:'approved'}]},admin);assert.equal(badMeasurement.counts.inventory,null);assert.equal(badMeasurement.counts.requests,0);
 for(const requests of [[request('duplicate'),request('duplicate')],[request(undefined)],[null]])assert.equal(summarizeAdminSidebarNotifications({requests,measurements:[]},admin).counts.requests,null);
 assert.equal(summarizeAdminSidebarNotifications({requests:[],measurements:[{id:'m',status:'pending',volumeM3:null}]},admin).counts.inventory,1,'Review is still visible for pending evidence needing repair; do not pretend it has been approved');
});

test('aggregate is Admin-only and no inherited/persisted aggregate crosses other role projections',()=>{
 const state=createSeed();state.adminSidebarNotifications={privateCount:999,privateReference:'PRIVATE_ADMIN_WORK'};
 state.requests=[request('visible'),request('not-visible','requested',{source:'LEGACY'})];state.measurements=[{id:'measurement',status:'pending',crusherId:'crusher-1'}];
 const before=structuredClone(state),view=integratedView(state,admin,options);
 assert.equal(view.adminSidebarNotifications.counts.requests,1);assert.equal(view.adminSidebarNotifications.counts.inventory,1);assert.doesNotMatch(JSON.stringify(view.adminSidebarNotifications),/PRIVATE_ADMIN_WORK|privateCount|visible|measurement"/);
 for(const actor of [stock,driver,{id:'jetty',role:'jetty',jettyIds:['jetty-1']}]){
  assert.equal(Object.hasOwn(integratedView(state,actor,options),'adminSidebarNotifications'),false);
  assert.throws(()=>summarizeAdminSidebarNotifications(state,actor),error=>error.code==='FORBIDDEN');
 }
 assert.equal(Object.hasOwn(publicState(state,stock),'adminSidebarNotifications'),false);assert.deepEqual(state,before);
});

test('real request planning and measurement approval remove only their own notification, not inventory or workflow evidence',()=>{
 const state=createSeed(),read=()=>integratedView(state,admin,options).adminSidebarNotifications;
 const created=applyIntegratedAction(state,'request.create',{transferMode:'LAND',destinationLocationId:'stockpile-location-crusher-2',lines:[{skuId:'split-12',quantity:10,unit:'t'}]},admin,options);
 assert.equal(read().counts.requests,1);
 applyIntegratedAction(state,'request.plan',{requestId:created.requestId},admin,options);assert.equal(read().counts.requests,0);assert.equal(read().counts.tasks,0);
 const measurement=applyAction(state,'measurement.create',{stockpileId:'stock-1-3',skuId:'split-12',method:'manual',quantityValue:500,quantityUnit:'m3'},stock);
 assert.equal(read().counts.inventory,1);const beforeRead=structuredClone(state);read();read();assert.deepEqual(state,beforeRead,'Reading never acknowledges a pending submission or advances status');
 applyAction(state,'measurement.approve',{measurementId:measurement.entityId},admin);
 assert.equal(read().counts.inventory,0);assert.equal(read().counts.audit,0,'NetSuite awaiting_configuration is not an Admin submission approval');
 assert.equal(state.measurements.find(row=>row.id===measurement.entityId).status,'approved');assert.equal(state.erpOutbox.length,1);
});
