// Pure WhatsApp handoff helpers — shared by the browser app and the test suite.
import { formatEGP, formatTime } from './format.js';

export function buildWhatsAppMessage({ event, performance, reservation, customerName }) {
  const lines = [
    `مرحبًا، أريد تأكيد حجز عرض «${event.name}»`,
    customerName ? `الاسم: ${customerName}` : null,
    `العرض: ${performance.id} — ${performance.name}`,
    `فتح الأبواب: ${formatTime(performance.doors_open)} — بداية العرض: ${formatTime(performance.starts_at)}`,
    `عدد التذاكر: ${reservation.quantity}`,
    `رقم الحجز: ${reservation.reference}`,
    'أرقام التذاكر المبدئية:',
    ...reservation.ticket_numbers,
    `المبلغ: ${formatEGP(reservation.total_piasters)} ج.م (تحويل إنستاباي)`,
    'سأرفق صورة الدفع في هذه المحادثة. من فضلكم راجعوا التحويل وأكدوا الحجز.',
  ].filter(Boolean);
  return lines.join('\n');
}

export function buildWhatsAppUrl(number, message) {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
