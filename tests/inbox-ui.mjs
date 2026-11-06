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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/Chicago" });
  await page.clock.setFixedTime(new Date("2026-11-18T18:00:00-06:00"));
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
  try { await page.getByRole("button", { name: "Check Inbox" }).waitFor(); }
  catch(error) { console.error("Startup errors:",errors);console.error((await page.locator("body").innerText()).slice(0,1000));throw error; }
  assert.equal(await page.locator("nav.sidebar").count(), 0, "Home must be separate from inbox navigation");
  await page.getByRole("button", {name:"Search mail",exact:true}).waitFor();
  const homeControls=[page.getByRole("button",{name:"Check Inbox",exact:true}),page.getByRole("button",{name:"Search mail",exact:true}),page.getByRole("button",{name:"Compose",exact:true}),page.locator(".mail-preview").first()];
  for (const control of homeControls) {
    await control.hover({position:{x:8,y:8}});
    await page.waitForFunction(el=>el.getAnimations({subtree:true}).some(animation=>animation.playState==="running"),await control.elementHandle());
    const origin=await control.evaluate(el=>({x:parseFloat(el.style.getPropertyValue("--ripple-x")),y:parseFloat(el.style.getPropertyValue("--ripple-y"))}));
    assert(origin.x>=0 && origin.x<20 && origin.y>=0 && origin.y<20,"Hover ripple starts near the pointer entry");
    await page.waitForFunction(el=>el.getAnimations({subtree:true}).every(animation=>animation.playState!=="running"),await control.elementHandle());
    assert.equal(await control.evaluate(el=>getComputedStyle(el,"::after").opacity),"0","The ripple settles while the pointer stays over the control");
  }
  assert.equal(await page.locator(".mail-preview").first().evaluate(el=>getComputedStyle(el).transform),"none","Hover does not move or indent unread rows");
  await page.emulateMedia({reducedMotion:"reduce"});
  for (const control of homeControls) {
    await control.hover();
    assert.equal(await control.evaluate(el=>el.getAnimations({subtree:true}).filter(animation=>animation.playState==="running").length),0,"Reduced motion disables the ripple and hover movement");
    assert.equal(await control.evaluate(el=>getComputedStyle(el).transform),"none");
    await control.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await control.evaluate(el=>getComputedStyle(el).outlineStyle),"solid","Keyboard focus stays visible");
  }
  await page.emulateMedia({reducedMotion:"no-preference"});
  await page.getByRole("button", {name:"Compose",exact:true}).click();
  await page.locator(".compose-dock").waitFor();
  await page.getByRole("button",{name:"Close and save draft",exact:true}).click();
  await page.locator(".compose-dock").waitFor({state:"hidden"});
  await page.locator(".mail-preview").first().waitFor();
  await page.getByRole("heading",{name:"New Unread Emails",exact:true}).waitFor();
  assert((await page.locator(".mail-preview").count()) <= 5);
  await mkdir(new URL("../demo/output/", import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL("../demo/output/home.png", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
  await page.getByRole("button", { name: "Check Inbox" }).click();
  const list = page.locator("section.list");
  await list.getByRole("heading", { name: "Priority", exact: true }).waitFor();
  await list.getByRole("heading", { name: "Today", exact: true }).waitFor();
  await list.getByRole("heading", { name: "Yesterday", exact: true }).waitFor();
  const notificationGroup=list.locator(".date-section").filter({has:page.getByRole("button",{name:/^Notifications/})});
  assert.equal(await notificationGroup.count(),1,"A category appears once, in its newest message's date section");
  await notificationGroup.getByRole("heading",{name:"Today",exact:true}).waitFor();
  assert.equal(await list.getByRole("heading",{name:"People",exact:true}).count(),0,"Dates replace the separate People/bottom-category layout");
  async function checkUnreadAlignment() {
    const geometry=await list.locator(".row-wrap").evaluateAll(rows=>rows.map(el=>{
      const rect=el.getBoundingClientRect();
      return {unread:el.classList.contains("unread"), avatar:el.querySelector(".sender-avatar").getBoundingClientRect().left-rect.left};
    }));
    assert(geometry.some(r=>r.unread) && geometry.some(r=>!r.unread),"Alignment check needs read and unread examples");
    assert(geometry.every(r=>Math.abs(r.avatar-42)<1),"Read and unread avatars must share a fixed gutter");
    const markerCenters=await list.locator(".row-wrap.unread").evaluateAll(rows=>rows.map(el=>{
      const avatar=el.querySelector(".sender-avatar").getBoundingClientRect(), dot=el.querySelector(".unread-dot").getBoundingClientRect();
      return Math.abs(avatar.y+avatar.height/2-dot.y-dot.height/2);
    }));
    assert(markerCenters.every(delta=>delta<1),"Unread markers align with avatars in full and split layouts");
    if(await list.evaluate(el=>el.classList.contains("wide"))) {
      const columns=await list.locator(".date-section .row-wrap, .date-section .group-row").evaluateAll(rows=>rows.map(el=>{
        const row=el.getBoundingClientRect();return el.querySelector(".subject,.preview").getBoundingClientRect().x-row.x;
      }));
      assert(Math.max(...columns)-Math.min(...columns)<1,`Group previews and message subjects share one column: ${JSON.stringify(columns)}`);
    }
  }
  await checkUnreadAlignment();
  await page.setViewportSize({width:1155,height:956});
  await checkUnreadAlignment();
  await page.setViewportSize({width:960,height:900});
  await checkUnreadAlignment();
  await page.setViewportSize({width:1440,height:1000});
  const unreadRow=list.locator(".row-wrap.unread").first();
  const avatarBefore=await unreadRow.locator(".sender-avatar").boundingBox();
  await unreadRow.hover();
  const avatarAfter=await unreadRow.locator(".sender-avatar").boundingBox();
  assert.deepEqual(avatarAfter,avatarBefore,"Revealing Done must not move the sender");
  await page.waitForFunction(()=>getComputedStyle(document.querySelector(".row-wrap.unread:hover .unread-dot")).opacity==="0");
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
  await list.getByRole("button", { name: /Back to inbox/ }).click();
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
  await inherited.locator("button.row").click();
  const inheritedToolbar=page.locator(".reading-host .toolbar");
  await inheritedToolbar.getByRole("button",{name:"Remove Priority",exact:true}).waitFor();
  await page.keyboard.press("i");
  await inheritedToolbar.getByRole("button",{name:"Mark as Priority",exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>JSON.parse(JSON.parse(localStorage.getItem("skimdemo.settings")).inbox_sender_rules)["priya@brightwave.io"].priority),true,"Reader toggle changes the message exception, not the sender rule");
  await page.keyboard.press("i");
  await inheritedToolbar.getByRole("button",{name:"Remove Priority",exact:true}).waitFor();
  await page.getByRole("button",{name:"Back to list",exact:true}).click();
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
  async function checkCopyMenu(layout) {
    const iframe=page.locator(".reading-host iframe").first();
    const paragraph=page.frameLocator(".reading-host iframe").first().locator("p,pre").filter({hasText:/\S/}).first();
    await paragraph.waitFor();
    await paragraph.evaluate(el=>{
      const selection=el.ownerDocument.getSelection(),range=el.ownerDocument.createRange();
      range.selectNodeContents(el);selection.removeAllRanges();selection.addRange(range);
    });
    await paragraph.click({button:"right",position:{x:5,y:8}});
    const copy=page.getByRole("menuitem",{name:/^Copy/});
    await copy.waitFor();
    const box=await page.getByRole("menu",{name:"Copy",exact:true}).boundingBox(), frame=await iframe.boundingBox();
    assert(box.x>=frame.x && box.x<=frame.x+80,`Copy menu stays near the selected text in ${layout}: ${JSON.stringify({box,frame})}`);
    assert(box.x+box.width<=page.viewportSize().width && box.y+box.height<=page.viewportSize().height,"Copy stays on screen");
    await page.screenshot({path:new URL(`../demo/output/copy-menu-${layout}.png`,import.meta.url).pathname.replace(/^\/(\w:)/,"$1")});
    await copy.press("Escape");
    await page.getByRole("menu",{name:"Copy",exact:true}).waitFor({state:"detached"});
    assert(await iframe.isVisible(),"Closing Copy must not navigate out of the email");
  }
  async function checkReadingScroll() {
    await page.waitForFunction(()=> {
      const el=document.querySelector(".reading-host .scroll");
      return el && el.scrollHeight>el.clientHeight+600;
    });
    const scroll=page.locator(".reading-host .scroll");
    const iframe=page.locator(".reading-host iframe").first();
    await iframe.waitFor();
    const box=await iframe.boundingBox();
    await page.mouse.move(box.x+Math.min(box.width/2,200),Math.max(150,Math.min(box.y+70,800)));
    await page.mouse.wheel(0,650);
    await page.waitForFunction(()=>document.querySelector(".reading-host .scroll").scrollTop>200);
    assert(await scroll.evaluate(el=>el.getBoundingClientRect().bottom<=window.innerHeight),"Reading scroller must remain inside the window");
    assert(await page.locator(".reading-host footer.card-actions").last().isVisible(),"Reply actions remain reachable");
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
  await checkUnreadAlignment();
  assert(await page.locator(".reading-host").isVisible());
  await page.getByText("Browse messages",{exact:true}).waitFor();
  await list.locator("button.row").first().click();
  await checkCopyMenu("split");
  await checkReadingScroll();
  await page.keyboard.press("Escape");

  await page.locator("nav.sidebar").getByRole("button", {name:/Settings$/}).click();
  await page.getByLabel("All inboxes reading layout",{exact:true}).selectOption("full");
  await page.locator(".overlay .close").click();
  await list.getByRole("button", { name: /^Anna Weber/ }).click();
  await list.locator("button.row").first().click();
  await page.getByRole("button", {name:"Back to list",exact:true}).waitFor();
  await checkCopyMenu("full");
  const readerToolbar=page.locator(".reading-host .toolbar");
  assert.equal(await readerToolbar.locator(".leading-actions").getByRole("button").count(),2,"Back and Done share the leading control");
  assert.equal(await readerToolbar.getByTitle("Archive",{exact:true}).count(),0,"Inbox reader offers Done instead of Archive");
  await readerToolbar.getByRole("button",{name:"Mark Undone",exact:true}).waitFor();
  assert(!(await page.locator(".list-host").isVisible()), "Full-width email replaces the list");
  await page.locator(".reading-host .toolbar").getByText("Browse messages",{exact:true}).waitFor();
  assert((await page.locator(".conversation-card").count())>=5,"The conversation is visible as cards without earlier/later accordions");
  assert.equal(await page.locator(".thread-more").count(),0);
  const attachmentChips = page.locator(".reading-host .chips");
  await attachmentChips.locator("button.name").first().click();
  await page.waitForFunction(async()=>(await import("/demo/mock/tauri-core.ts")).commandLog.some(call=>call.cmd==="open_attachment"));
  await page.evaluate(()=>localStorage.setItem("skimdemo.failAttachment","on"));
  await attachmentChips.locator("button.name").first().click();
  await attachmentChips.getByRole("alert").waitFor();
  assert.equal(await attachmentChips.getByRole("alert").textContent(),"Synthetic attachment unavailable");
  await page.evaluate(()=>localStorage.removeItem("skimdemo.failAttachment"));
  await attachmentChips.locator("button.save").first().click();
  await page.waitForFunction(async()=>(await import("/demo/mock/tauri-core.ts")).commandLog.some(call=>call.cmd==="save_attachment"));
  assert.equal(await attachmentChips.getByRole("alert").count(),0,"Successful retry clears attachment error");
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
  assert.equal(await page.getByLabel("Sent mail copies",{exact:true}).inputValue(),"auto");
  await page.getByLabel("Sent mail copies",{exact:true}).selectOption("server");
  await page.waitForFunction(()=>JSON.parse(JSON.parse(localStorage.getItem("skimdemo.settings")).sent_copy_modes)["acc-1"]==="server");
  assert.equal(await page.evaluate(()=>JSON.parse(JSON.parse(localStorage.getItem("skimdemo.settings")).sent_copy_modes)["acc-2"]),undefined,"Sent-copy override is scoped to one account");
  await page.getByLabel("Email appearance",{exact:true}).selectOption("original");
  await page.locator(".overlay .close").click();
  await page.waitForFunction(() => {
    const body=document.querySelector("iframe")?.contentDocument?.body;
    return body && getComputedStyle(body).backgroundColor === "rgb(255, 255, 255)";
  });

  await page.getByRole("button", {name:"Back to list",exact:true}).click();
  assert.equal(await list.locator("button.row").count(),2,"Back preserves the sender drill-down");
  await list.getByRole("button", {name:/Back to inbox/}).click();
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
  await readerToolbar.getByRole("button",{name:"Mark as Priority",exact:true}).click();
  await readerToolbar.getByRole("button",{name:"Remove Priority",exact:true}).waitFor();
  assert.equal(await page.evaluate(async()=>(await import("/src/lib/stores/mail.svelte.ts")).mail.selectedThread.isStarred),false,"Priority is independent of stars/Pinned");
  await page.getByRole("button",{name:"Back to list",exact:true}).click();
  assert.equal(await list.locator(".priority button.row").filter({hasText:"City Utilities"}).count(),1);
  await list.locator("button.row").filter({hasText:"City Utilities"}).click();
  await page.keyboard.press("i");
  await readerToolbar.getByRole("button",{name:"Mark as Priority",exact:true}).waitFor();
  await page.evaluate(()=>localStorage.setItem("skimdemo.failPriority","on"));
  await readerToolbar.getByRole("button",{name:"Mark as Priority",exact:true}).click();
  await readerToolbar.getByRole("button",{name:"Mark as Priority",exact:true}).waitFor();
  await page.waitForFunction(async()=>!(await import("/src/lib/stores/mail.svelte.ts")).mail.priorityPending((await import("/src/lib/stores/mail.svelte.ts")).mail.selectedThread));
  assert.equal(await readerToolbar.getByRole("button",{name:"Mark as Priority",exact:true}).getAttribute("aria-pressed"),"false");
  await page.evaluate(()=>localStorage.removeItem("skimdemo.failPriority"));
  await page.getByRole("button",{name:"Back to list",exact:true}).click();

  // Reader Done and E use the same read-and-archive operation, even with Show Done on.
  const city=list.locator(".message-wrap").filter({hasText:"City Utilities"});
  await city.locator("button.row").click();
  await readerToolbar.getByRole("button",{name:"Mark Done",exact:true}).click();
  await list.waitFor({state:"visible"});
  await page.waitForFunction(async()=>{const {mail}=await import("/src/lib/stores/mail.svelte.ts");const row=mail.threads.find(r=>r.id===202);return row?.isDone && row.isRead;});
  await city.locator("button.row").click();
  await readerToolbar.getByRole("button",{name:"Mark Undone",exact:true}).click();
  await readerToolbar.getByRole("button",{name:"Mark Done",exact:true}).waitFor();
  await page.keyboard.press("e");
  await list.waitFor({state:"visible"});
  await page.waitForFunction(async()=>{const {mail}=await import("/src/lib/stores/mail.svelte.ts");return mail.threads.find(r=>r.id===202)?.isDone;});

  // A date-heading action completes all represented mail in one batch.
  const earlier=list.locator(".date-section").filter({has:page.getByRole("heading",{name:"Earlier",exact:true})});
  const sectionIds=(await earlier.locator(".date-heading [data-done-ids]").getAttribute("data-done-ids")).split(",").map(Number);
  await earlier.locator(".date-heading [data-done-ids]").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(ids=>ids.every(id=>JSON.parse(localStorage.getItem("skimdemo.done")||"[]").includes(id)),sectionIds);
  const dateBatch=await page.evaluate(async()=>(await import("/demo/mock/tauri-core.ts")).commandLog.filter(c=>c.cmd==="set_tasks_done").at(-1));
  assert.deepEqual(dateBatch.args.threadIds,sectionIds);
  assert.equal(dateBatch.args.done,true);

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

  const selectedFlatId=await page.evaluate(async()=>{
    const {mail}=await import("/src/lib/stores/mail.svelte.ts");
    await mail.setGroupThreads(false);
    const first=mail.threads[0];first.messageId=70001;
    mail.threads.push({...first,messageId:70002});
    mail.selectedThreadId=first.id;mail.selectedMessageId=70002;
    const selected=mail.selectedThread?.messageId;
    mail.selectedThreadId=null;mail.selectedMessageId=null;
    await mail.setGroupThreads(true);
    return selected;
  });
  assert.equal(selectedFlatId,70002,"Flat reading targets the selected message rather than the first row sharing its thread");

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

  // The same Back/Done control owns the currently open group, never its parent.
  const groupPage=await browser.newPage({viewport:{width:1155,height:956},timezoneId:"America/Chicago"});
  groupPage.on("pageerror",error=>errors.push(error.message));
  await groupPage.clock.setFixedTime(new Date("2026-11-18T18:00:00-06:00"));
  await groupPage.addInitScript(()=>{
    localStorage.setItem("skimdemo.taskInbox","on");
    localStorage.setItem("skimdemo.settings",JSON.stringify({inbox_sender_rules:JSON.stringify({
      "marcus@acme-partners.example":{priority:true},
      "anna.weber@northwind.example":{group:true},
      "brief@northstar.example":{category:"newsletters",group:true},
      "alex@brightwave.io":{group:true},
    })}));
  });
  await groupPage.goto("http://localhost:1421");
  await groupPage.getByRole("button",{name:"Check Inbox",exact:true}).click();
  const groupList=groupPage.locator("section.list"), groupActions=groupList.locator(".organize .leading-actions");
  const batchLog=()=>groupPage.evaluate(async()=>(await import("/demo/mock/tauri-core.ts")).commandLog.filter(c=>c.cmd==="set_tasks_done"));
  await groupList.getByRole("button",{name:/^Anna Weber/}).click();
  assert.equal(await groupActions.getByRole("button").count(),2);
  assert.equal(await groupActions.innerText(),"","Group navigation uses the same icon-only control as the reader");
  await groupActions.getByRole("button",{name:"Back to inbox",exact:true}).click();
  assert.equal((await batchLog()).length,0,"Back never changes mail");
  await groupList.getByRole("button",{name:/^Anna Weber/}).click();
  await groupActions.getByRole("button",{name:"Mark Done: Anna Weber",exact:true}).click();
  await groupPage.waitForFunction(()=>document.querySelector(".organize.drilldown")===null);
  assert.deepEqual((await batchLog()).at(-1).args.threadIds.sort((a,b)=>a-b),[101,109]);
  await groupList.getByRole("switch",{name:"Show Done",exact:true}).check();
  await groupPage.waitForFunction(async()=>{
    const {mail}=await import("/src/lib/stores/mail.svelte.ts");return [101,109].every(id=>mail.threads.some(row=>row.id===id && row.isDone && row.isRead));
  });
  await groupList.getByRole("button",{name:/^Anna Weber/}).click();
  await groupActions.getByRole("button",{name:"Mark Undone: Anna Weber",exact:true}).click();
  await groupPage.waitForFunction(()=>document.querySelector(".organize.drilldown")===null);
  assert.equal((await batchLog()).at(-1).args.done,false,"Completed groups can be restored as one batch");
  await groupList.getByRole("button",{name:/^Anna Weber/}).click();
  await groupPage.evaluate(()=>localStorage.setItem("skimdemo.failArchive","on"));
  await groupActions.getByRole("button",{name:"Mark Done: Anna Weber",exact:true}).click();
  await groupPage.locator("nav.sidebar .sync.error").waitFor();
  await groupActions.getByRole("button",{name:"Mark Done: Anna Weber",exact:true}).waitFor();
  assert.equal(await groupList.locator("button.row").count(),2,"Failed group completion restores rows and keeps the current group open");
  await groupPage.evaluate(()=>localStorage.removeItem("skimdemo.failArchive"));
  await groupPage.locator("nav.sidebar").getByRole("button",{name:/Settings$/}).click();
  const beforeSettings=(await batchLog()).length;
  await groupPage.keyboard.press("e");
  assert.equal((await batchLog()).length,beforeSettings,"Group shortcuts do not complete mail behind Settings");
  await groupPage.locator(".overlay .close").click();
  await groupPage.keyboard.press("Escape");
  await groupPage.waitForFunction(()=>document.querySelector(".organize.drilldown")===null);

  await groupList.getByRole("button",{name:/^Newsletters/}).click();
  await groupList.getByRole("button",{name:/^Northstar Weekly/}).click();
  await groupActions.getByRole("button",{name:"Back to Newsletters",exact:true}).click();
  await groupActions.getByRole("button",{name:"Mark Done: Newsletters",exact:true}).waitFor();
  await groupList.getByRole("button",{name:/^Northstar Weekly/}).click();
  const northstarIds=await groupList.locator(".message-wrap [data-done-ids]").evaluateAll(els=>els.map(el=>Number(el.dataset.doneIds)));
  assert.equal(northstarIds.length,6);
  await groupPage.keyboard.press("e");
  await groupActions.getByRole("button",{name:"Mark Done: Newsletters",exact:true}).waitFor();
  assert.deepEqual((await batchLog()).at(-1).args.threadIds,northstarIds,"Nested group Done affects only that sender and returns one level");
  await groupList.getByRole("button",{name:/^Northstar Weekly/}).click();
  await groupList.locator("button.row").first().click();
  await groupPage.locator(".reading-host .leading-actions").waitFor();
  await groupPage.keyboard.press("Escape");
  await groupActions.getByRole("button",{name:"Mark Undone: Northstar Weekly",exact:true}).waitFor();
  await groupPage.keyboard.press("Escape");
  await groupActions.getByRole("button",{name:"Mark Done: Newsletters",exact:true}).waitFor();
  await groupPage.keyboard.press("Escape");
  await groupPage.waitForFunction(()=>document.querySelector(".organize.drilldown")===null);

  await groupList.getByRole("button",{name:/^Notifications/}).click();
  const notificationIds=await groupList.locator(".message-wrap [data-done-ids]").evaluateAll(els=>els.map(el=>Number(el.dataset.doneIds)));
  await groupActions.getByRole("button",{name:"Mark Done: Notifications",exact:true}).click();
  await groupPage.waitForFunction(()=>document.querySelector(".organize.drilldown")===null);
  assert.deepEqual((await batchLog()).at(-1).args.threadIds,notificationIds);
  await groupList.locator(".priority").getByRole("button",{name:/^Show all/}).click();
  const priorityIds=await groupList.locator(".message-wrap [data-done-ids]").evaluateAll(els=>els.map(el=>Number(el.dataset.doneIds)));
  assert(priorityIds.length>5);
  await groupPage.keyboard.press("e");
  await groupPage.waitForFunction(()=>document.querySelector(".organize.drilldown")===null);
  assert.deepEqual((await batchLog()).at(-1).args.threadIds,priorityIds,"Priority group Done includes cards beyond the root's first five");

  // Navigating during a pending save keeps the user's newer location.
  await groupList.getByRole("button",{name:/^Anna Weber/}).click();
  await groupPage.evaluate(async()=>{
    const {api}=await import("/src/lib/api.ts");
    const original=api.setTasksDone;
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    window.releaseGroupSave=release;
    api.setTasksDone=async(...args)=>{await gate;api.setTasksDone=original;return original(...args);};
  });
  await groupActions.getByRole("button",{name:"Mark Done: Anna Weber",exact:true}).click();
  assert(await groupActions.locator(".done-action").isDisabled(),"A pending group save cannot be submitted twice");
  await groupActions.getByRole("button",{name:"Back to inbox",exact:true}).click();
  await groupList.getByRole("button",{name:/^Newsletters/}).click();
  await groupPage.evaluate(()=>window.releaseGroupSave());
  await groupActions.getByRole("button",{name:"Mark Done: Newsletters",exact:true}).waitFor();
  await groupPage.waitForFunction(()=>!document.querySelector(".organize .done-action")?.disabled);
  await groupList.locator(".group-heading").getByRole("heading",{name:"Newsletters",exact:true}).waitFor();

  // Sent sender groups use the same Back control without offering Done.
  await groupPage.evaluate(async()=>{
    const {THREADS_BY_FOLDER}=await import("/demo/mock/data.ts");
    THREADS_BY_FOLDER[3].push({...THREADS_BY_FOLDER[3][0],id:302,subject:"A second sent conversation"});
  });
  await groupPage.locator("nav.sidebar").getByRole("button",{name:/^Sent/}).click();
  await groupList.locator(".group-row .summary").filter({hasText:"Alex Morgan"}).click();
  assert.equal(await groupActions.getByRole("button").count(),1);
  await groupActions.getByRole("button",{name:"Back to Sent",exact:true}).waitFor();
  const beforeSent=(await batchLog()).length;
  await groupPage.keyboard.press("e");
  assert.equal((await batchLog()).length,beforeSent,"Done is never offered for a Sent group");
  await groupPage.keyboard.press("Escape");
  await groupPage.waitForFunction(()=>document.querySelector(".organize.drilldown")===null);
  await groupPage.close();

  // Home tracks Inbox visits, not read flags or the message's Date header.
  const homePage=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:"America/Chicago"});
  homePage.on("pageerror",error=>errors.push(error.message));
  await homePage.addInitScript(()=>{
    if(localStorage.getItem("skimdemo.settings")) return;
    localStorage.setItem("skimdemo.settings",JSON.stringify({active_account:"acc-1"}));
  });
  await homePage.goto("http://localhost:1421");
  await homePage.getByRole("heading",{name:"New Unread Emails",exact:true}).waitFor();
  const unreadBeforeVisit=await homePage.evaluate(async()=>{
    const {api}=await import("/src/lib/api.ts");return (await api.listTaskInbox("acc-1",false,true,0,100)).filter(row=>!row.isRead).length;
  });
  await homePage.getByRole("button",{name:"Check Inbox",exact:true}).click();
  await homePage.locator("nav.sidebar").getByRole("button",{name:"Home",exact:true}).click();
  await homePage.getByText("No New Emails",{exact:true}).waitFor();
  assert.equal(await homePage.locator(".mail-preview").count(),0);
  assert.equal(await homePage.evaluate(async()=>{
    const {api}=await import("/src/lib/api.ts");return (await api.listTaskInbox("acc-1",false,true,0,100)).filter(row=>!row.isRead).length;
  }),unreadBeforeVisit,"Visiting Inbox does not mark unread mail read");
  const otherSummary=await homePage.evaluate(async()=>(await import("/src/lib/api.ts")).api.listRecentUnread("acc-2"));
  assert(otherSummary.total>0,"Visiting one account leaves the other account's new unread intact");
  await homePage.reload();
  await homePage.getByText("No New Emails",{exact:true}).waitFor();
  await homePage.evaluate(async()=>{
    const {INBOX_THREADS}=await import("/demo/mock/data.ts");
    INBOX_THREADS.push({...INBOX_THREADS[0],id:9001,subject:"New arrival with yesterday's date",date:Math.floor(Date.now()/1000)-86400,isRead:false});
    const {mail}=await import("/src/lib/stores/mail.svelte.ts");await mail.refreshThreads();
  });
  await homePage.getByText("1 new unread email",{exact:true}).waitFor();
  await homePage.locator(".mail-preview").filter({hasText:"New arrival with yesterday's date"}).waitFor();
  await homePage.screenshot({path:new URL("../demo/output/home-new-unread.png",import.meta.url).pathname.replace(/^\/(\w:)/,"$1"),fullPage:true});
  await homePage.getByRole("button",{name:"Check Inbox",exact:true}).click();
  await homePage.locator("nav.sidebar").getByRole("button",{name:"Home",exact:true}).click();
  await homePage.getByText("No New Emails",{exact:true}).waitFor();
  await homePage.screenshot({path:new URL("../demo/output/home-no-new.png",import.meta.url).pathname.replace(/^\/(\w:)/,"$1"),fullPage:true});
  await homePage.close();
  const scenePage=await browser.newPage({viewport:{width:1280,height:900},timezoneId:"America/Chicago"});
  scenePage.on("pageerror",error=>errors.push(error.message));
  await scenePage.clock.setFixedTime(new Date("2026-11-06T06:35:00-06:00"));
  await scenePage.goto("http://localhost:1421");
  for(const [hour,id,image,greeting] of [[6,"dawn","home-nature.png","Good morning."],[9,"morning","home-morning.png","Good morning."],[15,"afternoon","home-afternoon.png","Good afternoon."],[19,"evening","home-evening.png","Good evening."],[22,"night","home-night.png","Good night."]]) {
    await scenePage.clock.setFixedTime(new Date(`2026-11-06T${String(hour).padStart(2,"0")}:35:00-06:00`));
    await scenePage.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await scenePage.waitForFunction(id=>document.querySelector(".home")?.getAttribute("data-scene")===id,id);
    await scenePage.getByRole("heading",{name:greeting,exact:true}).waitFor();
    assert((await scenePage.locator(".home").evaluate(el=>getComputedStyle(el).backgroundImage)).includes(image));
    const response=await scenePage.request.get(`http://localhost:1421/${image}`);
    assert.equal(response.status(),200,`${id} background is bundled and available offline`);
  }
  await scenePage.screenshot({path:new URL("../demo/output/home-night-live.png",import.meta.url).pathname.replace(/^\/(\w:)/,"$1"),fullPage:true});
  await scenePage.close();
  assert.deepEqual(errors, []);
  console.log("Inbox UI passed: unread alignment, mixed date sections, section/group Done, reader Back/Done and E, Home, sidebar, sender drill-down, Show Done, sweep batching, failure recovery, Priority and unified Sent.");
} finally {
  await browser?.close();
  server.kill();
}
