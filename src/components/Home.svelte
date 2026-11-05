<script lang="ts">
  import { onMount } from "svelte";
  import { api, reportError } from "../lib/api";
  import { mail } from "../lib/stores/mail.svelte";
  import { ui } from "../lib/stores/ui.svelte";
  import { palette } from "../lib/stores/palette.svelte";
  import type { ThreadRow } from "../lib/types";
  let now = $state(new Date());
  let composeError = $state(false);
  let composing = $state(false);
  let recentFailed = $state(false);
  let recent = $state<ThreadRow[]>([]);
  let newUnread = $state(0);
  let recentLoaded = $state(false);
  onMount(() => {
    const timer = setInterval(() => now = new Date(), 60000);
    return () => clearInterval(timer);
  });
  const greeting = $derived(now.getHours() < 12 ? "Good morning." : now.getHours() < 18 ? "Good afternoon." : "Good evening.");
  const clockParts = $derived(new Intl.DateTimeFormat(undefined, {hour:"numeric",minute:"2-digit"}).formatToParts(now));
  const clockTime = $derived(clockParts.filter(part => part.type !== "dayPeriod").map(part => part.value).join("").trim());
  const clockPeriod = $derived(clockParts.find(part => part.type === "dayPeriod")?.value);
  const inbox = $derived(mail.folders.find(folder => folder.role === "inbox"));
  $effect(() => {
    void mail.threads;
    if (!mail.accounts.length) return;
    const account = mail.unified ? null : mail.account?.id ?? null;
    let active = true;
    void mail.newUnread(account).then(summary => { if (active) { recent = summary.rows; newUnread = summary.total; recentFailed = false; recentLoaded = true; } })
      .catch(error => { if (active) { recentFailed = true; recentLoaded = true; } reportError("home.unread", error); });
    return () => { active = false; };
  });
  $effect(() => {
    if (inbox && inbox.id !== mail.selectedFolderId) void mail.selectFolder(inbox.id);
  });
  async function enter() {
    mail.selectedThreadId = null;
    mail.selectedMessageId = null;
    ui.showInbox();
    if (inbox && inbox.id !== mail.selectedFolderId) await mail.selectFolder(inbox.id);
  }
  async function open(row: ThreadRow) {
    await enter();
    mail.selectedThreadId = row.id;
    mail.selectedMessageId = row.messageId ?? null;
  }
  async function compose() {
    if (composing) return;
    composing = true;
    composeError = false;
    try {
      const draft = await api.createDraft(await mail.composeAccountId());
      ui.openComposer(draft);
    } catch (error) {
      reportError("home.compose", error);
      composeError = true;
    } finally { composing = false; }
  }
  function time(date: number) {
    const d = new Date(date * 1000);
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
</script>

<section class="home" aria-label="Home">
  <div class="topline">
    <div><time class="date" datetime={now.toISOString()}>{now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</time>
      <time class="clock" datetime={now.toISOString()}><span>{clockTime}</span>{#if clockPeriod}<span class="period">{clockPeriod}</span>{/if}</time></div>
    <div class="tools">
      <button onclick={() => palette.show()} aria-label="Search mail" title="Search mail · Ctrl+K">
        <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.8"/><path d="m13 13 4.5 4.5"/></svg>
      </button>
      <button onclick={() => void compose()} disabled={composing} aria-label="Compose" title="Compose · Ctrl+N">
        <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13 3 4 4-9 9-5 1 1-5zM11 5l4 4"/></svg>
      </button>
    </div>
  </div>
  <div class="welcome">
    <h1>{greeting}</h1>
    <button class="enter" onclick={() => void enter()}>Check Inbox</button>
    <p class="status">{#if mail.loadFailed || recentFailed}Mail couldn't load. Open Inbox to retry.
      {:else if !recentLoaded}Checking for new mail…
      {:else if newUnread > 0}{newUnread.toLocaleString()} new unread {newUnread === 1 ? "email" : "emails"}
      {:else}No New Emails{/if}</p>
    {#if composeError}<p class="error" role="alert">Couldn't open the composer. Please try again.</p>{/if}
    {#if recent.length}
      <div class="latest"><h2>New Unread Emails</h2><ul>
        {#each recent as row (row.messageId ?? row.id)}
          <li><button class="mail-preview" onclick={() => void open(row)}>
            <span class="sender">{row.fromName || row.fromAddr}</span>
            <span class="subject">{row.subject || "No subject"}</span><time>{time(row.date)}</time>
          </button></li>
        {/each}
      </ul></div>
    {/if}
  </div>
</section>

<style>
  .home { position:relative; isolation:isolate; flex:1; overflow:auto; display:flex; flex-direction:column; padding:54px 64px 36px; color:#fff; background:#17342f; background-image:linear-gradient(180deg,#10241c26 0%,#071a2252 55%,#0818207a 100%),url("/home-nature.png"); background-size:cover; background-position:center; }
  .topline { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
  .date { font-size:14px; font-weight:450; color:#ffffffe0; } .clock { display:flex; align-items:baseline; gap:9px; margin-top:10px; font-size:40px; line-height:1.12; font-weight:320; letter-spacing:-1.4px; font-variant-numeric:tabular-nums; } .period { font-size:17px; font-weight:400; letter-spacing:0; color:#ffffffd9; }
  .tools { display:flex; gap:10px; }
  .tools button { display:grid; place-items:center; width:42px; height:42px; padding:0; border:1px solid #ffffff35; border-radius:50%; color:#ffffffeb; background:#102c2824; }
  .tools button:hover { background:#ffffff20; } .tools button:disabled { opacity:.5; }
  .welcome { width:min(820px,100%); margin:auto; padding:48px 0 68px; text-align:center; }
  h1 { margin:0 0 26px; font-size:clamp(36px,5vw,52px); font-weight:510; letter-spacing:-1.65px; line-height:1.12; text-shadow:0 2px 24px #10251a20; }
  .enter { display:inline-flex; align-items:center; min-height:46px; padding:13px 25px; border:1px solid #ffffff4d; border-radius:28px; background:#f3f7f1; color:#18382f; font-weight:600; font-size:13px; box-shadow:0 4px 24px #0b1d1512; }
  .enter:hover { background:#fff; } .status { margin:16px 0 0; font-size:12px; color:#ffffffe0; }
  .latest { margin:40px auto 0; text-align:left; width:100%; }
  h2 { font-size:12px; font-weight:500; color:#ffffffe0; margin:0 16px 12px; }
  ul { padding:0; margin:0; list-style:none; border:1px solid #ffffff1c; border-radius:14px; background:#09262ba3; overflow:hidden; }
  li+li { border-top:1px solid #ffffff14; }
  .mail-preview { display:grid; grid-template-columns:minmax(100px,22%) minmax(0,1fr) 60px; gap:18px; align-items:center; width:100%; min-height:53px; padding:14px 20px; color:#fff; text-align:left; font-size:12.5px; }
  .mail-preview:hover { background:#ffffff0c; }
  .sender,.subject { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sender { font-weight:600; } .subject { color:#ffffffe8; } .mail-preview time { font-size:10px; color:#ffffffca; text-align:right; }
  .home :focus-visible { outline:2px solid #fff; outline-offset:3px; }
  .error { margin:12px; font-size:12px; }
  @media(max-width:650px) { .home { padding:40px 26px 24px; } .date { font-size:12px; } .clock { font-size:36px; } .tools { gap:8px; } .tools button { width:38px; height:38px; } .mail-preview { grid-template-columns:minmax(80px,30%) minmax(0,1fr); gap:12px; padding:14px; } .mail-preview time { display:none; } }
  @media(max-height:700px) { .welcome { padding:30px 0; } h1 { font-size:40px; margin-bottom:20px; } .latest { margin-top:22px; } }
</style>
