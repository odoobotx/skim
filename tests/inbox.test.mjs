import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/inbox.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { groupInbox, inboxSection, parseSenderRules } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
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
