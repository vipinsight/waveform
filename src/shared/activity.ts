/**
 * What the Overview makes of the activity counts: the calendar grid, the
 * monthly bars, milestones, and the fun equivalents. Pure functions over
 * plain data, so they can be tested without a window.
 */

import type { Activity, DayStat, MonthStat } from "./contracts";

/** Word counts worth marking. Each one is roughly double the last. */
export const MILESTONES = [
  1_000, 2_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000,
  5_000_000, 10_000_000,
];

export interface MilestoneProgress {
  /** Milestones already passed, smallest first. */
  reached: number[];
  /** The next one, or null once the last is passed. */
  next: number | null;
  /** The one before `next`, or 0 at the start. */
  previous: number;
  /** How far from `previous` to `next`, 0..1. */
  fraction: number;
  /** Words still to go to `next`; 0 when there is none. */
  remaining: number;
}

export function milestoneProgress(words: number): MilestoneProgress {
  const reached = MILESTONES.filter((m) => words >= m);
  const next = MILESTONES.find((m) => words < m) ?? null;
  const previous = reached[reached.length - 1] ?? 0;
  const fraction = next === null ? 1 : Math.min(1, Math.max(0, (words - previous) / (next - previous)));
  return { reached, next, previous, fraction, remaining: next === null ? 0 : next - words };
}

/** Things a word count can be measured against, smallest first. */
export interface Equivalent {
  /** Singular, with its article: "a page". */
  one: string;
  /** Plural: "pages". */
  many: string;
  words: number;
}

export const EQUIVALENTS: Equivalent[] = [
  { one: "a page", many: "pages", words: 275 },
  { one: "a newspaper article", many: "newspaper articles", words: 800 },
  { one: "a TED talk", many: "TED talks", words: 2_500 },
  { one: "a short story", many: "short stories", words: 7_500 },
  { one: "a movie screenplay", many: "movie screenplays", words: 20_000 },
  { one: "a novella", many: "novellas", words: 40_000 },
  { one: "a season of a TV drama", many: "seasons of a TV drama", words: 80_000 },
  { one: "a novel", many: "novels", words: 90_000 },
  { one: "The Lord of the Rings", many: "copies of The Lord of the Rings", words: 480_000 },
  { one: "War and Peace", many: "copies of War and Peace", words: 587_000 },
  { one: "the Harry Potter series", many: "Harry Potter series", words: 1_084_000 },
  { one: "the Encyclopædia Britannica", many: "Encyclopædia Britannicas", words: 44_000_000 },
];

export interface Insight {
  /** "3.2 novels", "a short story", "41% of a novel". */
  text: string;
  /** True for the line the others are measured around. */
  headline: boolean;
}

/**
 * The equivalents worth saying for a total: the largest unit the words
 * fill at least once as the headline, the one below it for scale, and the
 * one above as a fraction still to fill. With nothing yet, the first page.
 */
export function insights(words: number): Insight[] {
  if (words <= 0) return [{ text: "The first page is 275 words away", headline: true }];
  let index = -1;
  for (let i = 0; i < EQUIVALENTS.length; i += 1) {
    if (words >= (EQUIVALENTS[i]?.words ?? Infinity)) index = i;
  }
  const lines: Insight[] = [];
  const first = EQUIVALENTS[0];
  const unit = EQUIVALENTS[index];
  const below = EQUIVALENTS[index - 1];
  if (index === -1 || !unit || !first) {
    if (!first) return lines;
    lines.push({ text: `${percent(words / first.words)} of ${first.one}`, headline: true });
    return lines;
  }
  lines.push({ text: amount(words, unit), headline: true });
  if (below) lines.push({ text: amount(words, below), headline: false });
  const above = EQUIVALENTS[index + 1];
  if (above) lines.push({ text: `${percent(words / above.words)} of ${above.one}`, headline: false });
  return lines;
}

function amount(words: number, unit: Equivalent): string {
  const count = words / unit.words;
  if (count < 1.05) return unit.one;
  const shown = count >= 10 ? Math.round(count).toLocaleString() : (Math.round(count * 10) / 10).toFixed(1);
  return `${shown} ${unit.many}`;
}

function percent(fraction: number): string {
  return `${Math.max(1, Math.round(fraction * 100))}%`;
}

export interface CalendarCell {
  /** YYYY-MM-DD, local. */
  day: string;
  words: number;
  phrases: number;
  /** 0 for nothing, 1..4 by share of the busiest day shown. */
  level: number;
  /** True for days after today, which are drawn but empty. */
  future: boolean;
  /** True for days before the first one with words: drawn, but kept quiet. */
  before: boolean;
}

export interface CalendarColumn {
  /** Seven cells, Monday first. */
  cells: CalendarCell[];
  /** Short month name when this column starts a new month, else "". */
  monthLabel: string;
}

const WEEK = 7;
/** A year of weeks, as a commit graph draws it. */
export const YEAR_WEEKS = 53;
/** Half a year: what fits beside the months at ordinary window widths. */
export const HALF_YEAR_WEEKS = 26;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthName(index: number): string {
  return MONTHS[index] ?? "";
}

/** Parses YYYY-MM-DD as a local date, never as UTC. */
export function localDate(day: string): Date {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The earliest day with words, or null with none. The list is oldest first, but this does not trust it. */
export function firstDay(days: DayStat[]): string | null {
  let first: string | null = null;
  for (const stat of days) {
    if (stat.words > 0 && (first === null || stat.day < first)) first = stat.day;
  }
  return first;
}

/**
 * `weeks` columns of weeks ending with the week that holds today, Monday at
 * the top, like a commit graph. Intensity is relative to the busiest day in
 * view, so a light week still shows against a heavy year. Days before the
 * first one with words are marked `before`, and months that lie wholly
 * before it carry no label: the grid is drawn, but nothing points at the
 * time before the user started.
 */
export function calendar(today: string, days: DayStat[], weeks = YEAR_WEEKS): CalendarColumn[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const end = localDate(today);
  // Back to the Monday of this week, then the rest of the weeks.
  const weekday = (end.getDay() + 6) % WEEK;
  const start = new Date(end);
  start.setDate(end.getDate() - weekday - (weeks - 1) * WEEK);
  const max = Math.max(0, ...days.map((d) => d.words));
  const began = firstDay(days);
  const columns: CalendarColumn[] = [];
  const cursor = new Date(start);
  let lastMonth = -1;
  /** A month that began before the first word, waiting to be named at it. */
  let pending: string | null = null;
  for (let c = 0; c < weeks; c += 1) {
    const cells: CalendarCell[] = [];
    const firstMonth = cursor.getMonth();
    for (let r = 0; r < WEEK; r += 1) {
      const key = dayKey(cursor);
      const stat = byDay.get(key);
      const words = stat?.words ?? 0;
      cells.push({
        day: key,
        words,
        phrases: stat?.phrases ?? 0,
        level: words === 0 || max === 0 ? 0 : Math.max(1, Math.ceil((words / max) * 4)),
        future: cursor > end,
        before: began !== null && key < began,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    // A label where a month begins, skipping the very first column so the
    // label row does not start with a stub of a month already half gone.
    // A month that began before the first word is named at the column the
    // words start in instead, so a late starter still sees where they are.
    const wholeColumnBefore = cells.every((cell) => cell.before);
    let monthLabel = "";
    if (firstMonth !== lastMonth && c > 0) {
      if (wholeColumnBefore) pending = monthName(firstMonth);
      else monthLabel = monthName(firstMonth);
    } else if (pending !== null && !wholeColumnBefore) {
      monthLabel = pending;
    }
    if (monthLabel) pending = null;
    lastMonth = firstMonth;
    columns.push({ cells, monthLabel });
  }
  return columns;
}

export interface MonthBar {
  /** YYYY-MM. */
  month: string;
  /** "Oct", or "Oct 2025" when the year changes in the run. */
  label: string;
  words: number;
  phrases: number;
  activeDays: number;
  current: boolean;
}

/**
 * The months from the first one with words through this month, quiet
 * months between them included, at most `count` of the most recent. With no
 * words yet, this month alone. Nothing is drawn for the time before the
 * user started.
 */
export function monthBars(today: string, months: MonthStat[], count = 12): MonthBar[] {
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const end = localDate(today);
  const thisMonth = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}`;
  let earliest = thisMonth;
  for (const stat of months) {
    if (stat.words > 0 && stat.month < earliest) earliest = stat.month;
  }
  const [firstYear = end.getFullYear(), firstMonth = end.getMonth() + 1] = earliest.split("-").map(Number);
  const span = (end.getFullYear() - firstYear) * 12 + (end.getMonth() + 1 - firstMonth) + 1;
  const shown = Math.max(1, Math.min(count, span));
  const bars: MonthBar[] = [];
  for (let i = shown - 1; i >= 0; i -= 1) {
    const date = new Date(end.getFullYear(), end.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const stat = byMonth.get(key);
    const label =
      (date.getMonth() === 0 || i === shown - 1) && shown > 1
        ? `${monthName(date.getMonth())} ${date.getFullYear()}`
        : monthName(date.getMonth());
    bars.push({
      month: key,
      label,
      words: stat?.words ?? 0,
      phrases: stat?.phrases ?? 0,
      activeDays: stat?.activeDays ?? 0,
      current: i === 0,
    });
  }
  return bars;
}

/**
 * This month against last, as a percentage: positive is up, negative is
 * down, zero is level. Null when there is no last month to compare with,
 * or last month had nothing (a share of nothing is not a number).
 */
export function monthDelta(bars: MonthBar[]): number | null {
  if (bars.length < 2) return null;
  const now = bars[bars.length - 1]?.words ?? 0;
  const before = bars[bars.length - 2]?.words ?? 0;
  if (before === 0) return null;
  return Math.round(((now - before) / before) * 100);
}

/** "Up 40% on last month", "Down 12% on last month", "Same as last month", "Back after a quiet month", or "". */
export function monthChange(bars: MonthBar[]): string {
  const delta = monthDelta(bars);
  if (delta === null) {
    if (bars.length < 2) return "";
    const now = bars[bars.length - 1]?.words ?? 0;
    return now > 0 ? "Back after a quiet month" : "";
  }
  if (delta === 0) return "Same as last month";
  return delta > 0 ? `Up ${delta}% on last month` : `Down ${Math.abs(delta)}% on last month`;
}

/** A line for the streak header. */
export function streakLine(activity: Activity): string {
  const { currentStreak, longestStreak } = activity;
  if (currentStreak === 0) return longestStreak > 0 ? `Longest streak ${longestStreak} days` : "No streak yet";
  const current = `${currentStreak}-day streak`;
  return currentStreak >= longestStreak ? `${current}, your longest` : `${current} · longest ${longestStreak}`;
}
