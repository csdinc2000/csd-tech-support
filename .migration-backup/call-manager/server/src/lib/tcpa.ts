/**
 * TCPA / outbound-calling-hours helpers.
 *
 * Federal TCPA rule: telemarketing calls allowed only between 8am and 9pm
 * local time of the called party. We use the configured per-campaign window
 * (default 9am–8pm — stricter than TCPA) and the called number's local time
 * zone.
 *
 * Time-zone resolution uses a NANP NPA (area code) → IANA tz mapping. This is
 * approximate (some area codes overlap multiple time zones) but is the
 * standard industry approach for outbound dialer compliance and is far better
 * than guessing a single zone.
 */

const NPA_TZ: Record<string, string> = {
  // Eastern
  '202': 'America/New_York', '203': 'America/New_York', '212': 'America/New_York',
  '215': 'America/New_York', '216': 'America/New_York', '267': 'America/New_York',
  '301': 'America/New_York', '302': 'America/New_York', '305': 'America/New_York',
  '321': 'America/New_York', '347': 'America/New_York', '352': 'America/New_York',
  '386': 'America/New_York', '404': 'America/New_York', '407': 'America/New_York',
  '410': 'America/New_York', '470': 'America/New_York', '484': 'America/New_York',
  '561': 'America/New_York', '571': 'America/New_York', '585': 'America/New_York',
  '603': 'America/New_York', '607': 'America/New_York', '610': 'America/New_York',
  '631': 'America/New_York', '646': 'America/New_York', '703': 'America/New_York',
  '704': 'America/New_York', '716': 'America/New_York', '718': 'America/New_York',
  '727': 'America/New_York', '732': 'America/New_York', '754': 'America/New_York',
  '772': 'America/New_York', '786': 'America/New_York', '813': 'America/New_York',
  '843': 'America/New_York', '850': 'America/New_York', '856': 'America/New_York',
  '860': 'America/New_York', '904': 'America/New_York', '917': 'America/New_York',
  '919': 'America/New_York', '929': 'America/New_York', '941': 'America/New_York',
  '954': 'America/New_York', '973': 'America/New_York',
  // Central
  '210': 'America/Chicago', '214': 'America/Chicago', '217': 'America/Chicago',
  '224': 'America/Chicago', '225': 'America/Chicago', '254': 'America/Chicago',
  '281': 'America/Chicago', '309': 'America/Chicago', '312': 'America/Chicago',
  '314': 'America/Chicago', '316': 'America/Chicago', '318': 'America/Chicago',
  '319': 'America/Chicago', '331': 'America/Chicago', '402': 'America/Chicago',
  '405': 'America/Chicago', '414': 'America/Chicago', '417': 'America/Chicago',
  '432': 'America/Chicago', '469': 'America/Chicago', '479': 'America/Chicago',
  '501': 'America/Chicago', '504': 'America/Chicago', '512': 'America/Chicago',
  '515': 'America/Chicago', '563': 'America/Chicago', '601': 'America/Chicago',
  '618': 'America/Chicago', '630': 'America/Chicago', '636': 'America/Chicago',
  '651': 'America/Chicago', '660': 'America/Chicago', '662': 'America/Chicago',
  '682': 'America/Chicago', '708': 'America/Chicago', '713': 'America/Chicago',
  '763': 'America/Chicago', '773': 'America/Chicago', '779': 'America/Chicago',
  '800': 'America/Chicago', '816': 'America/Chicago', '817': 'America/Chicago',
  '830': 'America/Chicago', '832': 'America/Chicago', '847': 'America/Chicago',
  '870': 'America/Chicago', '901': 'America/Chicago', '903': 'America/Chicago',
  '913': 'America/Chicago', '915': 'America/Chicago', '918': 'America/Chicago',
  '920': 'America/Chicago', '936': 'America/Chicago', '952': 'America/Chicago',
  '956': 'America/Chicago', '972': 'America/Chicago',
  // Mountain
  '303': 'America/Denver', '385': 'America/Denver', '435': 'America/Denver',
  '505': 'America/Denver', '575': 'America/Denver', '719': 'America/Denver',
  '720': 'America/Denver', '801': 'America/Denver', '970': 'America/Denver',
  // Mountain (Arizona — no DST)
  '480': 'America/Phoenix', '520': 'America/Phoenix', '602': 'America/Phoenix',
  '623': 'America/Phoenix', '928': 'America/Phoenix',
  // Pacific
  '206': 'America/Los_Angeles', '209': 'America/Los_Angeles',
  '213': 'America/Los_Angeles', '253': 'America/Los_Angeles',
  '310': 'America/Los_Angeles', '323': 'America/Los_Angeles',
  '360': 'America/Los_Angeles', '408': 'America/Los_Angeles',
  '415': 'America/Los_Angeles', '424': 'America/Los_Angeles',
  '425': 'America/Los_Angeles', '442': 'America/Los_Angeles',
  '503': 'America/Los_Angeles', '510': 'America/Los_Angeles',
  '530': 'America/Los_Angeles', '541': 'America/Los_Angeles',
  '559': 'America/Los_Angeles', '562': 'America/Los_Angeles',
  '619': 'America/Los_Angeles', '626': 'America/Los_Angeles',
  '650': 'America/Los_Angeles', '661': 'America/Los_Angeles',
  '669': 'America/Los_Angeles', '702': 'America/Los_Angeles',
  '707': 'America/Los_Angeles', '714': 'America/Los_Angeles',
  '725': 'America/Los_Angeles', '747': 'America/Los_Angeles',
  '760': 'America/Los_Angeles', '775': 'America/Los_Angeles',
  '805': 'America/Los_Angeles', '818': 'America/Los_Angeles',
  '858': 'America/Los_Angeles', '909': 'America/Los_Angeles',
  '916': 'America/Los_Angeles', '925': 'America/Los_Angeles',
  '949': 'America/Los_Angeles', '951': 'America/Los_Angeles',
  // Alaska / Hawaii
  '907': 'America/Anchorage',
  '808': 'Pacific/Honolulu',
};

const FALLBACK_TZ = 'America/New_York';

/** Strip non-digits and grab the NANP NPA (3 digits after the leading 1, if present). */
export function extractNpa(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1, 4);
  if (digits.length === 10) return digits.slice(0, 3);
  return null;
}

export function tzForPhone(phone: string): string {
  const npa = extractNpa(phone);
  return (npa && NPA_TZ[npa]) ?? FALLBACK_TZ;
}

/** Returns "HH:MM" in the called party's local time. */
export function localHHMM(phone: string, now: Date = new Date()): string {
  const tz = tzForPhone(phone);
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const parts = f.formatToParts(now);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h === '24' ? '00' : h}:${m}`;
}

/**
 * Returns true iff the called party's current local time is within BOTH:
 *   1. the campaign's [windowStart, windowEnd) and
 *   2. the federal TCPA hard window of [08:00, 21:00).
 *
 * windowStart / windowEnd are "HH:MM" strings.
 */
export function isWithinAllowedWindow(
  phone: string,
  windowStart: string,
  windowEnd: string,
  now: Date = new Date(),
): boolean {
  const cur = localHHMM(phone, now);
  const inRange = (start: string, end: string) => cur >= start && cur < end;
  // TCPA federal hard limit
  if (!inRange('08:00', '21:00')) return false;
  // Operator window (must be a strict subset, but we still enforce it)
  return inRange(windowStart.slice(0, 5), windowEnd.slice(0, 5));
}
