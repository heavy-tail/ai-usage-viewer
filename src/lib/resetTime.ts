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
const MAX_RESET_LABEL_LENGTH = 128;
const MAX_RELATIVE_RESET_MS = 370 * 24 * 60 * 60_000;

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
  // A display preference must never supply the missing source timezone.
  // Collectors canonicalize offset-less provider labels at collection time;
  // historical labels without source context remain verbatim.
  const instant = resolveResetInstant(limit);
  if (!instant) return limit.resetLabel;

  try {
    const formatter = new Intl.DateTimeFormat(options.locale ?? "en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      ...(timeZone ? { timeZone } : {}),
    });
    return `Resets ${formatter.format(instant)}`;
  } catch {
    return limit.resetLabel;
  }
}

export function resolveResetInstant(
  limit: ResetFields,
  sourceTimeZone?: string
): Date | undefined {
  if (limit.resetAt) {
    const instant = new Date(limit.resetAt);
    if (Number.isFinite(instant.valueOf())) return instant;
  }

  if (!limit.resetLabel) return undefined;
  if (limit.resetLabel.length > MAX_RESET_LABEL_LENGTH) return undefined;
  const checkedAt = new Date(limit.checkedAt);
  if (!Number.isFinite(checkedAt.valueOf())) return undefined;

  const relative = parseRelativeReset(limit.resetLabel, checkedAt);
  if (relative) return relative;

  return parseAbsoluteReset(limit.resetLabel, checkedAt, sourceTimeZone);
}

function parseRelativeReset(label: string, checkedAt: Date): Date | undefined {
  const match = label.match(
    /^(?:Resets?|Refreshes?)\s+in\s+(?:(\d{1,4})\s*d(?:ays?)?\s*)?(?:(\d{1,4})\s*h(?:ours?)?\s*)?(?:(\d{1,3})\s*m(?:in(?:utes?)?)?)?$/i
  );
  if (!match || !match.slice(1).some((value) => value != null)) return undefined;

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  if (days > 366 || hours > 8_784 || minutes > 59) return undefined;
  const durationMs = ((days * 24 + hours) * 60 + minutes) * 60_000;
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > MAX_RELATIVE_RESET_MS
  ) {
    return undefined;
  }
  const result = new Date(checkedAt.getTime() + durationMs);
  return Number.isFinite(result.valueOf()) ? result : undefined;
}

function parseAbsoluteReset(
  label: string,
  checkedAt: Date,
  fallbackSourceTimeZone?: string
): Date | undefined {
  if (label.length > MAX_RESET_LABEL_LENGTH) return undefined;
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

  const timeZone = validTimeZone(sourceTimeZone ?? fallbackSourceTimeZone);
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
  let candidates = instantsFromWallClock(wallClock, timeZone);
  if (candidates.length === 0) return undefined;
  const futureCandidate = candidates.find(
    (candidate) => candidate.getTime() > checkedAt.getTime()
  );
  if (futureCandidate) return futureCandidate;

  if (candidates.every((candidate) => candidate.getTime() <= checkedAt.getTime())) {
    wallClock = { ...wallClock, year: wallClock.year + 1 };
    candidates = instantsFromWallClock(wallClock, timeZone);
  }
  return candidates[0];
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
  let candidates = instantsFromWallClock(wallClock, timeZone);
  if (candidates.length === 0) return undefined;
  const futureCandidate = candidates.find(
    (candidate) => candidate.getTime() > checkedAt.getTime()
  );
  if (futureCandidate) return futureCandidate;

  if (candidates.every((candidate) => candidate.getTime() <= checkedAt.getTime())) {
    const nextDate = new Date(
      Date.UTC(wallClock.year, wallClock.month - 1, wallClock.day + 1)
    );
    wallClock = {
      ...wallClock,
      year: nextDate.getUTCFullYear(),
      month: nextDate.getUTCMonth() + 1,
      day: nextDate.getUTCDate(),
    };
    candidates = instantsFromWallClock(wallClock, timeZone);
  }
  return candidates[0];
}

function instantsFromWallClock(
  wallClock: WallClock,
  timeZone: string
): Date[] {
  const wallAsUtc = Date.UTC(
    wallClock.year,
    wallClock.month - 1,
    wallClock.day,
    wallClock.hour,
    wallClock.minute
  );
  const candidates = new Map<number, Date>();

  // A wall-clock time can map to two instants when daylight saving time falls
  // back. Sample both sides of any nearby offset transition, derive every
  // plausible instant, and retain only exact wall-clock matches. Sampling a
  // three-day window also covers current civil offsets from UTC-12 to UTC+14.
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = wallAsUtc + hours * 60 * 60_000;
    const represented = zonedParts(new Date(sample), timeZone);
    if (!represented) continue;
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute
    );
    const candidateTime = wallAsUtc - (representedAsUtc - sample);
    const candidate = new Date(candidateTime);
    const verified = zonedParts(candidate, timeZone);
    if (verified && sameWallClock(verified, wallClock)) {
      candidates.set(candidateTime, candidate);
    }
  }
  return [...candidates.values()].sort(
    (left, right) => left.getTime() - right.getTime()
  );
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
