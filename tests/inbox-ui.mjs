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
  assert.equal(await page.getByText("Browse messages",{exact:true}).count(),0,"Full-width cards have no reading-navigation hint");
  await page.locator("nav.sidebar").getByRole("button", { name: "More", exact: true }).waitFor();
  assert.equal(await page.locator("nav.sidebar").getByRole("button", { name: /^Archive/ }).count(), 0);
  await page.locator("nav.sidebar").getByRole("button", { name: "More", exact: true }).click();
  await page.locator("nav.sidebar").getByRole("button", { name: /^Archive/ }).waitFor();
  await page.locator("nav.sidebar").getByRole("button", { name: "More", exact: true }).click();
  assert.equal(await list.locator("button.row").filter({hasText:"Anna Weber"}).count(), 2, "Personal senders start ungrouped");
  // Unified parents remain available while account children select a precise scope.
  const sidebar=page.locator("nav.sidebar");
  await sidebar.getByRole("button",{name:"morgan.alex@fastmail.example — Inbox",exact:true}).click();
  await page.waitForFunction(async()=>{const {mail}=await import("/src/lib/stores/mail.svelte.ts");return mail.account?.id==="acc-2" && mail.threads.length>0 && mail.threads.every(row=>row.accountId==="acc-2");});
  await sidebar.getByRole("button",{name:/^Inbox/}).click();
  await page.waitForFunction(async()=>{const {mail}=await import("/src/lib/stores/mail.svelte.ts");return mail.unified && new Set(mail.threads.map(row=>row.accountId)).size===2;});
  const badges=await page.evaluate(async()=>{const {mail}=await import("/src/lib/stores/mail.svelte.ts");return mail.accounts.map(a=>mail.accountBadge(a.id));});
  assert.equal(new Set(badges.map(b=>b.letter)).size,2,"Mailbox badges distinguish identical display names");
  assert(badges.every(b=>b.letter.length>=3 && b.title.includes("@")));
  await sidebar.getByRole("button",{name:"Show Sent accounts",exact:true}).click();
  const commandsBeforeSent=await page.evaluate(async()=>(await import("/demo/mock/tauri-core.ts")).commandLog.length);
  await sidebar.getByRole("button",{name:"morgan.alex@fastmail.example — Sent",exact:true}).click();
  await page.waitForFunction(async()=>{const {mail}=await import("/src/lib/stores/mail.svelte.ts");return mail.account?.id==="acc-2" && mail.selectedFolder?.role==="sent" && mail.threads.some(row=>row.id===601);});
  assert.equal(await page.evaluate(async n=>(await import("/demo/mock/tauri-core.ts")).commandLog.slice(n).some(call=>call.cmd==="list_task_inbox"),commandsBeforeSent),false,"Selecting Sent must not load Inbox in between");
  await sidebar.getByRole("button",{name:/^Sent/}).click();
  await page.waitForFunction(async()=>{const {mail}=await import("/src/lib/stores/mail.svelte.ts");return mail.unified && new Set(mail.threads.map(row=>row.accountId)).size===2;});
  await sidebar.getByRole("button",{name:"Pinned",exact:true}).click();
  await list.getByRole("heading",{name:"Pinned",exact:true}).waitFor();
  await page.waitForFunction(async()=>{const {mail}=await import("/src/lib/stores/mail.svelte.ts");return mail.threads.length===3 && mail.threads.every(row=>row.isStarred);});
  await sidebar.getByRole("button",{name:"Show Pinned accounts",exact:true}).click();
  await sidebar.getByRole("button",{name:"morgan.alex@fastmail.example — Pinned",exact:true}).click();
  await page.waitForFunction(async()=>{const {mail}=await import("/src/lib/stores/mail.svelte.ts");return mail.threads.length===1 && mail.threads[0].id===265;});
  await sidebar.getByRole("button",{name:/Settings$/}).click();
  await page.getByRole("switch",{name:"Show Pinned",exact:true}).uncheck();
  assert.equal(await sidebar.getByRole("button",{name:"Pinned",exact:true}).count(),0);
  await page.getByRole("switch",{name:"Unified Inbox, Sent and Pinned",exact:true}).uncheck();
  assert.equal(await sidebar.locator(".account-children").count(),0);
  await page.locator(".overlay .close").click();
  await page.reload();await page.getByRole("button",{name:"Check Inbox"}).click();
  assert.equal(await sidebar.getByRole("button",{name:"Pinned",exact:true}).count(),0,"Sidebar preference persists");
  await sidebar.getByRole("button",{name:/Settings$/}).click();
  await page.getByRole("switch",{name:"Show Pinned",exact:true}).check();
  await page.getByRole("switch",{name:"Unified Inbox, Sent and Pinned",exact:true}).check();
  await page.locator(".overlay .close").click();
  await sidebar.getByRole("button",{name:/^Inbox/}).click();
  await page.waitForFunction(async()=>(await import("/src/lib/stores/mail.svelte.ts")).mail.unified);
  const individual=list.locator(".message-wrap").filter({hasText:"A separate conversation with Anna"});
  await individual.getByRole("button",{name:"Mark message Priority",exact:true}).click();
  await list.locator(".priority button.row").filter({hasText:"A separate conversation with Anna"}).waitFor();
  assert.equal(await list.locator(".priority button.row").filter({hasText:"Q3 launch"}).count(),0,"Priority must not promote every message from the sender");
  assert.equal(await page.evaluate(async()=>(await import("/src/lib/stores/mail.svelte.ts")).mail.selectedThreadId),null,"Hover action must not open the message");
  await page.reload();await page.getByRole("button",{name:"Check Inbox"}).click();
  await individual.getByRole("button",{name:"Remove message Priority",exact:true}).click();
  await page.waitForFunction(()=>!JSON.parse(localStorage.getItem("skimdemo.priority") ?? "[]").includes(109));
  await page.evaluate(()=>localStorage.setItem("skimdemo.failPriority","on"));
  await individual.getByRole("button",{name:"Mark message Priority",exact:true}).click();
  await page.locator("nav.sidebar .sync.error").waitFor();
  await individual.getByRole("button",{name:"Mark message Priority",exact:true}).waitFor();
  await page.evaluate(()=>localStorage.removeItem("skimdemo.failPriority"));

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
  await list.getByRole("switch", { name: "Show Done" }).check();
  await list.getByRole("button", { name: /^Notifications/ }).click();
  await list.locator(".message-wrap").filter({hasText:"GitHub"}).getByRole("button", { name: "Mark Undone", exact: true }).focus();
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
  const inherited=list.locator(".message-wrap").filter({hasText:"Design review moved to Friday"});
  await inherited.getByRole("button",{name:"Remove message Priority",exact:true}).click();
  await page.waitForFunction(async()=> {
    const {mail}=await import("/src/lib/stores/mail.svelte.ts");
    return mail.threads.find(row=>row.id===103)?.priorityOverride===false;
  });
  assert.equal(await list.locator(".priority button.row").filter({hasText:"Priya Nair"}).count(),0);
  await inherited.locator(".sender-menu-trigger").click();
  await page.getByRole("menuitem",{name:"Use sender's Priority setting",exact:true}).click();
  await inherited.getByRole("button",{name:"Remove message Priority",exact:true}).waitFor();
  assert.equal(await list.locator(".priority button.row").filter({hasText:"Priya Nair"}).count(),1);
  assert.equal(await list.locator(".priority button.row").count(),5,"Priority shows five cards before Show all");
  await list.locator(".priority").getByRole("button",{name:/^Show all/}).click();
  assert((await list.locator("button.row").count())>5);
  await list.getByRole("button",{name:/Back to inbox/}).click();
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
  await page.evaluate(()=>localStorage.setItem("skimdemo.longEmail","on"));
  async function checkReadingScroll() {
    await page.waitForFunction(()=> {
      const el=document.querySelector(".reading-host .scroll");
      return el && el.scrollHeight>el.clientHeight+600;
    });
    const scroll=page.locator(".reading-host .scroll");
    const iframe=page.locator(".reading-host iframe");
    await iframe.waitFor();
    const box=await iframe.boundingBox();
    await page.mouse.move(box.x+Math.min(box.width/2,200),Math.max(150,Math.min(box.y+70,800)));
    await page.mouse.wheel(0,650);
    await page.waitForFunction(()=>document.querySelector(".reading-host .scroll").scrollTop>200);
    assert(await scroll.evaluate(el=>el.getBoundingClientRect().bottom<=window.innerHeight),"Reading scroller must remain inside the window");
    assert(await page.locator(".reading-host footer.actions").isVisible(),"Reply actions remain reachable");
    await page.mouse.click(box.x+Math.min(box.width/2,200),Math.max(150,Math.min(box.y+70,800)));
    await page.keyboard.press("Home");
    await page.waitForFunction(()=>document.querySelector(".reading-host .scroll").scrollTop===0);
    await page.keyboard.press("PageDown");
    await page.waitForFunction(()=>document.querySelector(".reading-host .scroll").scrollTop>200);
    await page.keyboard.press("End");
    await page.waitForFunction(()=> {const el=document.querySelector(".reading-host .scroll");return el.scrollTop+el.clientHeight>=el.scrollHeight-2;});

  }
  // Account-level layout applies to categories and sender drill-downs alike.
  await page.locator("nav.sidebar").getByRole("button", {name:/Settings$/}).click();
  await page.getByLabel("All inboxes reading layout",{exact:true}).selectOption("split");
  await page.locator(".overlay .close").click();
  assert(await page.locator(".list-host.split").isVisible());
  assert(await page.locator(".reading-host").isVisible());
  await page.getByText("Browse messages",{exact:true}).waitFor();
  await list.locator("button.row").first().click();
  await checkReadingScroll();
  await page.keyboard.press("Escape");

  await page.locator("nav.sidebar").getByRole("button", {name:/Settings$/}).click();
  await page.getByLabel("All inboxes reading layout",{exact:true}).selectOption("full");
  await page.locator(".overlay .close").click();
  await list.getByRole("button", { name: /^Anna Weber/ }).click();
  await list.locator("button.row").first().click();
  await page.getByRole("button", {name:"← Back to list",exact:true}).waitFor();
  assert(!(await page.locator(".list-host").isVisible()), "Full-width email replaces the list");
  await page.locator(".reading-host .toolbar").getByText("Browse messages",{exact:true}).waitFor();
  assert((await page.locator(".conversation-card").count())>=5,"The conversation is visible as cards without earlier/later accordions");
  assert.equal(await page.locator(".thread-more").count(),0);
  await checkReadingScroll();
  // Account appearance applies immediately to an open email in All inboxes.
  await page.waitForFunction(() => {
    const body=document.querySelector("iframe")?.contentDocument?.body;
    return body && getComputedStyle(body).backgroundColor!=="rgb(255, 255, 255)";
  });
  assert.equal(await page.getByLabel("Email appearance",{exact:true}).count(),0);
  await page.locator("nav.sidebar").getByRole("button",{name:/Settings$/}).click();
  await page.locator(".overlay .chevron").first().click();
  assert.equal(await page.getByLabel("Email appearance",{exact:true}).inputValue(),"theme");
  await page.getByLabel("Email appearance",{exact:true}).selectOption("original");
  await page.locator(".overlay .close").click();
  await page.waitForFunction(() => {
    const body=document.querySelector("iframe")?.contentDocument?.body;
    return body && getComputedStyle(body).backgroundColor === "rgb(255, 255, 255)";
  });

  await page.getByRole("button", {name:"← Back to list",exact:true}).click();
  assert.equal(await list.locator("button.row").count(),2,"Back preserves the sender drill-down");
  await list.getByRole("button", {name:/Back to senders/}).click();
  await page.reload();
  await page.getByRole("button", {name:"Check Inbox"}).click();
  assert.equal(await page.evaluate(async () => (await import("/src/lib/stores/mail.svelte.ts")).mail.readingLayout),"full");
  assert.deepEqual(await page.evaluate(async () => {
    const {mail}=await import("/src/lib/stores/mail.svelte.ts");
    return [mail.emailAppearanceFor("acc-1"),mail.emailAppearanceFor("acc-2")];
  }),["original","theme"],"Appearance persists separately per account");
  await list.locator("button.row").filter({hasText:"City Utilities"}).click();
  await page.waitForFunction(() => {
    const body=document.querySelector("iframe")?.contentDocument?.body;
    return body && getComputedStyle(body).backgroundColor!=="rgb(255, 255, 255)";
  });
  await page.getByRole("button",{name:"← Back to list",exact:true}).click();

  await mkdir(new URL("../demo/output/", import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL("../demo/output/task-inbox.png", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
  await page.evaluate(async () => {
    const { ui } = await import("/src/lib/stores/ui.svelte.ts");
    ui.setTheme("cold", "dark");
  });
  await page.screenshot({ path: new URL("../demo/output/task-inbox-dark.png", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
  // The custom theme persists, and Compose uses palette surfaces in every mode.
  await page.locator("nav.sidebar").getByRole("button", {name:/Settings$/}).click();
  await page.getByRole("button",{name:"Moonlit · Dark",exact:true}).click();
  await page.locator(".overlay .close").click();
  await page.reload();
  await page.getByRole("button",{name:"Check Inbox"}).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"),"moonlit-dark");
  for (const temperature of ["moonlit","cold","warm"]) for (const lightness of ["dark","light"]) {
    await page.evaluate(async ({temperature,lightness}) => {
      (await import("/src/lib/stores/ui.svelte.ts")).ui.setTheme(temperature,lightness);
    },{temperature,lightness});
    const compose=await page.locator("nav.sidebar .compose").evaluate(el => {
      const s=getComputedStyle(el), root=getComputedStyle(document.documentElement);
      return {color:s.color,text:root.getPropertyValue("--text").trim(),fill:s.backgroundImage,border:s.borderTopStyle};
    });
    assert.notEqual(compose.fill,"none",`${temperature}-${lightness} should use the shared Compose surface`);
    assert.equal(compose.border,"solid");
    // Compare normalized CSS colors rather than hex/rgb formatting.
    assert(await page.locator("nav.sidebar .compose").evaluate(el => {
      const probe=document.createElement("span");probe.style.color="var(--text)";el.append(probe);
      const matches=getComputedStyle(el).color===getComputedStyle(probe).color;probe.remove();return matches;
    }));
  }
  await page.evaluate(async () => (await import("/src/lib/stores/ui.svelte.ts")).ui.setTheme("moonlit","dark"));
  await page.screenshot({path:new URL("../demo/output/task-inbox-moonlit.png",import.meta.url).pathname.replace(/^\/(\w:)/,"$1"),fullPage:true});

  await page.evaluate(async () => {
    const {mail}=await import("/src/lib/stores/mail.svelte.ts");
    await mail.setShowDone(false);
    await mail.setDoneRows([...mail.threads],true);
  });
  await page.waitForFunction(async () => (await import("/src/lib/stores/mail.svelte.ts")).mail.threads.length === 0);
  await list.getByRole("switch",{name:"Show Done",exact:true}).check();
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
