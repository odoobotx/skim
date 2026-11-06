<script lang="ts">
  import { onMount } from "svelte";
  import { api, reportError } from "../lib/api";
  import { mail } from "../lib/stores/mail.svelte";
  import { ui } from "../lib/stores/ui.svelte";
  import { palette } from "../lib/stores/palette.svelte";
  import { homeScene } from "../lib/home-scene";
  import { homeBackgrounds } from "../lib/stores/home-backgrounds.svelte";
  import type { ThreadRow } from "../lib/types";
  let now = $state(new Date());
  let composeError = $state(false);
  let composing = $state(false);
  let recentFailed = $state(false);
  let recent = $state<ThreadRow[]>([]);
  let newUnread = $state(0);
  let recentLoaded = $state(false);
  const glowAllowed = window.matchMedia("(hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference)");
  let glowFrame = 0;
  let glowPoint: {button: HTMLButtonElement; x: number; y: number} | null = null;
  onMount(() => {
    void homeBackgrounds.load();
    const refreshClock = () => now = new Date();
    const timer = setInterval(refreshClock, 60000);
    document.addEventListener("visibilitychange", refreshClock);
    window.addEventListener("focus", refreshClock);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshClock);
      window.removeEventListener("focus", refreshClock);
      cancelAnimationFrame(glowFrame);
    };
  });
  const scene = $derived(homeScene(now));
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
  function followGlow(event: PointerEvent) {
    if (event.pointerType !== "mouse" || !glowAllowed.matches) return;
    glowPoint = {button: event.currentTarget as HTMLButtonElement, x: event.clientX, y: event.clientY};
    if (glowFrame) return;
    glowFrame = requestAnimationFrame(() => {
      glowFrame = 0;
      const point = glowPoint;
      if (!point || !glowAllowed.matches || !point.button.matches(":hover")) return;
      const rect = point.button.getBoundingClientRect();
      point.button.style.setProperty("--glow-x", `${point.x - rect.left}px`);
      point.button.style.setProperty("--glow-y", `${point.y - rect.top}px`);
    });
  }
  function leaveGlow(event: PointerEvent) {
    if (glowPoint?.button !== event.currentTarget) return;
    cancelAnimationFrame(glowFrame);
    glowFrame = 0;
    glowPoint = null;
  }
</script>

<section class="home" class:night={scene.id === "night"} data-scene={scene.id} style:--home-image={`url("${homeBackgrounds.image(scene.id)}")`} aria-label="Home">
  <div class="topline">
    <div><time class="date" datetime={now.toISOString()}>{now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</time>
      <time class="clock" datetime={now.toISOString()}><span>{clockTime}</span>{#if clockPeriod}<span class="period">{clockPeriod}</span>{/if}</time></div>
    <div class="tools">
      <button class="glass" onpointerenter={followGlow} onpointermove={followGlow} onpointerleave={leaveGlow} onclick={() => palette.show()} aria-label="Search mail" title="Search mail · Ctrl+K">
        <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.8"/><path d="m13 13 4.5 4.5"/></svg>
      </button>
      <button class="glass" onpointerenter={followGlow} onpointermove={followGlow} onpointerleave={leaveGlow} onclick={() => void compose()} disabled={composing} aria-label="Compose" title="Compose · Ctrl+N">
        <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13 3 4 4-9 9-5 1 1-5zM11 5l4 4"/></svg>
      </button>
    </div>
  </div>
  <div class="welcome">
    <h1>{scene.greeting}</h1>
    <button class="enter glass" onpointerenter={followGlow} onpointermove={followGlow} onpointerleave={leaveGlow} onclick={() => void enter()}>Check Inbox</button>
    <p class="status">{#if mail.loadFailed || recentFailed}Mail couldn't load. Open Inbox to retry.
      {:else if !recentLoaded}Checking for new mail…
      {:else if newUnread > 0}{newUnread.toLocaleString()} new unread {newUnread === 1 ? "email" : "emails"}
      {:else}No New Emails{/if}</p>
    {#if composeError}<p class="error" role="alert">Couldn't open the composer. Please try again.</p>{/if}
    {#if recent.length}
      <div class="latest"><h2>New Unread Emails</h2><ul>
        {#each recent as row (row.messageId ?? row.id)}
          <li><button class="mail-preview glass" onpointerenter={followGlow} onpointermove={followGlow} onpointerleave={leaveGlow} onclick={() => void open(row)}>
            <span class="sender">{row.fromName || row.fromAddr}</span>
            <span class="subject">{row.subject || "No subject"}</span><time>{time(row.date)}</time>
          </button></li>
        {/each}
      </ul></div>
    {/if}
  </div>
</section>

<style>
  .home { position:relative; isolation:isolate; flex:1; overflow:auto; display:flex; flex-direction:column; padding:54px 64px 36px; color:#fff; background:#17342f; background-image:linear-gradient(180deg,#10241c26 0%,#071a2252 55%,#0818207a 100%),var(--home-image); background-size:cover; background-position:right center; }
  .home.night { background-image:linear-gradient(180deg,#06101c14,#06101c36),var(--home-image); }
  .topline { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
  .date { font-size:14px; font-weight:450; color:#ffffffe0; } .clock { display:flex; align-items:baseline; gap:9px; margin-top:10px; font-size:40px; line-height:1.12; font-weight:320; letter-spacing:-1.4px; font-variant-numeric:tabular-nums; } .period { font-size:17px; font-weight:400; letter-spacing:0; color:#ffffffd9; }
  .tools { display:flex; gap:10px; }
  .glass { color:#fff; background:linear-gradient(165deg,#ffffff22 0%,#ffffff05 54%,#ffffff0f 100%),#102b3338; border:1px solid #ffffff5c; box-shadow:inset 0 1px 0 #ffffff55,inset 0 -1px 0 #ffffff0d,0 5px 20px #061b1f1f; -webkit-backdrop-filter:blur(12px) saturate(1.08); backdrop-filter:blur(12px) saturate(1.08); }
  .glass { position:relative; isolation:isolate; overflow:hidden; text-shadow:0 1px 5px #06191f55; transition:transform 240ms cubic-bezier(.2,.7,.2,1),background-color 260ms ease,border-color 260ms ease,box-shadow 260ms ease; }
  .glass::before,.glass::after { content:""; position:absolute; pointer-events:none; z-index:-1; opacity:0; }
  .glass::before { inset:0; border-radius:inherit; background:linear-gradient(155deg,#ffffff28 0%,#ffffff0a 42%,transparent 72%); transition:opacity 280ms cubic-bezier(.2,.7,.2,1); }
  .glass::after { left:calc(var(--glow-size,160px) / -2); top:calc(var(--glow-size,160px) / -2); width:var(--glow-size,160px); height:var(--glow-size,160px); border-radius:50%; background:radial-gradient(circle,#ffffff1f 0%,#ffffff0d 26%,#ffffff03 48%,transparent 68%); transform:translate3d(var(--glow-x,0px),var(--glow-y,0px),0); transition:opacity 300ms ease,transform 100ms ease-out; }
  .glass:focus-visible::before { opacity:.5; }
  .tools button { --glow-size:100px; display:grid; place-items:center; width:42px; height:42px; padding:0; border-radius:50%; }
  .tools button:disabled { opacity:.5; }
  .enter:active:not(:disabled),.tools button:active:not(:disabled) { transform:translateY(0) scale(.985); transition-duration:120ms; }
  @media(hover:hover) and (pointer:fine) {
    .glass:hover:not(:disabled) { background-color:#173e484a; border-color:#ffffff80; }
    .glass:hover:not(:disabled)::before { opacity:.5; }
    .glass:hover:not(:disabled)::after { opacity:.6; }
    .enter:hover,.tools button:hover:not(:disabled) { transform:translateY(-1px); box-shadow:inset 0 1px 0 #ffffff70,inset 0 -1px 0 #ffffff0d,0 7px 22px #061b1f26; }
    .enter:active,.tools button:active:not(:disabled) { transform:translateY(0) scale(.985); }
  }
  .welcome { width:min(820px,100%); margin:auto; padding:48px 0 68px; text-align:center; }
  h1 { margin:0 0 26px; font-size:clamp(36px,5vw,52px); font-weight:510; letter-spacing:-1.65px; line-height:1.12; text-shadow:0 2px 24px #10251a20; }
  .enter { display:inline-flex; align-items:center; min-height:46px; padding:13px 25px; border-radius:28px; font-weight:600; font-size:13px; }
  .status { margin:16px 0 0; font-size:12px; color:#ffffffe0; }
  .latest { margin:40px auto 0; text-align:left; width:min(650px,100%); }
  h2 { font-size:12px; font-weight:500; color:#ffffffe0; margin:0 16px 12px; }
  ul { display:grid; gap:5px; padding:0; margin:0; list-style:none; }
  .mail-preview { display:grid; grid-template-columns:minmax(92px,25%) minmax(0,1fr) 56px; gap:14px; align-items:center; width:100%; min-height:36px; padding:8px 12px; border-radius:8px; border-color:#ffffff40; box-shadow:inset 0 1px 0 #ffffff26,0 3px 12px #061b1f18; color:#fff; text-align:left; font-size:12px; line-height:18px; }
  .sender,.subject { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sender { font-weight:600; } .subject { color:#ffffffe8; } .mail-preview time { font-size:10px; color:#ffffffca; text-align:right; }
  .home :focus-visible { outline:2px solid #fff; outline-offset:3px; }
  .mail-preview:focus-visible { outline-offset:-3px; }
  .error { margin:12px; font-size:12px; }
  @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))) { .glass { background:#163a43df; } }
  @media(prefers-reduced-transparency:reduce) { .glass,.glass:hover:not(:disabled) { background:#163a43; -webkit-backdrop-filter:none; backdrop-filter:none; } }
  @media(prefers-reduced-motion:reduce) {
    .glass { transition:none; }
    .home button.glass:hover,.home button.glass:active { transform:none; }
    .glass::before,.glass::after { transition:none; }
    .glass::after { display:none; }
  }
  @media(max-width:650px) { .home { padding:40px 26px 24px; } .date { font-size:12px; } .clock { font-size:36px; } .tools { gap:8px; } .tools button { width:38px; height:38px; } .mail-preview { grid-template-columns:88px minmax(0,1fr); gap:12px; } .mail-preview time { display:none; } }
  @media(pointer:coarse) { .mail-preview { min-height:44px; } }
  @media(max-height:700px) { .welcome { padding:30px 0; } h1 { font-size:40px; margin-bottom:20px; } .latest { margin-top:22px; } }
</style>
