# Email rendering

The fork keeps WebView2 and the existing sandboxed message iframe. It does not
embed a second rendering engine or copy Thunderbird/Flectar renderer code.

## Confirmed failure

A cached HTML notification used an embedded stylesheet to constrain its logo to
120 × 40 pixels and its template to 660 pixels wide. The source logo was
2104 × 905 pixels. Dropping the stylesheet and class names lost those limits;
the transparent logo also looked wrong against the application's dark canvas.

Only the structural sizing rules are represented by the synthetic fixture in
`tests/fixtures/email-rendering.html`. The original email, addresses, links and
screenshots are private local files, outside this repository and CI.

## Pipeline

1. Inline embedded styles using `css-inline`. Its network, filesystem, CLI and
   cache features are disabled, and external stylesheet loading is off.
2. Preserve inlined root/body presentation on ordinary HTML wrappers.
3. Run Ammonia's existing tag/attribute/URL allowlists and the CSS allowlist.
   CSS values are tokenized so escaped URLs and indirect image functions cannot
   bypass remote-image blocking. Scripts, event handlers and style blocks do
   not reach the viewer. CID images still use the existing local protocol.
4. Render rich mail on an original light canvas by default, retaining supported
   sender colors. A per-view appearance control can explicitly follow the app
   theme instead. Plain text follows the app theme without extra controls.
5. Keep smaller sender image limits while fitting images to the available width.
   Respect fixed dimensions and height-only hints without stretching. Unlinked
   images can be enlarged in a keyboard-accessible dialog; linked images retain
   the existing link safety behavior.

## Limits

This is a deliberately restricted HTML/CSS subset. External stylesheets, CSS
background images, web fonts, pseudo-elements and responsive media queries are
not enabled. Malformed CSS falls back to the existing sanitization path rather
than making the message unreadable. Theme mode intentionally replaces sender
text/background colors; original mode preserves them. No arbitrary logo-size
cap is applied: small dimensions must come from the sender's markup.

## Validation

`cargo test` covers inlining, root colors, hidden preheaders and malicious
styles/scripts. Build `cargo build --example render_email` from `src-tauri`, then
run `npm run test:rendering` to test the actual Rust output in a headless browser.
The test covers wide/narrow layouts, image dimensions, appearance switching,
image enlargement, plain text and blocking external requests. The helper reads
HTML from stdin and returns JSON; it starts no app or mail connection.

For local private reproduction only, set `SKIM_PRIVATE_RENDER_HTML` to a cached
HTML copy and `SKIM_PRIVATE_LOGO` to its locally saved static logo. The test
intercepts image requests and uses that local file. Private output remains next
to the private input. `SKIM_RENDERER_EXE` can select a helper downloaded from CI,
and `SKIM_TEST_BROWSER` can select an existing Chromium test executable.
