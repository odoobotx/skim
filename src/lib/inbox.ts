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
