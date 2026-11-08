import React from 'react';
import {adminSidebarBadge} from './admin-sidebar-notifications.mjs';
import './workspace-navigation.css';

/** One navigation button per menu. Its described count is separate from its name. */
export function WorkspaceNavigation({items,role,currentPage,onNavigate,notifications,stale,L,formatCount}){
 const admin=role==='admin';
 return <nav className={admin?'ig-admin-nav':undefined} aria-label={L('Navigasi utama','Main navigation')}>
  {items.map(([id,label,Icon])=>{
   const badge=admin?adminSidebarBadge(notifications,id,{stale}):null;
   const count=badge?.count??null,formatted=count===null?'—':formatCount?formatCount(count):String(count);
   const description=count===null?badge?.state==='stale'?L('Jumlah pengajuan belum terkini','The pending submission count is not current'):L('Jumlah pengajuan belum tersedia','The pending submission count is unavailable'):formatted+' '+L('pengajuan menunggu',count===1?'pending submission':'pending submissions');
   const descriptionId='admin-nav-description-'+id;
   return <button key={id} type="button" className={currentPage===id?'active':''} aria-label={label} aria-current={currentPage===id?'page':undefined} aria-describedby={admin?descriptionId:undefined} data-menu-id={id} onClick={()=>onNavigate(id)}>
    <Icon size={18} aria-hidden="true"/><span className="ig-nav-label">{label}</span>
    {admin&&<><span className={'ig-nav-badge '+(badge.state!=='ready'?'ig-nav-badge--unavailable':count>0?'ig-nav-badge--pending':'ig-nav-badge--zero')} data-testid={'admin-nav-badge-'+id} data-menu-id={id} data-state={badge.state} data-count={count===null?undefined:count} aria-hidden="true" title={description}>{count===null?'—':count>99?'99+':formatted}</span><span className="ig-nav-count-description" id={descriptionId}>{description}</span></>}
   </button>;
  })}
 </nav>;
}
