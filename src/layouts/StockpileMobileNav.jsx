import React from 'react';
import { tr } from '../i18n.js';
export function StockpileMobileNav({navs,page,selectPage}) {
  return <nav className="stockpile-mobile-nav" aria-label={tr('Navigasi Stockpile')}>
    {navs.map(([id,label,Icon])=><button key={id} type="button" className={page===id?'selected':''}
      aria-current={page===id?'page':undefined} onClick={()=>selectPage(id)}>
      <Icon size={19}/><span>{tr(label)}</span></button>)}
  </nav>;
}
