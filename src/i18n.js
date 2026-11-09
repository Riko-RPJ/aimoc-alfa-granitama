import {useSyncExternalStore} from 'react';
import english from './locales/en.json';

export const LANGUAGE_KEY='aimoc.alfa.language';
const allowed=new Set(['id','en']);
const readLanguage=()=>{try{const value=globalThis.localStorage?.getItem(LANGUAGE_KEY);return allowed.has(value)?value:'id';}catch{return 'id';}};
let language=readLanguage();
const listeners=new Set();
const subscribe=callback=>{listeners.add(callback);return()=>listeners.delete(callback);};
export const getLanguage=()=>language;
export const locale=()=>language==='en'?'en-GB':'id-ID';
export function tr(source,...values){
 if(typeof source!=='string')return source;
 const key=source.trim().replace(/\s+/g,' ');
 const translated=language==='en'?(english[key]||key):key;
 const result=translated.replace(/\{(\d+)\}/g,(_,i)=>values[Number(i)]??`{${i}}`);
 const before=source.match(/^\s*/)?.[0]||'',after=source.match(/\s*$/)?.[0]||'';
 return before+result+after;
}
export function localize(value){
 if(!value||typeof value!=='object'||value.$$typeof)return value;
 return new Proxy(value,{get(target,key,receiver){const item=Reflect.get(target,key,receiver);return typeof item==='string'?tr(item):item&&typeof item==='object'&&!item.$$typeof?localize(item):item;}});
}
function applyDocumentLanguage(){
 if(typeof document==='undefined')return;
 const quarry=import.meta.env.VITE_APP_VARIANT==='quarry-cilegon'||globalThis.location?.pathname?.startsWith('/quarry-cilegon');
 document.documentElement.lang=language;
 document.title='AIMOC | Integrated Operations Management';
 const description=document.querySelector('meta[name="description"]');
 if(description)description.content=quarry?(language==='en'?'AIMOC Quarry Cilegon — shared stock inventory, serial dispatch trips, bidirectional weighbridges, QR return gates and jetty receiving.':'AIMOC Quarry Cilegon — stok bersama, ritase dispatch serial, jembatan timbang dua arah, jalur kembali QR dan penerimaan jetty.'):(language==='en'?'AIMOC Gandasari Alfa Granitama — crusher inventory, fleet dispatch and jetty receiving operations.':'AIMOC Gandasari Alfa Granitama — aplikasi operasi stok crusher, dispatch armada dan penerimaan jetty.');
}
export function setLanguage(next){
 if(!allowed.has(next)||next===language)return;
 language=next;try{globalThis.localStorage?.setItem(LANGUAGE_KEY,next);}catch{}
 applyDocumentLanguage();for(const notify of listeners)notify();
}
export function useLanguage(){return useSyncExternalStore(subscribe,getLanguage,()=> 'id');}
if(typeof window!=='undefined'){
 applyDocumentLanguage();
 window.addEventListener('storage',event=>{if(event.key===LANGUAGE_KEY){const next=allowed.has(event.newValue)?event.newValue:'id';if(next!==language){language=next;applyDocumentLanguage();for(const notify of listeners)notify();}}});
}

const eventLabels={
 'master.saved':'Master data diperbarui','request.created':'Permintaan transfer dibuat','request.planned':'Alokasi dispatch dibuat',
 'trip.start':'Pemuatan stockpile dimulai','trip.depart':'Truk berangkat','trip.arrive':'Truk tiba di jetty','trip.unload':'Bongkar ke kapal dikonfirmasi','trip.return':'Truk kembali',
 'measurement.created':'Pengukuran stockpile dicatat','measurement.approved':'Pengukuran stockpile disetujui',
 stock_transfer_departed:'Transfer stok berangkat',stock_transfer_received:'Transfer stok diterima',inventory_measurement_approved:'Pengukuran inventory disetujui',
 transfer_departed:'Material keluar stockpile',vessel_received:'Material diterima kapal',measurement_adjustment:'Penyesuaian stok hasil pengukuran'
};
export const eventTypeLabel=type=>tr(eventLabels[type]||type);
export function eventText(event){
 if(language==='id')return event.message||event.description||event.action||event.type||tr('Perubahan operasional');
 const reference=/^(TR|RIT|MSR|DSP)-\d+/.exec(event.description||'')?.[0];
 return (reference?reference+' · ':'')+eventTypeLabel(event.type||event.action||'Perubahan operasional');
}
const errorLabels={
 DESTINATION_LOCATION_REQUIRED:'Pilih lokasi stockpile tujuan dari Master Data.',DESTINATION_LOCATION_NOT_FOUND:'Lokasi tujuan tidak ditemukan atau tidak aktif.',DESTINATION_MODE_INVALID:'Lokasi tujuan tidak mendukung moda pengiriman ini.',
 DESTINATION_LOCATION_AMBIGUOUS:'Pilih lokasi stockpile tujuan secara eksplisit karena area penerima memiliki beberapa lokasi.',INACTIVE_DESTINATION:'Tujuan pengiriman tidak aktif. Pilih lokasi, area, jetty, atau kapal yang aktif.',
 RECEIVING_AREA_REQUIRED:'Lokasi LAND memerlukan area stok penerima yang aktif.',DESTINATION_STOCKPILE_REQUIRED:'Area tujuan belum memiliki stockpile aktif untuk SKU yang dipilih.',
 OPEN_LOCATION_REFERENCE:'Lokasi masih dipakai permintaan atau ritase terbuka. Selesaikan pekerjaan sebelum mengubah pemetaan, moda, atau status aktif.',LOCATION_IN_USE:'Lokasi memiliki riwayat transaksi dan tidak dapat dihapus. Gunakan status nonaktif setelah pekerjaan selesai.',
 RECEIVING_LOCATION_IN_USE:'Area stok masih dipetakan pada Master Lokasi Stockpile. Perbarui pemetaan terlebih dahulu.',STOCKPILE_LOCATION_INVALID:'Periksa kode, nama, moda pengiriman, dan area penerima lokasi stockpile.',STOCKPILE_LOCATIONS_STATE_INVALID:'Master lokasi tersimpan perlu diperiksa oleh Admin.',
 AUTH_REQUIRED:'Silakan login untuk mengakses aplikasi.',INVALID_LOGIN:'Username atau password tidak sesuai.',TOO_MANY_ATTEMPTS:'Terlalu banyak percobaan. Coba lagi dalam 15 menit.',
 CSRF_REJECTED:'Sesi berubah. Muat ulang halaman.',ORIGIN_REJECTED:'Permintaan harus berasal dari aplikasi ini.',DATABASE_UNAVAILABLE:'Penyimpanan tidak tersedia.',
 REVISION_CONFLICT:'Data diperbarui operator lain. Muat ulang sebelum menyimpan.',IDEMPOTENCY_CONFLICT:'ID aksi sudah dipakai untuk permintaan lain.',
 FORBIDDEN:'Akun tidak ditugaskan untuk lokasi ini.',ROLE_REQUIRED:'Hanya Admin AIMOC.',NO_TRUCKS:'Tidak ada truk aktif.',TRUCK_BUSY:'Truk masih menjalankan ritase lain.',QUEUE_ORDER:'Selesaikan antrean truk sesuai urutan serial.',
 VESSEL_CAPACITY:'Sisa kapasitas kapal tidak mencukupi termasuk reservasi berjalan.',INSUFFICIENT_STOCK:'Stok SKU yang diminta tidak mencukupi.',ALREADY_PLANNED:'Permintaan sudah direncanakan.',
 INVALID_TRANSITION:'Status ritase sudah berubah. Periksa status terkini sebelum mengonfirmasi.',DESTINATION_MISMATCH:'Tujuan jetty/kapal atau SKU tidak sesuai dispatch.',STOCK_CONFLICT:'Saldo stok/reservasi tidak mencukupi.',
 VESSEL_NOT_LOADING:'Kapal belum aktif loading. Admin harus membuka status loading.',STALE_MEASUREMENT:'Stok sudah bergerak setelah pengukuran. Buat pengukuran baru agar saldo tidak menimpa transaksi.',
 RESERVED_STOCK:'Volume pengukuran lebih kecil dari reservasi aktif.',WEIGHT_RECONCILIATION:'Netto timbang harus sesuai kuantitas reservasi. Selisih memerlukan rekonsiliasi Admin.',
 OPEN_WORK:'Data master masih memiliki pekerjaan yang belum selesai.',INVALID_MEASUREMENT:'Pengukuran belum terkalibrasi atau sudah diproses.',
 EVIDENCE_ACCESS:'Bukti pengukuran tidak dapat diakses.',EVIDENCE_REQUIRED:'Unggah foto sebelum menyimpan bukti kamera.',EVIDENCE_QUOTA:'Penyimpanan foto prototipe penuh. Hubungi Admin.',
 IMAGE_SIZE:'Foto maksimal 2 MiB.',IMAGE_REQUIRED:'Gunakan foto JPEG atau PNG.',INVALID_IMAGE:'Isi foto tidak sesuai format.',INVALID_PASSWORD:'Password minimal 12 karakter.',USER_SCOPE:'Tentukan lokasi operator.',
 DUPLICATE:'Kode atau username sudah terdaftar.',VALIDATION:'Data tidak valid. Periksa kembali isian dan batas operasional.',NOT_FOUND:'Data tidak ditemukan.'
};
export function apiErrorSource(data){
 const code=typeof data?.error==='string'?data.error:data?.error?.code;
 const source=data?.message||data?.error?.message;
 // Keep known source messages as source text: switching language also updates an already visible error.
 return typeof source==='string'&&english[source.trim()]?source:(errorLabels[code]||source||'Permintaan gagal.');
}
