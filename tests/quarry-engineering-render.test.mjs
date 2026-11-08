import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import * as modelHelpers from '../public/quarry-engineering-model.mjs';
import {quarryEngineeringUrl} from '../src/features/quarry-cilegon/quarry-view.mjs';

const fixture=()=>({revision:41,state:{quarryCilegon:{model:'WIM_WIM',enabled:true,version:17,lanes:[
 {id:'lane-1',mode:'WIM',direction:'OUT',active:false},
 {id:'lane-2',mode:'WIM',direction:'IN',active:true},
 {id:'lane-3',mode:'QR_ONLY',direction:'BIDIRECTIONAL',active:true}
]},trips:[]}});

// Execute the shipping viewer and its rebuild() geometry path. The recorder replaces
// WebGL only; assertions inspect the actual BoxGeometry sizes and positions built.
class Element{
 constructor(){this.children=[];this.dataset={};this.listeners={};this.value='';this.textContent='';this.checked=false;this.hidden=false;this.classList={toggle(){},remove(){},add(){}};}
 append(...children){this.children.push(...children);}
 prepend(...children){this.children.unshift(...children);}
 replaceChildren(...children){this.children=[...children];}
 addEventListener(type,callback){this.listeners[type]=callback;}
 setAttribute(name,value){this[name]=String(value);if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=String(value);}
 getContext(){return{fillText(){}};}
}
class Object3D{
 constructor(){this.children=[];this.position={set:(x,y,z)=>Object.assign(this.position,{x,y,z})};this.scale={set(){}};this.rotation={};}
 add(...children){this.children.push(...children);}
 remove(child){this.children=this.children.filter(item=>item!==child);}
 traverse(visit){visit(this);this.children.forEach(child=>child.traverse?.(visit));}
}
class Geometry{constructor(...size){this.size=size;}dispose(){}}
class Material{constructor(options){Object.assign(this,options);}dispose(){}}
class Mesh extends Object3D{constructor(geometry,material){super();this.geometry=geometry;this.material=material;}}
const THREE={Group:Object3D,BoxGeometry:Geometry,MeshStandardMaterial:Material,Mesh,Sprite:Mesh,SpriteMaterial:Material,CanvasTexture:class{dispose(){}},Vector3:class{constructor(x,y,z){Object.assign(this,{x,y,z});}},ArrowHelper:Object3D,WebGLRenderer:class{constructor(){throw new Error('Geometry recorder does not initialize WebGL');}}};

async function viewer(query='',response=fixture()){
 const [source,html]=await Promise.all([readFile(new URL('../public/quarry-engineering.js',import.meta.url),'utf8'),readFile(new URL('../public/quarry-engineering.html',import.meta.url),'utf8')]);
 const elements=new Map(),tagged=[],menus=[],cameras=[],liveCard=new Element(),requests=[],storage=new Map();
 const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 for(const tag of html.matchAll(/<[a-z][^>]*>/gi)){
  const id=tag[0].match(/\bid="([^"]+)"/)?.[1],element=id?get(id):new Element();
  for(const attr of tag[0].matchAll(/\bdata-([\w-]+)="([^"]*)"/g))element.dataset[attr[1].replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=attr[2];
  if(element.dataset.t)tagged.push(element);
  if(element.dataset.menu)menus.push(element);
  if(element.dataset.camera)cameras.push(element);
 }
 get('canopy').checked=true;get('phase').value='4';
 const location=new URL('https://quarry.test/quarry-engineering.html'+query);
 const document={hidden:false,documentElement:{},getElementById:get,createElement:()=>new Element(),addEventListener(){},querySelector:selector=>selector==='.live-card'?liveCard:null,querySelectorAll:selector=>({'[data-t]':tagged,'[data-menu]':menus,'[data-camera]':cameras}[selector]||[])};
 let snapshot=response;
 const context=vm.createContext({...modelHelpers,THREE,document,URL,URLSearchParams,location,window:{location,addEventListener(){},history:{replaceState(){}}},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},setInterval(){},requestAnimationFrame(){},console,
  fetch:async(url,options={})=>{requests.push({url,method:options.method||'GET'});return{ok:true,status:200,json:async()=>structuredClone(snapshot)};}});
 vm.runInContext(source.replace(/^import[^\n]*\n/gm,''),context,{filename:'quarry-engineering.js'});
 await new Promise(resolve=>setImmediate(resolve));
 vm.runInContext('scene=new THREE.Group();',context);
 return{get,requests,context,snapshot:()=>snapshot,setSnapshot:next=>{snapshot=next;},poll:async()=>{await vm.runInContext('poll()',context);},
  fire:async(id,type,value)=>{const element=get(id);if(value!==undefined)element.value=value;await element.listeners[type]?.({target:element});await new Promise(resolve=>setImmediate(resolve));},
  geometry:()=>{vm.runInContext('rebuild()',context);const result=[];vm.runInContext('site',context).traverse(object=>{if(object.geometry?.size)result.push({size:[...object.geometry.size],x:object.position.x,y:object.position.y,z:object.position.z});});return result;}};
}

function assertLaneGeometry(harness,modes){
 const boxes=harness.geometry();
 modes.forEach((mode,index)=>{
  const x=(index-1)*6,deck=boxes.filter(box=>box.x===x&&box.size[0]===4.3&&box.size[1]===.18&&box.size[2]===18),sensors=boxes.filter(box=>box.x===x&&box.size[0]===4.4&&box.size[1]===.1&&box.size[2]===.22);
  assert.equal(deck.length,mode==='STATIC'?1:0,'Lane '+(index+1)+' static deck geometry');
  assert.equal(sensors.length,mode==='WIM'?2:0,'Lane '+(index+1)+' WIM sensor geometry');
 });
 assert.equal(boxes.filter(box=>box.x===6&&box.size[0]===3.7&&box.size[2]===5).length,1,'Third lane retains its QR pad');
}

test('all three URL previews render their physical scale geometry while saved WIM/WIM remains unchanged',async()=>{
 for(const [model,modes] of Object.entries(modelHelpers.MODEL_MODES)){
  const original=fixture(),before=structuredClone(original),harness=await viewer('?model='+model+'&lang=en',original);
  assertLaneGeometry(harness,modes);
  assert.match(harness.get('view-kind').textContent,/preview/i);
  assert.match(harness.get('active-model-note').textContent,/WIM \+ WIM/);
  assert.equal(harness.context.document.documentElement.lang,'en');
  assert.equal(harness.get('model-preview').value,model);
  await harness.poll();
  assertLaneGeometry(harness,modes);
  assert.deepEqual(original,before);
  assert.ok(harness.requests.every(request=>request.method==='GET'&&request.url==='/api/v1/demo/context'));
 }
});

test('default 3D follows live configuration; local preview changes preserve directions and return to live',async()=>{
 const original=fixture(),before=structuredClone(original),harness=await viewer('',original);
 assertLaneGeometry(harness,['WIM','WIM']);
 assert.doesNotMatch(harness.get('view-kind').textContent,/preview/i);
 await harness.fire('model-preview','change','STATIC_STATIC');
 assertLaneGeometry(harness,['STATIC','STATIC']);
 assert.match(harness.get('view-kind').textContent,/pratinjau|preview/i);
 assert.match(harness.get('lane-list').children[0].children[1].children[1].textContent,/Nonaktif|Inactive/);
 assert.match(harness.get('lane-list').children[1].children[1].children[1].textContent,/Masuk|Inbound/);
 await harness.fire('language','click');
 assert.equal(harness.context.document.documentElement.lang,'en');
 assertLaneGeometry(harness,['STATIC','STATIC']);
 assert.match(harness.get('active-model-note').textContent,/WIM \+ WIM/);
 const next=fixture();next.state.quarryCilegon.model='STATIC_WIM';next.state.quarryCilegon.lanes[0].mode='STATIC';
 harness.setSnapshot(next);await harness.poll();
 assertLaneGeometry(harness,['STATIC','STATIC']);
 assert.match(harness.get('active-model-note').textContent,/Static \+ WIM/);
 await harness.fire('model-preview','change','');
 assertLaneGeometry(harness,['STATIC','WIM']);
 assert.doesNotMatch(harness.get('view-kind').textContent,/preview/i);
 assert.deepEqual(original,before);
 assert.ok(harness.requests.every(request=>request.method==='GET'));
});

test('invalid or duplicated preview URLs follow live geometry',async()=>{
 const data=fixture();data.state.quarryCilegon.model='STATIC_STATIC';data.state.quarryCilegon.lanes[0].mode='STATIC';data.state.quarryCilegon.lanes[1].mode='STATIC';
 for(const query of ['?model=UNKNOWN','?model=STATIC_WIM&model=WIM_WIM'])assertLaneGeometry(await viewer(query,data),['STATIC','STATIC']);
});

test('launch URL carries the selected preview method and UI language',()=>{
 for(const model of Object.keys(modelHelpers.MODEL_MODES))for(const lang of ['id','en']){
  const url=new URL(quarryEngineeringUrl(model,lang),'https://quarry.test');
  assert.equal(url.pathname,'/quarry-engineering.html');
  assert.equal(url.searchParams.get('model'),model);
  assert.equal(url.searchParams.get('lang'),lang);
 }
});

test('legacy method routes render a matching 3D link and both launch points use the same handoff',async()=>{
 const server=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'silent'}),previous=globalThis.window;
 try{
  globalThis.window={location:new URL('https://quarry.test/'),addEventListener(){}};
  const {QuarryCilegonWorkspace}=await server.ssrLoadModule('/src/features/quarry-cilegon/QuarryCilegonWorkspace.jsx');
  for(const [path,model] of [['/parallel.html','STATIC_WIM'],['/static.html','STATIC_STATIC'],['/wim.html','WIM_WIM'],['/?model=STATIC_STATIC','STATIC_STATIC']]){
   globalThis.window.location=new URL(path,'https://quarry.test');
   const html=renderToStaticMarkup(React.createElement(QuarryCilegonWorkspace,{user:{id:'fixture-admin',role:'admin'}})),href=html.match(/href="([^"]*quarry-engineering\.html[^"]*)"/)?.[1];
   assert.ok(href,path+' has a 3D launch link');
   const link=new URL(href.replaceAll('&amp;','&'),'https://quarry.test');
   assert.equal(link.searchParams.get('model'),model,path);
   assert.equal(link.searchParams.get('lang'),'id');
   assert.equal(html.includes('<iframe'),false);
  }
  const source=await readFile(new URL('../src/features/quarry-cilegon/QuarryCilegonWorkspace.jsx',import.meta.url),'utf8');
  assert.equal((source.match(/href=\{quarryEngineeringUrl\(model,language\)\}/g)||[]).length,2,'Operations and Design both hand off the chosen method');
 }finally{globalThis.window=previous;await server.close();}
});
