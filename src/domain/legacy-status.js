import { localize } from '../i18n.js';

// Preserve the existing status presentation until Phase 2 domain mapping.
export const statusText = localize({
  needs_calibration: 'Perlu pengukuran',
  unavailable: 'Nonaktif',
  requested: 'Permintaan baru',
  planned: 'Terencana',
  in_progress: 'Dalam proses',
  completed: 'Selesai',
  queued: 'Antrean serial',
  loading: 'Muat stockpile',
  in_transit: 'Dalam perjalanan',
  arrived: 'Tiba di jetty',
  unloaded: 'Bongkar selesai',
  returned: 'Kembali / selesai',
  waiting: 'Menunggu sandar',
  closed: 'Ditutup',
  pending: 'Perlu persetujuan',
  approved: 'Disetujui',
  camera_pending: 'Bukti kamera',
  awaiting_configuration: 'Menunggu konfigurasi',
  manual: 'Survei lapangan',
  calibrated_geometry: 'Estimasi geometri',
  available: 'Tersedia',
  idle: 'Idle',
  allocated: 'Dialokasikan · antre',
  busy: 'Operasional berlangsung'
});
