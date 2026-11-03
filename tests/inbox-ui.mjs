import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// A separate headless browser and synthetic mail only; no desktop focus or
// access to the user's installed mail client, credentials or browser profile.
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "demo/vite.demo.config.ts"], {
  cwd: new URL("..", import.meta.url), windowsHide: true, stdio: "pipe",
});
let output = "";
server.stdout.on("data", chunk => { output += chunk; });
server.stderr.on("data", chunk => { output += chunk; });
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw Error(`Vite exited: ${output}`);
    try { if ((await fetch("http://localhost:1421")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
    if (attempt === 59) throw Error(`Vite did not start: ${output}`);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.SKIM_TEST_BROWSER || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    if (localStorage.getItem("skimdemo.taskInbox") === "on") return;
    localStorage.setItem("skimdemo.taskInbox", "on");
    localStorage.setItem("skimdemo.multiaccount", "on");
    localStorage.setItem("skimdemo.settings", JSON.stringify({ inbox_sender_rules: JSON.stringify({
      "marcus@acme-partners.example": { priority: true },
      "notifications@github.example": { category: "notifications" },
      "receipts@stripe.example": { category: "newsletters" },
    }) }));
  });
  await page.goto("http://localhost:1421");
  await page.getByRole("button", { name: "Check Inbox" }).waitFor();
  assert.equal(await page.locator("nav.sidebar").count(), 0, "Home must be separate from inbox navigation");
  await page.getByRole("button", {name:"Search mail",exact:true}).waitFor();
  await page.getByRole("button", {name:"Compose",exact:true}).click();
  await page.waitForFunction(async () => {
    const { commandLog } = await import("/demo/mock/tauri-core.ts");
    return commandLog.some(call => call.cmd === "open_compose_window");
  });
  await page.locator(".mail-preview").first().waitFor();
  assert((await page.locator(".mail-preview").count()) <= 5);
  await mkdir(new URL("../demo/output/", import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL("../demo/output/home.png", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
  await page.getByRole("button", { name: "Check Inbox" }).click();
  const list = page.locator("section.list");
  await list.getByRole("heading", { name: "Priority", exact: true }).waitFor();
  await page.locator("nav.sidebar").getByRole("button", { name: "More", exact: true }).waitFor();
  assert.equal(await page.locator("nav.sidebar").getByRole("button", { name: /^Archive/ }).count(), 0);
  await page.locator("nav.sidebar").getByRole("button", { name: "More", exact: true }).click();
  await page.locator("nav.sidebar").getByRole("button", { name: /^Archive/ }).waitFor();
  await page.locator("nav.sidebar").getByRole("button", { name: "More", exact: true }).click();
  assert.equal(await list.locator("button.row").filter({hasText:"Anna Weber"}).count(), 2, "Personal senders start ungrouped");
  await list.locator("button.row").filter({hasText:"Anna Weber"}).first().click({button:"right"});
  await page.getByRole("menuitem", {name:"Group by Sender",exact:true}).click();
  await list.getByRole("button", { name: /^Anna Weber/ }).click();
  assert.equal(await list.locator("button.row").filter({ hasText: "Anna Weber" }).count(), 2);
  await list.getByRole("button", { name: "Select message", exact: true }).first().click();
  await list.getByRole("button", { name: "Select message", exact: true }).last().click({ modifiers: ["Shift"] });
  await list.getByText("2 selected", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(async () => {
    const { mail } = await import("/src/lib/stores/mail.svelte.ts");
    return mail.selectedRows.map(row => row.id);
  }), [101, 109]);
  await list.getByRole("button", { name: /Back to senders/ }).click();
  // Category completion is one batch, not one backend request per message.
  const notificationsDone = list.getByRole("button", { name: "Mark Done: Notifications", exact: true });
  await notificationsDone.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("skimdemo.done") || "[]").includes(106));
  await list.getByRole("checkbox", { name: "Show Done" }).check();
  await list.getByRole("button", { name: /^Notifications/ }).click();
  await list.getByRole("button", { name: "Mark Undone", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !JSON.parse(localStorage.getItem("skimdemo.done") || "[]").includes(106));
  await list.getByRole("button", { name: /Back to inbox/ }).click();
  // Rejected archive restores the row and reports a visible failure.
  await page.evaluate(() => localStorage.setItem("skimdemo.failArchive", "on"));
  const priya = list.locator(".message-wrap").filter({ hasText: "Priya Nair" });
  await priya.getByRole("button", { name: "Mark Done", exact: true }).click();
  await page.locator("nav.sidebar .sync.error").waitFor();
  await priya.locator("button.row").waitFor();
  await page.evaluate(() => localStorage.removeItem("skimdemo.failArchive"));
  await priya.locator(".sender-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Make Priority sender", exact:true }).click();
  await page.waitForFunction(() => JSON.parse(JSON.parse(localStorage.getItem("skimdemo.settings")).inbox_sender_rules)["priya@brightwave.io"]?.priority === true);
  await page.reload();
  await page.getByRole("button", { name: "Check Inbox" }).click();
  await list.getByRole("heading", { name: "Priority", exact: true }).waitFor();
  assert.equal(await list.locator(".priority button.row").filter({ hasText: "Priya Nair" }).count(), 1);
  // Sweep the two visible Anna rows in one gesture; no rows move until release.
  await list.getByRole("button", { name: /^Anna Weber/ }).click();
  const doneButtons = list.getByRole("button", { name: "Mark Done", exact: true });
  const first = await doneButtons.first().boundingBox(), last = await doneButtons.last().boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 12 });
  assert.equal(await list.locator("button.row").count(), 2, "Rows must remain stable while sweeping");
  await page.mouse.up();
  await page.waitForFunction(() => {
    const done = JSON.parse(localStorage.getItem("skimdemo.done") || "[]");
    return done.includes(101) && done.includes(109);
  });
  const batches = await page.evaluate(async () => {
    const { commandLog } = await import("/demo/mock/tauri-core.ts");
    return commandLog.filter(call => call.cmd === "set_tasks_done");
  });
  assert.deepEqual(batches.at(-1).args.threadIds, [101,109]);
  assert.equal(batches.at(-1).args.done, true);
  await page.locator("nav.sidebar").getByRole("button", { name: /^Sent/ }).click();
  await list.getByRole("heading", { name: "Sent", exact: true }).waitFor();
  assert.equal(await list.locator("[data-done-ids]").count(), 0);
  await page.locator("nav.sidebar").getByRole("button", { name: /^Inbox/ }).click();
  await list.getByRole("heading", { name: "Priority", exact: true }).waitFor();
  // Account-level layout applies to categories and sender drill-downs alike.
  await page.locator("nav.sidebar").getByRole("button", {name:/Settings$/}).click();
  await page.getByLabel("All inboxes reading layout",{exact:true}).selectOption("split");
  await page.locator(".overlay .close").click();
  assert(await page.locator(".list-host.split").isVisible());
  assert(await page.locator(".reading-host").isVisible());
  await page.locator("nav.sidebar").getByRole("button", {name:/Settings$/}).click();
  await page.getByLabel("All inboxes reading layout",{exact:true}).selectOption("full");
  await page.locator(".overlay .close").click();
  await list.getByRole("button", { name: /^Anna Weber/ }).click();
  await list.locator("button.row").first().click();
  await page.getByRole("button", {name:"← Back to list",exact:true}).waitFor();
  assert(!(await page.locator(".list-host").isVisible()), "Full-width email replaces the list");
  await page.getByRole("button", {name:"← Back to list",exact:true}).click();
  assert.equal(await list.locator("button.row").count(),2,"Back preserves the sender drill-down");
  await list.getByRole("button", {name:/Back to senders/}).click();
  await page.reload();
  await page.getByRole("button", {name:"Check Inbox"}).click();
  assert.equal(await page.evaluate(async () => (await import("/src/lib/stores/mail.svelte.ts")).mail.readingLayout),"full");
  await mkdir(new URL("../demo/output/", import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL("../demo/output/task-inbox.png", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
  await page.evaluate(async () => {
    const { ui } = await import("/src/lib/stores/ui.svelte.ts");
    ui.setTheme("cold", "dark");
  });
  await page.screenshot({ path: new URL("../demo/output/task-inbox-dark.png", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
  await page.evaluate(async () => {
    const {mail}=await import("/src/lib/stores/mail.svelte.ts");
    await mail.setShowDone(false);
    await mail.setDoneRows([...mail.threads],true);
  });
  await page.waitForFunction(async () => (await import("/src/lib/stores/mail.svelte.ts")).mail.threads.length === 0);
  await list.getByRole("checkbox",{name:"Show Done",exact:true}).check();
  await page.waitForFunction(async () => {
    const {mail}=await import("/src/lib/stores/mail.svelte.ts");
    return mail.threads.length > 0 && mail.threads.every(row=>row.isDone && row.isRead) && mail.selectedFolder.unreadCount === 0;
  });
  assert.deepEqual(errors, []);
  console.log("Inbox UI passed: Home, minimal sidebar, sender drill-down, category completion, Show Done, restore, sweep batching, failure recovery, persisted priority, unified Sent.");
} finally {
  await browser?.close();
  server.kill();
}
