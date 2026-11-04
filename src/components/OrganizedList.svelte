<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { reportError } from "../lib/api";
  import { senderGroups, groupInbox, inboxTimeline, isPriority, inboxSection, senderAddress, type Category, type SenderRule, type SenderRules } from "../lib/inbox";
  import { t } from "../lib/i18n/index.svelte";
  import { mail, rowKey } from "../lib/stores/mail.svelte";
  import type { ThreadRow } from "../lib/types";
  import MessageRow from "./MessageRow.svelte";

  let { rules, saveRule }: {
    rules: SenderRules;
    saveRule: (address: string, patch: SenderRule) => Promise<void>;
  } = $props();
  let category = $state<string | null>(null);
  let sender = $state<string | null>(null);
  let busy = $state<number[]>([]);
  let sweep = $state<number[]>([]);
  let snapshot = $state<ThreadRow[]>([]);
  const isInbox = $derived(mail.selectedFolder?.role === "inbox");
  let today = $state(new Date());
  let limit = $state(100);
  const displayRows = $derived(sweep.length ? snapshot : mail.threads);
  const priorityRows = $derived(displayRows.filter(row => inboxSection(row, rules) === "priority").sort((a,b)=>(b.priorityAt ?? 0)-(a.priorityAt ?? 0) || b.date-a.date));
  const priorityGroups = $derived(senderGroups(priorityRows, rules));
  const timeline = $derived(inboxTimeline(displayRows, rules, today, limit));
  const scoped = $derived(!isInbox || (category === null && sender === null) ? displayRows
    : displayRows.filter(row => inboxSection(row, rules) === (category ?? "mail")));
  const groups = $derived(senderGroups(scoped, rules));
  const opened = $derived(groups.find(group => group.key === sender));
  const openedRows = $derived(opened?.rows ?? []);

  onMount(() => {
    let timer: ReturnType<typeof setTimeout>;
    function updateDay() {
      clearTimeout(timer);
      today = new Date();
      const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      timer = setTimeout(updateDay, midnight.getTime() - today.getTime() + 50);
    }
    function resume() { if (!document.hidden) updateDay(); }
    updateDay();
    document.addEventListener("visibilitychange", resume);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", resume); };
  });

  // Folder/account switches must not inherit a previous sender drill-down.
  $effect(() => {
    void mail.selectedFolderId;
    void mail.unified;
    category = null;
    sender = null;
  });
  $effect(() => {
    const rows = sender !== null ? openedRows.slice(0, limit)
      : isInbox && category === null
        ? [...priorityGroups.slice(0,5).filter(g => g.rows.length === 1).flatMap(g => g.rows), ...timeline.sections.flatMap(section => section.groups).filter(g => g.kind === "mail" && g.rows.length === 1).flatMap(g => g.rows)]
        : groups.slice(0, limit).filter(g => g.rows.length === 1).flatMap(g => g.rows);
    mail.setNavigationRows(rows.map(rowKey));
  });
  onDestroy(() => mail.setNavigationRows(null));

  function navigate(nextCategory: string | null, nextSender: string | null = null) {
    mail.clearSelection();
    mail.selectedThreadId = null;
    mail.selectedMessageId = null;
    category = nextCategory;
    sender = nextSender;
    limit = 100;
  }

  async function done(row: ThreadRow) {
    if (busy.includes(rowKey(row))) return;
    busy = [...busy, rowKey(row)];
    try {
      await mail.setDone(row, !row.isDone);
    } catch (error) {
      reportError("inbox.done", error);
      mail.noteError(t("ops.failed"));
      await mail.refreshThreads();
    } finally {
      busy = busy.filter(key => key !== rowKey(row));
    }
  }

  async function priority(row: ThreadRow, value: boolean | null = !isPriority(row,rules)) {
    try { await mail.setPriority(row,value); }
    catch(error) { reportError("inbox.priority",error); mail.noteError(t("ops.failed")); }
  }

  let pointer: number | null = null;
  let previousY = 0;
  let sweepDone = true;
  let root: HTMLDivElement;

  async function complete(rows: ThreadRow[], done = !rows.every(row => row.isDone)) {
    if (!rows.length || busy.length) return;
    busy = rows.map(rowKey);
    try { await mail.setDoneRows(rows, done); }
    catch (error) { reportError("inbox.done", error); mail.noteError(t("ops.failed")); }
    finally { busy = []; }
  }
  function begin(rows: ThreadRow[], event: PointerEvent) {
    if (event.button !== 0 || busy.length || pointer !== null) return;
    event.preventDefault();
    pointer = event.pointerId;
    previousY = event.clientY;
    snapshot = [...mail.threads];
    sweepDone = !rows.every(row => row.isDone);
    sweep = rows.map(rowKey);
  }
  function move(event: PointerEvent) {
    if (pointer !== event.pointerId) return;
    if (!(event.buttons & 1)) { cancel(); return; }
    const low = Math.min(previousY, event.clientY), high = Math.max(previousY, event.clientY);
    const keys = new Set(sweep);
    for (const button of root.querySelectorAll<HTMLElement>("[data-done-ids]")) {
      const rect = button.getBoundingClientRect();
      if (event.clientX >= rect.left - 8 && event.clientX <= rect.right + 8 && high >= rect.top && low <= rect.bottom) {
        for (const id of button.dataset.doneIds!.split(",")) keys.add(Number(id));
      }
    }
    sweep = [...keys];
    previousY = event.clientY;
  }
  function finish(event: PointerEvent) {
    if (pointer !== event.pointerId) return;
    const keys = new Set(sweep);
    const rows = snapshot.filter(row => keys.has(rowKey(row)));
    cancel();
    void complete(rows, sweepDone);
  }
  function cancel() { pointer = null; sweep = []; snapshot = []; }
  let menu = $state<{row:ThreadRow;x:number;y:number} | null>(null);
  let menuEl = $state<HTMLDivElement>();
  function context(row:ThreadRow,event:MouseEvent) {
    if (!senderAddress(row)) return;
    event.preventDefault();
    const rect=(event.currentTarget as HTMLElement).getBoundingClientRect();
    menu={row,x:Math.max(8,Math.min(event.clientX || rect.left+20,window.innerWidth-250)),y:Math.max(8,Math.min(event.clientY || rect.top+20,window.innerHeight-325))};
  }
  $effect(() => { if (menu) menuEl?.querySelector<HTMLButtonElement>("button")?.focus(); });
  function dismiss(event:PointerEvent) { if (menu && !menuEl?.contains(event.target as Node)) menu=null; }
  function menuKey(event:KeyboardEvent) {
    event.stopPropagation();
    if (event.key === "Escape") { event.stopPropagation(); menu=null; }
    if (["ArrowDown","ArrowUp","Home","End"].includes(event.key)) {
      event.preventDefault();
      const buttons=[...menuEl!.querySelectorAll<HTMLButtonElement>("button")];
      const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length-1 : (index+(event.key === "ArrowDown" ? 1 : buttons.length-1))%buttons.length]?.focus();
    }
  }
  function choose(patch:SenderRule) {
    const row=menu?.row; menu=null;
    if (row) { sender=null; void saveRule(senderAddress(row),patch); }
  }
</script>

<svelte:window onpointermove={move} onpointerup={finish} onpointercancel={cancel} onblur={() => {cancel();menu=null;}} onpointerdown={dismiss} />
{#if menu}
  <div class="sender-menu" role="menu" tabindex="-1" bind:this={menuEl} style:left={`${menu.x}px`} style:top={`${menu.y}px`} onkeydown={menuKey}>
    <header>{menu.row.fromName}<br />{senderAddress(menu.row)}</header>
    <button role="menuitem" onclick={() => choose({group: !rules[senderAddress(menu!.row)]?.group})}>{rules[senderAddress(menu.row)]?.group ? "Ungroup Sender" : "Group by Sender"}</button>
    {#if isInbox}
      {#if !menu.row.isDone}<button role="menuitem" onclick={() => { const row=menu!.row; menu=null; void priority(row); }}>{isPriority(menu.row,rules) ? "Remove message Priority" : "Mark message Priority"}</button>{/if}
      {#if menu.row.priorityOverride != null}<button role="menuitem" onclick={() => {const row=menu!.row;menu=null;void priority(row,null);}}>Use sender's Priority setting</button>{/if}
      <button role="menuitem" onclick={() => choose({priority: !rules[senderAddress(menu!.row)]?.priority})}>{rules[senderAddress(menu.row)]?.priority ? "Remove Priority sender" : "Make Priority sender"}</button>
      <div class="section-label">Move sender to</div>
      <button role="menuitem" onclick={() => choose({category:"mail"})}>People</button>
      <button role="menuitem" onclick={() => choose({category:"notifications"})}>Notifications</button>
      <button role="menuitem" onclick={() => choose({category:"newsletters"})}>Newsletters</button>
    {/if}
  </div>
{/if}
<div bind:this={root} class="organized" class:sweeping={sweep.length > 0}>
<div class="organize">
  {#if category !== null || sender !== null}
    <button class="back" onclick={() => navigate(sender !== null ? category : null)}>
      ← {sender !== null ? t("inbox.back_senders") : t("inbox.back_inbox")}
    </button>
  {/if}
  <small>{t("inbox.loaded", { n: scoped.length })}</small>
</div>

{#snippet completion(label: string, rows: ThreadRow[])}
  <button class="group-done" data-done-ids={rows.map(rowKey).join(",")}
    aria-label={`${t(rows.every(row => row.isDone) ? "inbox.mark_undone" : "inbox.mark_done")}: ${label}`}
    aria-pressed={rows.every(row => row.isDone || sweep.includes(rowKey(row)))}
    onpointerdown={(event) => begin(rows, event)}
    onclick={(event) => { if (event.detail === 0) void complete(rows); }}
    class:staged={rows.some(row => sweep.includes(rowKey(row)))}>✓</button>
{/snippet}

{#snippet summary(label: string, rows: ThreadRow[], open: () => void, senderRow?: ThreadRow, kind: Category = "mail")}
  {@const unread = rows.filter(row => !row.isRead).length}
  <div class="group-row" class:completed={rows.every(row => row.isDone)} class:has-unread={unread > 0}>
  {#if isInbox}{@render completion(label, rows)}{/if}
  <button class="summary" onclick={open} oncontextmenu={(event) => { if (senderRow) context(senderRow,event); }}>
    {#if unread}<span class="unread-dot" aria-hidden="true"></span>{/if}
    <span class="summary-title">
      <span class="group-avatar" class:category-avatar={kind !== "mail"} aria-hidden="true">
        {#if kind === "notifications"}<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5h10l-1.5-2V6a3.5 3.5 0 0 0-7 0v3.5L3 11.5zM6.5 13.5h3" /></svg>
        {:else if kind === "newsletters"}<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2" width="11" height="12" rx="1.5" /><path d="M5 5h6M5 8h6M5 11h3" /></svg>
        {:else}{label.split(/\s+/).filter(Boolean).slice(0,2).map(word => Array.from(word)[0]).join("").toUpperCase()}{/if}
      </span>
      <span class="group-name">{label}</span><span class="count">{rows.length}</span><span class="arrow" aria-hidden="true">›</span>
    </span>
    <span class="preview">{kind === "mail" ? rows.slice(0,3).map(row => row.subject).join(" · ") : groupInbox(rows,"address").slice(0,3).map(group => `${group.rows[0].fromName || group.label}${group.rows.length > 1 ? ` ${group.rows.length}` : ""}`).join(" · ")}</span>
    <span class="unread">{unread ? t("list.unread", { n: unread }) : ""}</span>
  </button>
  </div>
{/snippet}

{#snippet message(row: ThreadRow)}
  <div class="message-wrap">
  <MessageRow thread={row}
    selected={mail.groupThreads ? mail.selectedThreadId === row.id : mail.selectedMessageId === row.messageId}
    checked={mail.isSelected(rowKey(row))}
    onselect={() => { mail.selectedThreadId = row.id; mail.selectedMessageId = row.messageId ?? null; }}
    ontoggle={(extend) => mail.toggleRow(rowKey(row), extend)}
    ondone={isInbox ? () => void done(row) : undefined}
    ondonepointer={isInbox ? (event) => begin([row], event) : undefined}
    priority={isPriority(row,rules)}
    onpriority={isInbox && !row.isDone ? () => void priority(row) : undefined}
    completing={sweep.includes(rowKey(row))}
    oncontextmenu={(event) => context(row,event)}
  />
  <button class="sender-menu-trigger" aria-label={`Sender options: ${row.fromName}`}
    onclick={(event) => context(row,event)}>···</button>
  </div>
{/snippet}

{#if isInbox && category === null && sender === null}
  {#if priorityRows.length}
    <div class="priority">
      <h2>{t("inbox.priority")}</h2>
      {#each priorityGroups.slice(0, 5) as group (group.key)}
        {#if group.rows.length === 1}{@render message(group.rows[0])}
        {:else}{@render summary(group.label,group.rows,() => navigate("priority",group.key),group.rows[0])}{/if}
      {/each}
      {#if priorityGroups.length > 5}
        <button class="more" onclick={() => navigate("priority")}>{t("inbox.show_priority", { n: priorityRows.length })}</button>
      {/if}
    </div>
  {/if}
  {#each timeline.sections as section (section.key)}
    {@const rows = section.groups.flatMap(group => group.rows)}
    <section class="date-section" aria-label={t(`inbox.date_${section.key}`)}>
      <header class="date-heading">
        {@render completion(t(`inbox.date_${section.key}`), rows)}
        <h2>{t(`inbox.date_${section.key}`)}</h2>
      </header>
      {#each section.groups as group (group.key)}
        {#if group.kind !== "mail"}
          {@render summary(t(`inbox.${group.kind}`), group.rows, () => navigate(group.kind),undefined,group.kind)}
        {:else if group.rows.length === 1}
          {@render message(group.rows[0])}
        {:else}
          {@render summary(group.label, group.rows, () => navigate(null, group.key),group.rows[0])}
        {/if}
      {/each}
    </section>
  {/each}
  {#if timeline.total > limit}<button class="more" onclick={() => limit += 100}>{t("inbox.show_more")}</button>{/if}
{:else if sender !== null}
  <h2>{opened?.label ?? t("inbox.empty_group")}</h2>
  {#each openedRows.slice(0, limit) as row (rowKey(row))}{@render message(row)}{/each}
  {#if openedRows.length > limit}<button class="more" onclick={() => limit += 100}>{t("inbox.show_more")}</button>{/if}
{:else}
  {#each groups.slice(0, limit) as group (group.key)}
    {#if group.rows.length === 1}
      {@render message(group.rows[0])}
    {:else}
      {@render summary(group.label, group.rows, () => navigate(category, group.key),group.rows[0])}
    {/if}
  {/each}
  {#if groups.length > limit}<button class="more" onclick={() => limit += 100}>{t("inbox.show_more")}</button>{/if}
{/if}

</div>
<style>
  .organized { padding:0 12px 28px; }
  .sweeping { user-select:none; }
  .message-wrap, .group-row { position:relative; }
  .group-done { position:absolute; z-index:2; left:8px; top:50%; transform:translateY(-50%); width:26px; height:28px; display:grid; place-items:center; opacity:0; color:var(--text-dim); border-radius:8px; touch-action:none; transition:opacity 120ms,background 120ms; }
  .group-row .group-done { top:25px; }
  .group-row:is(:hover,:focus-within) .group-done, .date-heading:is(:hover,:focus-within) .group-done, .group-done.staged { opacity:1; }
  .group-done:hover, .group-done.staged { color:var(--accent); background:color-mix(in srgb,var(--accent) 16%,transparent); }
  .unread-dot { position:absolute; left:18px; top:25px; transform:translateY(-50%); width:6px; height:6px; border-radius:50%; background:var(--accent); pointer-events:none; transition:opacity 120ms; }
  .group-row:has(.group-done):is(:hover,:focus-within) .unread-dot { opacity:0; }
  .date-section { margin-top:14px; }
  .date-heading { position:relative; }
  .date-heading h2 { padding:12px 42px; font-weight:500; color:var(--text-dim); }
  .completed .summary { opacity:.48; }
  .sender-menu-trigger { position:absolute; right:10px; top:50%; transform:translateY(-50%); padding:6px; border-radius:6px; opacity:0; color:var(--text-dim); }
  .message-wrap:hover .sender-menu-trigger, .sender-menu-trigger:focus-visible { opacity:1; }
  .sender-menu { position:fixed; z-index:200; width:240px; padding:6px; border:1px solid var(--hairline); border-radius:12px; background:var(--surface); color:var(--text); box-shadow:0 12px 40px #0003; }
  .sender-menu header { padding:10px; font-size:11px; color:var(--text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-bottom:1px solid var(--hairline); margin-bottom:4px; }
  .sender-menu button { display:block; width:100%; text-align:left; padding:10px; border-radius:7px; font-size:12px; }
  .sender-menu button:hover, .sender-menu button:focus-visible { background:var(--hover); }
  .sender-menu .section-label { padding:10px 10px 4px; font-size:10px; color:var(--text-faint); }
  @media(hover:none) { .group-done, .sender-menu-trigger { opacity:1; } .group-row:has(.group-done) .unread-dot { opacity:0; } }
  .organize { padding: 8px 16px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-bottom: 1px solid var(--hairline); }
  small, .back, .unread { font-size: 11px; color: var(--text-faint); }
  small { width: 100%; }
  .summary { display: block; width: 100%; text-align: left; padding: 12px 42px; border-bottom: 1px solid var(--hairline); border-radius:10px; transition:background 120ms; }
  .summary:hover { background: var(--hover); }
  .summary-title { display: flex; min-width:0; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 500; }
  .has-unread .summary-title { font-weight:600; }
  .group-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .group-avatar { width:26px; height:26px; border-radius:50%; flex-shrink:0; display:grid; place-items:center; font-size:9px; font-weight:600; color:var(--text-dim); background:color-mix(in srgb,var(--accent) 10%,var(--bg)); border:1px solid color-mix(in srgb,var(--accent) 18%,transparent); }
  .category-avatar { color:var(--accent); }
  .count { flex-shrink:0; font-size: 11px; font-weight: 400; color: var(--text-faint); }
  .arrow { margin-left: auto; }
  .preview { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 4px 0; font-size: 12px; color: var(--text-dim); }
  .priority { margin:12px 0; border-radius:14px; background:var(--priority-bg); border:1px solid var(--priority-border); }
  .priority h2 { color:var(--accent); }
  h2 { font-size: 13px; padding: 12px 16px; }
  .more { width: 100%; padding: 12px 16px; font-size: 12px; color: var(--text-dim); text-align: left; }
  @media(prefers-reduced-motion:reduce) { .summary, .group-done, .unread-dot { transition:none; } }
</style>
