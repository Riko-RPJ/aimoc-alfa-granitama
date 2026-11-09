import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'vite';
import {buildAssignmentQr,ASSIGNMENT_QR_MAX_BYTES} from '../src/features/integrated/assignment-qr.mjs';

const reference = overrides => JSON.stringify({v:1,type:'AIMOC_ASSIGNMENT_REFERENCE',
  requestId:'request-demo-001',dispatchId:'dispatch-demo-001',tripId:'trip-demo-001',truckId:'truck-demo-001',...overrides});

test('assignment reference QR is deterministic and changes when a canonical identity changes',()=>{
  const original=buildAssignmentQr(reference()),again=buildAssignmentQr(reference());
  assert.equal(original.ok,true);assert.deepEqual(original.matrix,again.matrix);assert.equal(original.path,again.path);
  for(const field of ['requestId','dispatchId','tripId','truckId']){
    const changed=buildAssignmentQr(reference({[field]:'different-reference'}));
    assert.equal(changed.ok,true);assert.notDeepEqual(changed.matrix,original.matrix);
  }
});

test('dispatch-truck Driver QR is renderable and rejects mismatched or augmented payloads',()=>{
 const payload={v:1,type:'AIMOC_DRIVER_DISPATCH_REFERENCE',dispatchId:'dispatch-demo-001',truckId:'truck-demo-001',assignedDriverUserId:'driver-demo-001'};
 const qr=buildAssignmentQr(JSON.stringify(payload));
 assert.equal(qr.ok,true);
 assert.ok(qr.path.length>100);
 for(const changed of [{...payload,assignedDriverUserId:'bad/user'},{...payload,tripId:'trip-leak'},{...payload,dispatchId:null},{...payload,v:2}])assert.equal(buildAssignmentQr(JSON.stringify(changed)).ok,false);
});

test('QR has a four-module white quiet zone and valid version-sized square geometry',()=>{
  const qr=buildAssignmentQr(reference());
  assert.equal(qr.ok,true);assert.equal(qr.quietZone,4);assert.equal(qr.size,qr.moduleCount+8);
  assert.equal((qr.moduleCount-17)%4,0);assert.ok(qr.moduleCount>=21&&qr.moduleCount<=177);
  assert.equal(qr.matrix.length,qr.size);
  for(let y=0;y<qr.size;y++){
    assert.equal(qr.matrix[y].length,qr.size);
    for(let x=0;x<qr.size;x++){
      assert.equal(typeof qr.matrix[y][x],'boolean');
      if(x<4||y<4||x>=qr.size-4||y>=qr.size-4)assert.equal(qr.matrix[y][x],false,'quiet zone must remain white');
    }
  }
  assert.equal(qr.matrix[4][4],true,'finder starts immediately after exactly four quiet modules');
  const rectangles=[...qr.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)];
  assert.ok(rectangles.length>100);assert.equal(rectangles.map(match=>match[0]).join(''),qr.path);
  assert.equal(rectangles.length,qr.matrix.flat().filter(Boolean).length);
  for(const match of rectangles){const x=Number(match[1]),y=Number(match[2]);assert.equal(qr.matrix[y][x],true);}
});

test('encoded QR format information independently verifies ECC M and its BCH checksum',()=>{
  const qr=buildAssignmentQr(reference());
  const dark=(row,column)=>qr.matrix[row+4][column+4];
  // ISO QR format positions, least-significant bit first; skip timing row 6.
  const rows=[0,1,2,3,4,5,7,8,...Array.from({length:7},(_,i)=>qr.moduleCount-7+i)];
  const encoded=rows.reduce((word,row,bit)=>word|(Number(dark(row,8))<<bit),0);
  const unmasked=encoded^0x5412;
  let remainder=unmasked;
  for(let bit=14;bit>=10;bit--)if(remainder&(1<<bit))remainder^=0x537<<(bit-10);
  assert.equal(remainder,0,'valid QR BCH format checksum');
  const formatData=unmasked>>10;
  assert.equal(formatData>>3,0,'QR standard ECC M format bits are 00');
  assert.ok((formatData&7)>=0&&(formatData&7)<=7);
});

test('maximum permitted reference IDs encode, while credentials, URLs and malformed DTOs do not',()=>{
  const full=reference(Object.fromEntries(['requestId','dispatchId','tripId','truckId'].map((key,i)=>[key,String(i).repeat(100)])));
  assert.ok(Buffer.byteLength(full)<ASSIGNMENT_QR_MAX_BYTES);assert.equal(buildAssignmentQr(full).ok,true);
  for(const value of [null,undefined,42,'','  '])assert.equal(buildAssignmentQr(value).ok,false);
  for(const value of ['not-json','null','[]','{}','https://example.invalid/login?token=example',
    reference({token:'not-a-reference'}),reference({v:2}),reference({type:'LOGIN'}),
    reference({tripId:'invalid/id'}),reference({truckId:'x'.repeat(101)}),reference({dispatchId:null})]){
    assert.equal(buildAssignmentQr(value).ok,false);
  }
  const oversize=' '.repeat(ASSIGNMENT_QR_MAX_BYTES)+reference();
  assert.deepEqual(buildAssignmentQr(oversize),{ok:false,reason:'TOO_LONG'});
});

let componentPromise;
async function component(){
  componentPromise ||= (async()=>{
    const result=await build({configFile:false,logLevel:'silent',build:{
      ssr:fileURLToPath(new URL('../src/features/integrated/AssignmentQr.jsx',import.meta.url)),write:false,
      rollupOptions:{external:['react'],output:{format:'es',inlineDynamicImports:true}}
    }});
    const entry=result.output.find(item=>item.type==='chunk'&&item.isEntry);
    const code=entry.code.replace(/from\s*(['"])react\1/g,`from ${JSON.stringify(import.meta.resolve('react'))}`);
    return (await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).AssignmentQr;
  })();
  return componentPromise;
}

test('real React component renders accessible controlled SVG and a visible safe fallback',async()=>{
  const AssignmentQr=await component(),value=reference(),qr=buildAssignmentQr(value);
  const markup=renderToStaticMarkup(React.createElement(AssignmentQr,{value,label:'Reference <script> label'}));
  assert.match(markup,/role="img"/);assert.match(markup,/aria-label="Reference &lt;script&gt; label"/);
  assert.match(markup,new RegExp(`viewBox="0 0 ${qr.size} ${qr.size}"`));
  assert.match(markup,/data-quiet-zone="4"/);assert.match(markup,/data-error-correction="M"/);
  assert.match(markup,/shape-rendering="crispEdges"/);assert.match(markup,/<rect[^>]+fill="#fff"/);
  assert.match(markup,/<path[^>]+fill="#000"/);assert.doesNotMatch(markup,/<script>|<image|<foreignObject|data:image|(?:href|src)=["']https?:\/\//);
  // The SVG namespace is the sole URL-shaped value and is not an external asset.
  const changed=renderToStaticMarkup(React.createElement(AssignmentQr,{value:reference({tripId:'another-trip'}),label:'Reference'}));
  assert.notEqual(/<path d="([^"]+)"/.exec(markup)[1],/<path d="([^"]+)"/.exec(changed)[1]);
  for(const invalid of ['',reference({token:'never render me'}),' '.repeat(2048)]){
    const fallback=renderToStaticMarkup(React.createElement(AssignmentQr,{value:invalid,label:'QR reference'}));
    assert.match(fallback,/role="status"/);assert.match(fallback,/QR reference/);
    assert.doesNotMatch(fallback,/<svg|never render me/);
  }
});
