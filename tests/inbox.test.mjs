import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/inbox.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { groupInbox, senderGroups, inboxSection, parseSenderRules, isPriority } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const row = (id, fromName, fromAddr, extra = {}) => ({
  id, accountId: "work", fromName, fromAddr, subject: `Subject ${id}`,
  snippet: "", date: 100 - id, isRead: false, isStarred: false,
  hasAttachments: false, messageCount: 1, ...extra,
});

test("sender grouping spans subjects and accounts while preserving input order", () => {
  const rows = [row(1, "Clifford", "cliff@example.com"), row(2, "Someone", "other@example.com"),
    row(3, "CLIFFORD", "cliff@work.example", { accountId: "personal" })];
  const groups = groupInbox(rows, "sender");
  assert.deepEqual(groups.map(g => g.rows.map(r => r.id)), [[1, 3], [2]]);
  assert.equal(groups[0].label, "Clifford");
});

test("address mode distinguishes equal names and normalizes address case", () => {
  const groups = groupInbox([row(1, "Clifford", " CLIFF@example.com "),
    row(2, "Clifford", "other@example.com"), row(3, "C", "cliff@example.com")], "address");
  assert.deepEqual(groups.map(g => g.rows.map(r => r.id)), [[1, 3], [2]]);
});

test("missing senders never merge and flat messages with one thread stay distinct", () => {
  assert.equal(groupInbox([row(1, "", ""), row(2, "", "")], "sender").length, 2);
  const rows = [row(1, "C", "c@example.com", { messageId: 10 }), row(1, "C", "c@example.com", { messageId: 11 })];
  assert.deepEqual(groupInbox(rows, "none").map(g => g.key), ["row:10", "row:11"]);
});

test("priority is separate from stars and takes precedence over sender categories", () => {
  const message = row(1, "Clifford", "cliff@example.com", { isStarred: true });
  assert.equal(inboxSection(message, {}), "mail");
  assert.equal(inboxSection(message, { "cliff@example.com": { category: "newsletters" } }), "newsletters");
  assert.equal(inboxSection(message, { "cliff@example.com": { priority: true, category: "newsletters" } }), "priority");
});

test("sender rule parsing rejects malformed settings and unsafe keys", () => {
  for (const value of ["not json", "null", "[]", "42"]) assert.deepEqual(parseSenderRules(value), {});
  assert.deepEqual(parseSenderRules('{"__proto__":{"priority":true},"x@example.com":null}'), {});
  assert.deepEqual(parseSenderRules('{" CLIFF@example.com ":{"priority":true,"category":"newsletters"}}'),
    { "cliff@example.com": { priority: true, category: "newsletters" } });
  assert.deepEqual(parseSenderRules('{"c@example.com":{"priority":"yes","category":"invalid"}}'), {});
});

test("automatic categories remain active until explicitly corrected by the sender rule", () => {
  const notification = row(1, "Updates", "updates@example.com", { category: "notifications" });
  assert.equal(inboxSection(notification, {}), "notifications");
  assert.equal(inboxSection(notification, parseSenderRules('{"updates@example.com":{"priority":false}}')), "notifications");
  assert.equal(inboxSection(notification, {"updates@example.com": {category: "mail"}}), "mail");
});

test("sender grouping is opt-in, address-specific, and independently reversible", () => {
  const rows=[row(1,"Anna","anna@example.com"),row(2,"Anna","other@example.com"),row(3,"Anna","anna@example.com")];
  assert.equal(senderGroups(rows,{}).length,3);
  const rules=parseSenderRules('{"anna@example.com":{"group":true}}');
  assert.deepEqual(senderGroups(rows,rules).map(group=>group.rows.map(row=>row.id)),[[1,3],[2]]);
  assert.equal(senderGroups(rows,parseSenderRules('{"anna@example.com":{"group":false}}')).length,3);
});

test("message Priority overrides category without promoting the whole sender", () => {
  const rules={"person@example.com":{category:"newsletters"}};
  assert.equal(inboxSection(row(1,"Person","person@example.com",{priorityOverride:true}),rules),"priority");
  assert.equal(inboxSection(row(2,"Person","person@example.com"),rules),"newsletters");
});

test("Priority sender rules are inherited and individual messages can opt out or reset", () => {
  const rules={"person@example.com":{priority:true}};
  assert(isPriority(row(1,"Person","person@example.com"),rules));
  assert(!isPriority(row(2,"Person","person@example.com",{priorityOverride:false}),rules));
  assert(isPriority(row(2,"Person","person@example.com",{priorityOverride:null}),rules));
  assert(!isPriority(row(3,"Person","person@example.com",{isDone:true}),rules));
});
