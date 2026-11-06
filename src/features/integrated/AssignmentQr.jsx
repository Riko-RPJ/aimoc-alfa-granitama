import React,{useMemo} from 'react';
import {useLanguage} from '../../i18n.js';
import {buildAssignmentQr} from './assignment-qr.mjs';

/** A readable reference QR, not an authorization or scan command. */
export function AssignmentQr({value,label}) {
  const language = useLanguage();
  const L = (id,en) => language === 'en' ? en : id;
  const caption = typeof label === 'string' && label.trim() ? label : L('QR referensi penugasan','Assignment reference QR');
  const qr = useMemo(() => buildAssignmentQr(value), [value]);
  const unavailable = qr.reason === 'TOO_LONG'
    ? L('Referensi QR terlalu panjang.','The QR reference is too long.')
    : qr.reason === 'INVALID'
      ? L('Referensi QR tidak valid.','The QR reference is invalid.')
      : L('QR belum tersedia.','QR is unavailable.');
  if (!qr.ok) return <div className="assignment-qr assignment-qr-unavailable" role="status" aria-label={`${caption}: ${unavailable}`}>
    <strong>{caption}</strong><p>{unavailable}</p>
  </div>;
  return <figure className="assignment-qr" style={{margin:0}}>
    <svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label={caption} viewBox={`0 0 ${qr.size} ${qr.size}`}
      width={qr.size*4} height={qr.size*4} shapeRendering="crispEdges"
      data-quiet-zone={qr.quietZone} data-error-correction={qr.errorCorrection}
      style={{display:'block',maxWidth:'100%',height:'auto',background:'#fff'}}>
      <title>{caption}</title>
      <rect width={qr.size} height={qr.size} fill="#fff"/>
      <path d={qr.path} fill="#000"/>
    </svg>
    <figcaption><strong>{caption}</strong><small style={{display:'block'}}>{L('Referensi penugasan · tidak memberi otorisasi','Assignment reference · grants no authorization')}</small></figcaption>
  </figure>;
}
