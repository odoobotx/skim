<script lang="ts">
  import { t } from "../lib/i18n/index.svelte";

  let { onback, ondone, backLabel, doneLabel, done = false, disabled = false }: {
    onback?: () => void;
    ondone?: () => void;
    backLabel?: string;
    doneLabel?: string;
    done?: boolean;
    disabled?: boolean;
  } = $props();
  const backText = $derived(backLabel ?? t("reading.back_to_list"));
  const doneText = $derived(doneLabel ?? t(done ? "inbox.mark_undone" : "inbox.mark_done"));
</script>

<div class="leading-actions" role="group" aria-label={onback && ondone ? t("inbox.back_done") : onback ? backText : doneText}>
  {#if onback}
    <button class="back-control" onclick={onback} aria-label={backText} title={`${backText} (Esc)`}>
      <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 10H4m6-6-6 6 6 6" /></svg>
    </button>
  {/if}
  {#if ondone}
    <button class="done-action" onclick={ondone} aria-label={doneText} title={`${doneText} (E)`} aria-pressed={done} {disabled}>
      <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 10 3.5 3.5L15.5 6" /></svg>
    </button>
  {/if}
</div>

<style>
  .leading-actions { display:inline-flex; flex-shrink:0; align-items:center; gap:2px; padding:3px; border:1px solid var(--hairline); border-radius:24px; background:var(--hover); }
  button { display:grid; place-items:center; width:34px; height:32px; border-radius:50%; color:var(--text-dim); transition:background 120ms,color 120ms; }
  button:hover { background:var(--hover); color:var(--text); }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .done-action { color:var(--accent); background:color-mix(in srgb,var(--accent) 10%,transparent); }
  .done-action:hover { color:var(--accent); background:color-mix(in srgb,var(--accent) 20%,transparent); }
  button:disabled { opacity:.45; cursor:default; }
  @media(prefers-reduced-motion:reduce) { button { transition:none; } }
</style>
