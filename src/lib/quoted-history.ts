export interface QuotedMessage {
  html: string;
  sender: string | null;
  date: string | null;
  attribution: string;
}

const historySelector = '[data-skim-quote="history"],.gmail_quote,.yahoo_quoted,blockquote[type="cite"],blockquote.iosymail,[class$="iosymail"]';
const attributionSelector = '[data-skim-quote="attribution"],.moz-cite-prefix,.gmail_attr,.yahoo-quoted-begin,[class$="yahoo-quoted-begin"]';
const outlookSelector = '[data-skim-quote="outlook"],#divRplyFwdMsg';

function textWithBreaks(element: Element): string {
  const copy=element.cloneNode(true) as Element;
  for (const br of copy.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of copy.querySelectorAll("p,div,li,tr")) block.append("\n");
  return (copy.textContent ?? "").replace(/\u00a0/g," ").trim();
}

function header(text: string): Omit<QuotedMessage,"html"> {
  const attribution=text.replace(/(^|\n)\s*(?:>\s*)+/g,"$1").replace(/[ \t]+/g," ").trim();
  const on=attribution.replace(/\s+/g," ").match(/^On (.+) wrote:\s*$/i);
  const from=attribution.match(/\bFrom\s*:\s*(.*?)(?=\n|\bSent\s*:|\bDate\s*:|\bTo\s*:|$)/i);
  const sent=attribution.match(/\b(?:Sent|Date)\s*:\s*(.*?)(?=\n|\bTo\s*:|\bSubject\s*:|$)/i);
  const parts=on?.[1].match(/^(.*),\s*([^,]+)$/);
  const sender=(parts?.[2] ?? from?.[1] ?? "").replace(/\s*<.*$/,"").trim();
  return {sender:sender || null,date:parts?.[1]?.trim() || sent?.[1]?.trim() || null,attribution};
}

function hasContent(root: DocumentFragment): boolean {
  const copy=root.cloneNode(true) as DocumentFragment;
  for (const style of copy.querySelectorAll("style")) style.remove();
  return !!(copy.textContent ?? "").trim() || !!copy.querySelector("img,hr,table");
}

function serialize(root: DocumentFragment): string {
  const template=document.createElement("template");template.content.append(root);
  return template.innerHTML;
}

function precedingAttribution(quote: Element): Element | null {
  let node=quote.previousSibling;
  while (node && (!node.textContent?.trim() && (!(node instanceof Element) || node.tagName === "BR"))) node=node.previousSibling;
  if (!(node instanceof Element)) return null;
  return node.matches(attributionSelector) || /^On\s+.+\s+wrote:\s*$/is.test(textWithBreaks(node)) ? node : null;
}

interface QuoteSeed { content: DocumentFragment; attribution: string; }

const headerLine=/^(?:From|Sent|Date|To|Cc|Bcc|Subject)\s*:/i;
function headerLines(element: Element): string[] {
  return textWithBreaks(element).split("\n").map(line=>line.replace(/^\s*(?:>\s*)+/,"").trim()).filter(Boolean);
}
function isMailHeader(lines: string[]): boolean {
  return lines.length>=3 && /^From\s*:/i.test(lines[0]) && lines.every(line=>headerLine.test(line)) &&
    lines.some(line=>/^(?:Sent|Date)\s*:.*\d/i.test(line)) && lines.some(line=>/^(?:To|Subject)\s*:/i.test(line));
}

/** Outlook often flattens every older reply into sibling paragraphs, without quote tags. */
function markFlatHeaders(root: DocumentFragment): void {
  for (const element of [...root.querySelectorAll("p,div")].reverse()) {
    if (!root.contains(element) || element.closest(`${outlookSelector},${attributionSelector}`)) continue;
    if ((element.textContent ?? "").length>1600) continue;
    const text=textWithBreaks(element);
    if (text.length>1600) continue;
    let lines=headerLines(element), marker=element;
    if (!isMailHeader(lines) && lines.length===1 && /^From\s*:/i.test(lines[0])) {
      const siblings: Element[]=[];
      let next=element.nextElementSibling;
      while (next && siblings.length<8) {
        const more=headerLines(next);
        if (textWithBreaks(next).length>1600 || more.some(line=>!headerLine.test(line) || /^From\s*:/i.test(line))) break;
        siblings.push(next);lines=lines.concat(more);next=next.nextElementSibling;
      }
      if (isMailHeader(lines)) {
        marker=document.createElement("div");element.before(marker);marker.append(element,...siblings);
      }
    }
    if (!isMailHeader(lines) && !/^On\s+.+\s+wrote:\s*$/is.test(lines.join(" "))) continue;
    // Include redundant header wrappers, but never consume the body or its images.
    while (marker.parentElement?.tagName==="DIV" && !marker.parentElement.matches(`${historySelector},${attributionSelector}`) &&
      textWithBreaks(marker.parentElement)===textWithBreaks(marker) && !marker.parentElement.querySelector("img,hr,table")) marker=marker.parentElement;
    marker.setAttribute("data-skim-quote","outlook");
  }
}

/** Remove recognizable history blocks; ordinary inline quotes stay put. */
function extract(root: DocumentFragment): QuoteSeed[] {
  for (const marker of root.querySelectorAll(outlookSelector)) {
    if (!root.contains(marker)) continue;
    const wrapper=document.createElement("div");wrapper.dataset.skimQuote="history";
    marker.before(wrapper);
    let node: ChildNode | null=marker;
    while (node) {const next: ChildNode | null=node.nextSibling;wrapper.append(node);node=next;}
    marker.removeAttribute("id");
    marker.setAttribute("data-skim-quote",textWithBreaks(marker).length<=1600 ? "attribution" : "unparsed");
  }
  const candidates=[...root.querySelectorAll(`${historySelector},blockquote`)]
    .filter(element=>element.matches(historySelector) || precedingAttribution(element));
  const quoted=new Set(candidates);
  const outer=candidates.filter(element=>{
    for (let parent=element.parentElement;parent;parent=parent.parentElement) if (quoted.has(parent)) return false;
    return true;
  });
  return outer.map(quote=>{
    const prefix=precedingAttribution(quote);
    let attribution=prefix ? textWithBreaks(prefix) : "";
    prefix?.remove();
    const inside=[...quote.querySelectorAll(attributionSelector)]
      .find(element=>element.closest(`blockquote,${historySelector}`) === quote);
    if (inside) {attribution ||= textWithBreaks(inside);inside.remove();}
    const content=document.createDocumentFragment();content.append(...quote.childNodes);quote.remove();
    // Gmail often wraps its whole quoted message in one extra blockquote.
    const children=[...content.children].filter(element=>element.tagName!=="STYLE" && element.tagName!=="BR");
    if (children.length===1 && children[0].tagName==="BLOCKQUOTE") {
      const outside=content.cloneNode(true) as DocumentFragment;outside.querySelector("blockquote")?.remove();
      if (!hasContent(outside)) children[0].replaceWith(...children[0].childNodes);
    }
    return {content,attribution};
  });
}

function plainBoundary(lines: string[], start: number): {end: number; attribution: string} | null {
  const clean=(line:string)=>line.replace(/^\s*(?:>\s*)+/,"").trim();
  const first=clean(lines[start]);
  if (first.length>1600) return null;
  if (/^-+Original Message-+\s*$/i.test(first)) return {end:start+1,attribution:first};
  if (/^On\s+/i.test(first)) {
    let attribution="";
    for (let i=start;i<Math.min(start+4,lines.length);i++) {
      attribution+=(attribution ? " " : "")+clean(lines[i]);
      if (attribution.length>1600) break;
      if (/^On\s+.+\s+wrote:\s*$/i.test(attribution)) return {end:i+1,attribution};
    }
  }
  if (!/^From\s*:/i.test(first)) return null;
  const fields: string[]=[];
  let end=start;
  for (;end<Math.min(start+16,lines.length);end++) {
    const line=clean(lines[end]);
    if (!line) continue;
    if (line.length>1600 || fields.join("\n").length+line.length>1600) break;
    if (!headerLine.test(line) || (fields.length>0 && /^From\s*:/i.test(line))) break;
    fields.push(line);
  }
  return isMailHeader(fields) ? {end,attribution:fields.join("\n")} : null;
}

function plainHistory(html: string, plain: Element): {html:string;hasQuoted:boolean;history:QuotedMessage[]} {
  const lines=(plain.textContent ?? "").split("\n"), history:QuotedMessage[]=[];
  const pre=(text:string)=>{const element=document.createElement("pre");element.className="skim-plain";element.textContent=text;return element.outerHTML;};
  let start=0,attribution="",own="",quoted=false;
  function add(end: number) {
    let body=lines.slice(start,end);
    if (quoted) {
      body=body.map(line=>/^\s*(?:>\s*)+$/.test(line) ? "" : line);
      // Remove only shared quote indentation; intentional comparisons/inline quotes remain.
      const meaningful=body.filter(line=>line.replace(/[>\s]/g,"").length);
      while (meaningful.length && meaningful.every(line=>/^\s*>(?:[ \t]|>|$)/.test(line))) {
        body=body.map(line=>line.replace(/^\s*>[ \t]?/,""));
        for (let i=0;i<meaningful.length;i++) meaningful[i]=meaningful[i].replace(/^\s*>[ \t]?/,"");
      }
    }
    const text=body.join("\n").trimEnd();
    if (!quoted) own=text;
    else if (text.trim()) history.push({html:pre(text),...header(attribution)});
  }
  for (let i=0;i<lines.length;i++) {
    const boundary=plainBoundary(lines,i);
    if (!boundary) continue;
    if (!quoted && !lines.slice(0,i).join("\n").trim()) return {html,hasQuoted:false,history:[]};
    add(i);quoted=true;attribution=boundary.attribution;start=boundary.end;i=boundary.end-1;
  }
  add(lines.length);
  return history.length ? {html:pre(own),hasQuoted:true,history} : {html,hasQuoted:false,history:[]};
}

/** Input is sanitized. Each history card contains only text actually quoted in this email. */
export function withoutQuotedHistory(html: string): {html:string;hasQuoted:boolean;history:QuotedMessage[]} {
  const template=document.createElement("template");template.innerHTML=html;
  const root=template.content, plain=root.querySelector("pre.skim-plain");
  if (plain && root.childElementCount===1 && root.firstElementChild===plain) return plainHistory(html,plain);
  // Some clients encode plain-text mail as nothing but text, <br> and body wrappers.
  if (root.querySelector("br") && [...root.querySelectorAll("*")].every(element=>["DIV","BR"].includes(element.tagName))) {
    const wrapper=document.createElement("div");wrapper.append(root.cloneNode(true));
    const pre=document.createElement("pre");pre.textContent=textWithBreaks(wrapper);
    return plainHistory(html,pre);
  }
  const styles=[...root.querySelectorAll("style")].map(style=>style.outerHTML).join("");
  markFlatHeaders(root);
  const queue=extract(root);
  if (!queue.length || !hasContent(root)) return {html,hasQuoted:false,history:[]};
  const own=serialize(root), history:QuotedMessage[]=[];
  while (queue.length) {
    const quoted=queue.shift()!, nested=extract(quoted.content);
    if (hasContent(quoted.content)) history.push({html:styles+serialize(quoted.content),...header(quoted.attribution)});
    else if (nested.length && !nested[0].attribution) nested[0].attribution=quoted.attribution;
    queue.unshift(...nested);
  }
  return history.length ? {html:own,hasQuoted:true,history} : {html,hasQuoted:false,history:[]};
}
