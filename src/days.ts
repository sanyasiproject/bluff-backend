/** today's date in India (UTC+5:30) as YYYY-MM-DD; daily bonuses reset at Indian midnight */
export function istDay(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** start of today in India, on a clock shifted so its UTC fields read as IST */
function istDayStart(now: Date): number {
  return Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS;
}

/** start of this week (Monday) in India, on the same shifted clock */
function istWeekStart(now: Date): number {
  const day = istDayStart(now);
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
}

/** this week's Monday in India as YYYY-MM-DD; weekly missions start again at Monday 00:00 IST */
export function istWeek(now = new Date()): string {
  return new Date(istWeekStart(now)).toISOString().slice(0, 10);
}

/** when the next IST day starts */
export function nextIstDay(now = new Date()): Date {
  return new Date(istDayStart(now) + DAY_MS - IST_OFFSET_MS);
}

/** when the next IST week starts (Monday 00:00 IST) */
export function nextIstWeek(now = new Date()): Date {
  return new Date(istWeekStart(now) + 7 * DAY_MS - IST_OFFSET_MS);
}
