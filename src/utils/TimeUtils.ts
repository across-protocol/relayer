/**
 * Determines if the current time is a weekday.
 * A weekday is defined as any time OUTSIDE of Friday midnight EST to Sunday midnight EST.
 * In other words:
 * - Weekend (not weekday): Friday 00:00 EST through Sunday 23:59:59 EST
 * - Weekday: Monday 00:00 EST through Thursday 23:59:59 EST
 *
 * @param now - Optional Date object for testing. Defaults to current time.
 * @returns true if it's currently a weekday, false if it's a weekend.
 */
export function isWeekday(now: Date = new Date()): boolean {
  // Convert the current time to EST/EDT (America/New_York handles DST automatically)
  const estTimeString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const estDate = new Date(estTimeString);

  // getDay() returns 0 for Sunday, 1 for Monday, ..., 5 for Friday, 6 for Saturday
  const dayOfWeek = estDate.getDay();

  // Weekend is Friday (5), Saturday (6), Sunday (0)
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 5 || dayOfWeek === 6;

  return !isWeekend;
}
