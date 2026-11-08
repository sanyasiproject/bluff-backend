/** today's date in India (UTC+5:30) as YYYY-MM-DD; daily bonuses reset at Indian midnight */
export function istDay(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
