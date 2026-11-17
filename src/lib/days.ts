/** Number of weekdays set in an availableDays mask (bit0 = Saturday). */
export function countDays(mask: number): number {
  let n = 0;
  for (let bit = 0; bit < 7; bit++) if (mask & (1 << bit)) n++;
  return n;
}
export const DAYS_PER_WEEK_MESSAGE = "daysPerWeek cannot be more than the number of available days";
/** True when a days-per-week count fits the available days. Null count always fits. */
export function daysPerWeekFits(
  daysPerWeek: number | null | undefined,
  availableDays: number,
): boolean {
  return daysPerWeek == null || daysPerWeek <= countDays(availableDays);
}
