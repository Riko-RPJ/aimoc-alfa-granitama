import React, { useEffect, useRef } from 'react';
import { ArrowUpRight, Box, X } from 'lucide-react';
import { tr, useLanguage, setLanguage } from '../../i18n.js';
import { statusText } from '../../domain/legacy-status.js';

// Presentational components extracted without changing markup or CSS classes.
const number = v => Number(v) || 0;

export function Badge({
  status,
  children,
  tone
}) {
  return <span className={`badge ${tone || (['returned', 'completed', 'approved', 'loading'].includes(status) ? 'green' : ['queued', 'allocated', 'waiting', 'pending', 'requested', 'awaiting_configuration'].includes(status) ? 'amber' : ['in_transit', 'in_progress', 'arrived', 'planned'].includes(status) ? 'blue' : 'neutral')}`}>{children || statusText[status] || status || '—'}</span>;
}

export function LanguageSwitcher({compact=false}) {
  const language=useLanguage();
  return <div className={`language-switch ${compact?'compact':''}`} role="group" aria-label={tr('Bahasa aplikasi')}>
    <button type="button" data-language="id" aria-label="Bahasa Indonesia" title="Bahasa Indonesia" aria-pressed={language==='id'} onClick={()=>setLanguage('id')}>ID</button>
    <button type="button" data-language="en" aria-label="English" title="English" aria-pressed={language==='en'} onClick={()=>setLanguage('en')}>EN</button>
  </div>;
}

export function Empty({
  icon: Icon = Box,
  title = tr("Belum ada data"),
  text = tr("Data operasional akan muncul di sini setelah dicatat.")
}) {
  return <div className="empty"><Icon size={30} /><strong>{title}</strong><p>{text}</p></div>;
}

export function Button({
  children,
  icon: Icon,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled = false,
  ...rest
}) {
  return <button type={type} className={`btn ${variant}`} disabled={disabled} onClick={onClick} {...rest}>{Icon && <Icon size={16} />} {children}</button>;
}

export function Field({
  label,
  children,
  hint
}) {
  return <label className="field"><span>{tr(label)}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  embedded = false
}) {
  const ref = useRef();
  useEffect(() => {
    if (embedded) return;
    const old = document.activeElement;
    ref.current?.focus();
    const key = e => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        let nodes = ref.current?.querySelectorAll('button:not(:disabled),input,select,textarea,[tabindex="0"]');
        let a = [...(nodes || [])].filter(x => x.offsetParent !== null);
        if (!a.length) return;
        let first = a[0],
          last = a[a.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      old?.focus?.();
    };
  }, [embedded]);
  const content=<section className={`modal ${wide ? 'wide' : ''} ${embedded ? 'embedded' : ''}`} role={embedded?'region':'dialog'} aria-modal={embedded?undefined:'true'} aria-label={title} tabIndex={embedded?undefined:-1} ref={ref}><div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><div className="modal-heading-tools"><LanguageSwitcher compact /><button className="icon-btn" onClick={onClose} aria-label={tr("Tutup")}><X size={21} /></button></div></div>{children}</section>;
  return embedded?content:<div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>{content}</div>;
}

export function StatCard({
  label,
  value,
  unit,
  caption,
  icon: Icon,
  tone = 'teal',
  trend
}) {
  return <article className="stat-card"><div className="stat-top"><span>{tr(label)}</span><span className={`stat-icon ${tone}`}><Icon size={20} /></span></div><div className="stat-number">{value}<small>{unit}</small></div><div className="stat-caption">{trend && <span className="stat-trend"><ArrowUpRight size={13} />{trend}</span>}{caption}</div></article>;
}

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = ''
}) {
  return <section className={`panel ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>{children}</section>;
}

export function DataTable({
  headers,
  children
}) {
  return <div className="table-wrap"><table><thead><tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

export function ProgressBar({
  value,
  max,
  color
}) {
  let p = max ? Math.min(100, Math.max(0, number(value) / number(max) * 100)) : 0;
  return <div className="progress-track"><span style={{
      width: `${p}%`,
      background: color
    }} /></div>;
}
