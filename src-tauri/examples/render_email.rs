//! Offline rendering regression helper. Reads one HTML email on stdin;
//! no application startup, mail account, network access or credential store.
use std::io::{self, Read};

#[allow(dead_code)]
#[path = "../src/mail/sanitize.rs"]
mod sanitize;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut html = String::new();
    io::stdin().read_to_string(&mut html)?;
    let allow_images = std::env::args().any(|arg| arg == "--allow-remote-images");
    let rendered = sanitize::sanitize_email_html(&html, 1, allow_images);
    println!(
        "{}",
        serde_json::json!({ "html": rendered.html, "blockedImages": rendered.blocked_images })
    );
    Ok(())
}
