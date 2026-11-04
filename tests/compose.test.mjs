import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

const {outputText}=ts.transpileModule(readFileSync(new URL("../src/lib/compose.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
const {splitComposeQuote}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("compose quote collapse preserves signature, history and line endings exactly",()=>{
  for(const nl of ["\n","\r\n"]) {
    const text=`Here is my reply.${nl}${nl}-- ${nl}Brenden`;
    const quote=`${nl}${nl}On Tue, Anna <anna@example.com> wrote:${nl}> The original message.${nl}>${nl}> On Mon, someone wrote:${nl}> > Earlier reply`;
    const parts=splitComposeQuote(text+quote);
    assert.deepEqual(parts,{text,quote});
    assert.equal(parts.text+parts.quote,text+quote);
    assert.equal("Updated reply"+parts.quote,"Updated reply"+quote);
  }
});
test("ordinary compose prose and loose blockquotes remain editable",()=>{
  for(const text of ["","On Wednesday we wrote:\nSome notes","> A deliberate quote","A thought\n\nOn Tuesday we wrote:\nThese are my own notes."]) {
    assert.deepEqual(splitComposeQuote(text),{text,quote:""});
  }
});
