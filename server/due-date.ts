/** Calendar dates shared by the chat agent, task API, and persistent store. */
import { z } from "zod";

export const calendarDate = z.iso.date();
export const chatDueDate = z.union([calendarDate, z.enum(["yesterday", "today", "tomorrow"])]);

const hongKongCalendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Capture the Hong Kong calendar day for a single chat turn. */
export function hongKongDate(instant: Date): string {
  return hongKongCalendar.format(instant);
}

/** Resolve a validated chat date against the Hong Kong day on which the turn began. */
export function resolveDueDate(value: string, today: string): string {
  if (value === "today") return today;
  if (value !== "yesterday" && value !== "tomorrow") return value;

  // Use UTC for arithmetic on the already-local calendar date, independent of host timezone.
  const day = new Date(today + "T00:00:00Z");
  const offset = value === "yesterday" ? -1 : 1;
  day.setUTCDate(day.getUTCDate() + offset);

  return day.toISOString().slice(0, 10);
}
