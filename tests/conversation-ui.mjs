import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";

// Isolated, synthetic mail only. Never reads the installed client's profile.
const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--config","demo/vite.demo.config.ts","--port","1424"],{cwd:new URL("..",import.meta.url),windowsHide:true,stdio:"pipe"});
let output="",browser;
server.stdout.on("data",chunk=>output+=chunk);server.stderr.on("data",chunk=>output+=chunk);
try {
  for(let attempt=0;attempt<60;attempt++) {
    if(server.exitCode!==null) throw Error(output);
    try {if((await fetch("http://localhost:1424")).ok) break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
    if(attempt===59) throw Error(output);
  }
  browser=await chromium.launch({headless:true,executablePath:process.env.SKIM_TEST_BROWSER || undefined});
  const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:"America/Chicago"});
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.addInitScript(()=>{localStorage.setItem("skimdemo.taskInbox","on");localStorage.setItem("skimdemo.multiaccount","on");});
  await page.goto("http://localhost:1424");
  await page.locator('.mail-preview').filter({hasText:'Anna Weber'}).first().click();
  const reader=page.locator(".reading-host"),cards=reader.locator(".conversation-card"),scroll=reader.locator(".scroll"),dock=page.locator(".compose-dock");
  const calls=cmd=>page.evaluate(async cmd=>(await import("/demo/mock/tauri-core.ts")).commandLog.filter(call=>call.cmd===cmd),cmd);
  const atBottom=()=>page.waitForFunction(()=>{const el=document.querySelector(".reading-host .scroll");return el && el.scrollHeight>el.clientHeight && el.scrollHeight-el.clientHeight-el.scrollTop<3;});
  await cards.nth(4).locator("iframe").waitFor();
  await atBottom();
  assert.equal(await cards.count(),5);
  assert.equal(await cards.locator("article.message").count(),5,"Every email is an expanded card");
  assert.equal(await reader.locator(".chat-row").count(),0);
  const dimensions=await cards.evaluateAll(nodes=>nodes.map(node=>({x:node.getBoundingClientRect().x,width:node.getBoundingClientRect().width})));
  assert(dimensions.every(box=>box.x===dimensions[0].x && box.width===dimensions[0].width),"Incoming and outgoing cards share clean edges");
  const ids=await cards.evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.messageId)));
  assert.deepEqual(ids,[10110,10111,10112,10113,1011],"Messages run oldest to newest");
  await page.frameLocator(`.conversation-card[data-message-id="${ids.at(-1)}"] iframe`).first().getByText("The release notes are attached. We are ready for Thursday.",{exact:true}).waitFor();
  assert.equal(await reader.locator(".history-card").count(),0,"Quoted history is hidden initially");
  await mkdir(new URL("../demo/output/",import.meta.url),{recursive:true});
  await page.screenshot({path:fileURLToPath(new URL("../demo/output/conversation-cards.png",import.meta.url))});

  // Expanding one email reveals only its actual quoted history, as inner cards.
  await cards.last().getByRole("button",{name:"Show quoted history",exact:true}).click();
  await cards.last().locator(".history-card").nth(3).waitFor();
  assert.equal(await cards.last().locator(".history-card").count(),4);
  assert.equal(await cards.first().locator(".history-card").count(),0);
  assert.deepEqual(await cards.last().locator(".history-meta strong").allTextContents(),["Alex Morgan","Anna Weber","Alex Morgan","Anna Weber"]);
  await cards.last().locator(".history-card").first().scrollIntoViewIfNeeded();
  await page.screenshot({path:fileURLToPath(new URL("../demo/output/conversation-history.png",import.meta.url))});
  await cards.last().getByRole("button",{name:"Hide quoted history",exact:true}).click();

  // Reply, Reply All and Forward use the selected card, including sent cards.
  for(const [index,mode,label] of [[1,"reply","Reply"],[0,"reply_all","Reply all"],[2,"forward","Forward"]]) {
    await cards.nth(index).getByRole("button",{name:label,exact:true}).click();
    const form=dock.locator(".draft-host:not([hidden]) .compose-form");
    await form.getByRole("textbox",{name:"Message body",exact:true}).waitFor();
    const request=(await calls("get_reply_template")).at(-1);
    assert.equal(request.args.messageId,ids[index]);assert.equal(request.args.mode,mode);
    const to=await form.getByRole("textbox",{name:"To",exact:true}).inputValue();
    if(mode==="forward") assert.equal(to,"");
    else {assert(to.includes("anna.weber@northwind.example"));assert(!to.includes("alex@brightwave.io"));}
    if(mode==="reply_all") assert(to.includes("sam@northwind.example"));
    await dock.getByRole("button",{name:"Close and save draft",exact:true}).click();
    await dock.waitFor({state:"hidden"});
  }

  // Keyboard shortcuts inside an older message use that message's context.
  await page.frameLocator(`.conversation-card[data-message-id="${ids[0]}"] iframe`).first().locator("p").first().click();
  await page.keyboard.press("r");
  await dock.getByRole("textbox",{name:"Message body",exact:true}).waitFor();
  assert.equal((await calls("get_reply_template")).at(-1).args.messageId,ids[0]);
  await dock.getByRole("button",{name:"Close and save draft",exact:true}).click();
  await dock.waitFor({state:"hidden"});

  // Copy menus remain local to the selected text with several live iframes.
  for(const index of [0,1]) {
    const paragraph=page.frameLocator(`.conversation-card[data-message-id="${ids[index]}"] iframe`).first().locator("p").first();
    await paragraph.evaluate(el=>{const range=el.ownerDocument.createRange(),selection=el.ownerDocument.getSelection();range.selectNodeContents(el);selection.removeAllRanges();selection.addRange(range);});
    await paragraph.click({button:"right",position:{x:5,y:8}});
    await page.getByRole("menuitem",{name:/^Copy/}).waitFor();
    assert.equal(await page.getByRole("menu",{name:"Copy",exact:true}).count(),1,"Opening another card's menu dismisses the first");
  }
  await page.getByRole("menuitem",{name:/^Copy/}).press("Escape");
  assert.equal(await cards.count(),5,"Escape from Copy keeps the conversation open");

  // The reply account follows the individual email in a unified inbox.
  await reader.getByRole("button",{name:"Back to list",exact:true}).click();
  await page.locator("section.list button.row").filter({hasText:"Tomas Rivera"}).first().click();
  await cards.nth(1).locator("iframe").waitFor();
  await cards.first().getByRole("button",{name:"Reply",exact:true}).click();
  await dock.getByRole("textbox",{name:"Message body",exact:true}).waitFor();
  const secondaryDraft=await page.evaluate(async()=>{
    const {ui}=await import("/src/lib/stores/ui.svelte.ts");const {getDraft}=await import("/demo/mock/data.ts");return getDraft(ui.activeComposeId);
  });
  assert.equal(secondaryDraft.accountId,"acc-2");assert(secondaryDraft.to.includes("tomas.r@gmail.example"));
  await dock.getByRole("button",{name:"Close and save draft",exact:true}).click();await dock.waitFor({state:"hidden"});

  // A concrete message ID from Home/search must not silently disable grouped cards.
  for(let attempt=0;attempt<2;attempt++) {
    await page.evaluate(async()=>{
      const {mail}=await import('/src/lib/stores/mail.svelte.ts');
      await mail.setGroupThreads(false);mail.selectedThreadId=101;mail.selectedMessageId=1011;
    });
    await reader.getByRole('button',{name:'Show quoted history',exact:true}).waitFor();
    assert.equal(await cards.count(),0,'Flat view targets one message');
    await reader.getByRole('button',{name:'Show quoted history',exact:true}).click();
    await reader.locator('.history-card').nth(3).waitFor();
    assert.equal(await reader.locator('.history-card').count(),4,'Quoted history still uses cards in flat view');
    const groupedId=await page.evaluate(async()=>{
      const {mail}=await import('/src/lib/stores/mail.svelte.ts');
      await mail.setGroupThreads(true);mail.selectedThreadId=101;mail.selectedMessageId=1011;return mail.selectedMessageId;
    });
    assert.equal(groupedId,null,'Grouped navigation ignores row-level message IDs');
    await cards.nth(4).locator('iframe').waitFor();
    assert.equal(await cards.count(),5,'Reopening retains the full conversation');
  }

  // A long chain loads nearby bodies, keeps position on refresh and follows new mail only at the bottom.
  await reader.getByRole("button",{name:"Back to list",exact:true}).click();
  await page.evaluate(async()=>{
    const {api}=await import("/src/lib/api.ts");
    const base=await api.getThread(101), originalGetThread=api.getThread,originalGetBody=api.getMessageBody;
    window.conversationFixture=Array.from({length:100},(_,i)=>({...base.messages[0],id:70000+i,date:base.messages[0].date+i*60,snippet:`Long conversation ${i+1}`}));
    window.conversationBodyRequests=[];window.conversationThreadRequests=0;window.conversationFailBody=true;
    api.getThread=async id=>{if(id!==101) return originalGetThread(id);window.conversationThreadRequests++;return {...base,messages:window.conversationFixture.map(m=>({...m}))};};
    api.getMessageBody=async id=>{
      if(id<70000) return originalGetBody(id);
      window.conversationBodyRequests.push(id);
      if(id===70000 && window.conversationFailBody) throw Error("Synthetic body unavailable");
      await new Promise(resolve=>setTimeout(resolve,25));
      return {messageId:id,html:`<p>Message ${id-69999} — full authored content.</p><p>Another paragraph for comfortable reading.</p>`,blockedImages:0,fromAddr:null,attachments:[],invite:null,security:null};
    };
  });
  await page.locator("section.list button.row").filter({hasText:"Anna Weber"}).first().click();
  await cards.nth(99).locator("iframe").waitFor();await atBottom();
  const fetched=await page.evaluate(()=>window.conversationBodyRequests.length);
  assert(fetched<35,`Opening 100 messages should fetch a small nearby set, got ${fetched}`);
  await scroll.hover({position:{x:20,y:150}});await page.mouse.wheel(0,-650);
  await page.waitForFunction(()=>{const el=document.querySelector(".reading-host .scroll");return el.scrollHeight-el.clientHeight-el.scrollTop>250;});
  await page.waitForTimeout(150);
  const before=await scroll.evaluate(el=>el.scrollTop);
  const frameHandle=await cards.last().locator("iframe").elementHandle();
  await page.evaluate(async()=>{
    const {mail}=await import("/src/lib/stores/mail.svelte.ts");
    const last=window.conversationFixture.at(-1);window.conversationFixture.push({...last,id:last.id+1,date:last.date+60});
    mail.patchThreadRow(101,{messageCount:101,date:last.date+60});
  });
  await cards.nth(100).waitFor();await page.waitForTimeout(150);
  assert(Math.abs((await scroll.evaluate(el=>el.scrollTop))-before)<3,"New mail must not yank the reader to the bottom");
  assert(await frameHandle.evaluate(el=>el.isConnected),"Refresh keeps loaded iframe documents mounted");
  await scroll.evaluate(el=>el.scrollTop=el.scrollHeight);await atBottom();await page.waitForTimeout(150);
  await page.evaluate(async()=>{
    const {mail}=await import("/src/lib/stores/mail.svelte.ts");
    const last=window.conversationFixture.at(-1);window.conversationFixture.push({...last,id:last.id+1,date:last.date+60});
    mail.patchThreadRow(101,{messageCount:102,date:last.date+60});
  });
  await cards.nth(101).locator("iframe").waitFor();await atBottom();
  await cards.first().scrollIntoViewIfNeeded();
  await cards.first().getByRole("button",{name:"Retry",exact:true}).waitFor();
  await page.evaluate(()=>window.conversationFailBody=false);
  await cards.first().getByRole("button",{name:"Retry",exact:true}).click();
  await page.frameLocator('.conversation-card[data-message-id="70000"] iframe').getByText("Message 1 — full authored content.",{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.conversationBodyRequests.filter(id=>id===70000).length),2);
  await reader.getByRole("button",{name:"Back to list",exact:true}).click();
  await page.locator("nav.sidebar").getByRole("button",{name:/Settings$/}).click();
  await page.getByLabel("All inboxes reading layout",{exact:true}).selectOption("split");
  await page.locator(".overlay .close").click();
  await page.locator("section.list button.row").filter({hasText:"Marcus Lee"}).first().click();
  await cards.nth(1).locator("iframe").waitFor();
  assert(await page.locator(".list-host.split").isVisible());
  assert.equal(await cards.locator("footer.card-actions").count(),2,"Split layout uses the same expanded cards");
  await page.screenshot({path:fileURLToPath(new URL("../demo/output/conversation-split.png",import.meta.url))});
  assert.deepEqual(errors,[]);
  console.log("Conversation UI passed: expanded chronological cards, bottom opening, nested quoted history, per-message replies, iframe shortcuts, lazy loading, retry and scroll-preserving refresh.");
} finally {await browser?.close();server.kill();}
