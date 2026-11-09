import React, { useState } from 'react';
import { ArrowRight, Eye, EyeOff, Factory, Loader2, LockKeyhole, ShieldCheck, Ship, Truck, UserRound } from 'lucide-react';
import { tr, useLanguage } from '../../i18n.js';
import { api } from '../../services/legacy-api.js';
import { LanguageSwitcher, Button, Field } from '../../components/ui/index.jsx';
import { Brand, BrandPartners } from '../../components/brand/index.jsx';
import { isStockpilePath } from '../../app/navigation.js';
import { StockpileThemeToggle, useStockpileTheme } from '../pages/stockpile/stockpile-theme.jsx';

export function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [theme, selectTheme] = useStockpileTheme();
  const language = useLanguage();
  const L = (id, en) => language === 'en' ? en : id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async e => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      onLogin(await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!isStockpilePath(window.location.pathname)) return <div className="login-shell"><div className="login-story"><Brand light /><div className="login-story-copy"><span className="eyebrow">{tr("CONNECTED QUARRY OPERATIONS")}</span><h1>{tr("Dari crusher.")}<br />{tr("Ke kapal.")}<br /><em>{tr("Dalam satu kendali.")}</em></h1><p>{tr("Stok yang terlacak. Dispatch yang terarah.")}<br />{tr("Setiap ritase sampai ke tujuan yang benar.")}</p></div><div className="login-flow"><div><Factory size={30} /><span>{tr("CRUSHER")}</span></div><i /><div><Truck size={30} /><span>{tr("DISPATCH")}</span></div><i /><div><Ship size={30} /><span>{tr("JETTY")}</span></div></div><div className="login-story-footer"><span>{tr("GANDASARI GROUP")}</span><span>{tr("PT ALFA GRANITAMA")}</span></div></div><div className="login-form-wrap"><div className="login-language"><LanguageSwitcher /></div><BrandPartners /><form className="login-form" onSubmit={submit}><span className="eyebrow">{tr("AIMOC OPERATIONS")}</span><h2>{tr("Selamat datang kembali")}</h2><p>{tr("Masuk ke ruang operasi sesuai peran Anda.")}</p><Field label={tr("Username")}><input autoComplete="username" autoFocus required value={username} onChange={e => setUsername(e.target.value)} placeholder={tr("Username akun Anda")} /></Field><Field label={tr("Password")}><input autoComplete="current-password" required type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={tr("Masukkan password")} /></Field>{error && <div className="form-error" role="alert">{tr(error)}</div>}<Button type="submit" disabled={busy} icon={busy ? Loader2 : ArrowRight}>{busy ? tr("Menghubungkan…") : tr("Masuk ke aplikasi")}</Button><div className="login-assurance"><ShieldCheck size={17} /><span>{tr("Akses berbasis peran")}<br /><small>{tr("Admin · Operator stockpile · Operator jetty")}</small></span></div></form><p className="login-bottom">{tr("AIMOC Gandasari Alfa Granitama · Operational prototype")}</p></div></div>;

  return <main className={`stock-login stock-tablet--${theme}`} data-testid="stockpile-login">
    <div className="stock-login-toolbar"><LanguageSwitcher /><StockpileThemeToggle {...{theme, selectTheme, L}} /></div>
    <form className="stock-login-card" onSubmit={submit}>
      <Brand light />
      <h1>{L('Operator stockpile', 'Stockpile operator')}</h1>
      <p>{L('Masuk untuk mencatat pengukuran dan melihat persediaan material.', 'Sign in to record measurements and view material inventory.')}</p>
      <Field label={L('Username Stockpile', 'Stockpile username')}>
        <span className="stock-login-field"><UserRound size={18} aria-hidden="true" /><input autoComplete="username" autoFocus required value={username} onChange={e => setUsername(e.target.value)} placeholder={L('Masukkan username Stockpile', 'Enter your stockpile username')} /></span>
      </Field>
      <div className="stock-login-password">
        <Field label={L('Kata sandi', 'Password')}>
          <span className="stock-login-field"><LockKeyhole size={18} aria-hidden="true" /><input autoComplete="current-password" required type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={L('Masukkan kata sandi Anda', 'Enter your password')} /></span>
        </Field>
        <button type="button" className="stock-login-eye" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? L('Sembunyikan kata sandi', 'Hide password') : L('Tampilkan kata sandi', 'Show password')} aria-pressed={showPassword}>{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button>
      </div>
      {error && <div className="form-error" role="alert">{tr(error)}</div>}
      <Button type="submit" disabled={busy} icon={busy ? Loader2 : ArrowRight}>{busy ? tr('Menghubungkan…') : L('Masuk ke aplikasi', 'Sign in')}</Button>
    </form>
    <BrandPartners />
  </main>;
}
