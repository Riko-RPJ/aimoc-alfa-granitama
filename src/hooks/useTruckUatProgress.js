import {useEffect,useState} from 'react';

/** Local-only cross-role UAT read model. Never replace verified trip status. */
export function useTruckUatProgress(enabled=true){
 const [result,setResult]=useState({available:false,items:[],error:null});
 useEffect(()=>{
  if(!enabled)return;
  let alive=true;
  const fetchStatus=async()=>{
   try{
    const r=await fetch('/api/uat/truck-task-status',{credentials:'same-origin'});
    if(!r.ok)throw new Error('UAT progress read unavailable ('+r.status+')');
    const payload=await r.json();
    if(alive)setResult({available:true,items:payload.items||[],error:null});
   }catch(e){if(alive)setResult({available:false,items:[],error:e.message});}
  };
  fetchStatus();
  const timer=setInterval(fetchStatus,5000);
  return()=>{alive=false;clearInterval(timer);};
 },[enabled]);
 return result;
}
