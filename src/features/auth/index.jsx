import React, { useState, useEffect, useMemo, useRef } from 'react';
import { tr, localize, locale, useLanguage, setLanguage, eventText, eventTypeLabel } from '../../i18n.js';
import { statusText } from '../../domain/legacy-status.js';
import { api } from '../../services/legacy-api.js';
import { ArrowRight, Factory, Loader2, ShieldCheck, Ship, Truck } from 'lucide-react';
import { LanguageSwitcher, Button, Field } from '../../components/ui/index.jsx';
import { Brand, BrandPartners } from '../../components/brand/index.jsx';

export function Login({
  onLogin
}) {
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submit = async e => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      onLogin(await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password
        })
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return <div className="login-shell"><div className="login-story"><Brand light /><div className="login-story-copy"><span className="eyebrow">{tr("CONNECTED QUARRY OPERATIONS")}</span><h1>{tr("Dari crusher.")}<br />{tr("Ke kapal.")}<br /><em>{tr("Dalam satu kendali.")}</em></h1><p>{tr("Stok yang terlacak. Dispatch yang terarah.")}<br />{tr("Setiap ritase sampai ke tujuan yang benar.")}</p></div><div className="login-flow"><div><Factory size={30} /><span>{tr("CRUSHER")}</span></div><i /><div><Truck size={30} /><span>{tr("DISPATCH")}</span></div><i /><div><Ship size={30} /><span>{tr("JETTY")}</span></div></div><div className="login-story-footer"><span>{tr("GANDASARI GROUP")}</span><span>{tr("PT ALFA GRANITAMA")}</span></div></div><div className="login-form-wrap"><div className="login-language"><LanguageSwitcher /></div><BrandPartners /><form className="login-form" onSubmit={submit}><span className="eyebrow">{tr("AIMOC OPERATIONS")}</span><h2>{tr("Selamat datang kembali")}</h2><p>{tr("Masuk ke ruang operasi sesuai peran Anda.")}</p><Field label={tr("Username")}><input autoComplete="username" autoFocus required value={username} onChange={e => setUsername(e.target.value)} placeholder={tr("Username akun Anda")} /></Field><Field label={tr("Password")}><input autoComplete="current-password" required type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={tr("Masukkan password")} /></Field>{error && <div className="form-error" role="alert">{tr(error)}</div>}<Button type="submit" disabled={busy} icon={busy ? Loader2 : ArrowRight}>{busy ? tr("Menghubungkan…") : tr("Masuk ke aplikasi")}</Button><div className="login-assurance"><ShieldCheck size={17} /><span>{tr("Akses berbasis peran")}<br /><small>{tr("Admin · Operator stockpile · Operator jetty")}</small></span></div></form><p className="login-bottom">{tr("AIMOC Gandasari Alfa Granitama · Operational prototype")}</p></div></div>;
}
