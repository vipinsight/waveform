import { describe, expect, it } from "vitest";
import {
  HALF_YEAR_WEEKS,
  calendar,
  dayKey,
  firstDay,
  insights,
  localDate,
  milestoneProgress,
  monthBars,
  monthChange,
  monthDelta,
  streakLine,
} from "../src/shared/activity";
import type { Activity } from "../src/shared/contracts";

describe("milestoneProgress", () => {
  it("starts with nothing reached and the first thousand ahead", () => {
    const progress = milestoneProgress(0);
    expect(progress.reached).toEqual([]);
    expect(progress.next).toBe(1_000);
    expect(progress.previous).toBe(0);
    expect(progress.fraction).toBe(0);
    expect(progress.remaining).toBe(1_000);
  });

  it("measures the stretch between the last milestone and the next", () => {
    const progress = milestoneProgress(7_500);
    expect(progress.reached).toEqual([1_000, 2_000, 5_000]);
    expect(progress.next).toBe(10_000);
    expect(progress.previous).toBe(5_000);
    expect(progress.fraction).toBeCloseTo(0.5);
    expect(progress.remaining).toBe(2_500);
  });

  it("is complete past the last milestone", () => {
    const progress = milestoneProgress(20_000_000);
    expect(progress.next).toBeNull();
    expect(progress.fraction).toBe(1);
    expect(progress.remaining).toBe(0);
  });
});

describe("insights", () => {
  it("points at the first page before any words", () => {
    expect(insights(0)[0]?.text).toMatch(/first page/);
  });

  it("gives a share of a page under one page", () => {
    expect(insights(55)[0]?.text).toBe("20% of a page");
  });

  it("names the largest unit filled, the one below, and the share of the next", () => {
    const lines = insights(10_000);
    expect(lines[0]).toEqual({ text: "1.3 short stories", headline: true });
    expect(lines[1]?.text).toBe("4.0 TED talks");
    expect(lines[2]?.text).toBe("50% of a movie screenplay");
  });

  it("says one of a thing when it is about one", () => {
    expect(insights(90_500)[0]?.text).toBe("a novel");
  });

  it("rounds big counts to whole numbers", () => {
    expect(insights(1_000_000)[1]?.text).toBe("2.1 copies of The Lord of the Rings");
    expect(insights(12_000_000)[0]?.text).toBe("11 Harry Potter series");
    expect(insights(1_000_000)[0]?.text).toBe("1.7 copies of War and Peace");
  });
});

describe("calendar", () => {
  it("lays out 53 columns of 7 ending with the week that holds today", () => {
    const columns = calendar("2026-10-02", []);
    expect(columns).toHaveLength(53);
    expect(columns.every((c) => c.cells.length === 7)).toBe(true);
    const last = columns[52]!;
    // Friday 2 Oct 2026: Monday 28 Sep through Sunday 4 Oct.
    expect(last.cells[0]?.day).toBe("2026-09-28");
    expect(last.cells[4]?.day).toBe("2026-10-02");
    expect(last.cells[4]?.future).toBe(false);
    expect(last.cells[5]?.future).toBe(true);
    expect(columns[0]?.cells[0]?.day).toBe("2025-09-29");
  });

  it("draws half a year when asked, ending on the same week", () => {
    const columns = calendar("2026-10-02", [], HALF_YEAR_WEEKS);
    expect(columns).toHaveLength(26);
    expect(columns[25]?.cells[4]?.day).toBe("2026-10-02");
    expect(columns[0]?.cells[0]?.day).toBe("2026-04-06");
  });

  it("shades days by their share of the busiest day", () => {
    const columns = calendar("2026-10-02", [
      { day: "2026-10-02", words: 400, phrases: 10 },
      { day: "2026-10-01", words: 100, phrases: 2 },
      { day: "2026-09-30", words: 1, phrases: 1 },
    ]);
    const week = columns[52]!.cells;
    expect(week[4]?.level).toBe(4);
    expect(week[3]?.level).toBe(1);
    expect(week[2]?.level).toBe(1);
    expect(week[1]?.level).toBe(0);
  });

  it("labels the columns where a month begins", () => {
    const labels = calendar("2026-10-02", []).map((c) => c.monthLabel).filter(Boolean);
    expect(labels[0]).toBe("Oct");
    expect(labels).toContain("Jan");
    expect(labels.length).toBeGreaterThanOrEqual(12);
  });

  /*
   * Someone who started in September should not see a year of labelled,
   * empty months behind their first week. The grid is still drawn, so today
   * sits where it always does, but the time before is unlabelled and marked.
   */
  it("keeps the months before the first words quiet", () => {
    const columns = calendar("2026-10-02", [{ day: "2026-09-15", words: 50, phrases: 2 }], HALF_YEAR_WEEKS);
    const labels = columns.map((c) => c.monthLabel).filter(Boolean);
    // September began before the first word, so it is named at the week the
    // words start in; October has not begun a column yet in this window.
    expect(labels).toEqual(["Sep"]);
    const labelled = columns.find((c) => c.monthLabel === "Sep")!;
    expect(labelled.cells.some((cell) => cell.day === "2026-09-15")).toBe(true);
    const cells = columns.flatMap((c) => c.cells);
    expect(cells.find((cell) => cell.day === "2026-09-14")?.before).toBe(true);
    expect(cells.find((cell) => cell.day === "2026-09-15")?.before).toBe(false);
    expect(cells.find((cell) => cell.day === "2026-10-02")?.before).toBe(false);
    expect(firstDay([{ day: "2026-09-15", words: 50, phrases: 2 }, { day: "2026-09-01", words: 0, phrases: 0 }])).toBe("2026-09-15");
    expect(firstDay([])).toBeNull();
  });

  it("reads days as local dates", () => {
    expect(dayKey(localDate("2026-03-01"))).toBe("2026-03-01");
  });
});

describe("monthBars", () => {
  it("runs from the first month with words to this month, quiet ones at zero", () => {
    const bars = monthBars("2026-10-02", [
      { month: "2026-10", words: 300, phrases: 9, activeDays: 2 },
      { month: "2026-08", words: 50, phrases: 1, activeDays: 1 },
    ]);
    expect(bars.map((b) => b.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(bars[0]).toMatchObject({ words: 50, label: "Aug 2026" });
    expect(bars[1]?.words).toBe(0);
    expect(bars[2]).toMatchObject({ month: "2026-10", words: 300, current: true, label: "Oct" });
  });

  it("is this month alone before any words", () => {
    const bars = monthBars("2026-10-02", []);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ month: "2026-10", words: 0, current: true, label: "Oct" });
  });

  it("keeps the most recent twelve of a longer run, naming the year where it changes", () => {
    const bars = monthBars("2026-10-02", [{ month: "2024-03", words: 10, phrases: 1, activeDays: 1 }]);
    expect(bars).toHaveLength(12);
    expect(bars[0]?.label).toBe("Nov 2025");
    expect(bars.find((b) => b.month === "2026-01")?.label).toBe("Jan 2026");
    expect(bars[11]?.month).toBe("2026-10");
  });

  it("compares this month with last", () => {
    const up = monthBars("2026-10-02", [
      { month: "2026-10", words: 140, phrases: 1, activeDays: 1 },
      { month: "2026-09", words: 100, phrases: 1, activeDays: 1 },
    ]);
    expect(monthDelta(up)).toBe(40);
    expect(monthChange(up)).toBe("Up 40% on last month");
    const down = monthBars("2026-10-02", [
      { month: "2026-10", words: 88, phrases: 1, activeDays: 1 },
      { month: "2026-09", words: 100, phrases: 1, activeDays: 1 },
    ]);
    expect(monthDelta(down)).toBe(-12);
    expect(monthChange(down)).toBe("Down 12% on last month");
    const quiet = monthBars("2026-10-02", [
      { month: "2026-10", words: 10, phrases: 1, activeDays: 1 },
      { month: "2026-08", words: 10, phrases: 1, activeDays: 1 },
    ]);
    expect(monthDelta(quiet)).toBeNull();
    expect(monthChange(quiet)).toBe("Back after a quiet month");
    // One month is nothing to compare with.
    expect(monthChange(monthBars("2026-10-02", [{ month: "2026-10", words: 10, phrases: 1, activeDays: 1 }]))).toBe("");
    expect(monthChange(monthBars("2026-10-02", []))).toBe("");
  });
});

describe("streakLine", () => {
  const base: Activity = { today: "2026-10-02", days: [], months: [], currentStreak: 0, longestStreak: 0, activeDays: 0 };
  it("says what there is", () => {
    expect(streakLine(base)).toBe("No streak yet");
    expect(streakLine({ ...base, longestStreak: 4 })).toBe("Longest streak 4 days");
    expect(streakLine({ ...base, currentStreak: 3, longestStreak: 3 })).toBe("3-day streak, your longest");
    expect(streakLine({ ...base, currentStreak: 2, longestStreak: 9 })).toBe("2-day streak · longest 9");
  });
});
