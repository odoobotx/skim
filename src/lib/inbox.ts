import type { ThreadRow } from "./types";

export type GroupBy = "none" | "sender" | "address";
export type Category = "mail" | "notifications" | "newsletters";
export interface SenderRule { priority?: boolean; category?: Category }
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
      const { priority, category } = rule as SenderRule;
      if (typeof priority !== "boolean" && !["mail", "notifications", "newsletters"].includes(category ?? "")) continue;
      rules[address.trim().toLowerCase()] = {
        priority: priority === true,
        category: ["mail", "notifications", "newsletters"].includes(category ?? "") ? category : "mail",
      };
    }
    return rules;
  } catch {
    return {};
  }
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

/** Categories are explicit sender rules for now. Guessing from subjects would
 * bury personal mail; automatic classification needs reliable header signals. */
export function inboxSection(row: ThreadRow, rules: SenderRules): "priority" | Category {
  const rule = Object.hasOwn(rules, senderAddress(row)) ? rules[senderAddress(row)] : undefined;
  return rule?.priority ? "priority" : rule?.category ?? "mail";
}
