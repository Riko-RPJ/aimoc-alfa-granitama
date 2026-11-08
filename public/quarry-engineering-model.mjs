export const MODEL_MODES=Object.freeze({
  WIM_WIM:Object.freeze(['WIM','WIM']),
  STATIC_WIM:Object.freeze(['STATIC','WIM']),
  STATIC_STATIC:Object.freeze(['STATIC','STATIC'])
});

const defaultLanes=Object.freeze([
  Object.freeze({id:'lane-1',mode:'WIM',direction:'BIDIRECTIONAL',active:true}),
  Object.freeze({id:'lane-2',mode:'WIM',direction:'BIDIRECTIONAL',active:true}),
  Object.freeze({id:'lane-3',mode:'QR_ONLY',direction:'BIDIRECTIONAL',active:true})
]);

function singleParameter(search,name,allowed){
  const values=new URLSearchParams(search).getAll(name);
  return values.length===1&&allowed.includes(values[0])?values[0]:null;
}

export const parsePreviewModel=search=>singleParameter(search,'model',Object.keys(MODEL_MODES));
export const parseViewerLanguage=search=>singleParameter(search,'lang',['id','en']);

export function resolveViewerLanes(config,previewModel){
  const lanes=Array.isArray(config?.lanes)&&config.lanes.length?config.lanes:defaultLanes;
  const modes=Object.hasOwn(MODEL_MODES,previewModel)?MODEL_MODES[previewModel]:null;
  return lanes.map((lane,index)=>{
    const slot=lane.id==='lane-1'?0:lane.id==='lane-2'?1:lane.id==='lane-3'?2:index;
    return {...lane,...(modes&&slot<2?{mode:modes[slot]}:{})};
  });
}
