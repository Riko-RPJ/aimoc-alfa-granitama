import { tr, locale, localize } from '../../i18n.js';

export const fmt = (v, d = 0) => new Intl.NumberFormat(locale(), {
  maximumFractionDigits: d,
  minimumFractionDigits: 0
}).format(Number(v) || 0);
export const stamp = v => v ? new Date(v).toLocaleString(locale(), {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit'
}) : '—';
export const minute = v => v ? new Date(v).toLocaleTimeString(locale(), {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
}) : tr("Belum tersinkron");
export const number = v => Number(v) || 0;
export const arr = (s, key) => Array.isArray(s?.[key]) ? s[key] : [];
export const sum = (xs, key) => xs.reduce((v, x) => v + number(typeof key === 'function' ? key(x) : x[key]), 0);
export const lookup = (xs, id) => xs.find(x => x.id === id);
export const roleName = localize({
  admin: 'Administrator',
  stock: 'Operator stockpile',
  jetty: 'Operator jetty'
});
