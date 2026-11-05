<script lang="ts">
  import { t } from "../lib/i18n/index.svelte";
  import { ui } from "../lib/stores/ui.svelte";
  import ComposeForm from "./ComposeForm.svelte";

  let forms = $state<Record<number, ComposeForm>>({});
  const active = $derived(ui.composeDrafts.find(draft => draft.id === ui.activeComposeId));
  function keydown(event: KeyboardEvent) {
    if (active) forms[active.id]?.handleShortcut(event);
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (ui.composeExpanded) ui.toggleComposeExpanded(); else ui.minimizeComposer();
    }
  }
</script>

{#if active}
  <div class="compose-dock" role="dialog" aria-modal="false" tabindex="-1" class:expanded={ui.composeExpanded} class:minimized={ui.composeMinimized} aria-label={t("compose.editor")} onkeydown={keydown}>
    <header class="dock-header">
      {#if ui.composeMinimized}
        <button class="restore-title" onclick={() => ui.activateComposer(active.id)} title={t("compose.restore")}>{active.title || t("compose.new")}</button>
      {:else}<h2>{active.title || t("compose.new")}</h2>{/if}
      <div class="dock-controls">
        <button aria-label={ui.composeMinimized ? t("compose.restore") : t("compose.minimize")} title={ui.composeMinimized ? t("compose.restore") : t("compose.minimize")} onclick={() => ui.composeMinimized ? ui.activateComposer(active.id) : ui.minimizeComposer()}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d={ui.composeMinimized ? "m5 12 5-5 5 5" : "M5 13h10"} /></svg>
        </button>
        <button aria-label={ui.composeExpanded ? t("compose.restore_size") : t("compose.expand")} title={ui.composeExpanded ? t("compose.restore_size") : t("compose.expand")} onclick={() => ui.toggleComposeExpanded()}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={ui.composeExpanded ? "M7 3v4H3m10 10v-4h4M7 7 3 3m10 10 4 4" : "M12 3h5v5M8 17H3v-5m14-9-5 5M3 17l5-5"} /></svg>
        </button>
        <button aria-label={t("compose.popout")} title={t("compose.popout")} onclick={() => void forms[active.id]?.popOut()}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 3h6v6m0-6-8 8M7 4H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-3" /></svg>
        </button>
        <button aria-label={t("compose.close")} title={t("compose.close")} onclick={() => void forms[active.id]?.close()}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg>
        </button>
      </div>
    </header>
    {#if ui.composeDrafts.length > 1 && !ui.composeMinimized}
      <nav class="draft-tabs" aria-label={t("compose.open_drafts")}>
        {#each ui.composeDrafts as draft (draft.id)}<button class:active={draft.id === active.id} aria-pressed={draft.id === active.id} onclick={() => ui.activateComposer(draft.id)}>{draft.title || t("compose.new")}</button>{/each}
      </nav>
    {/if}
    {#each ui.composeDrafts as draft (draft.id)}
      <div class="draft-host" hidden={draft.id !== active.id || ui.composeMinimized}>
        <ComposeForm bind:this={forms[draft.id]} draftId={draft.id} active={draft.id === active.id && !ui.composeMinimized} expanded={ui.composeExpanded}
          onSent={() => ui.closeComposer(draft.id)} onDiscarded={() => ui.closeComposer(draft.id)} onClose={() => ui.closeComposer(draft.id)} onLocalSave={ui.updateComposer} />
      </div>
    {/each}
  </div>
{/if}

<style>
  .compose-dock { position:fixed; z-index:90; right:20px; bottom:20px; width:min(640px,calc(100vw - 40px)); height:min(560px,calc(100dvh - var(--titlebar-h) - 40px)); display:flex; flex-direction:column; min-height:0; overflow:hidden; border:1px solid var(--hairline-strong); border-radius:16px; background:var(--surface); box-shadow:0 18px 70px #0005,0 2px 8px #0002; }
  .compose-dock.expanded { inset:var(--titlebar-h) 0 0; width:auto; height:auto; border:0; border-radius:0; box-shadow:none; }
  .compose-dock.minimized { height:auto; width:min(340px,calc(100vw - 40px)); }
  .dock-header { display:flex; align-items:center; gap:12px; min-height:48px; padding:6px 10px 6px 20px; flex-shrink:0; border-bottom:1px solid var(--hairline); background:var(--bg); }
  h2, .restore-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:600; text-align:left; }
  .dock-controls { display:flex; align-items:center; gap:2px; flex-shrink:0; }
  .dock-controls button { display:grid; place-items:center; width:30px; height:30px; border-radius:8px; color:var(--text-dim); transition:background 120ms,color 120ms; }
  .dock-controls button:hover { color:var(--text); background:var(--hover); }
  .dock-controls button:focus-visible, .restore-title:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .draft-tabs { display:flex; gap:6px; padding:8px 16px; overflow-x:auto; flex-shrink:0; border-bottom:1px solid var(--hairline); }
  .draft-tabs button { max-width:180px; flex-shrink:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; padding:5px 9px; border-radius:7px; font-size:11px; color:var(--text-dim); }
  .draft-tabs button.active { color:var(--text); background:var(--selected); }
  .draft-host { flex:1; min-height:0; display:flex; }
  .draft-host[hidden] { display:none; }
  @media(prefers-reduced-motion:reduce) { .dock-controls button { transition:none; } }
</style>
