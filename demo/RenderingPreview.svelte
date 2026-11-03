<script lang="ts">
  import HtmlViewer from "../src/components/HtmlViewer.svelte";
  import { ui } from "../src/lib/stores/ui.svelte";
  let html = $state("");
  let trimQuotes=$state(false);
  let appearance = $state<"theme" | "original">("theme");
  ui.hydrate("cold-dark");
  // Test-only page. Production never loads this entry point or raw fixtures.
  Object.assign(window, {setRenderingConversation: (value:boolean) => trimQuotes=value, setRenderingHtml: (value: string) => html = value, setRenderingAppearance: (value: "theme" | "original") => appearance = value });
</script>
<main><HtmlViewer {html} {appearance} {trimQuotes} /></main>
<style>
  :global(body) { margin: 0; padding: 20px; background: var(--surface); font-family: "Segoe UI", sans-serif; }
  main { width: 100%; min-width: 0; }
</style>
