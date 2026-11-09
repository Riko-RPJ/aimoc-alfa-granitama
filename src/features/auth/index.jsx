import React, { useState } from 'react';
import { ArrowRight, Factory, Loader2, ShieldCheck, Ship, Truck, UserRound } from 'lucide-react';
import { tr } from '../../i18n.js';
import { api } from '../../services/legacy-api.js';
import { LanguageSwitcher, Button, Field } from '../../components/ui/index.jsx';
import { Brand, BrandPartners } from '../../components/brand/index.jsx';

export function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('aimoc.stockpile.theme') === 'dark' ? 'dark' : 'light');
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
  const selectTheme = value => {
    localStorage.setItem('aimoc.stockpile.theme', value);
    setTheme(value);
  };
  if (!window.location.pathname.startsWith('/stockpile')) return <div className="login-shell"><div className="login-story"><Brand light /><div className="login-story-copy"><span className="eyebrow">{tr("CONNECTED QUARRY OPERATIONS")}</span><h1>{tr("Dari crusher.")}<br />{tr("Ke kapal.")}<br /><em>{tr("Dalam satu kendali.")}</em></h1><p>{tr("Stok yang terlacak. Dispatch yang terarah.")}<br />{tr("Setiap ritase sampai ke tujuan yang benar.")}</p></div><div className="login-flow"><div><Factory size={30} /><span>{tr("CRUSHER")}</span></div><i /><div><Truck size={30} /><span>{tr("DISPATCH")}</span></div><i /><div><Ship size={30} /><span>{tr("JETTY")}</span></div></div><div className="login-story-footer"><span>{tr("GANDASARI GROUP")}</span><span>{tr("PT ALFA GRANITAMA")}</span></div></div><div className="login-form-wrap"><div className="login-language"><LanguageSwitcher /></div><BrandPartners /><form className="login-form" onSubmit={submit}><span className="eyebrow">{tr("AIMOC OPERATIONS")}</span><h2>{tr("Selamat datang kembali")}</h2><p>{tr("Masuk ke ruang operasi sesuai peran Anda.")}</p><Field label={tr("Username")}><input autoComplete="username" autoFocus required value={username} onChange={e => setUsername(e.target.value)} placeholder={tr("Username akun Anda")} /></Field><Field label={tr("Password")}><input autoComplete="current-password" required type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={tr("Masukkan password")} /></Field>{error && <div className="form-error" role="alert">{tr(error)}</div>}<Button type="submit" disabled={busy} icon={busy ? Loader2 : ArrowRight}>{busy ? tr("Menghubungkan…") : tr("Masuk ke aplikasi")}</Button><div className="login-assurance"><ShieldCheck size={17} /><span>{tr("Akses berbasis peran")}<br /><small>{tr("Admin · Operator stockpile · Operator jetty")}</small></span></div></form><p className="login-bottom">{tr("AIMOC Gandasari Alfa Granitama · Operational prototype")}</p></div></div>;

  return <main className={`stock-login ${theme === 'dark' ? 'dark' : ''}`}>
    <div className="stock-login-theme" role="group" aria-label="Tema tampilan">
      <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => selectTheme('light')} aria-label="Gunakan tema terang" aria-pressed={theme === 'light'}><img src="/login/sun.png" alt="" /></button>
      <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => selectTheme('dark')} aria-label="Gunakan tema gelap" aria-pressed={theme === 'dark'}><img src="/login/moon.png" alt="" /></button>
    </div>
    <form className="stock-login-card" onSubmit={submit}>
      <img className="stock-login-logo" src="/login/aimoc.png" alt="AIMOC" />
      <label className="stock-login-field"><UserRound aria-hidden="true" /><input autoComplete="username" autoFocus required value={username} onChange={e => setUsername(e.target.value)} placeholder="Masukkan username Stockpile" aria-label="Username Stockpile" /></label>
      <label className="stock-login-field"><img src="/login/lock.png" alt="" /><input autoComplete="current-password" required type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Masukkan kata sandi Anda" aria-label="Kata sandi" /><button type="button" className="stock-login-eye" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'} aria-pressed={showPassword}><img src="/login/eye-off.png" alt="" /></button></label>
      <div className="stock-login-options"><label><input type="checkbox" /> <span>Ingat Saya</span></label><span>Lupa kata sandi ?</span></div>
      {error && <div className="form-error" role="alert">{tr(error)}</div>}
      <button className="stock-login-submit" type="submit" disabled={busy}>{busy ? <><Loader2 className="spin" size={22} /> Menghubungkan…</> : 'Sign in'}</button>
    </form>
    <div className="stock-login-partners"><img src="/login/gandasari.png" alt="Gandasari Shipyard" /><img src="/login/alfa-granitama.png" alt="Alfa Granitama" /></div>
  </main>;
}
