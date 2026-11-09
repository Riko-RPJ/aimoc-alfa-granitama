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

const partners = [
  ["/brand/gandasari-logo.png", "Gandasari Group", "GANDASARI GROUP"],
  ["/brand/alfa-granitama-logo.png", "PT Alfa Granitama", "ALFA GRANITAMA"],
  ["/brand/prasetia-dwidharma-logo.png", "Prasetia Dwi Dharma", "PRASETIA DWI DHARMA"]
];

export function BrandPartners() {
  return <div className="partners" aria-label="Gandasari Group, PT Alfa Granitama, Prasetia Dwi Dharma">{partners.map(([src, alt, fallback], index) => <React.Fragment key={src}>{index > 0 && <span aria-hidden="true" />}<div className="partner-mark"><img src={src} alt={alt} onError={e => { e.currentTarget.style.display = "none"; e.currentTarget.nextSibling.style.display = "block"; }} /><b style={{display: "none"}}>{fallback}</b></div></React.Fragment>)}</div>;
}
