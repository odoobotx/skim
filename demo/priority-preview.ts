import "../src/main";
import "./priority-preview.css";
import "./depth-preview.css";
const previewParams = new URLSearchParams(location.search);
if (previewParams.has("depth")) document.documentElement.dataset.cardDepth = previewParams.get("depth")!;
if (previewParams.has("embedded")) document.documentElement.dataset.embeddedPreview = "true";
import { ui } from "../src/lib/stores/ui.svelte";
const bar = document.createElement("aside");
bar.className = "priority-preview-controls";
bar.setAttribute("aria-label", "Priority design preview");
bar.innerHTML = `<strong>Priority preview</strong><label>Treatment <select aria-label="Priority treatment"><option value="amber">Amber</option><option value="red">Red</option><option value="current">Current</option></select></label><label>Theme <select aria-label="Preview theme">${["moonlit","warm","cold"].flatMap(t => ["light","dark"].map(l => `<option value="${t}-${l}">${t[0].toUpperCase()+t.slice(1)} · ${l}</option>`)).join("")}</select></label>`;
document.body.append(bar);
const treatment = bar.querySelectorAll("select")[0];
const theme = bar.querySelectorAll("select")[1];
document.documentElement.dataset.priorityPreview = "amber";
treatment.onchange = () => document.documentElement.dataset.priorityPreview = treatment.value;
theme.onchange = () => { const [t,l] = theme.value.split("-"); ui.setTheme(t as "moonlit"|"warm"|"cold",l as "light"|"dark"); };
const startup = setInterval(() => {
  const inbox = document.querySelector<HTMLButtonElement>('button.enter');
  if (!inbox) return;
  clearInterval(startup); inbox.click();
  const requested = previewParams.get("theme");
  if (requested && /^(moonlit|cold|warm)-(light|dark)$/.test(requested)) { const [t,l]=requested.split("-"); ui.setTheme(t as "moonlit"|"warm"|"cold",l as "light"|"dark"); }
  theme.value = ui.theme;
  if(previewParams.has("reader")) void import("../src/lib/stores/mail.svelte").then(({mail})=>{mail.selectedThreadId=101;mail.selectedMessageId=1011;});
}, 100);
setTimeout(() => clearInterval(startup), 15000);

window.addEventListener("message", event => {
 if(event.origin !== location.origin || event.source !== parent || event.data?.type !== "cove-preview-theme") return;
 const value=event.data.theme;
 if(typeof value!=="string" || !/^(moonlit|cold|warm)-(light|dark)$/.test(value)) return;
 const [t,l]=value.split("-"); ui.setTheme(t as "moonlit"|"warm"|"cold",l as "light"|"dark");
});
