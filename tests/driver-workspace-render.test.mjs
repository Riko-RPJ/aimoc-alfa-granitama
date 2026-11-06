import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';

test('Driver React layout renders four distinct page structures and never blanks when API has no data',async()=>{
 const server=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'silent'});
 const previous=globalThis.window;
 try{
  const {DriverLayout}=await server.ssrLoadModule('/src/layouts/DriverLayout.jsx');
  const user={id:'driver-uat',role:'driver',username:'driver1',displayName:'Driver UAT'};
  const expected={
   '/driver/home':['Selamat bertugas','Tugas perjalanan','Navigasi Driver'],
   '/driver/tasks':['Tugas &amp; checklist','Memuat detail tugas','Navigasi Driver'],
   '/driver/history':['Riwayat perjalanan','Memuat riwayat','Navigasi Driver'],
   '/driver/profile':['Profil Driver','Akses &amp; integrasi','Keluar dari akun']
  };
  for(const [url,texts] of Object.entries(expected)){
   globalThis.window={location:{pathname:url}};
   const html=renderToStaticMarkup(React.createElement(DriverLayout,{user,csrf:'uat-token',logout:()=>{}}));
   for(const phrase of texts)assert.ok(html.includes(phrase),url+' missing '+phrase);
   assert.equal((html.match(/class="driver-shell"/g)||[]).length,1);
   assert.ok(html.includes('STAGING API'),url+' missing source warning');
   assert.ok(html.includes('class="driver-mobile-nav"'));
   assert.ok(!html.includes('UAT-TRIP-0024'),url+' must never default to simulation');
  }
 }finally{
  globalThis.window=previous;
  await server.close();
 }
});
