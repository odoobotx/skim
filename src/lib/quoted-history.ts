/** Collapse known reply-history containers in already sanitized email HTML. */
export function withoutQuotedHistory(html: string): {html: string; hasQuoted: boolean} {
  const template=document.createElement("template");
  template.innerHTML=html;
  const root=template.content;
  let removed=false;
  for (const quote of root.querySelectorAll('.gmail_quote,.yahoo_quoted,blockquote[type="cite"]')) {
    quote.remove();removed=true;
  }
  if (removed) for (const prefix of root.querySelectorAll('.moz-cite-prefix,.gmail_attr')) prefix.remove();
  const outlook=root.querySelector('#divRplyFwdMsg');
  if (outlook) {
    let node: ChildNode|null=outlook;
    while (node) {const next:ChildNode|null=node.nextSibling;node.remove();node=next;}
    removed=true;
  }
  const plain=root.querySelector('pre.skim-plain');
  if (plain) {
    const lines=(plain.textContent ?? "").split("\n");
    const boundary=lines.findIndex(line => /^On .+wrote:\s*$/.test(line.trim()) || /^-----Original Message-----\s*$/.test(line.trim()));
    if (boundary>0) {plain.textContent=lines.slice(0,boundary).join("\n").trimEnd();removed=true;}
  }
  // Quote-only mail has no separate reply to show. Keep its full content visible.
  const own=root.cloneNode(true) as DocumentFragment;
  for (const style of own.querySelectorAll('style')) style.remove();
  if (!removed || !(own.textContent ?? "").trim()) return {html,hasQuoted:false};
  return {html:template.innerHTML,hasQuoted:true};
}
