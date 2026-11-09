import React, {useState} from 'react';
import {Moon, Sun} from 'lucide-react';
import './stockpile-tablet.css';

const themeKey = 'aimoc.stockpile.theme';

export function useStockpileTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(themeKey) === 'dark' ? 'dark' : 'light'; }
    catch { return 'light'; }
  });
  const selectTheme = next => {
    try { localStorage.setItem(themeKey, next); } catch {}
    setTheme(next);
  };
  return [theme, selectTheme];
}

export function StockpileThemeToggle({theme, selectTheme, L}) {
  return <div className="stock-theme-switch" role="group" aria-label={L('Tema tampilan','Display theme')}>
    <button type="button" aria-pressed={theme === 'light'} aria-label={L('Gunakan tema terang','Use light theme')} onClick={() => selectTheme('light')}><Sun size={17}/></button>
    <button type="button" aria-pressed={theme === 'dark'} aria-label={L('Gunakan tema gelap','Use dark theme')} onClick={() => selectTheme('dark')}><Moon size={17}/></button>
  </div>;
}
