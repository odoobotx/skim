<script lang="ts">
  import { onMount } from "svelte";
  import { HOME_SCENES, type HomeStage } from "../../lib/home-scene";
  import { homeBackgrounds } from "../../lib/stores/home-backgrounds.svelte";

  let picker: HTMLInputElement;
  let pendingStage: HomeStage = "dawn";
  let busy = $state(false);
  let error = $state("");
  let saved = $state("");
  onMount(() => { void homeBackgrounds.load(); });

  function choosePhoto(stage: HomeStage) {
    pendingStage = stage;
    error = "";
    saved = "";
    picker.click();
  }
  async function changeMode(stage: HomeStage, mode: "default" | "custom") {
    if (mode === "custom" && (!homeBackgrounds.hasCustom(stage) || homeBackgrounds.mode(stage) === "custom")) { choosePhoto(stage); return; }
    busy = true;
    error = "";
    saved = "";
    try {
      await homeBackgrounds.setMode(stage, mode);
      saved = `${HOME_SCENES[stage].label} now uses the ${mode} photo.`;
    } catch { error = "Couldn't save your choice. Your previous photo is still in place. Please try again."; }
    finally { busy = false; }
  }
  async function upload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    const stage = pendingStage;
    input.value = "";
    if (!file) return;
    busy = true;
    error = "";
    saved = "";
    try {
      await homeBackgrounds.upload(stage, file);
      saved = `${HOME_SCENES[stage].label} photo saved. You can return to Default at any time.`;
    } catch (cause) {
      error = cause instanceof Error && !["QuotaExceededError", "UnknownError"].includes(cause.name)
        ? cause.message : "Couldn't save this photo. Free some device storage and try again.";
    } finally { busy = false; }
  }
</script>

<div class="home-settings">
  <div>
    <h3>Home screen</h3>
    <p class="intro">A quiet scene for every part of your day. Photos change with your local time.</p>
  </div>
  <input class="file-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose Home photo" bind:this={picker} onchange={(event) => void upload(event)} />
  <div class="scenes">
    {#each Object.values(HOME_SCENES) as scene (scene.id)}
      <article class="scene" aria-label={`${scene.label} background`}>
        <img src={homeBackgrounds.image(scene.id)} alt={`${scene.label} ${homeBackgrounds.mode(scene.id)} background`} loading="lazy" />
        <div class="scene-body">
          <div class="scene-heading"><h4>{scene.label}</h4><span>{scene.hours}</span></div>
          <div class="choice" role="group" aria-label={`${scene.label} photo source`}>
            <button type="button" aria-pressed={homeBackgrounds.mode(scene.id) === "default"} disabled={busy || !homeBackgrounds.ready} onclick={() => void changeMode(scene.id, "default")}>Default</button>
            <button type="button" aria-pressed={homeBackgrounds.mode(scene.id) === "custom"} disabled={busy || !homeBackgrounds.ready} onclick={() => void changeMode(scene.id, "custom")}>Custom</button>
          </div>
        </div>
      </article>
    {/each}
  </div>
  <p class="note">Your photos stay on this device and apply to all accounts. Switching to Default keeps your custom photo for later. Wide JPG, PNG or WebP photos work best (up to 20 MB).</p>
  {#if homeBackgrounds.loadError}
    <p class="error" role="alert">Couldn't load personal photos. The default collection is still available. <button class="retry" onclick={() => void homeBackgrounds.load()}>Try again</button></p>
  {:else if !homeBackgrounds.ready}<p class="note" role="status">Loading your photo choices…</p>{/if}
  {#if busy}<p class="note" role="status">Saving your photo choice…</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <p class="save-status" role="status">{saved}</p>
</div>

<style>
  .home-settings { display:flex; flex-direction:column; gap:16px; }
  h3 { font-size:17px; font-weight:600; letter-spacing:-.02em; margin:0; }
  .intro { font-size:12.5px; color:var(--text-dim); line-height:1.5; margin:6px 0 0; }
  .file-input { display:none; }
  .scenes { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
  .scene { min-width:0; border:1px solid var(--hairline-strong); border-radius:11px; overflow:hidden; background:var(--surface); }
  .scene img { display:block; width:100%; aspect-ratio:16/9; object-fit:cover; object-position:right center; }
  .scene-body { padding:12px; }
  .scene-heading { display:flex; flex-direction:column; gap:3px; }
  h4 { margin:0; font-size:13px; font-weight:600; }
  .scene-heading span { font-size:10.5px; color:var(--text-dim); }
  .choice { display:flex; border:1px solid var(--hairline-strong); background:var(--bg); border-radius:7px; padding:3px; gap:3px; margin-top:11px; }
  .choice button { flex:1; min-width:0; padding:5px 3px; font-size:11px; color:var(--text-dim); border-radius:4px; transition:background-color 140ms ease,color 140ms ease; }
  .choice button[aria-pressed=true] { background:var(--selected); color:var(--text); }
  button:hover:not(:disabled) { background:var(--hover); color:var(--text); }
  button:disabled { opacity:.5; cursor:default; }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .note { margin:0; color:var(--text-dim); font-size:11.5px; line-height:1.6; }
  .save-status { margin:0; min-height:0; color:var(--text-dim); font-size:11.5px; line-height:1.5; }
  .save-status:empty { display:none; }
  .error { margin:0; color:var(--danger); font-size:12px; line-height:1.5; }
  .retry { text-decoration:underline; padding:3px 5px; }
  @media(max-width:650px) { .scenes { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media(prefers-reduced-motion:reduce) { .choice button { transition:none; } }
</style>
