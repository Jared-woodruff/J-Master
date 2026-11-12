// Loudness and peak readouts that stay honest at the bottom of the scale:
// silence has no integrated loudness (every block falls under the −70 LUFS
// gate) and no peak, so it reads as such instead of as the analysis floor.

/** "−14.2 LUFS", or "< −70 LUFS" when nothing clears the absolute gate. */
export function lufsText(lufs: number, digits = 1): string {
  return Number.isFinite(lufs) && lufs > -70 ? `${lufs.toFixed(digits)} LUFS` : '< −70 LUFS';
}

/** "−1.0 dBTP", or "−∞ dBTP" for digital silence. */
export function dbtpText(db: number, digits = 1): string {
  return Number.isFinite(db) && db > -150 ? `${db.toFixed(digits)} dBTP` : '−∞ dBTP';
}
