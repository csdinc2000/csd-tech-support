import { supabaseAdmin } from './supabase.js';

type BusinessHoursState = 'open' | 'closed' | 'either';

interface BHRow {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  timezone: string;
}

/**
 * Determine whether the business is open right now per business_hours + holidays.
 * Returns 'open' or 'closed'. Defaults to 'open' if no rows exist (fail-open during config).
 */
export async function getCurrentBusinessHoursState(now: Date = new Date()): Promise<BusinessHoursState> {
  // Holiday check first — uses today's local date in the configured timezone
  const { data: hoursRows } = await supabaseAdmin.from('business_hours').select('*');
  const tz = hoursRows?.[0]?.timezone || 'America/New_York';

  const localDateStr = formatInTz(now, tz, { year: 'numeric', month: '2-digit', day: '2-digit' })
    .split('/')
    .join('-'); // mm-dd-yyyy → reorder
  const [mm, dd, yyyy] = localDateStr.split('-');
  const isoDate = `${yyyy}-${mm}-${dd}`;

  const { data: holiday } = await supabaseAdmin
    .from('holidays')
    .select('closed')
    .eq('date', isoDate)
    .maybeSingle();

  if (holiday?.closed) return 'closed';

  if (!hoursRows || hoursRows.length === 0) return 'open';

  // Compute current local day-of-week and HH:MM in the timezone
  const dayName = formatInTz(now, tz, { weekday: 'short' }); // 'Sun', 'Mon', ...
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dayMap[dayName];

  const timeStr = formatInTz(now, tz, { hour: '2-digit', minute: '2-digit', hour12: false });
  // timeStr like "14:32"; en-US sometimes returns "24:32" for midnight — normalize
  const [hStr, mStr] = timeStr.split(':');
  const minutes = parseInt(hStr === '24' ? '00' : hStr, 10) * 60 + parseInt(mStr, 10);

  const todayRow = (hoursRows as BHRow[]).find((r) => r.day_of_week === dow);
  if (!todayRow || !todayRow.open_time || !todayRow.close_time) return 'closed';

  const open = toMinutes(todayRow.open_time);
  const close = toMinutes(todayRow.close_time);

  return minutes >= open && minutes < close ? 'open' : 'closed';
}

function formatInTz(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(date);
}

function toMinutes(t: string): number {
  // 'HH:MM:SS' or 'HH:MM'
  const [h, m] = t.split(':');
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}
