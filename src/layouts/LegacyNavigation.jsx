import React from 'react';
import { ChevronDown, Factory, LogOut, X } from 'lucide-react';
import { tr } from '../i18n.js';
import { Brand } from '../components/brand/index.jsx';
import { LanguageSwitcher } from '../components/ui/index.jsx';

export function LegacyNavigation({mobileNav,setMobileNav,navs,page,selectPage,requests,user,roleName,role,logout}) {
  return <>
    {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}><div className="sidebar-logo"><Brand light /><button className="mobile-only icon-btn" onClick={() => setMobileNav(false)} aria-label={tr("Tutup menu")}><X size={20} /></button></div><div className="workspace-label"><span className="workspace-icon"><Factory size={18} /></span><div><strong>{tr("Gandasari Operations")}</strong><small>{tr("PT Alfa Granitama")}</small></div><ChevronDown size={15} /></div><div className="nav-section-label">{tr("WORKSPACE")}</div><nav aria-label={tr("Menu utama")}>{navs.map(([id, label, Icon]) => <button key={id} onClick={() => selectPage(id)} className={page === id ? 'selected' : ''}><Icon size={18} /><span>{tr(label)}</span>{id === 'requests' && requests.filter(x => x.status === 'requested').length > 0 && <i>{requests.filter(x => x.status === 'requested').length}</i>}</button>)}</nav><div className="sidebar-bottom">{role === 'stock' && <div className="stockpile-sidebar-language"><LanguageSwitcher compact /></div>}<div className="environment"><span /><div><strong>{tr("Prototipe operasional")}</strong><small>{tr("Data awal contoh · tersimpan bersama")}</small></div></div><div className="sidebar-user"><span className="avatar">{(user.name || user.displayName || user.username || tr("A")).slice(0, 2).toUpperCase()}</span><div><strong>{user.name || user.displayName || user.username}</strong><small>{roleName[role]}</small></div><button onClick={logout} title={tr("Keluar")} className="icon-btn"><LogOut size={17} /></button></div></div></aside>
  </>;
}
