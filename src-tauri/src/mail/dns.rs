//! The one DNS query Skim makes: the MX lookup that tells onboarding whether a
//! domain's mail lives at Microsoft. It goes through the system resolver
//! (Windows `DnsQuery_W`, Linux GIO), using the machine's DNS servers and cache. The
//! address never reaches a third-party resolver, and split-horizon DNS on a
//! corporate VPN answers with the truth.

#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::ptr::NonNull;
#[cfg(target_os = "windows")]
use windows::core::HSTRING;
#[cfg(target_os = "windows")]
use windows::Win32::NetworkManagement::Dns::{
    DnsFree, DnsFreeRecordList, DnsQuery_W, DNS_QUERY_STANDARD, DNS_RECORDA, DNS_RECORDW,
    DNS_TYPE_MX,
};

/// The MX exchange hosts of `domain`, or an empty vec on any failure — no
/// records, NXDOMAIN, no network are all the same answer to the caller.
///
/// Blocking: `DnsQuery_W` has no timeout of its own and a dead resolver can sit
/// on the call for seconds, so callers run this on `spawn_blocking` under a
/// `tokio::time::timeout`.
#[cfg(target_os = "windows")]
pub fn mx_hosts(domain: &str) -> Vec<String> {
    let name = HSTRING::from(domain);
    let mut out: *mut DNS_RECORDA = std::ptr::null_mut();
    // SAFETY: `name` is a NUL-terminated wide string that outlives the call, and
    // `out` is a valid out-pointer. On success the resolver hands back a list it
    // owns, which goes back to `DnsFree` below.
    let status =
        unsafe { DnsQuery_W(&name, DNS_TYPE_MX, DNS_QUERY_STANDARD, None, &mut out, None) };
    // Everything past here works on `NonNull`, so the "the resolver gave us a
    // list" check is made once and carried by the type instead of by a comment.
    let Some(head) = NonNull::new(out).filter(|_| status.is_ok()) else {
        return Vec::new();
    };

    let mut hosts = Vec::new();
    // The `_W` query returns wide records; the out-parameter is typed
    // `DNS_RECORDA` for both charsets, and the layouts differ only in the string
    // type.
    let mut next = Some(head.cast::<DNS_RECORDW>());
    while let Some(node) = next {
        // SAFETY: the resolver owns this list and nothing frees it before the
        // `DnsFree` below, so every node it links to is live for this walk.
        let record = unsafe { node.as_ref() };
        // The list can carry other record types — a CNAME at the head, say — so
        // the `MX` arm of the union is only read once `wType` says it is an MX.
        if record.wType == DNS_TYPE_MX.0 {
            // SAFETY: `wType` above says this record's union holds MX data.
            let exchange = unsafe { record.Data.MX.pNameExchange };
            if !exchange.is_null() {
                // SAFETY: a non-null exchange name is a NUL-terminated wide
                // string owned by the same list.
                if let Ok(host) = unsafe { exchange.to_string() } {
                    hosts.push(host);
                }
            }
        }
        next = NonNull::new(record.pNext);
    }

    // SAFETY: this is the list `DnsQuery_W` handed out, freed exactly once, and
    // the strings above were copied into owned `String`s.
    unsafe { DnsFree(Some(head.as_ptr() as *const c_void), DnsFreeRecordList) };
    hosts
}

#[cfg(target_os = "linux")]
pub fn mx_hosts(domain: &str) -> Vec<String> {
    use gio::prelude::ResolverExt;
    gio::Resolver::default()
        .lookup_records(domain, gio::ResolverRecordType::Mx, gio::Cancellable::NONE)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|record| record.get::<(u16, String)>().map(|(_, host)| host))
        .collect()
}
