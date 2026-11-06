import React from 'react';
import { tr } from '../../i18n.js';

export function Brand({
  light = false
}) {
  return <div className={`brand ${light ? 'light' : ''}`}><div className="aimoc-crop"><img className="aimoc-logo" src="/brand/aimoc-logo.webp" alt={tr("AIMOC")} onError={e => {
        e.currentTarget.style.display = 'none';
        e.currentTarget.parentNode.nextSibling.style.display = 'block';
      }} /></div><b className="brand-fallback" style={{
      display: 'none'
    }}>{tr("AIMOC")}<span>●</span></b><span className="brand-sub">{tr("ALFA GRANITAMA")}</span></div>;
}

export function BrandPartners() {
  return <div className="partners"><img src="/brand/gandasari-logo.png" alt={tr("Gandasari Group")} onError={e => {
      e.currentTarget.style.display = 'none';
      e.currentTarget.nextSibling.style.display = 'block';
    }} /><b style={{
      display: 'none'
    }}>{tr("GANDASARI ")}<small>{tr("GROUP")}</small></b><span /><img src="/brand/alfa-granitama-logo.png" alt={tr("PT Alfa Granitama")} onError={e => {
      e.currentTarget.style.display = 'none';
      e.currentTarget.nextSibling.style.display = 'block';
    }} /><b style={{
      display: 'none'
    }}>{tr("ALFA ")}<small>{tr("GRANITAMA")}</small></b></div>;
}
