use serde_json::Value;

/// Zoho SMTP stores Sent automatically, as Gmail does. An account override
/// supports servers where that behavior has been disabled by the user.
pub fn client_saves(
    provider: &str,
    smtp_host: &str,
    account_id: &str,
    setting: Option<&str>,
) -> bool {
    let modes = setting.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    match modes
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|modes| modes.get(account_id))
        .and_then(Value::as_str)
    {
        Some("client") => true,
        Some("server") => false,
        _ => {
            let host = smtp_host.trim().trim_end_matches('.').to_ascii_lowercase();
            provider != "gmail" && !matches!(host.as_str(), "smtp.zoho.com" | "smtppro.zoho.com")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::client_saves;

    #[test]
    fn automatic_sent_copy_policy_keeps_one_writer() {
        assert!(!client_saves("gmail", "smtp.gmail.com", "a", None));
        for host in ["smtp.zoho.com", "smtppro.zoho.com", " SMTPPRO.ZOHO.COM. "] {
            assert!(!client_saves("custom", host, "a", None), "{host}");
        }
        for host in [
            "smtp.example.com",
            "smtppro.zoho.com.example.net",
            "zoho.com",
        ] {
            assert!(client_saves("custom", host, "a", None), "{host}");
        }
    }

    #[test]
    fn overrides_are_account_scoped_and_can_restore_client_saving() {
        let modes = Some(r#"{"a":"client","b":"server"}"#);
        assert!(client_saves("custom", "smtppro.zoho.com", "a", modes));
        assert!(!client_saves("custom", "smtp.example.com", "b", modes));
        assert!(client_saves("custom", "smtp.example.com", "c", modes));
    }

    #[test]
    fn malformed_or_unknown_modes_fall_back_to_automatic() {
        for raw in [
            "bad json",
            "[]",
            "null",
            r#"{"a":true}"#,
            r#"{"a":"other"}"#,
        ] {
            assert!(!client_saves("custom", "smtppro.zoho.com", "a", Some(raw)));
            assert!(client_saves("custom", "smtp.example.com", "a", Some(raw)));
        }
    }
}
