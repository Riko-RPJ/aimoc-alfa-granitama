import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import {createSeed} from '../server/seed.mjs';
import {publicState} from '../server/domain.mjs';
import {legacyPageFromPath,legacyPathForPage,legacyNavigationByRole} from '../src/app/navigation.js';

test('Admin final routes cover 10 operational workspaces without exposing them to Stockpile',()=>{
 const expected={
  overview:'/admin/overview',requests:'/admin/transfers',
  dispatchPlanning:'/admin/dispatch/planning',
  dispatchMonitoring:'/admin/dispatch/monitoring',
  inventory:'/admin/inventory',exceptions:'/admin/exceptions',
  jetty:'/admin/jetty',master:'/admin/master-data',
  integrations:'/admin/integrations',access:'/admin/access-control'
 };
 for(const [page,path] of Object.entries(expected)){
  assert.equal(legacyNavigationByRole.admin.includes(page),!['dispatchMonitoring','exceptions'].includes(page));
  assert.equal(legacyPathForPage('admin',page),path);
  assert.equal(legacyPageFromPath('admin',path),page);
  assert.ok(!legacyNavigationByRole.stock.includes(page)||['inventory'].includes(page));
 }
});
test('10 Admin final operational pages render informative content from genuine legacy seed',async()=>{
 const vite=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'silent'});
 try{
 const {AdminFinalPage}=await vite.ssrLoadModule('/src/features/pages/admin-final/AdminFinalPage.jsx');
 const user={id:'qa-admin',role:'admin',displayName:'QA Admin',crusherIds:[],jettyIds:[]};
 const state=publicState(createSeed(),user);
 const names=['products','crushers','stockpiles','trucks','jetties','vessels','requests','dispatches','trips','measurements','events','inventoryLedger','erpOutbox'];
 const c=Object.fromEntries(names.map(name=>[name,state[name]||[]]));
 const find=(kind,id)=>c[kind].find(x=>x.id===id);
 const lookups={product:'products',crusher:'crushers',stockpile:'stockpiles',truck:'trucks',jetty:'jetties',vessel:'vessels'};
 for(const [name,kind] of Object.entries(lookups))c[name]=id=>find(kind,id);
 Object.assign(c,{role:'admin',user,can:true,sources:state,scopeStock:c.stockpiles,scopeJetty:c.jetties,
 activeTrips:[],queuedTrips:[],transit:[],idleTrucks:c.trucks,activeTruckIds:new Set(),availableM3:0,
 displayEvents:[],search:'',setSearch:()=>{},busy:false,csrf:'uat',
 notify:()=>{},setModal:()=>{},act:()=>{},selectPage:()=>{},openRequest:()=>{},openMeasurement:()=>{},density:()=>1.5});
 const expected={
 overview:'Trip process overview',
 requests:'Transfer Requests',
 dispatchPlanning:'Ketersediaan armada',
 dispatchMonitoring:'Trip Register',
 inventory:'STOCK ON HAND',
 exceptions:'Review queue',
 jetty:'Jetty',
 master:'Master Data',
 integrations:'AUDIT EVENTS',
 access:'Admin Permission'
 };
 for(const [page,needle] of Object.entries(expected)){
  const html=renderToStaticMarkup(React.createElement(AdminFinalPage,{page,context:c,contract:{dataState:'READY'},capabilities:{role:'admin',permissions:[]}}));
  assert.ok(html.includes('data-admin-final-page="'+page+'"'),page+' missing identity');
  assert.ok(html.includes(needle),page+' missing section '+needle);
  assert.ok(html.length>300,page+' blank render');
  if(page==='overview'){
   assert.ok(html.includes('snapshot legacy'));
   assert.ok(html.includes('NOT VERIFIED'));
  }
  if(page==='dispatchPlanning'){
   for(const removed of ['Planning queue','Planned Dispatches · Legacy','Eksekusi staging terpisah · UAT','Execute Dispatch · V1 Staging','Verified Driver Assignment · V1 Staging'])
    assert.equal(html.includes(removed),false,'dispatchPlanning still renders '+removed);
  }
 }
 }finally{await vite.close();}
});
