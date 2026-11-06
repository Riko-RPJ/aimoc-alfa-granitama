import React, { useState, useEffect, useMemo, useRef } from 'react';
import { tr, localize, locale, useLanguage, setLanguage, eventText, eventTypeLabel } from '../../i18n.js';
import { statusText } from '../../domain/legacy-status.js';
import { api } from '../../services/legacy-api.js';
import { Activity, Check, Factory, Ship, Truck } from 'lucide-react';
import { fmt, stamp, number, sum } from '../shared/legacy-utils.js';
import { Empty } from '../../components/ui/index.jsx';

export function FlowMap({
  crushers,
  stockpiles,
  activeTrips,
  vessels,
  jetties
}) {
  return <div className="flow-map"><div className="flow-map-nodes source">{crushers.slice(0, 3).map((c, i) => <div className="flow-node" key={c.id}><span className="node-icon"><Factory size={24} /></span><div><b>{c.name}</b><small>{fmt(sum(stockpiles.filter(s => s.crusherId === c.id), "onHandM3"))}{tr(" m³ tercatat")}</small></div><span className="node-status" /></div>)}</div><div className="flow-map-path"><div className="flow-line" /><div className="flow-truck"><Truck size={24} /></div><span>{activeTrips.length}{tr(" ritase aktif")}</span><small>{tr("Penugasan serial")}</small><div className="flow-line right" /></div><div className="flow-map-nodes dest">{jetties.slice(0, 3).map(j => <div className="flow-node" key={j.id}><span className="node-icon blue"><Ship size={25} /></span><div><b>{j.name}</b><small>{vessels.filter(v => v.jettyId === j.id && v.status !== 'closed').length}{tr(" kapal loading / menunggu")}</small></div></div>)}</div></div>;
}

export function VesselMini({
  v,
  jetty
}) {
  return <div className="vessel-mini"><div className="vessel-mini-top"><span className="mini-ship"><Ship size={19} /></span><div><b>{v.name}</b><small>{jetty?.name} · {v.status === 'loading' ? tr("Sedang loading") : statusText[v.status] || v.status}</small></div><strong>{fmt(number(v.loadedT) + number(v.reservedT))}<small> / {fmt(v.payloadLimitT)}{tr(" t")}</small></strong></div><div className="vessel-capacity-track"><span style={{
        width: `${Math.min(100, number(v.loadedT) / number(v.payloadLimitT) * 100)}%`
      }} /><i style={{
        width: `${Math.min(100, number(v.reservedT) / number(v.payloadLimitT) * 100)}%`
      }} /></div><div className="vessel-mini-foot"><span>{fmt(v.loadedT)}{tr(" t muat")}</span><span>{fmt(v.reservedT)}{tr(" t reservasi")}</span></div></div>;
}

export function EventList({
  events,
  full = false
}) {
  return events.length ? <div className={`events ${full ? 'full' : ''}`}>{events.map((e, i) => <div className="event" key={e.id || i}><span className="event-mark"><Check size={12} /></span><div><strong>{eventText(e)}</strong><small>{e.actorName || e.actor?.name || e.userName || e.actorId || tr("Pengguna")} {e.reference && <>· {e.reference}</>}</small></div><time>{stamp(e.createdAt || e.timestamp || e.at)}</time></div>)}</div> : <Empty icon={Activity} title={tr("Belum ada aksi operasional")} text={tr("Aksi operator dan Admin akan tercatat setelah disimpan.")} />;
}
