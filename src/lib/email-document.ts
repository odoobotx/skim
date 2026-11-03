// Input must already have passed the Rust sanitizer. Never use with raw mail.
export function buildEmailDocument(body: string, dark: boolean, original: boolean, surface: string): string {
    // Rich HTML defaults to its original light canvas; plain text and the
    // explicit theme mode follow the app palette.
    const colors = dark
      ? {
          scheme: "dark",
          bg: surface,
          text: "#ececef",
          link: "#8ab4f8",
          quoteBorder: "#3a3a42",
          quoteText: "#a3a3ab",
        }
      : {
          scheme: "light",
          bg: original ? "#ffffff" : surface,
          text: "#17171b",
          link: "#1a56c4",
          quoteBorder: "#dddddd",
          quoteText: "#555555",
        };
    return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http://skim-cid.localhost data: https: http:; style-src 'unsafe-inline'">
<style>
  :root { color-scheme: ${colors.scheme}; }
  /* The background goes on the root too, not just body: the canvas takes its
     colour from html first, and color-scheme makes the UA paint an opaque
     default there — which would defeat a transparent body. */
  html, body { margin: 0; padding: 0; background: ${colors.bg}; }
  body {
    /* For the height measurement below, which reads this box: keep the
       children's margins inside. A first or last child's margin would
       otherwise collapse out of the body, so the body's height would miss
       what the document still counts and the frame would come up exactly
       that margin short, which is a scrollbar on the message. */
    display: flow-root;
    font-family: 'Hanken Grotesk', 'Segoe UI', sans-serif;
    font-size: 14px; line-height: 1.6; color: ${colors.text};
    word-wrap: break-word; overflow-wrap: break-word;
  }
  img { max-width: 100%; height: auto; object-fit: contain; }
  img[src=""] { display: none; }
  a { color: ${colors.link}; }
  table { max-width: 100%; }
  blockquote { margin: 8px 0 8px 2px; padding-left: 12px; border-left: 2px solid ${colors.quoteBorder}; color: ${colors.quoteText}; }
  pre.skim-plain { white-space: pre-wrap; font: inherit; margin: 0; }
  ${original ? "" : `
  body * { color: inherit !important; background: transparent !important; border-color: ${colors.quoteBorder} !important; }
  body a { color: ${colors.link} !important; }
  body img { background: #ffffff !important; }
  `}
</style></head><body>${body}</body></html>`;
  }

