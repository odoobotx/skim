import type { ThreadRow } from "./types";

export type GroupBy = "none" | "sender" | "address";
export type Category = "mail" | "notifications" | "newsletters";
export interface SenderRule { priority?: boolean; category?: Category; group?: boolean }
export type SenderRules = Record<string, SenderRule>;
export interface InboxGroup {
  key: string;
  label: string;
  rows: ThreadRow[];
}

export function senderAddress(row: ThreadRow): string {
  return row.fromAddr.trim().toLowerCase();
}

export function parseSenderRules(value?: string): SenderRules {
  try {
    const parsed: unknown = JSON.parse(value ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const rules: SenderRules = {};
    for (const [address, rule] of Object.entries(parsed)) {
      if (!address.includes("@")) continue;
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) continue;
      const { priority, category, group } = rule as SenderRule;
      if (typeof priority !== "boolean" && typeof group !== "boolean" && !["mail", "notifications", "newsletters"].includes(category ?? "")) continue;
      rules[address.trim().toLowerCase()] = {
        priority: priority === true,
        category: ["mail", "notifications", "newsletters"].includes(category ?? "") ? category : undefined,
        ...(typeof group === "boolean" ? {group} : {}),
      };
    }
    return rules;
  } catch {
    return {};
  }
}

/** Personal sender groups are opt-in and keyed by address, never display name. */
export function senderGroups(rows: ThreadRow[], rules: SenderRules): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  for (const row of rows) {
    const address = senderAddress(row);
    const key = address && rules[address]?.group ? `address:${address}` : `row:${row.messageId ?? row.id}`;
    let group = groups.get(key);
    if (!group) { group = {key, label: row.fromName.trim() || address, rows: []}; groups.set(key, group); }
    group.rows.push(row);
  }
  return [...groups.values()];
}

/** Sender grouping deliberately spans subjects. Exact-address mode keeps
 * people with the same display name separate. Missing senders never merge. */
export function groupInbox(rows: ThreadRow[], mode: GroupBy): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  for (const row of rows) {
    const address = senderAddress(row);
    const name = row.fromName.trim();
    const identity = mode === "sender" ? (name.toLowerCase() || address) : address;
    const key = mode === "none" || !identity
      ? `row:${row.messageId ?? row.id}` : `${mode}:${identity}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: mode === "address" ? address : name || address, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

/** A message exception wins over a sender rule; Done is no longer active Priority. */
export function isPriority(row: ThreadRow, rules: SenderRules): boolean {
  return !row.isDone && (row.priorityOverride ?? rules[senderAddress(row)]?.priority ?? false);
}

/** Explicit sender corrections override the backend's header classification. */
export function inboxSection(row: ThreadRow, rules: SenderRules): "priority" | Category {
  const rule = Object.hasOwn(rules, senderAddress(row)) ? rules[senderAddress(row)] : undefined;
  return isPriority(row,rules) ? "priority" : rule?.category ?? row.category ?? "mail";
}

export interface TimelineGroup extends InboxGroup { kind: Category }
export type InboxDate = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "earlier";
export interface InboxDateSection { key: InboxDate; groups: TimelineGroup[] }

/** A collapsed group lives once, at its newest message; Priority stays above the timeline. */
export function inboxTimeline(rows: ThreadRow[], rules: SenderRules, now = new Date(), limit = Infinity): { sections: InboxDateSection[]; total: number } {
  const ordinary: ThreadRow[] = [], notifications: ThreadRow[] = [], newsletters: ThreadRow[] = [];
  for (const row of rows) {
    const section = inboxSection(row, rules);
    if (section === "mail") ordinary.push(row);
    else if (section === "notifications") notifications.push(row);
    else if (section === "newsletters") newsletters.push(row);
  }
  const sorted = (items: ThreadRow[]) => [...items].sort((a, b) => b.date - a.date);
  const groups: TimelineGroup[] = senderGroups(sorted(ordinary), rules).map(group => ({ ...group, kind: "mail" }));
  for (const [kind, items] of [["notifications", notifications], ["newsletters", newsletters]] as const) {
    if (items.length) groups.push({ key: kind, label: kind, kind, rows: sorted(items) });
  }
  groups.sort((a, b) => b.rows[0].date - a.rows[0].date);

  // Calendar arithmetic keeps midnight and week boundaries correct across DST.
  const year = now.getFullYear(), month = now.getMonth(), day = now.getDate();
  const monday = day - (now.getDay() + 6) % 7;
  const boundaries: [InboxDate, number][] = [
    ["today", new Date(year, month, day).getTime() / 1000],
    ["yesterday", new Date(year, month, day - 1).getTime() / 1000],
    ["this_week", new Date(year, month, monday).getTime() / 1000],
    ["last_week", new Date(year, month, monday - 7).getTime() / 1000],
    ["this_month", new Date(year, month, 1).getTime() / 1000],
    ["last_month", new Date(year, month - 1, 1).getTime() / 1000],
    ["earlier", -Infinity],
  ];
  const sections = new Map<InboxDate, InboxDateSection>();
  for (const group of groups.slice(0, limit)) {
    const key = boundaries.find(([, start]) => group.rows[0].date >= start)![0];
    let section = sections.get(key);
    if (!section) { section = { key, groups: [] }; sections.set(key, section); }
    section.groups.push(group);
  }
  return { sections: [...sections.values()], total: groups.length };
}
