//! HTML email sanitization. Runs in Rust so unsanitized markup never crosses
//! the IPC boundary; the frontend additionally renders the result inside a
//! sandboxed iframe with a strict CSP.

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

pub struct SanitizedHtml {
    pub html: String,
    pub blocked_images: usize,
}

/// CSS properties allowed in inline `style` attributes.
const STYLE_ALLOWED: &[&str] = &[
    "color",
    "background",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-align",
    "text-decoration",
    "line-height",
    "letter-spacing",
    "margin",
    "margin-top",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "padding",
    "padding-top",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "border",
    "border-top",
    "border-bottom",
    "border-left",
    "border-right",
    "border-width",
    "border-style",
    "border-color",
    "border-top-width",
    "border-top-style",
    "border-top-color",
    "border-bottom-width",
    "border-bottom-style",
    "border-bottom-color",
    "border-left-width",
    "border-left-style",
    "border-left-color",
    "border-right-width",
    "border-right-style",
    "border-right-color",
    "border-radius",
    "border-collapse",
    "border-spacing",
    "width",
    "max-width",
    "max-height",
    "min-width",
    "height",
    "display",
    "vertical-align",
    "white-space",
    "word-break",
    "overflow-wrap",
    "box-sizing",
    "table-layout",
    "list-style",
    "list-style-type",
    "text-transform",
    "margin-block-start",
    "margin-block-end",
];

/// Inspect decoded CSS tokens, not substrings: escaped url() and image-set()
/// must not bypass the remote-image policy through a background declaration.
fn safe_css_value(value: &str) -> bool {
    use cssparser::{Parser, ParserInput, Token};

    fn check<'i>(parser: &mut Parser<'i, '_>) -> Result<(), cssparser::ParseError<'i, ()>> {
        while !parser.is_exhausted() {
            match parser.next_including_whitespace_and_comments()?.clone() {
                Token::Function(name) => {
                    if ![
                        "rgb",
                        "rgba",
                        "hsl",
                        "hsla",
                        "calc",
                        "min",
                        "max",
                        "clamp",
                        "linear-gradient",
                        "radial-gradient",
                        "conic-gradient",
                        "repeating-linear-gradient",
                        "repeating-radial-gradient",
                    ]
                    .contains(&name.to_ascii_lowercase().as_str())
                    {
                        return Err(parser.new_custom_error(()));
                    }
                    parser.parse_nested_block(check)?;
                }
                Token::UnquotedUrl(_)
                | Token::BadUrl(_)
                | Token::BadString(_)
                | Token::AtKeyword(_)
                | Token::CurlyBracketBlock
                | Token::SquareBracketBlock => {
                    return Err(parser.new_custom_error(()));
                }
                Token::ParenthesisBlock => parser.parse_nested_block(check)?,
                _ => {}
            }
        }
        Ok(())
    }

    let mut input = ParserInput::new(value);
    check(&mut Parser::new(&mut input)).is_ok()
}

fn filter_style(value: &str) -> Option<String> {
    let mut kept = Vec::new();
    for decl in value.split(';') {
        let Some((prop, val)) = decl.split_once(':') else {
            continue;
        };
        let prop = prop.trim().to_lowercase();
        if !STYLE_ALLOWED.contains(&prop.as_str()) {
            continue;
        }
        // Drop an `!important` flag but KEEP the declaration. Bulk-mail
        // preheaders hide themselves with `display:none !important`; discarding
        // the whole declaration (as we used to) un-hid them, turning a screenful
        // of zero-width spacer glyphs into a giant blank scroll area. Inline
        // `!important` only maxes out specificity — which inline styles already
        // do — so it can't reach or override our iframe's protective stylesheet.
        let val = match val.find('!') {
            Some(i) => val[..i].trim(),
            None => val.trim(),
        };
        if val.is_empty() {
            continue;
        }
        let val_lower = val.to_lowercase();
        // No external fetches or layout escapes through CSS.
        if !safe_css_value(val)
            || val_lower.contains("url(")
            || val_lower.contains("expression(")
            || val_lower.contains("fixed")
            || val_lower.contains("absolute")
        {
            continue;
        }
        // A viewport- or percentage-relative height lets email content size
        // itself to the iframe viewport, which our auto-height measurement then
        // grows — a feedback loop that ratchets the frame up to its cap. Email
        // bodies never legitimately need one (images use height:auto).
        if (prop == "height" || prop == "max-height")
            && (val_lower.contains('%')
                || val_lower.contains("vh")
                || val_lower.contains("vw")
                || val_lower.contains("vmin")
                || val_lower.contains("vmax"))
        {
            continue;
        }
        kept.push(format!("{prop}:{val}"));
    }
    if kept.is_empty() {
        None
    } else {
        Some(kept.join(";"))
    }
}

/// Resolve a `cid:` reference to the URL served by the `skim-cid` protocol.
/// (On Windows, Tauri custom protocols are exposed as `http://<scheme>.localhost/`.)
pub fn cid_url(message_id: i64, content_id: &str) -> String {
    let origin = if cfg!(target_os = "windows") {
        "http://skim-cid.localhost"
    } else {
        "skim-cid://localhost"
    };
    format!("{origin}/{message_id}/{}", urlencode(content_id))
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Sanitize an HTML email body.
///
/// * `message_id` — used to resolve `cid:` inline images.
/// * `allow_remote_images` — when false, http(s) image sources are emptied
///   and counted so the UI can offer a "show images" bar.
pub fn sanitize_email_html(
    html: &str,
    message_id: i64,
    allow_remote_images: bool,
) -> SanitizedHtml {
    // Inlining happens BEFORE the security boundary. The result still passes
    // through the exact same tag, URL and CSS allowlists below.
    let inlined = css_inline::CSSInliner::options()
        .load_remote_stylesheets(false)
        .keep_style_tags(false)
        .keep_link_tags(false)
        .build()
        .inline(html)
        .unwrap_or_else(|_| html.to_string());
    let document = dom_query::Document::from(inlined);
    // Preserve only known reply markers; ordinary email classes/IDs stay stripped.
    document
        .select("[data-skim-quote]")
        .remove_attr("data-skim-quote");
    document
        .select(".gmail_quote,.yahoo_quoted,blockquote[type='cite']")
        .set_attr("data-skim-quote", "history");
    document
        .select(".moz-cite-prefix,.gmail_attr")
        .set_attr("data-skim-quote", "attribution");
    document
        .select("#divRplyFwdMsg")
        .set_attr("data-skim-quote", "outlook");
    document.select("head").remove();
    // Ammonia parses a fragment and discards html/body attributes. Convert
    // their inlined presentation to ordinary wrappers so it survives cleaning.
    document.select("html, body").rename("div");
    let html = document.html().to_string();
    let blocked = Arc::new(AtomicUsize::new(0));
    let blocked_in_filter = blocked.clone();

    let tags: HashSet<&str> = [
        "a",
        "abbr",
        "b",
        "blockquote",
        "br",
        "caption",
        "center",
        "code",
        "col",
        "colgroup",
        "dd",
        "div",
        "dl",
        "dt",
        "em",
        "font",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "i",
        "img",
        "li",
        "ol",
        "p",
        "pre",
        "q",
        "s",
        "small",
        "span",
        "strike",
        "strong",
        "sub",
        "sup",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "tr",
        "u",
        "ul",
    ]
    .into();

    let mut builder = ammonia::Builder::empty();
    builder
        .tags(tags)
        .clean_content_tags(["script", "style", "svg", "math", "head", "title"].into())
        .generic_attributes(["style", "align", "valign", "dir", "data-skim-quote"].into())
        .add_tag_attributes("a", ["href", "title"])
        .add_tag_attributes("img", ["src", "alt", "width", "height", "border"])
        .add_tag_attributes("td", ["colspan", "rowspan", "width", "height", "bgcolor"])
        .add_tag_attributes("th", ["colspan", "rowspan", "width", "height", "bgcolor"])
        .add_tag_attributes(
            "table",
            ["cellpadding", "cellspacing", "border", "width", "bgcolor"],
        )
        .add_tag_attributes("font", ["color", "size", "face"])
        // `cid`/`data` are allowed through so the img filter below can see
        // them; anchors are re-restricted to http/https/mailto in the filter.
        .url_schemes(["http", "https", "mailto", "cid", "data"].into())
        .link_rel(Some("noopener noreferrer"))
        .attribute_filter(move |element, attribute, value| {
            if attribute == "data-skim-quote" {
                return matches!(value, "history" | "attribution" | "outlook")
                    .then_some(Cow::Borrowed(value));
            }
            if attribute == "style" {
                return filter_style(value).map(Cow::Owned);
            }
            if element == "a" && attribute == "href" {
                let lower = value.trim().to_lowercase();
                if lower.starts_with("http://")
                    || lower.starts_with("https://")
                    || lower.starts_with("mailto:")
                {
                    return Some(Cow::Borrowed(value));
                }
                return None;
            }
            if element == "img" && attribute == "src" {
                let lower = value.trim().to_lowercase();
                if let Some(cid) = lower.strip_prefix("cid:") {
                    return Some(Cow::Owned(cid_url(message_id, cid.trim())));
                }
                if lower.starts_with("data:image/") {
                    return Some(Cow::Owned(value.to_string()));
                }
                if lower.starts_with("http://") || lower.starts_with("https://") {
                    if allow_remote_images {
                        return Some(Cow::Owned(value.to_string()));
                    }
                    blocked_in_filter.fetch_add(1, Ordering::Relaxed);
                    return Some(Cow::Borrowed(""));
                }
                return None;
            }
            Some(Cow::Borrowed(value))
        });

    let html = builder.clean(&html).to_string();
    SanitizedHtml {
        html,
        blocked_images: blocked.load(Ordering::Relaxed),
    }
}

/// Render a plain-text body as safe HTML: escape, linkify, preserve wrapping.
pub fn text_to_html(text: &str) -> String {
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let linkified = linkify(&escaped);
    format!("<pre class=\"skim-plain\">{linkified}</pre>")
}

fn linkify(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find("http") {
        let (before, tail) = rest.split_at(pos);
        out.push_str(before);
        if tail.starts_with("http://") || tail.starts_with("https://") {
            let end = tail
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<')
                .unwrap_or(tail.len());
            let (url, after) = tail.split_at(end);
            let trimmed = url.trim_end_matches(['.', ',', ')', ']', ';']);
            let extra = &url[trimmed.len()..];
            out.push_str(&format!(
                "<a href=\"{trimmed}\" rel=\"noopener noreferrer\">{trimmed}</a>{extra}"
            ));
            rest = after;
        } else {
            out.push_str("http");
            rest = &tail[4..];
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_images_use_the_native_webview_protocol() {
        let expected = if cfg!(target_os = "windows") {
            "http://skim-cid.localhost/42/logo%40mail"
        } else {
            "skim-cid://localhost/42/logo%40mail"
        };
        assert_eq!(cid_url(42, "logo@mail"), expected);
        let rendered = sanitize_email_html(r#"<img src="cid:logo@mail">"#, 42, false);
        assert!(rendered.html.contains(expected));
        assert_eq!(rendered.blocked_images, 0);
    }

    #[test]
    fn embedded_styles_keep_logo_and_message_constraints() {
        let rendered = sanitize_email_html(
            include_str!("../../../tests/fixtures/email-rendering.html"),
            1,
            false,
        );
        assert!(rendered.html.contains("max-width:120px"));
        assert!(rendered.html.contains("max-height:40px"));
        assert!(rendered.html.contains("max-width:660px"));
        assert!(rendered.html.contains("display:none"));
        assert!(!rendered.html.contains("<style"));
        assert!(!rendered.html.contains("class="));
        assert!(rendered.html.contains(&cid_url(1, "logo")));
    }

    #[test]
    fn reply_markers_survive_without_allowing_arbitrary_classes_or_forged_markers() {
        let result = sanitize_email_html(
            r#"<p data-skim-quote="history">My reply</p><div class="gmail_quote">Old history</div><div class="moz-cite-prefix">On Tuesday:</div><blockquote type="cite">Older reply</blockquote><div id="divRplyFwdMsg">From header</div>"#,
            1,
            false,
        );
        assert!(result.html.contains("<p>My reply</p>"));
        assert_eq!(
            result.html.matches("data-skim-quote=\"history\"").count(),
            2
        );
        assert!(result.html.contains("data-skim-quote=\"attribution\""));
        assert!(result.html.contains("data-skim-quote=\"outlook\""));
        assert!(!result.html.contains("class="));
        assert!(!result.html.contains(" id="));
    }

    #[test]
    fn body_colors_survive_fragment_sanitization() {
        let rendered = sanitize_email_html(
            "<html><head><style>body { background-color: #fff; color: #111 }</style></head><body><p>Hello</p></body></html>",
            1,
            false,
        );
        assert!(rendered.html.contains("background-color:#fff"));
        assert!(rendered.html.contains("color:#111"));
    }

    #[test]
    fn table_border_longhands_survive_without_enabling_external_css() {
        let result = sanitize_email_html(
            r#"<table style="border-width:1px;border-style:solid;border-color:#aeb8c5;border-collapse:collapse"><tr><td style="border-left-width:1px;border-left-style:solid;border-left-color:#aeb8c5;border-image-source:url(https://tracker.example/x);border-top-color:expression(bad())">Cell</td></tr></table>"#,
            1,
            false,
        );
        for declaration in [
            "border-width:1px",
            "border-style:solid",
            "border-color:#aeb8c5",
            "border-left-width:1px",
            "border-left-style:solid",
            "border-left-color:#aeb8c5",
        ] {
            assert!(result.html.contains(declaration));
        }
        assert!(!result.html.contains("tracker.example"));
        assert!(!result.html.contains("expression"));
    }

    #[test]
    fn inlining_never_trusts_stylesheet_urls_or_scripts() {
        let rendered = sanitize_email_html(
            r#"<link rel="stylesheet" href="file:///not-readable.css">
            <style>@import url('https://tracker.example/style.css');
              .x { max-width:120px; background-image:url('https://tracker.example/pixel'); position:fixed; }
            </style><p class="x" onclick="bad()">Hello<script>bad()</script></p>
            <img src="https://tracker.example/image">"#,
            1,
            false,
        );
        assert!(rendered.html.contains("max-width:120px"));
        assert!(!rendered.html.contains("tracker.example"));
        assert!(!rendered.html.contains("file:"));
        assert!(!rendered.html.contains("script"));
        assert!(!rendered.html.contains("onclick"));
        assert!(!rendered.html.contains("fixed"));
        assert_eq!(rendered.blocked_images, 1);
    }

    #[test]
    fn css_tokens_reject_escaped_and_indirect_image_fetches() {
        for value in [
            r"background:u\72l(https://tracker.example/x)",
            r#"background:image-set("https://tracker.example/x" 1x)"#,
            "background:var(--remote)",
            "height:calc(100vh - 10px)",
            "max-height:100%",
        ] {
            assert_eq!(filter_style(value), None, "{value}");
        }
        assert_eq!(
            filter_style("background:rgb(1, 2, 3)"),
            Some("background:rgb(1, 2, 3)".into())
        );
    }

    #[test]
    fn strips_scripts_and_event_handlers() {
        let s = sanitize_email_html(
            "<p onclick=\"evil()\">hi<script>alert(1)</script></p><style>body{}</style>",
            1,
            true,
        );
        assert!(!s.html.contains("script"));
        assert!(!s.html.contains("onclick"));
        assert!(!s.html.contains("body{}"));
        assert!(s.html.contains("hi"));
    }

    #[test]
    fn blocks_remote_images_and_counts() {
        let s = sanitize_email_html(
            "<img src=\"https://tracker.example/x.png\"><img src=\"data:image/png;base64,AA==\">",
            1,
            false,
        );
        assert_eq!(s.blocked_images, 1);
        assert!(!s.html.contains("tracker.example"));
        assert!(s.html.contains("data:image/png"));
    }

    #[test]
    fn rewrites_cid_references() {
        let s = sanitize_email_html("<img src=\"cid:logo@corp\">", 42, false);
        assert_eq!(s.blocked_images, 0);
        assert!(s.html.contains(&cid_url(42, "logo@corp")));
    }

    #[test]
    fn style_filter_drops_dangerous_values() {
        assert_eq!(
            filter_style("color: red; background: url(https://x); position: absolute"),
            Some("color:red".to_string())
        );
        assert_eq!(filter_style("position: fixed"), None);
    }

    #[test]
    fn style_filter_keeps_declaration_minus_important() {
        // `!important` is stripped, not the whole declaration — otherwise
        // `display:none !important` preheaders un-hide into a giant blank area.
        assert_eq!(
            filter_style("display: none !important"),
            Some("display:none".to_string())
        );
        assert_eq!(
            filter_style("color: red !important"),
            Some("color:red".to_string())
        );
    }

    #[test]
    fn style_filter_rejects_viewport_relative_height() {
        // Viewport/percentage heights feed the iframe auto-height loop.
        assert_eq!(filter_style("height: 100vh"), None);
        assert_eq!(filter_style("height: 100%"), None);
        assert_eq!(
            filter_style("height: 40px"),
            Some("height:40px".to_string())
        );
    }

    #[test]
    fn preheader_stays_hidden() {
        let s = sanitize_email_html(
            "<div style=\"display: none !important; max-width: 0px; overflow: hidden;\">spacer</div>",
            1,
            true,
        );
        assert!(s.html.contains("display:none"));
    }

    #[test]
    fn javascript_links_removed() {
        let s = sanitize_email_html("<a href=\"javascript:alert(1)\">x</a>", 1, true);
        assert!(!s.html.contains("javascript"));
    }

    #[test]
    fn plain_text_is_escaped_and_linkified() {
        let html = text_to_html("see <b> https://example.com/a.");
        assert!(html.contains("&lt;b&gt;"));
        assert!(html.contains("<a href=\"https://example.com/a\""));
    }
}
