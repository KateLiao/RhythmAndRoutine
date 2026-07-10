const ABBREV_MAP: Record<string, string> = {
  "Asia/Shanghai": "CST",
  "Asia/Hong_Kong": "HKT",
  "Asia/Tokyo": "JST",
  "Asia/Seoul": "KST",
  "America/New_York": "ET",
  "America/Los_Angeles": "PT",
  "Europe/London": "GMT",
  "Europe/Paris": "CET",
};

/**
 * 将 IANA 时区格式化为日历左侧显示的缩写标签。
 * @param timezone - 用户时区设置
 */
export function formatTimezoneAbbrev(timezone: string) {
  if (ABBREV_MAP[timezone]) return ABBREV_MAP[timezone];
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" }).formatToParts(new Date());
    const offset = parts.find((part) => part.type === "timeZoneName")?.value;
    if (offset) return offset.replace("GMT", "GMT");
    const short = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(new Date());
    return short.find((part) => part.type === "timeZoneName")?.value ?? timezone;
  } catch {
    return timezone;
  }
}
