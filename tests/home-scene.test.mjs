import {readFileSync,existsSync} from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

const {outputText}=ts.transpileModule(readFileSync(new URL("../src/lib/home-scene.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
const {homeScene}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("Home stages follow local time at every boundary and through midnight",()=>{
  for(const [hour,minute,stage] of [[0,0,"night"],[4,59,"night"],[5,0,"dawn"],[7,59,"dawn"],[8,0,"morning"],[11,59,"morning"],[12,0,"afternoon"],[16,59,"afternoon"],[17,0,"evening"],[20,59,"evening"],[21,0,"night"],[23,59,"night"]]) {
    for(const date of [new Date(2026,0,1,hour,minute),new Date(2026,10,1,hour,minute)]) {
      assert.equal(homeScene(date).id,stage);
    }
  }
});

test("Every stage uses a bundled photograph and a matching greeting",()=>{
  for(const [hour,greeting] of [[6,"Good morning."],[9,"Good morning."],[15,"Good afternoon."],[19,"Good evening."],[22,"Good night."]]) {
    const scene=homeScene(new Date(2026,10,6,hour));
    assert.equal(scene.greeting,greeting);
    assert(existsSync(new URL(`../public${scene.image}`,import.meta.url)),`${scene.id} photograph is bundled locally`);
  }
});
