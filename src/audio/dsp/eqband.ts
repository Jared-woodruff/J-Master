// One band of the advanced EQ as a filter. The chain and the drawer's
// response curve both tune their biquads here, so what is drawn is what
// is heard.
import { Biquad } from './biquad';
import type { AdvEqBand } from './params';

export function tuneBand(bq: Biquad, fs: number, band: AdvEqBand): void {
  const f = Math.max(10, Math.min(fs * 0.45, band.freq));
  switch (band.type) {
    case 'lowshelf': bq.setLowShelf(fs, f, band.gainDb, 0.9); break;
    case 'highshelf': bq.setHighShelf(fs, f, band.gainDb, 0.9); break;
    case 'highpass': bq.setHighpass(fs, f, Math.SQRT1_2); break;
    case 'lowpass': bq.setLowpass(fs, f, Math.SQRT1_2); break;
    default: bq.setPeaking(fs, f, band.gainDb, band.q);
  }
}

/** The filter's gain at `freq`, in dB. */
export function biquadDb(bq: Biquad, fs: number, freq: number): number {
  const w = (2 * Math.PI * freq) / fs;
  const cw = Math.cos(w), sw = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = bq.b0 + bq.b1 * cw + bq.b2 * c2;
  const ni = -(bq.b1 * sw + bq.b2 * s2);
  const dr = 1 + bq.a1 * cw + bq.a2 * c2;
  const di = -(bq.a1 * sw + bq.a2 * s2);
  return 10 * Math.log10(Math.max((nr * nr + ni * ni) / (dr * dr + di * di), 1e-12));
}
