//! Task inbox projections and durable optimistic archive/restore operations.
use super::{
    bodies,
    models::{NewMessage, ThreadRow},
    queries,
};
use crate::mail::threading;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

pub fn task_ids(
    conn: &Connection,
    threads: &[i64],
    messages: &[i64],
    done: bool,
) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT m.id FROM messages m JOIN folders f ON f.id=m.folder_id JOIN accounts a ON a.id=m.account_id
      WHERE m.thread_id IN (SELECT value FROM json_each(?1))
        AND (json_array_length(?2)=0 OR m.id IN (SELECT value FROM json_each(?2)))
        AND ((?3 AND f.role='inbox') OR (NOT ?3 AND (f.role='archive' OR
          (f.role='all' AND COALESCE(m.from_addr,'') != a.email COLLATE NOCASE
            AND NOT EXISTS (SELECT 1 FROM messages s JOIN folders sf ON sf.id=s.folder_id
              WHERE s.account_id=m.account_id AND s.message_id=m.message_id AND sf.role IN ('sent','trash','junk'))))))")?;
    let rows = stmt
        .query_map(
            params![
                json!(threads).to_string(),
                json!(messages).to_string(),
                done
            ],
            |r| r.get(0),
        )?
        .collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(rows)
}

pub fn category(
    from: &str,
    list: bool,
    unsubscribe: bool,
    auto: &str,
    precedence: &str,
) -> &'static str {
    let auto = auto.trim().to_ascii_lowercase();
    let precedence = precedence.trim().to_ascii_lowercase();
    let from = from.to_ascii_lowercase();
    let (local, domain) = from.rsplit_once('@').unwrap_or((&from, ""));
    if ["github.com", "gitlab.com", "bitbucket.org"]
        .iter()
        .any(|d| domain == *d || domain.ends_with(&format!(".{d}")))
    {
        "notifications"
    } else if list || unsubscribe || matches!(precedence.as_str(), "bulk" | "list") {
        "newsletters"
    } else if (!auto.is_empty() && auto != "no")
        || [
            "noreply",
            "no-reply",
            "no_reply",
            "notifications",
            "notification",
            "alerts",
            "mailer-daemon",
            "postmaster",
        ]
        .iter()
        .any(|s| {
            local == *s
                || local.starts_with(&format!("{s}+"))
                || local.starts_with(&format!("{s}-"))
        })
    {
        "notifications"
    } else {
        "mail"
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    #[serde(flatten)]
    pub row: ThreadRow,
    pub is_done: bool,
    pub pending_move: bool,
    pub category: String,
}

pub fn list_inbox(
    conn: &Connection,
    account: Option<&str>,
    show_done: bool,
    grouped: bool,
    offset: i64,
    limit: i64,
) -> rusqlite::Result<Vec<TaskRow>> {
    // Page thread IDs before windowing wide header rows, keeping large archives cheap.
    let candidates = if grouped {
        ", page_items AS (SELECT item FROM raw_scope GROUP BY item ORDER BY MAX(date) DESC,item DESC LIMIT ?4 OFFSET ?5)"
    } else {
        ""
    };
    let page_filter = if grouped {
        "WHERE item IN (SELECT item FROM page_items)"
    } else {
        ""
    };
    let pagination = if grouped { "" } else { "LIMIT ?4 OFFSET ?5" };
    let sql = format!(
        "WITH raw_scope AS NOT MATERIALIZED (
           SELECT m.*, f.role,
             CASE WHEN ?3 THEN m.thread_id ELSE m.id END AS item
           FROM messages m JOIN folders f ON f.id=m.folder_id JOIN accounts a ON a.id=m.account_id
           WHERE (?1 IS NULL OR m.account_id=?1)
             AND (f.role='inbox' OR (?2 AND (f.role='archive' OR
               (f.role='all' AND COALESCE(m.from_addr,'') != a.email COLLATE NOCASE
                AND NOT EXISTS (SELECT 1 FROM messages s JOIN folders sf ON sf.id=s.folder_id
                  WHERE s.account_id=m.account_id AND s.message_id=m.message_id
                    AND sf.role IN ('sent','trash','junk'))))))
         ) {candidates}, copies AS (
           SELECT *,ROW_NUMBER() OVER (PARTITION BY account_id,
             CASE WHEN message_id IS NOT NULL THEN 'mid:'||message_id ELSE 'id:'||id END
             ORDER BY (role='inbox') DESC,local_move DESC,id DESC) AS copy_rank FROM raw_scope {page_filter}
         ), scope AS (SELECT * FROM copies WHERE copy_rank=1), ranked AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY item ORDER BY (role='inbox') DESC,date DESC,id DESC) AS rank,
             MAX(role='inbox') OVER (PARTITION BY item) AS outstanding,
             MIN(is_read) OVER (PARTITION BY item) AS all_read,
             MAX(is_starred) OVER (PARTITION BY item) AS any_star,
             MAX(local_move) OVER (PARTITION BY item) AS pending_all,
             COUNT(*) OVER (PARTITION BY item) AS n,
             MAX(has_attachments) OVER (PARTITION BY item) AS any_attachment,
             MAX(date) OVER (PARTITION BY item) AS last_date
           FROM scope
         ) SELECT thread_id,id,account_id,from_name,from_addr,subject,snippet,last_date,
             all_read,any_star,any_attachment,n,NOT outstanding,pending_all,list_id,
             list_unsubscribe,auto_submitted,precedence
           FROM ranked WHERE rank=1 ORDER BY last_date DESC,item DESC {pagination}"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map(params![account, show_done, grouped, limit, offset], |r| {
            let address = r.get::<_, Option<String>>(4)?.unwrap_or_default();
            let list: Option<String> = r.get(14)?;
            let unsubscribe: Option<String> = r.get(15)?;
            let auto = r.get::<_, Option<String>>(16)?.unwrap_or_default();
            let precedence = r.get::<_, Option<String>>(17)?.unwrap_or_default();
            Ok(TaskRow {
                category: category(
                    &address,
                    list.is_some(),
                    unsubscribe.is_some(),
                    &auto,
                    &precedence,
                )
                .into(),
                is_done: r.get(12)?,
                pending_move: r.get(13)?,
                row: ThreadRow {
                    id: r.get(0)?,
                    message_id: if grouped { None } else { Some(r.get(1)?) },
                    account_id: r.get(2)?,
                    from_name: r
                        .get::<_, Option<String>>(3)?
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| address.clone()),
                    from_addr: address,
                    subject: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    snippet: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    date: r.get(7)?,
                    is_read: r.get(8)?,
                    is_starred: r.get(9)?,
                    has_attachments: r.get(10)?,
                    message_count: r.get(11)?,
                },
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Move the cached row instead of deleting it: body, attachments and FTS keep
/// their stable IDs while the real server coordinates live in the op journal.
pub fn set_done(conn: &mut Connection, ids: &[i64], done: bool) -> rusqlite::Result<Vec<String>> {
    let tx = conn.transaction()?;
    let mut accounts = Vec::new();
    let mut folders = std::collections::BTreeSet::new();
    let mut batches = std::collections::BTreeMap::<(String, i64, i64), Value>::new();
    for id in ids {
        let row: Option<(String,i64,i64,bool,String,String)> = tx.query_row(
            "SELECT m.account_id,m.folder_id,m.uid,m.local_move,f.imap_name,a.provider
             FROM messages m JOIN folders f ON f.id=m.folder_id JOIN accounts a ON a.id=m.account_id WHERE m.id=?1",
            [id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
        let Some((account, origin, uid, pending, origin_name, provider)) = row else {
            continue;
        };
        let role = if done {
            if provider == "gmail" {
                "all"
            } else {
                "archive"
            }
        } else {
            "inbox"
        };
        let target:Option<(i64,String)>=tx.query_row("SELECT id,imap_name FROM folders WHERE account_id=?1 AND role=?2 ORDER BY id LIMIT 1",params![account,role],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let (target, target_name) = match target {
            Some(v) => v,
            None if done && provider != "gmail" => {
                tx.execute("INSERT INTO folders(account_id,imap_name,role,display_name,sort_order) VALUES(?1,'Archive','archive','Archive',30)",[&account])?;
                (tx.last_insert_rowid(), "Archive".into())
            }
            None => return Err(rusqlite::Error::InvalidQuery),
        };
        if target == origin {
            continue;
        }
        if pending {
            // Reversing the desired move is safe offline; the journal schedules
            // the inverse with the destination's real UID once it arrives.
            let has_id: bool = tx.query_row(
                "SELECT message_id IS NOT NULL FROM messages WHERE id=?1",
                [id],
                |r| r.get(0),
            )?;
            if !has_id {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.execute(
                "UPDATE cached_moves SET desired_folder=?2 WHERE message_id=?1",
                params![id, target],
            )?;
        } else {
            let validity: Option<i64> = tx.query_row(
                "SELECT uidvalidity FROM folders WHERE id=?1",
                [origin],
                |r| r.get(0),
            )?;
            tx.execute("INSERT INTO cached_moves(message_id,origin_folder,origin_uid,origin_validity,expected_folder,desired_folder) VALUES(?1,?2,?3,?4,?5,?5)",params![id,origin,uid,validity,target])?;
            let payload=batches.entry((account.clone(),origin,target)).or_insert_with(||json!({
                "folderId":origin,"imapName":origin_name,"originValidity":validity,"uids":[],"cachedMessageIds":[],
                "destFolderId":target,"destImapName":target_name,"createDest":done && provider!="gmail"
            }));
            payload["uids"]
                .as_array_mut()
                .expect("batch UIDs")
                .push(json!(uid));
            payload["cachedMessageIds"]
                .as_array_mut()
                .expect("batch IDs")
                .push(json!(id));
        }
        tx.execute(
            "UPDATE messages SET folder_id=?2,uid=-id,local_move=1 WHERE id=?1",
            params![id, target],
        )?;
        folders.insert(origin);
        folders.insert(target);
        if !accounts.contains(&account) {
            accounts.push(account);
        }
    }
    for ((account, _, _), payload) in batches {
        bodies::enqueue_op(
            &tx,
            &account,
            if done { "archive" } else { "restore" },
            &payload,
        )?;
    }
    for folder in folders {
        queries::recompute_folder_unread(&tx, folder)?;
    }
    tx.commit()?;
    Ok(accounts)
}

pub fn finish_cached(
    conn: &mut Connection,
    payload: &Value,
    success: bool,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for id in payload["cachedMessageIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_i64)
    {
        if success {
            tx.execute(
                "UPDATE cached_moves SET confirmed=1 WHERE message_id=?1",
                [id],
            )?;
        } else {
            let row:Option<(i64,i64,Option<i64>)>=tx.query_row("SELECT origin_folder,origin_uid,origin_validity FROM cached_moves WHERE message_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            if let Some((folder, uid, validity)) = row {
                let Some(current) = tx
                    .query_row(
                        "SELECT uidvalidity FROM folders WHERE id=?1",
                        [folder],
                        |r| r.get::<_, Option<i64>>(0),
                    )
                    .optional()?
                else {
                    continue;
                };
                let previous: i64 =
                    tx.query_row("SELECT folder_id FROM messages WHERE id=?1", [id], |r| {
                        r.get(0)
                    })?;
                if current == validity {
                    tx.execute(
                        "UPDATE messages SET folder_id=?2,uid=?3,local_move=0 WHERE id=?1",
                        params![id, folder, uid],
                    )?;
                    tx.execute("DELETE FROM cached_moves WHERE message_id=?1", [id])?;
                } else {
                    // Never reuse coordinates across a UIDVALIDITY reset.
                    tx.execute(
                        "UPDATE messages SET folder_id=?2 WHERE id=?1",
                        params![id, folder],
                    )?;
                    tx.execute("UPDATE cached_moves SET expected_folder=?2,desired_folder=?2,confirmed=1 WHERE message_id=?1",params![id,folder])?;
                }
                queries::recompute_folder_unread(&tx, folder)?;
                queries::recompute_folder_unread(&tx, previous)?;
            }
        }
    }
    tx.commit()
}

/// Bind a moved message back to its new server UID without replacing its body.
pub fn adopt(conn: &Connection, msg: &NewMessage) -> rusqlite::Result<Option<(i64, i64)>> {
    type CachedMatch = (i64, i64, i64, Option<bool>, Option<bool>);
    let Some(key) = msg
        .message_id
        .as_deref()
        .and_then(threading::normalize_msgid)
    else {
        return Ok(None);
    };
    let row:Option<CachedMatch>=conn.query_row(
        "SELECT m.id,m.thread_id,c.desired_folder,c.read_override,c.star_override FROM messages m JOIN cached_moves c ON c.message_id=m.id
         WHERE m.account_id=?1 AND m.message_id=?2 AND c.expected_folder=?3 AND c.confirmed=1 AND m.local_move=1 ORDER BY m.id LIMIT 1",
        params![msg.account_id,key,msg.folder_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let Some((id, thread, desired, read, star)) = row else {
        return Ok(None);
    };
    let duplicate: Option<(i64, i64, i64)> = conn
        .query_row(
            "SELECT id,thread_id,body_state FROM messages WHERE folder_id=?1 AND uid=?2 AND id!=?3",
            params![msg.folder_id, msg.uid, id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((other, other_thread, body_state)) = duplicate {
        let cached: bool = conn.query_row(
            "SELECT body_state!=0 FROM messages WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        if !cached && body_state != 0 {
            conn.execute("INSERT OR REPLACE INTO message_bodies(message_id,body_html,body_text,headers_raw) SELECT ?1,body_html,body_text,headers_raw FROM message_bodies WHERE message_id=?2",params![id,other])?;
            conn.execute(
                "UPDATE attachments SET message_id=?1 WHERE message_id=?2",
                params![id, other],
            )?;
            conn.execute(
                "UPDATE messages SET body_state=?2 WHERE id=?1",
                params![id, body_state],
            )?;
            if let Some((_, Some(text))) = bodies::get_body(conn, id)? {
                queries::fts_index_body(conn, id, &text)?;
            }
        }
        conn.execute("DELETE FROM messages_fts WHERE rowid=?1", [other])?;
        conn.execute("DELETE FROM messages WHERE id=?1", [other])?;
        if other_thread != thread {
            conn.execute(
                "UPDATE messages SET thread_id=?1 WHERE thread_id=?2",
                params![thread, other_thread],
            )?;
            conn.execute("DELETE FROM threads WHERE id=?1", [other_thread])?;
        }
    }
    let name: String = conn.query_row(
        "SELECT imap_name FROM folders WHERE id=?1",
        [msg.folder_id],
        |r| r.get(0),
    )?;
    for (flag, value, server) in [
        ("seen", read, msg.is_read),
        ("flagged", star, msg.is_starred),
    ] {
        if let Some(on) = value.filter(|v| *v != server) {
            bodies::enqueue_op(
                conn,
                &msg.account_id,
                "set_flag",
                &json!({"folderId":msg.folder_id,"imapName":name,"uids":[msg.uid],"flag":flag,"on":on}),
            )?;
        }
    }
    if desired == msg.folder_id {
        conn.execute(
            "UPDATE messages SET uid=?2,local_move=0,is_read=?3,is_starred=?4 WHERE id=?1",
            params![
                id,
                msg.uid,
                read.unwrap_or(msg.is_read),
                star.unwrap_or(msg.is_starred)
            ],
        )?;
        conn.execute("DELETE FROM cached_moves WHERE message_id=?1", [id])?;
    } else {
        let dest: String = conn.query_row(
            "SELECT imap_name FROM folders WHERE id=?1",
            [desired],
            |r| r.get(0),
        )?;
        conn.execute("UPDATE cached_moves SET origin_folder=?2,origin_uid=?3,origin_validity=(SELECT uidvalidity FROM folders WHERE id=?2),expected_folder=desired_folder,confirmed=0 WHERE message_id=?1",params![id,msg.folder_id,msg.uid])?;
        let inbox: bool = conn.query_row(
            "SELECT role='inbox' FROM folders WHERE id=?1",
            [desired],
            |r| r.get(0),
        )?;
        let validity: Option<i64> = conn.query_row(
            "SELECT uidvalidity FROM folders WHERE id=?1",
            [msg.folder_id],
            |r| r.get(0),
        )?;
        bodies::enqueue_op(
            conn,
            &msg.account_id,
            if inbox { "restore" } else { "archive" },
            &json!({"folderId":msg.folder_id,"imapName":name,"originValidity":validity,"uids":[msg.uid],"destFolderId":desired,"destImapName":dest,"cachedMessageIds":[id]}),
        )?;
    }
    threading::recompute_thread(conn, thread)?;
    queries::recompute_folder_unread(conn, desired)?;
    Ok(Some((id, thread)))
}

pub fn cleanup_unidentified(conn: &mut Connection, folder: i64) -> rusqlite::Result<()> {
    // shortcut: without Message-ID we cannot bind an old body to a new UID
    // safely. Retain it offline, then use the server copy after destination
    // sync succeeds; UIDPLUS receipts would allow retaining its body too.
    let ids = {
        let mut stmt = conn.prepare(
            "SELECT m.id FROM messages m JOIN cached_moves c ON c.message_id=m.id
          WHERE m.local_move=1 AND m.message_id IS NULL AND c.confirmed=1 AND c.expected_folder=?1",
        )?;
        let ids = stmt
            .query_map([folder], |r| r.get(0))?
            .collect::<Result<Vec<i64>, _>>()?;
        ids
    };
    bodies::remove_messages_local(conn, &ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn seed(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute("INSERT INTO accounts(id,email,provider,imap_host,smtp_host,created_at) VALUES('a','me@example.com','custom','imap.example.com','smtp.example.com',0)",[])?;
        for (id, name, role) in [
            (1, "INBOX", "inbox"),
            (2, "Archive", "archive"),
            (3, "Sent", "sent"),
            (4, "All Mail", "all"),
        ] {
            conn.execute("INSERT INTO folders(id,account_id,imap_name,display_name,role,uidvalidity) VALUES(?1,'a',?2,?2,?3,1)",params![id,name,role])?;
        }
        Ok(())
    }
    fn message(folder: i64, uid: u32, key: Option<&str>, date: i64) -> NewMessage {
        NewMessage {
            account_id: "a".into(),
            folder_id: folder,
            uid,
            message_id: key.map(str::to_owned),
            date,
            from_addr: Some("person@example.com".into()),
            subject: Some("Work".into()),
            ..Default::default()
        }
    }
    fn add(conn: &mut Connection, msg: &NewMessage) -> (i64, i64) {
        queries::insert_message(conn, msg).unwrap().unwrap()
    }
    fn payload(conn: &Connection) -> Value {
        serde_json::from_str(
            &conn
                .query_row::<String, _, _>(
                    "SELECT payload FROM pending_ops ORDER BY id DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn classification_uses_headers_without_reclassifying_human_mail() {
        assert_eq!(
            category("human@example.com", false, false, "No", ""),
            "mail"
        );
        assert_eq!(
            category("news@example.com", true, false, "", ""),
            "newsletters"
        );
        assert_eq!(
            category("news@example.com", false, false, "", " BULK "),
            "newsletters"
        );
        assert_eq!(
            category("notifications@github.com", true, true, "", ""),
            "notifications"
        );
        assert_eq!(
            category("alerts+orders@example.com", false, false, "", ""),
            "notifications"
        );
        assert_eq!(
            category("human@example.com", false, false, "auto-generated", ""),
            "notifications"
        );
    }

    #[test]
    fn archive_restore_preserves_body_ids_and_new_reply_reopens_thread() {
        Db::open_in_memory()
            .unwrap()
            .with(|conn| {
                seed(conn)?;
                let original = message(1, 10, Some("<original@example.com>"), 10);
                let (id, thread) = add(conn, &original);
                bodies::set_body(
                    conn,
                    id,
                    Some("<p>Keep me</p>"),
                    Some("Keep me"),
                    "Keep me",
                    &[],
                )?;
                set_done(conn, &[id], true)?;
                assert!(list_inbox(conn, None, false, true, 0, 100)?.is_empty());
                assert!(list_inbox(conn, None, true, true, 0, 100)?[0].is_done);
                assert!(bodies::resolve_uids(conn, &[id])?.is_empty());
                finish_cached(conn, &payload(conn), true)?;
                let mut archived = original.clone();
                archived.folder_id = 2;
                archived.uid = 77;
                assert_eq!(add(conn, &archived), (id, thread));
                assert_eq!(
                    bodies::get_body(conn, id)?.unwrap().1.as_deref(),
                    Some("Keep me")
                );
                let mut reply = message(1, 11, Some("<reply@example.com>"), 20);
                reply.in_reply_to = original.message_id.clone();
                let (_, reply_thread) = add(conn, &reply);
                assert_eq!(reply_thread, thread);
                let rows = list_inbox(conn, None, true, true, 0, 100)?;
                assert_eq!(rows.len(), 1);
                assert!(!rows[0].is_done);
                assert_eq!(rows[0].row.message_count, 2);
                let ids = task_ids(conn, &[thread], &[], false)?;
                assert_eq!(ids, vec![id]);
                set_done(conn, &ids, false)?;
                finish_cached(conn, &payload(conn), true)?;
                let mut restored = original;
                restored.uid = 99;
                assert_eq!(add(conn, &restored).0, id);
                assert_eq!(
                    bodies::get_body(conn, id)?.unwrap().1.as_deref(),
                    Some("Keep me")
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn offline_undo_queues_inverse_with_actual_destination_uid() {
        Db::open_in_memory()
            .unwrap()
            .with(|conn| {
                seed(conn)?;
                let original = message(1, 10, Some("<offline@example.com>"), 10);
                let (id, _) = add(conn, &original);
                set_done(conn, &[id], true)?;
                let archive = payload(conn);
                set_done(conn, &[id], false)?;
                assert!(!list_inbox(conn, None, true, true, 0, 100)?[0].is_done);
                finish_cached(conn, &archive, true)?;
                let mut arrived = original.clone();
                arrived.folder_id = 2;
                arrived.uid = 202;
                add(conn, &arrived);
                let inverse = payload(conn);
                assert_eq!(inverse["uids"], json!([202]));
                assert_eq!(inverse["destFolderId"], 1);
                finish_cached(conn, &inverse, true)?;
                let mut restored = original;
                restored.uid = 303;
                assert_eq!(add(conn, &restored).0, id);
                assert_eq!(
                    conn.query_row::<i64, _, _>(
                        "SELECT local_move FROM messages WHERE id=?1",
                        [id],
                        |r| r.get(0)
                    )?,
                    0
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn failed_move_rolls_back_both_folder_counts_and_retains_body() {
        Db::open_in_memory()
            .unwrap()
            .with(|conn| {
                seed(conn)?;
                let (id, _) = add(conn, &message(1, 10, Some("<fail@example.com>"), 10));
                bodies::set_body(conn, id, None, Some("Offline"), "Offline", &[])?;
                set_done(conn, &[id], true)?;
                finish_cached(conn, &payload(conn), false)?;
                assert_eq!(
                    conn.query_row::<(i64, i64), _, _>(
                        "SELECT folder_id,uid FROM messages WHERE id=?1",
                        [id],
                        |r| Ok((r.get(0)?, r.get(1)?))
                    )?,
                    (1, 10)
                );
                assert_eq!(
                    conn.query_row::<i64, _, _>(
                        "SELECT unread_count FROM folders WHERE id=2",
                        [],
                        |r| r.get(0)
                    )?,
                    0
                );
                assert!(bodies::get_body(conn, id)?.is_some());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn gmail_existing_all_mail_copy_is_deduplicated_and_sent_is_not_restored() {
        Db::open_in_memory()
            .unwrap()
            .with(|conn| {
                seed(conn)?;
                conn.execute("UPDATE accounts SET provider='gmail'", [])?;
                let original = message(1, 10, Some("<gmail@example.com>"), 10);
                let (id, thread) = add(conn, &original);
                let mut all = original;
                all.folder_id = 4;
                all.uid = 55;
                add(conn, &all);
                assert_eq!(
                    list_inbox(conn, None, true, true, 0, 100)?[0]
                        .row
                        .message_count,
                    1
                );
                set_done(conn, &[id], true)?;
                finish_cached(conn, &payload(conn), true)?;
                assert_eq!(add(conn, &all).0, id);
                assert_eq!(
                    conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM messages", [], |r| r.get(0))?,
                    1
                );
                let mut sent = message(4, 56, Some("<sent@example.com>"), 11);
                sent.from_addr = Some("me@example.com".into());
                sent.in_reply_to = all.message_id;
                let (sent_id, _) = add(conn, &sent);
                assert_eq!(task_ids(conn, &[thread], &[], false)?, vec![id]);
                assert!(!task_ids(conn, &[thread], &[], false)?.contains(&sent_id));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn queued_archive_survives_database_reopen() {
        let path = std::env::temp_dir().join(format!("skim-task-test-{}.db", uuid::Uuid::new_v4()));
        let db = Db::open(&path).unwrap();
        let id = db
            .with(|conn| {
                seed(conn)?;
                let (id, _) = add(conn, &message(1, 10, Some("<restart@example.com>"), 10));
                bodies::set_body(conn, id, None, Some("Saved offline"), "Saved offline", &[])?;
                set_done(conn, &[id], true)?;
                Ok(id)
            })
            .unwrap();
        drop(db);
        let db = Db::open(&path).unwrap();
        db.with(|conn| {
            let rows = list_inbox(conn, None, true, true, 0, 100)?;
            assert_eq!(rows.len(), 1);
            assert!(rows[0].is_done && rows[0].pending_move);
            assert_eq!(
                bodies::get_body(conn, id)?.unwrap().1.as_deref(),
                Some("Saved offline")
            );
            assert_eq!(payload(conn)["uids"], json!([10]));
            Ok(())
        })
        .unwrap();
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn validity_reset_does_not_reuse_old_uid_and_pending_flags_follow_the_body() {
        Db::open_in_memory()
            .unwrap()
            .with(|conn| {
                seed(conn)?;
                let original = message(1, 10, Some("<reset@example.com>"), 10);
                let (id, _) = add(conn, &original);
                set_done(conn, &[id], true)?;
                conn.execute("UPDATE folders SET uidvalidity=2 WHERE id=1", [])?;
                finish_cached(conn, &payload(conn), false)?;
                assert!(list_inbox(conn, None, true, true, 0, 100)?[0].pending_move);
                assert!(bodies::resolve_uids(conn, &[id])?.is_empty());
                bodies::set_flag_local(conn, &[id], "seen", true)?;
                let mut arrived = original;
                arrived.uid = 800;
                assert_eq!(add(conn, &arrived).0, id);
                assert!(list_inbox(conn, None, false, true, 0, 100)?[0].row.is_read);
                assert_eq!(payload(conn)["uids"], json!([800]));
                assert_eq!(payload(conn)["flag"], "seen");
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn paging_and_account_scope_keep_the_same_order_for_tied_dates() {
        Db::open_in_memory().unwrap().with(|conn| {
            seed(conn)?;
            conn.execute("INSERT INTO accounts(id,email,provider,imap_host,smtp_host,created_at) VALUES('b','other@example.com','custom','x','x',0)",[])?;
            conn.execute("INSERT INTO folders(id,account_id,imap_name,display_name,role) VALUES(5,'b','INBOX','Inbox','inbox')",[])?;
            for uid in 1..=12 {
                let mut msg=message(1,uid,Some(&format!("<page{uid}@example.com>")),10);
                msg.subject=Some(format!("Separate {uid}"));
                add(conn,&msg);
            }
            let mut other=message(5,1,Some("<other@example.com>"),20);other.account_id="b".into();
            add(conn,&other);
            let all=list_inbox(conn,Some("a"),true,true,0,100)?;
            let mut pages=Vec::new();
            for offset in [0,5,10] {pages.extend(list_inbox(conn,Some("a"),true,true,offset,5)?.into_iter().map(|r|r.row.id));}
            assert_eq!(pages,all.iter().map(|r|r.row.id).collect::<Vec<_>>());
            assert_eq!(all.len(),12);
            assert_eq!(list_inbox(conn,None,true,true,0,100)?.len(),13);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn unidentified_messages_are_not_matched_by_subject_and_survive_until_sync() {
        Db::open_in_memory()
            .unwrap()
            .with(|conn| {
                seed(conn)?;
                let (id, _) = add(conn, &message(1, 10, None, 10));
                set_done(conn, &[id], true)?;
                cleanup_unidentified(conn, 2)?;
                assert_eq!(list_inbox(conn, None, true, true, 0, 100)?.len(), 1);
                assert!(set_done(conn, &[id], false).is_err());
                finish_cached(conn, &payload(conn), true)?;
                let (new_id, _) = add(conn, &message(2, 55, None, 10));
                assert_ne!(id, new_id);
                cleanup_unidentified(conn, 2)?;
                assert_eq!(list_inbox(conn, None, true, false, 0, 100)?.len(), 1);
                Ok(())
            })
            .unwrap();
    }
}
