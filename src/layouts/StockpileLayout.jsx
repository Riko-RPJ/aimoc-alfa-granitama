import React from 'react';
import { LegacyNavigation } from './LegacyNavigation.jsx';
import { StockpileMobileNav } from './StockpileMobileNav.jsx';
export function StockpileLayout(props) {
  return <>
    <LegacyNavigation {...props} />
    <StockpileMobileNav navs={props.navs} page={props.page} selectPage={props.selectPage} />
  </>;
}
