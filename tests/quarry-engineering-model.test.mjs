import test from 'node:test';
import assert from 'node:assert/strict';
import {MODEL_MODES,parsePreviewModel,parseViewerLanguage,resolveViewerLanes} from '../public/quarry-engineering-model.mjs';

const saved=()=>({model:'WIM_WIM',enabled:true,version:17,lanes:[
 {id:'lane-1',mode:'WIM',direction:'OUT',active:false},
 {id:'lane-2',mode:'WIM',direction:'IN',active:true},
 {id:'lane-3',mode:'QR_ONLY',direction:'BIDIRECTIONAL',active:true}
]});

test('3D URL accepts only one supported preview method and language',()=>{
 for(const model of Object.keys(MODEL_MODES)){
  assert.equal(parsePreviewModel('?model='+model),model);
  assert.equal(parsePreviewModel(new URLSearchParams({model})),model);
 }
 for(const query of ['','?model=','?model=static_wim','?model=UNKNOWN','?model=WIM_WIM&model=STATIC_STATIC','?model=STATIC_WIM&model=STATIC_WIM'])
  assert.equal(parsePreviewModel(query),null,query);
 for(const language of ['id','en'])assert.equal(parseViewerLanguage('?lang='+language),language);
 for(const query of ['','?lang=','?lang=EN','?lang=fr','?lang=en&lang=id','?lang=en&lang=en'])
  assert.equal(parseViewerLanguage(query),null,query);
});

test('three preview methods change only cloned weighing modes, preserving live gate settings',()=>{
 const config=saved(),before=structuredClone(config);
 for(const [model,modes] of Object.entries(MODEL_MODES)){
  const lanes=resolveViewerLanes(config,model);
  assert.deepEqual(lanes.map(lane=>lane.mode),[...modes,'QR_ONLY']);
  assert.deepEqual(lanes.map(({id,direction,active})=>({id,direction,active})),config.lanes.map(({id,direction,active})=>({id,direction,active})));
  assert.notEqual(lanes,config.lanes);
  lanes.forEach((lane,index)=>assert.notEqual(lane,config.lanes[index]));
  assert.deepEqual(config,before,'Viewing a design must not change the saved operation configuration');
 }
});

test('3D without a preview follows the saved modes and does not expose mutable lane objects',()=>{
 const config=saved();config.model='STATIC_WIM';config.lanes[0].mode='STATIC';
 const lanes=resolveViewerLanes(config,null);
 assert.deepEqual(lanes,config.lanes);
 lanes[0].mode='WIM';
 assert.equal(config.lanes[0].mode,'STATIC');
 assert.deepEqual(resolveViewerLanes(null,'STATIC_STATIC').map(lane=>lane.mode),['STATIC','STATIC','QR_ONLY']);
 assert.deepEqual(resolveViewerLanes(null,null).map(lane=>lane.mode),['WIM','WIM','QR_ONLY']);
});

test('preview method follows lane identity even if a saved lane array is reordered',()=>{
 const config=saved();config.lanes=[config.lanes[2],config.lanes[1],config.lanes[0]];
 const lanes=resolveViewerLanes(config,'STATIC_WIM');
 assert.equal(lanes.find(lane=>lane.id==='lane-1').mode,'STATIC');
 assert.equal(lanes.find(lane=>lane.id==='lane-2').mode,'WIM');
 assert.equal(lanes.find(lane=>lane.id==='lane-3').mode,'QR_ONLY');
});
