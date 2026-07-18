import type { UsageLimit } from "../types";

type ResetFields = Pick<UsageLimit, "checkedAt" | "resetAt" | "resetLabel">;

type DisplayResetOptions = {
  locale?: string;
  timeZone?: string;
};

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const MONTHS = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].flatMap((month, index) => [
    [month, index + 1] as const,
    [month.slice(0, 3), index + 1] as const,
  ])
);

/**
 * Render every provider's reset time in one local, user-facing format.
 * Canonical resetAt timestamps win. Older provider labels are interpreted only
 * when their shape and timezone are unambiguous; otherwise the original label
 * is preserved instead of guessing.
 */
export function displayResetLabel(
  limit: ResetFields,
  options: DisplayResetOptions = {}
): string | undefined {
  if (!limit.resetAt && !limit.resetLabel) return undefined;

  const timeZone = validTimeZone(
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const instant = resetInstant(limit, timeZone);
  if (!instant) return limit.resetLabel;

  const formatter = new Intl.DateTimeFormat(options.locale ?? "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  });
  return `Resets ${formatter.format(instant)}`;
}

function resetInstant(limit: ResetFields, displayTimeZone?: string): Date | undefined {
  if (limit.resetAt) {
    const instant = new Date(limit.resetAt);
    if (!Number.isNaN(instant.valueOf())) return instant;
  }

  if (!limit.resetLabel) return undefined;
  const checkedAt = new Date(limit.checkedAt);
  if (Number.isNaN(checkedAt.valueOf())) return undefined;

  const relative = parseRelativeReset(limit.resetLabel, checkedAt);
  if (relative) return relative;

  return parseAbsoluteReset(limit.resetLabel, checkedAt, displayTimeZone);
}

function parseRelativeReset(label: string, checkedAt: Date): Date | undefined {
  const match = label.match(
    /^(?:Resets?|Refreshes?)\s+in\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i
  );
  if (!match || !match.slice(1).some((value) => value != null)) return undefined;

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const durationMs = ((days * 24 + hours) * 60 + minutes) * 60_000;
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) return undefined;
  return new Date(checkedAt.getTime() + durationMs);
}

function parseAbsoluteReset(
  label: string,
  checkedAt: Date,
  displayTimeZone?: string
): Date | undefined {
  let value = label.replace(/^(?:Resets?|Refreshes?)\s+/i, "").trim();
  let sourceTimeZone: string | undefined;

  const parenthesizedZone = value.match(/\s*\(([^)]+)\)\s*$/);
  if (parenthesizedZone) {
    sourceTimeZone = normalizeTimeZone(parenthesizedZone[1]);
    value = value.slice(0, parenthesizedZone.index).trim();
  } else {
    const trailingZone = value.match(/\s+(PT|PST|PDT|UTC|GMT)\s*$/i);
    if (trailingZone) {
      sourceTimeZone = normalizeTimeZone(trailingZone[1]);
      value = value.slice(0, trailingZone.index).trim();
    }
  }

  const timeZone = validTimeZone(sourceTimeZone ?? displayTimeZone);
  if (!timeZone) return undefined;

  const monthFirst = value.match(
    /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i
  );
  if (monthFirst) {
    return futureWallClock(
      checkedAt,
      timeZone,
      monthNumber(monthFirst[1]),
      Number(monthFirst[2]),
      clockHour(monthFirst[3], monthFirst[5]),
      Number(monthFirst[4] ?? 0)
    );
  }

  const dayFirst = value.match(
    /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s+on\s+(\d{1,2})\s+([A-Za-z]+)$/i
  );
  if (dayFirst) {
    return futureWallClock(
      checkedAt,
      timeZone,
      monthNumber(dayFirst[5]),
      Number(dayFirst[4]),
      clockHour(dayFirst[1], dayFirst[3]),
      Number(dayFirst[2] ?? 0)
    );
  }

  const timeOnly = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!timeOnly) return undefined;
  return nextWallClockTime(
    checkedAt,
    timeZone,
    clockHour(timeOnly[1], timeOnly[3]),
    Number(timeOnly[2] ?? 0)
  );
}

function futureWallClock(
  checkedAt: Date,
  timeZone: string,
  month: number | undefined,
  day: number,
  hour: number | undefined,
  minute: number
): Date | undefined {
  if (!month || hour == null || !validClock(month, day, hour, minute)) {
    return undefined;
  }

  const checkedParts = zonedParts(checkedAt, timeZone);
  if (!checkedParts) return undefined;
  let wallClock = { year: checkedParts.year, month, day, hour, minute };
  let candidate = instantFromWallClock(wallClock, timeZone);
  if (!candidate) return undefined;
  if (candidate.getTime() <= checkedAt.getTime()) {
    wallClock = { ...wallClock, year: wallClock.year + 1 };
    candidate = instantFromWallClock(wallClock, timeZone);
  }
  return candidate;
}

function nextWallClockTime(
  checkedAt: Date,
  timeZone: string,
  hour: number | undefined,
  minute: number
): Date | undefined {
  if (hour == null || !validClock(1, 1, hour, minute)) return undefined;
  const checkedParts = zonedParts(checkedAt, timeZone);
  if (!checkedParts) return undefined;

  let wallClock: WallClock = {
    year: checkedParts.year,
    month: checkedParts.month,
    day: checkedParts.day,
    hour,
    minute,
  };
  let candidate = instantFromWallClock(wallClock, timeZone);
  if (!candidate) return undefined;
  if (candidate.getTime() <= checkedAt.getTime()) {
    const nextDate = new Date(
      Date.UTC(wallClock.year, wallClock.month - 1, wallClock.day + 1)
    );
    wallClock = {
      ...wallClock,
      year: nextDate.getUTCFullYear(),
      month: nextDate.getUTCMonth() + 1,
      day: nextDate.getUTCDate(),
    };
    candidate = instantFromWallClock(wallClock, timeZone);
  }
  return candidate;
}

function instantFromWallClock(
  wallClock: WallClock,
  timeZone: string
): Date | undefined {
  const wallAsUtc = Date.UTC(
    wallClock.year,
    wallClock.month - 1,
    wallClock.day,
    wallClock.hour,
    wallClock.minute
  );
  let guess = wallAsUtc;

  for (let index = 0; index < 3; index += 1) {
    const represented = zonedParts(new Date(guess), timeZone);
    if (!represented) return undefined;
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute
    );
    const nextGuess = wallAsUtc - (representedAsUtc - guess);
    if (nextGuess === guess) break;
    guess = nextGuess;
  }

  const candidate = new Date(guess);
  const verified = zonedParts(candidate, timeZone);
  return verified && sameWallClock(verified, wallClock) ? candidate : undefined;
}

function zonedParts(date: Date, timeZone: string): WallClock | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)])
    );
    if ([values.year, values.month, values.day, values.hour, values.minute].some(Number.isNaN)) {
      return undefined;
    }
    return {
      year: values.year,
      month: values.month,
      day: values.day,
      hour: values.hour,
      minute: values.minute,
    };
  } catch {
    return undefined;
  }
}

function normalizeTimeZone(value: string): string {
  const normalized = value.trim();
  if (/^(?:PT|PST|PDT)$/i.test(normalized)) return "America/Los_Angeles";
  if (/^(?:UTC|GMT)$/i.test(normalized)) return "UTC";
  return normalized;
}

function validTimeZone(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return undefined;
  }
}

function monthNumber(value: string): number | undefined {
  return MONTHS.get(value.toLowerCase());
}

function clockHour(value: string, meridiem?: string): number | undefined {
  const hour = Number(value);
  if (!Number.isInteger(hour)) return undefined;
  if (!meridiem) return hour >= 0 && hour <= 23 ? hour : undefined;
  if (hour < 1 || hour > 12) return undefined;
  return hour % 12 + (/^PM$/i.test(meridiem) ? 12 : 0);
}

function validClock(month: number, day: number, hour: number, minute: number): boolean {
  if (
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return false;
  }
  const normalized = new Date(Date.UTC(2024, month - 1, day));
  return normalized.getUTCMonth() === month - 1 && normalized.getUTCDate() === day;
}

function sameWallClock(left: WallClock, right: WallClock): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}
