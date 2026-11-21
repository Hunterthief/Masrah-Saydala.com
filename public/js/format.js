// Pure formatting helpers — shared by the browser app and the Node test suite.
export function formatEGP(piasters) { return (piasters / 100).toFixed(2).replace(/\.00$/, ''); }

export function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'م' : 'ص'}`;
}

export function formatDateAr(isoDate) {
  // Noon Africa/Cairo (UTC+2 in December) avoids any date-boundary edge.
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Cairo',
  }).format(new Date(isoDate + 'T12:00:00+02:00'));
}

export function formatExpiry(epochSeconds) {
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Africa/Cairo',
  }).format(new Date(epochSeconds * 1000));
}
