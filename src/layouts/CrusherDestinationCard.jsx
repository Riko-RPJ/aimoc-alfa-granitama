import React from 'react';
import {Factory,MapPin,Navigation,ShieldAlert,Route,MapPinned,Info} from 'lucide-react';

/**
 * Read-only assignment map. Never runs directions, GPS geofencing or basemap
 * coordinates unless both physical location and internal road network are
 * independently VERIFIED. No routing service is configured in this phase.
 */
export function CrusherDestinationCard({trip,simulated=false}){
 const dest=trip?.crusherDestination||null;
 if(!dest?.crusherId)return <section className="crusher-destination-card" aria-label="Lokasi crusher">
  <div className="driver-card-top"><div><span className="driver-card-eyebrow">CRUSHER LOCATION</span><h3>Lokasi crusher tujuan</h3></div><MapPin size={20}/></div>
  <div className="crusher-location-empty compact"><MapPin size={27}/><strong>Tujuan crusher belum ditetapkan</strong>
   <p>Assignment ini belum memiliki Crusher ID dan Loading Point yang terverifikasi. Hubungi Admin Dispatch.</p></div>
 </section>;
 const point=dest.loadingPoint;
 const verified=dest.verified===true && Number.isFinite(dest.latitude)&&Number.isFinite(dest.longitude);
 // Even when coordinates become verified, road network is not, so live routing stays disabled.
 const routeReady=false;
 return <section className="crusher-destination-card" aria-label="Lokasi crusher sesuai assignment">
  <div className="driver-card-top"><div><span className="driver-card-eyebrow">CRUSHER LOCATION · ASSIGNED</span>
    <h3>Crusher tujuan</h3></div><span className="crusher-location-status">{simulated?'UAT ONLY':'READ ONLY'}</span></div>
  <div className="crusher-destination-identity">
   <div className="crusher-location-icon"><Factory size={24}/></div>
   <div><b>{dest.name||dest.crusherId}</b><span>{dest.zone||'Zona belum tersedia'} · {point?.name||'Loading point belum ditetapkan'}</span>
    <small>Crusher ID: {dest.crusherId} · Loading Point: {point?.id||'—'}</small></div>
  </div>
  <div className="crusher-map-preview" role="img" aria-label={simulated?
     'Peta skematik UAT tanpa koordinat aktual dan tanpa routing':
     'Peta belum dapat ditampilkan karena titik dan jalan internal belum diverifikasi'}>
   {simulated?<svg viewBox="0 0 320 164" width="100%" height="164" aria-hidden="true">
    <rect width="320" height="164" fill="#153440"/>
    <path d="M12 126 Q58 100 93 121 T163 98 T249 67 T309 41" stroke="#46616C" strokeWidth="13" fill="none" strokeLinecap="round"/>
    <path d="M12 126 Q58 100 93 121 T163 98 T249 67 T309 41" stroke="#789099" strokeWidth="1.5" fill="none" strokeDasharray="5 7"/>
    <circle cx="245" cy="67" r="12" fill="#19B8A5" opacity=".18"/>
    <circle cx="245" cy="67" r="7" fill="#19B8A5" stroke="#F2FFFF" strokeWidth="2"/>
    <rect x="166" y="17" rx="7" width="140" height="25" fill="#086C6B"/>
    <text x="236" y="34" fill="white" fontSize="10" textAnchor="middle">{point?.id||'Loading Point UAT'}</text>
    <rect x="10" y="10" rx="6" width="128" height="22" fill="#274956"/>
    <text x="74" y="25" fill="#E4FAF8" fontSize="10" textAnchor="middle">UAT SCHEMATIC · NOT GPS</text>
    <circle cx="42" cy="121" r="6" fill="#7EA1B5"/>
    <text x="15" y="148" fill="#C4D5DF" fontSize="10">Contoh jalur, bukan rute sah</text>
   </svg>:
   <div className="crusher-map-unknown"><MapPinned size={32}/><strong>Map data belum terverifikasi</strong>
    <span>Koordinat dan road network kawasan harus diperiksa sebelum peta lokasi dapat digunakan.</span></div>}
  </div>
  <div className="crusher-destination-notes"><ShieldAlert size={17}/>
    <span>{simulated?'Marker dan jalur hanya ilustrasi UAT; tidak menunjukkan lokasi kawasan sebenarnya.':
     verified?'Titik GPS tercatat, tetapi jaringan jalan belum diverifikasi. Routing tetap nonaktif.':
     'Loading Point belum memiliki lokasi GPS yang terverifikasi. Tidak ada rute atau ETA yang dibuat otomatis.'}</span></div>
  {dest.accessNotes&&<p className="driver-muted driver-small">Catatan akses: {dest.accessNotes}</p>}
  <button className="driver-btn primary" type="button" disabled={!routeReady} aria-label="Navigasi belum tersedia">
    <Navigation size={16}/> Start Navigation · Belum tersedia
  </button>
  <p className="driver-subnote">Navigasi akan diaktifkan setelah koordinat, jaringan jalan internal, dan akses truck mendapat persetujuan operasional.</p>
 </section>;
}
