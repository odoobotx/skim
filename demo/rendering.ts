import { mount } from "svelte";
import Preview from "./RenderingPreview.svelte";
import "../src/styles/tokens.css";
mount(Preview, { target: document.getElementById("app")! });
