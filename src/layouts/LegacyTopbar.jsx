import React from 'react';
import { ChevronRight, Menu, RefreshCw, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import { tr } from '../i18n.js';
import { LanguageSwitcher } from '../components/ui/index.jsx';

export function LegacyTopbar({setMobileNav,head,connected,lastSync,refresh,roleName,role,minute}) {
  return <header className="topbar"><div className="topbar-left"><button className="mobile-only icon-btn" onClick={() => setMobileNav(true)} aria-label={tr("Buka menu")}><Menu size={22} /></button><span className="breadcrumb">{tr("Operations ")}<ChevronRight size={14} /><b>{head[1]}</b></span></div><div className="topbar-right"><LanguageSwitcher compact /><span className={`sync-state ${connected ? 'online' : 'offline'}`}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}<span>{connected ? tr("Tersinkron") : tr("Koneksi terputus")}</span><small>{minute(lastSync)}</small></span><button className="icon-btn" onClick={refresh} aria-label={tr("Muat ulang data")} title={tr("Muat ulang")}><RefreshCw size={17} /></button><div className="topbar-divider" /><span className="role-chip"><ShieldCheck size={14} />{roleName[role]}</span></div></header>;
}
