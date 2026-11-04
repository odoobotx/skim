import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/inbox.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { groupInbox, senderGroups, inboxSection, parseSenderRules, isPriority, inboxTimeline } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
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

const dated = (id, month, day, extra = {}) => row(id, `Sender ${id}`, `sender${id}@example.com`, {
  date: new Date(2026, month - 1, day, 12).getTime() / 1000, ...extra,
});

test("timeline sorts calendar sections and keeps mixed groups once at their newest date", () => {
  const rows = [dated(1,9,2), dated(2,11,5), dated(3,11,16,{fromAddr:"anna@example.com"}),
    dated(4,10,12,{category:"notifications"}), dated(5,11,18,{category:"notifications"}),
    dated(6,11,17,{category:"newsletters"}), dated(7,10,15,{category:"newsletters"}),
    dated(8,10,11,{fromAddr:"anna@example.com"}), dated(9,11,10), dated(10,10,12),
    dated(11,11,18,{priorityOverride:true})];
  const before = [...rows];
  const result = inboxTimeline(rows, {"anna@example.com":{group:true}}, new Date(2026,10,18,18));
  assert.deepEqual(result.sections.map(section => section.key),
    ["today","yesterday","this_week","last_week","this_month","last_month","earlier"]);
  assert.deepEqual(result.sections.slice(0,3).map(section => section.groups.map(g => g.rows.map(r => r.id))),
    [[[5,4]],[[6,7]],[[3,8]]]);
  assert.deepEqual(result.sections[0].groups.map(g => g.kind), ["notifications"]);
  assert.equal(result.total,7);
  assert.deepEqual(rows,before,"Timeline must not mutate the store's row order");
  const sectionDoneIds = result.sections[0].groups.flatMap(g => g.rows.map(r => r.id));
  assert.deepEqual(sectionDoneIds,[5,4],"Section Done includes older members of the visible collapsed group");
  assert.equal(new Set(result.sections.flatMap(s => s.groups.flatMap(g => g.rows.map(r => r.id)))).size,10);
  const limited = inboxTimeline(rows, {"anna@example.com":{group:true}},new Date(2026,10,18,18),2);
  assert.equal(limited.total,7);
  assert.deepEqual(limited.sections.flatMap(s => s.groups.map(g => g.rows.length)),[2,2],"Paging limits cards, never cuts a collapsed group in half");
});

test("Today, Yesterday and weeks use local dates at DST, month and year boundaries", () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    const rows = [dated(1,11,2),dated(2,11,1,{date:new Date(2026,10,1,0,15).getTime()/1000}),dated(3,10,31)];
    const result=inboxTimeline(rows,{},new Date(2026,10,2,0,30));
    assert.deepEqual(result.sections.map(s=>s.key),["today","yesterday","last_week"]);
    const yearRows = [row(1,"A","a@example.com",{date:new Date(2027,0,4,0,5).getTime()/1000}),
      row(2,"B","b@example.com",{date:new Date(2027,0,3,23,59).getTime()/1000}),
      row(3,"C","c@example.com",{date:new Date(2026,11,31,23,59).getTime()/1000}),
      row(4,"D","d@example.com",{date:new Date(2026,11,1).getTime()/1000})];
    assert.deepEqual(inboxTimeline(yearRows,{},new Date(2027,0,4,12)).sections.map(s=>s.key),
      ["today","yesterday","last_week","last_month"]);
  } finally {
    if(previousTZ === undefined) delete process.env.TZ; else process.env.TZ=previousTZ;
  }
});
