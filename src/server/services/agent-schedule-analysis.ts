type ScheduleWindowItem = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status?: string;
  blockKind?: string;
  source?: string;
};

export type ScheduleCandidate = {
  label?: string;
  startsAt: string;
  endsAt: string;
};

export type AgentScheduleWindowResult = {
  timezone: string;
  window: { from: string; to: string; localFrom: string; localTo: string };
  itemCount: number;
  items: Array<ScheduleWindowItem & { localStartsAt: string; localEndsAt: string }>;
  busyIntervals: Array<{ startsAt: string; endsAt: string; localStartsAt: string; localEndsAt: string; titles: string[] }>;
  availableIntervals: Array<{ startsAt: string; endsAt: string; localStartsAt: string; localEndsAt: string }>;
};

/**
 * 把日历原始行投影为 Agent 可直接使用的本地时间忙闲结论。
 * 精确过滤窗口外 Routine，并排除取消/已改期旧记录，避免模型自行清洗 ISO 数据。
 */
export function buildAgentScheduleWindowResult(
  rawItems: ScheduleWindowItem[],
  from: Date,
  to: Date,
  timezone: string,
): AgentScheduleWindowResult {
  const activeItems = rawItems
    .filter((item) => {
      const startsAt = new Date(item.startsAt);
      const endsAt = new Date(item.endsAt);
      const status = item.status?.toLowerCase();
      return !Number.isNaN(startsAt.getTime())
        && !Number.isNaN(endsAt.getTime())
        && startsAt < to
        && endsAt > from
        && status !== "cancelled"
        && status !== "rescheduled";
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const items = activeItems.map((item) => ({
    id: item.id,
    title: item.title,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    status: item.status,
    blockKind: item.blockKind,
    source: item.source,
    localStartsAt: formatLocalDateTime(new Date(item.startsAt), timezone),
    localEndsAt: formatLocalDateTime(new Date(item.endsAt), timezone),
  }));
  const busyIntervals = mergeBusyIntervals(activeItems, timezone);
  const availableIntervals = invertBusyIntervals(busyIntervals, from, to, timezone);

  return {
    timezone,
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
      localFrom: formatLocalDateTime(from, timezone),
      localTo: formatLocalDateTime(to, timezone),
    },
    itemCount: items.length,
    items,
    busyIntervals,
    availableIntervals,
  };
}

/** 对候选时段做确定性半开区间冲突校验。 */
export function validateScheduleCandidates(
  candidates: ScheduleCandidate[],
  schedule: AgentScheduleWindowResult,
) {
  const checked = candidates.map((candidate) => {
    const startsAt = new Date(candidate.startsAt);
    const endsAt = new Date(candidate.endsAt);
    const valid = !Number.isNaN(startsAt.getTime()) && !Number.isNaN(endsAt.getTime()) && startsAt < endsAt;
    const conflicts = valid
      ? schedule.items.filter((item) => startsAt < new Date(item.endsAt) && endsAt > new Date(item.startsAt))
      : [];
    return {
      ...candidate,
      valid,
      localStartsAt: valid ? formatLocalDateTime(startsAt, schedule.timezone) : null,
      localEndsAt: valid ? formatLocalDateTime(endsAt, schedule.timezone) : null,
      available: valid && conflicts.length === 0,
      conflicts: conflicts.map((item) => ({
        id: item.id,
        title: item.title,
        localStartsAt: item.localStartsAt,
        localEndsAt: item.localEndsAt,
      })),
    };
  });
  return { timezone: schedule.timezone, allAvailable: checked.length > 0 && checked.every((candidate) => candidate.available), candidates: checked };
}

function mergeBusyIntervals(items: ScheduleWindowItem[], timezone: string) {
  const merged: Array<{ startsAt: Date; endsAt: Date; titles: string[] }> = [];
  for (const item of items) {
    const startsAt = new Date(item.startsAt);
    const endsAt = new Date(item.endsAt);
    const previous = merged.at(-1);
    if (previous && startsAt <= previous.endsAt) {
      if (endsAt > previous.endsAt) previous.endsAt = endsAt;
      if (!previous.titles.includes(item.title)) previous.titles.push(item.title);
    } else {
      merged.push({ startsAt, endsAt, titles: [item.title] });
    }
  }
  return merged.map((item) => ({
    startsAt: item.startsAt.toISOString(),
    endsAt: item.endsAt.toISOString(),
    localStartsAt: formatLocalDateTime(item.startsAt, timezone),
    localEndsAt: formatLocalDateTime(item.endsAt, timezone),
    titles: item.titles,
  }));
}

function invertBusyIntervals(
  busyIntervals: AgentScheduleWindowResult["busyIntervals"],
  from: Date,
  to: Date,
  timezone: string,
) {
  const available: Array<{ startsAt: Date; endsAt: Date }> = [];
  let cursor = from;
  for (const busy of busyIntervals) {
    const startsAt = new Date(busy.startsAt);
    const endsAt = new Date(busy.endsAt);
    if (startsAt > cursor) available.push({ startsAt: cursor, endsAt: startsAt });
    if (endsAt > cursor) cursor = endsAt;
  }
  if (cursor < to) available.push({ startsAt: cursor, endsAt: to });
  return available.map((item) => ({
    startsAt: item.startsAt.toISOString(),
    endsAt: item.endsAt.toISOString(),
    localStartsAt: formatLocalDateTime(item.startsAt, timezone),
    localEndsAt: formatLocalDateTime(item.endsAt, timezone),
  }));
}

function formatLocalDateTime(value: Date, timezone: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value).replace(" ", "T");
}
