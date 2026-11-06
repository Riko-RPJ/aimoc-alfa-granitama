import {useCallback,useEffect,useRef,useState} from 'react';

export function useOperationalV1(path,{enabled=true,interval=3000}={}){
 const [state,setState]=useState({status:'LOADING',source:null,data:null,error:null});
 const active=useRef(false);
 const load=useCallback(async()=>{
  if(!enabled||active.current)return;
  active.current=true;
  try{
   const response=await fetch(path,{credentials:'same-origin',headers:{Accept:'application/json'}});
   const payload=await response.json();
   if(!response.ok)throw Object.assign(new Error(payload.message||'Operational v1 unavailable'),{status:response.status});
   setState({status:payload.data_status,source:payload.source,data:payload.data,error:null});
  }catch(error){setState(current=>({...current,status:error.status===404||error.status===501?'NOT_INTEGRATED':'ERROR',error:error.message}));}
  finally{active.current=false;}
 },[enabled,path]);
 useEffect(()=>{
  if(!enabled)return;
  let alive=true;
  const refresh=()=>{if(alive&&document.visibilityState==='visible')load();};
  load();const timer=setInterval(refresh,interval);document.addEventListener('visibilitychange',refresh);
  return()=>{alive=false;clearInterval(timer);document.removeEventListener('visibilitychange',refresh)};
 },[enabled,interval,load]);
 return {...state,reload:load};
}
