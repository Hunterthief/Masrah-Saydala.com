// Pure helpers — shared by the browser app, the backend core, and the test suite.
export function formatEGP(piasters) { return (piasters / 100).toFixed(2).replace(/\.00$/, ''); }

export function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'م' : 'ص'}`;
}

export function formatDateAr(isoDate) {
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Cairo',
  }).format(new Date(isoDate + 'T12:00:00+02:00'));
}

export function formatExpiry(epochSeconds) {
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Africa/Cairo',
  }).format(new Date(epochSeconds * 1000));
}

// Accepts Arabic-Indic digits, spaces, dashes, parentheses, leading + or 00.
// Returns digits-only (8–15), Egyptian local 01X… canonicalized to 201X…, or null.
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const latin = raw
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
  let s = latin.replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (/^01[0125]\d{8}$/.test(s)) s = '2' + s;
  return /^\d{8,15}$/.test(s) ? s : null;
}
