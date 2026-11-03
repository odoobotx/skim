import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import test from "node:test";

test("frontend settings keys are accepted by the native settings API", async () => {
  const rust=await readFile(new URL("../src-tauri/src/commands/settings.rs",import.meta.url),"utf8");
  const allowed=new Set([...rust.match(/const ALLOWED:[\s\S]*?= &\[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map(match=>match[1]));
  const missing=[];
  async function inspect(directory) {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const path=new URL(entry.name+(entry.isDirectory()?"/":""),directory);
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(ts|svelte)$/.test(entry.name)) {
        const source=await readFile(path,"utf8");
        for (const [,key] of source.matchAll(/api\.setSetting\(\s*["']([^"']+)["']/g)) {
          if (!allowed.has(key)) missing.push(`${key}: ${path.pathname}`);
        }
      }
    }
  }
  await inspect(new URL("../src/",import.meta.url));
  assert.deepEqual(missing,[],"A browser-only mock must not hide native persistence failures");
});
