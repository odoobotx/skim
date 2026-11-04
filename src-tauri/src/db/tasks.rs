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
        AND ((?3 AND f.role='inbox') OR (f.role='archive' OR
          (f.role='all' AND COALESCE(m.from_addr,'') != a.email COLLATE NOCASE
            AND NOT EXISTS (SELECT 1 FROM messages s JOIN folders sf ON sf.id=s.folder_id
              WHERE s.account_id=m.account_id AND s.message_id=m.message_id AND sf.role IN ('sent','trash','junk')))))")?;
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
    name: &str,
    subject: &str,
    list: bool,
    unsubscribe: bool,
    auto: &str,
    precedence: &str,
) -> &'static str {
    let auto = auto.trim().to_ascii_lowercase();
    let precedence = precedence.trim().to_ascii_lowercase();
    let from = from.to_ascii_lowercase();
    let (local, domain) = from.rsplit_once('@').unwrap_or((&from, ""));
    let subject = subject.trim().to_ascii_lowercase();
    let name = name.to_ascii_lowercase();
    let is_reply = ["re:", "fw:", "fwd:"]
        .iter()
        .any(|prefix| subject.trim_start().starts_with(prefix));
    let report = subject.starts_with("report domain:")
        && (subject.contains("submitter:") || subject.contains("report-id:"));
    let nas_word = |text: &str| {
        text.split(|c: char| !c.is_ascii_alphanumeric())
            .any(|word| {
                matches!(
                    word,
                    "nas" | "synology" | "qnap" | "truenas" | "readynas" | "asustor"
                )
            })
    };
    let nas_notice = (nas_word(local) || nas_word(&name)) && nas_word(&subject)
        || nas_word(&name) && (name.contains("notification") || name.contains("system"));
    let mailing_list = list || unsubscribe || matches!(precedence.as_str(), "bulk" | "list");
    if ["github.com", "gitlab.com", "bitbucket.org"]
        .iter()
        .any(|d| domain == *d || domain.ends_with(&format!(".{d}")))
        || !is_reply && (report || nas_notice && !mailing_list)
    {
        "notifications"
    } else if mailing_list {
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
    pub priority_override: Option<bool>,
    pub priority_at: i64,
}

pub fn set_priority(
    conn: &Connection,
    thread: i64,
    message: Option<i64>,
    priority: Option<bool>,
) -> rusqlite::Result<()> {
    let ids = task_ids(
        conn,
        &[thread],
        &message.into_iter().collect::<Vec<_>>(),
        true,
    )?;
    let marked_at = if priority == Some(true) {
        chrono::Utc::now().timestamp_millis()
    } else {
        0
    };
    conn.execute("UPDATE messages AS m SET priority_override=?2,priority_at=?3 WHERE
      (m.id IN (SELECT value FROM json_each(?1)) OR (m.account_id,m.message_id) IN
        (SELECT account_id,message_id FROM messages WHERE id IN (SELECT value FROM json_each(?1)) AND message_id IS NOT NULL))
      AND m.folder_id IN (SELECT id FROM folders WHERE role IN ('inbox','archive','all'))",params![json!(ids).to_string(),priority,marked_at])?;
    Ok(())
}

pub fn list_inbox(
    conn: &Connection,
    account: Option<&str>,
    show_done: bool,
    grouped: bool,
    offset: i64,
    limit: i64,
) -> rusqlite::Result<Vec<TaskRow>> {
    inbox_rows(conn, account, show_done, grouped, offset, limit, false)
}

pub fn recent_unread(
    conn: &Connection,
    account: Option<&str>,
    limit: i64,
) -> rusqlite::Result<Vec<TaskRow>> {
    inbox_rows(conn, account, false, true, 0, limit, true)
}

#[derive(Serialize)]
pub struct HomeUnread {
    pub rows: Vec<TaskRow>,
    pub total: i64,
}

fn home_checkpoint(conn: &Connection) -> rusqlite::Result<Value> {
    Ok(queries::get_setting(conn, "home_inbox_seen")?
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({})))
}

fn home_filter(checkpoint: &str) -> String {
    format!(
        "m.is_read=0 AND (
      json_extract({checkpoint}, '$.\"'||f.id||'\".account') IS NOT m.account_id
      OR json_extract({checkpoint}, '$.\"'||f.id||'\".validity') IS NOT f.uidvalidity
      OR m.uid > COALESCE(json_extract({checkpoint}, '$.\"'||f.id||'\".uid'), -1))"
    )
}

/// Inbox entry acknowledges arrivals, independently of the mail's read flag.
/// IMAP UIDs distinguish new arrivals from old mail fetched during backfill.
pub fn acknowledge_inbox(conn: &Connection, account: Option<&str>) -> rusqlite::Result<()> {
    let mut seen = home_checkpoint(conn)?;
    let mut stmt = conn.prepare(
        "SELECT f.id,f.account_id,f.uidvalidity,COALESCE(MAX(m.uid),0)
      FROM folders f LEFT JOIN messages m ON m.folder_id=f.id AND m.local_move=0
      WHERE f.role='inbox' AND (?1 IS NULL OR f.account_id=?1) GROUP BY f.id",
    )?;
    let rows = stmt.query_map([account], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    for row in rows {
        let (folder, account, validity, mut uid) = row?;
        let key = folder.to_string();
        let previous = &seen[&key];
        if previous["account"] == account && previous["validity"] == json!(validity) {
            uid = uid.max(previous["uid"].as_i64().unwrap_or(0));
        }
        seen[key] = json!({"account":account,"validity":validity,"uid":uid});
    }
    queries::set_setting(conn, "home_inbox_seen", &seen.to_string())
}

pub fn home_unread(conn: &Connection, account: Option<&str>) -> rusqlite::Result<HomeUnread> {
    let checkpoint = home_checkpoint(conn)?.to_string();
    let sql = format!("SELECT COUNT(DISTINCT m.account_id||':'||COALESCE('mid:'||NULLIF(m.message_id,''),'pk:'||m.id))
      FROM messages m JOIN folders f ON f.id=m.folder_id
      WHERE f.role='inbox' AND (?1 IS NULL OR m.account_id=?1) AND {}", home_filter("?2"));
    let total = conn.query_row(&sql, params![account, checkpoint], |r| r.get(0))?;
    Ok(HomeUnread {
        rows: recent_unread(conn, account, 5)?,
        total,
    })
}

fn inbox_rows(
    conn: &Connection,
    account: Option<&str>,
    show_done: bool,
    grouped: bool,
    offset: i64,
    limit: i64,
    unread_only: bool,
) -> rusqlite::Result<Vec<TaskRow>> {
    // Page thread IDs before windowing wide header rows, keeping large archives cheap.
    let order = if unread_only {
        "MAX(date) DESC,item DESC"
    } else {
        "MAX(COALESCE(priority_override,0)) DESC,MAX(priority_at) DESC,MAX(date) DESC,item DESC"
    };
    let candidates = if grouped {
        format!(", page_items AS (SELECT item FROM raw_scope GROUP BY item ORDER BY {order} LIMIT ?4 OFFSET ?5)")
    } else {
        String::new()
    };
    let priority_order = if unread_only {
        ""
    } else {
        "COALESCE(priority_all,0) DESC,priority_time DESC,"
    };
    let page_filter = if grouped {
        "WHERE item IN (SELECT item FROM page_items)"
    } else {
        ""
    };
    let pagination = if grouped { "" } else { "LIMIT ?4 OFFSET ?5" };
    let home_filter = home_filter("?7");
    let checkpoint = if unread_only {
        home_checkpoint(conn)?.to_string()
    } else {
        "{}".into()
    };
    let sql = format!(
        "WITH raw_scope AS NOT MATERIALIZED (
           SELECT m.*, f.role,
             CASE WHEN ?3 THEN m.thread_id ELSE m.id END AS item
           FROM messages m JOIN folders f ON f.id=m.folder_id JOIN accounts a ON a.id=m.account_id
           WHERE (?1 IS NULL OR m.account_id=?1)
             AND (NOT ?6 OR ({home_filter}))
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
             MAX(priority_override) OVER (PARTITION BY item) AS priority_all,
             MAX(priority_at) OVER (PARTITION BY item) AS priority_time,
             MAX(has_attachments) OVER (PARTITION BY item) AS any_attachment,
             MAX(date) OVER (PARTITION BY item) AS last_date
           FROM scope
         ) SELECT thread_id,id,account_id,from_name,from_addr,subject,snippet,last_date,
             all_read,any_star,any_attachment,n,NOT outstanding,pending_all,list_id,
             list_unsubscribe,auto_submitted,precedence,priority_all,priority_time
           FROM ranked WHERE rank=1 ORDER BY {priority_order}last_date DESC,item DESC {pagination}"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map(
            params![
                account,
                show_done,
                grouped,
                limit,
                offset,
                unread_only,
                checkpoint
            ],
            |r| {
                let address = r.get::<_, Option<String>>(4)?.unwrap_or_default();
                let name = r.get::<_, Option<String>>(3)?.unwrap_or_default();
                let subject = r.get::<_, Option<String>>(5)?.unwrap_or_default();
                let list: Option<String> = r.get(14)?;
                let unsubscribe: Option<String> = r.get(15)?;
                let auto = r.get::<_, Option<String>>(16)?.unwrap_or_default();
                let precedence = r.get::<_, Option<String>>(17)?.unwrap_or_default();
                Ok(TaskRow {
                    category: category(
                        &address,
                        &name,
                        &subject,
                        list.is_some(),
                        unsubscribe.is_some(),
                        &auto,
                        &precedence,
                    )
                    .into(),
                    priority_override: r.get(18)?,
                    priority_at: r.get(19)?,
                    is_done: r.get(12)?,
                    pending_move: r.get(13)?,
                    row: ThreadRow {
                        id: r.get(0)?,
                        message_id: if grouped { None } else { Some(r.get(1)?) },
                        account_id: r.get(2)?,
                        from_name: if name.is_empty() {
                            address.clone()
                        } else {
                            name
                        },
                        from_addr: address,
                        subject,
                        snippet: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        date: r.get(7)?,
                        is_read: r.get(8)?,
                        is_starred: r.get(9)?,
                        has_attachments: r.get(10)?,
                        message_count: r.get(11)?,
                    },
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Move the cached row instead of deleting it: body, attachments and FTS keep
/// their stable IDs while the real server coordinates live in the op journal.
pub fn set_done(conn: &mut Connection, ids: &[i64], done: bool) -> rusqlite::Result<Vec<String>> {
    let tx = conn.transaction()?;
    let mut accounts = Vec::new();
    let mut folders = std::collections::BTreeSet::new();
    let mut threads = std::collections::BTreeSet::new();
    let mut batches = std::collections::BTreeMap::<(String, i64, i64), Value>::new();
    let mut flags = std::collections::BTreeMap::<(String, i64), Value>::new();
    for id in ids {
        let row: Option<(String,i64,i64,bool,String,String)> = tx.query_row(
            "SELECT m.account_id,m.folder_id,m.uid,m.local_move,f.imap_name,a.provider
             FROM messages m JOIN folders f ON f.id=m.folder_id JOIN accounts a ON a.id=m.account_id WHERE m.id=?1",
            [id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
        let Some((account, origin, uid, pending, origin_name, provider)) = row else {
            continue;
        };
        let (inbox, was_read, validity, thread): (bool,bool,Option<i64>,Option<i64>) = tx.query_row(
            "SELECT f.role='inbox',m.is_read,f.uidvalidity,m.thread_id FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.id=?1",
            [id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        if let Some(thread) = thread {
            threads.insert(thread);
        }
        folders.insert(origin);
        if !accounts.contains(&account) {
            accounts.push(account.clone());
        }
        if done {
            tx.execute(
                "UPDATE messages SET is_read=1,priority_override=NULL,priority_at=0 WHERE id=?1",
                [id],
            )?;
            tx.execute(
                "UPDATE cached_moves SET read_override=1 WHERE message_id=?1",
                [id],
            )?;
            if !pending && !was_read {
                let payload=flags.entry((account.clone(),origin)).or_insert_with(||json!({
                    "folderId":origin,"imapName":origin_name,"originValidity":validity,"uids":[],"flag":"seen","on":true
                }));
                payload["uids"]
                    .as_array_mut()
                    .expect("flag UIDs")
                    .push(json!(uid));
            }
            // Older received archive messages also become read, but only Inbox moves.
            if !inbox {
                continue;
            }
        }
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
            tx.execute("INSERT INTO cached_moves(message_id,origin_folder,origin_uid,origin_validity,expected_folder,desired_folder,read_override) VALUES(?1,?2,?3,?4,?5,?5,(SELECT is_read FROM messages WHERE id=?1))",params![id,origin,uid,validity,target])?;
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
        folders.insert(target);
    }
    for ((account, _), payload) in flags {
        bodies::enqueue_op(&tx, &account, "set_flag", &payload)?;
    }
    for ((account, _, _), payload) in batches {
        bodies::enqueue_op(
            &tx,
            &account,
            if done { "archive" } else { "restore" },
            &payload,
        )?;
    }
    for thread in threads {
        threading::recompute_thread(&tx, thread)?;
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
            category("human@example.com", "", "", false, false, "No", ""),
            "mail"
        );
        assert_eq!(
            category("news@example.com", "", "", true, false, "", ""),
            "newsletters"
        );
        assert_eq!(
            category("news@example.com", "", "", false, false, "", " BULK "),
            "newsletters"
        );
        assert_eq!(
            category("notifications@github.com", "", "", true, true, "", ""),
            "notifications"
        );
        assert_eq!(
            category("alerts+orders@example.com", "", "", false, false, "", ""),
            "notifications"
        );
        assert_eq!(
            category(
                "human@example.com",
                "",
                "",
                false,
                false,
                "auto-generated",
                ""
            ),
            "notifications"
        );
    }

    #[test]
    fn reports_and_nas_notices_use_message_signals_without_hiding_human_discussions() {
        for (from, name, subject, list, expected) in [
            (
                "dmarc@example.com",
                "DMARC report",
                "Report domain: example.net Submitter: example.com Report-ID: abc",
                false,
                "notifications",
            ),
            (
                "admin@example.com",
                "Office NAS",
                "[Office NAS] System status",
                false,
                "notifications",
            ),
            (
                "service@example.com",
                "Synology System Notification",
                "Backup task completed",
                false,
                "notifications",
            ),
            (
                "person@example.com",
                "Jonas",
                "Can we discuss the NAS backup?",
                false,
                "mail",
            ),
            (
                "person@example.com",
                "Alex",
                "Re: Report domain: example.net Submitter: example.com",
                false,
                "mail",
            ),
            (
                "admin@example.com",
                "Office NAS",
                "Re: [Office NAS] Storage question",
                false,
                "mail",
            ),
            (
                "marketing@example.com",
                "Synology",
                "Meet our new NAS",
                true,
                "newsletters",
            ),
        ] {
            assert_eq!(
                category(from, name, subject, list, false, "", ""),
                expected,
                "{subject}"
            );
        }
    }

    #[test]
    fn message_priority_is_local_scoped_and_pages_before_older_mail() {
        Db::open_in_memory()
            .unwrap()
            .with(|conn| {
                seed(conn)?;
                let first = message(1, 1, Some("<pin@example.com>"), 1);
                let (id, thread) = add(conn, &first);
                let mut copy = first.clone();
                copy.folder_id = 4;
                copy.uid = 101;
                let (copy_id, _) = add(conn, &copy);
                for uid in 2..=120 {
                    let mut other = message(
                        1,
                        uid,
                        Some(&format!("<p{uid}@example.com>")),
                        i64::from(uid),
                    );
                    other.subject = Some(format!("Different conversation {uid}"));
                    add(conn, &other);
                }
                set_priority(conn, thread, Some(id), Some(true))?;
                let rows = list_inbox(conn, None, false, true, 0, 10)?;
                assert_eq!(rows[0].row.id, thread);
                assert!(
                    rows[0].priority_override == Some(true)
                        && !rows[0].row.is_starred
                        && !rows[0].row.is_read
                );
                assert_eq!(
                    rows.iter()
                        .filter(|row| row.priority_override == Some(true))
                        .count(),
                    1
                );
                assert!(conn.query_row::<bool, _, _>(
                    "SELECT priority_override FROM messages WHERE id=?1",
                    [copy_id],
                    |r| r.get(0)
                )?);
                assert_eq!(
                    conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM pending_ops", [], |r| r
                        .get(0))?,
                    0
                );
                set_priority(conn, thread, Some(id), Some(false))?;
                assert!(!conn.query_row::<bool, _, _>(
                    "SELECT priority_override FROM messages WHERE id=?1",
                    [copy_id],
                    |r| r.get(0)
                )?);
                assert!(list_inbox(conn, None, false, true, 0, 10)?
                    .iter()
                    .all(|row| row.priority_override != Some(true)));
                set_priority(conn, thread, None, None)?;
                let state: Option<bool> = conn.query_row(
                    "SELECT priority_override FROM messages WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )?;
                assert_eq!(state, None);
                set_priority(conn, thread, None, Some(true))?;
                let ids = task_ids(conn, &[thread], &[], true)?;
                set_done(conn, &ids, true)?;
                assert!(
                    list_inbox(conn, None, true, true, 0, 200)?
                        .iter()
                        .find(|row| row.row.id == thread)
                        .unwrap()
                        .priority_override
                        != Some(true)
                );
                Ok(())
            })
            .unwrap();
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
    fn done_marks_read_locally_and_before_server_archive_and_restore_stays_read() {
        Db::open_in_memory()
            .unwrap()
            .with(|conn| {
                seed(conn)?;
                let original = message(1, 10, Some("<done-read@example.com>"), 10);
                let (id, thread) = add(conn, &original);
                queries::recompute_folder_unread(conn, 1)?;
                assert_eq!(
                    bodies::get_thread(conn, thread)?.unwrap().messages[0].account_id,
                    "a"
                );
                set_done(conn, &[id], true)?;
                let rows = list_inbox(conn, None, true, true, 0, 100)?;
                assert!(rows[0].is_done && rows[0].row.is_read);
                assert_eq!(
                    conn.query_row::<i64, _, _>(
                        "SELECT unread_count FROM threads WHERE id=?1",
                        [thread],
                        |r| r.get(0)
                    )?,
                    0
                );
                for folder in [1, 2] {
                    assert_eq!(
                        conn.query_row::<i64, _, _>(
                            "SELECT unread_count FROM folders WHERE id=?1",
                            [folder],
                            |r| r.get(0)
                        )?,
                        0
                    );
                }
                let ops = {
                    let mut stmt =
                        conn.prepare("SELECT kind,payload FROM pending_ops ORDER BY id")?;
                    let rows = stmt
                        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                        .collect::<Result<Vec<_>, _>>()?;
                    rows
                };
                assert_eq!(
                    ops.iter()
                        .map(|(kind, _)| kind.as_str())
                        .collect::<Vec<_>>(),
                    vec!["set_flag", "archive"]
                );
                let seen: Value = serde_json::from_str(&ops[0].1).unwrap();
                assert_eq!(seen["flag"], "seen");
                assert_eq!(seen["on"], true);
                assert_eq!(seen["uids"], json!([10]));
                assert_eq!(seen["originValidity"], 1);
                // A flag receipt must not confirm a move which has not happened.
                finish_cached(conn, &seen, true)?;
                assert!(!conn.query_row::<bool, _, _>(
                    "SELECT confirmed FROM cached_moves WHERE message_id=?1",
                    [id],
                    |r| r.get(0)
                )?);
                let archive: Value = serde_json::from_str(&ops[1].1).unwrap();
                finish_cached(conn, &archive, true)?;
                // Stale destination flags cannot make a completed message unread.
                let mut arrived = original.clone();
                arrived.folder_id = 2;
                arrived.uid = 77;
                assert_eq!(add(conn, &arrived).0, id);
                assert!(list_inbox(conn, None, true, true, 0, 100)?[0].row.is_read);
                set_done(conn, &[id], false)?;
                let restore = payload(conn);
                finish_cached(conn, &restore, true)?;
                let mut restored = original;
                restored.uid = 99;
                assert_eq!(add(conn, &restored).0, id);
                let rows = list_inbox(conn, None, false, true, 0, 100)?;
                assert!(!rows[0].is_done && rows[0].row.is_read);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn completing_a_conversation_reads_older_archive_but_only_moves_inbox() {
        Db::open_in_memory()
            .unwrap()
            .with(|conn| {
                seed(conn)?;
                let original = message(2, 10, Some("<earlier@example.com>"), 10);
                let (old, thread) = add(conn, &original);
                let mut reply = message(1, 20, Some("<latest@example.com>"), 20);
                reply.in_reply_to = original.message_id.clone();
                let (new, reply_thread) = add(conn, &reply);
                assert_eq!(reply_thread, thread);
                let mut sent = message(3, 30, Some("<sent-reply@example.com>"), 15);
                sent.in_reply_to = original.message_id;
                sent.from_addr = Some("me@example.com".into());
                let (sent_id, _) = add(conn, &sent);
                // Flat mode stays on the selected message; conversation mode includes history.
                assert_eq!(task_ids(conn, &[thread], &[new], true)?, vec![new]);
                let ids = task_ids(conn, &[thread], &[], true)?;
                assert_eq!(ids.len(), 2);
                assert!(ids.contains(&old) && ids.contains(&new) && !ids.contains(&sent_id));
                set_done(conn, &ids, true)?;
                let rows = list_inbox(conn, None, true, true, 0, 100)?;
                assert!(rows[0].is_done && rows[0].row.is_read);
                assert_eq!(payload(conn)["cachedMessageIds"], json!([new]));
                assert_eq!(
                    conn.query_row::<(i64, bool), _, _>(
                        "SELECT folder_id,local_move FROM messages WHERE id=?1",
                        [old],
                        |r| Ok((r.get(0)?, r.get(1)?))
                    )?,
                    (2, false)
                );
                assert!(!conn.query_row::<bool, _, _>(
                    "SELECT is_read FROM messages WHERE id=?1",
                    [sent_id],
                    |r| r.get(0)
                )?);
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
            assert!(rows[0].is_done && rows[0].pending_move && rows[0].row.is_read);
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

    #[test]
    fn home_visit_acknowledges_arrivals_without_marking_them_read() {
        Db::open_in_memory()
            .unwrap()
            .with(|conn| {
                seed(conn)?;
                let original = message(1, 20, Some("<seen@example.com>"), 100);
                let (_, thread) = add(conn, &original);
                assert_eq!(home_unread(conn, None)?.total, 1);
                acknowledge_inbox(conn, Some("a"))?;
                assert_eq!(home_unread(conn, None)?.total, 0);
                assert!(recent_unread(conn, None, 5)?.is_empty());
                assert!(!list_inbox(conn, None, false, true, 0, 100)?[0].row.is_read);
                // A recently fetched old header is not a new delivery. A new UID
                // with an old Date header is, including replies to existing threads.
                add(conn, &message(1, 5, Some("<backfill@example.com>"), 500));
                let mut reply = message(1, 21, Some("<new-reply@example.com>"), 1);
                reply.in_reply_to = original.message_id;
                assert_eq!(add(conn, &reply).1, thread);
                let summary = home_unread(conn, None)?;
                assert_eq!(summary.total, 1);
                assert_eq!(summary.rows.len(), 1);
                assert_eq!(summary.rows[0].row.id, thread);
                // Two deliveries of the same RFC message count only once.
                reply.uid = 22;
                add(conn, &reply);
                assert_eq!(home_unread(conn, None)?.total, 1);
                acknowledge_inbox(conn, None)?;
                assert_eq!(home_unread(conn, None)?.total, 0);
                assert_eq!(
                    conn.query_row::<i64, _, _>(
                        "SELECT COUNT(*) FROM messages WHERE is_read=0",
                        [],
                        |r| r.get(0)
                    )?,
                    4
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn home_checkpoints_keep_accounts_and_uid_epochs_separate() {
        Db::open_in_memory().unwrap().with(|conn| {
            seed(conn)?;
            conn.execute("INSERT INTO accounts(id,email,provider,imap_host,smtp_host,created_at) VALUES('b','other@example.com','custom','x','x',0)", [])?;
            conn.execute("INSERT INTO folders(id,account_id,imap_name,display_name,role,uidvalidity) VALUES(5,'b','INBOX','Inbox','inbox',1)", [])?;
            add(conn, &message(1, 20, Some("<a@example.com>"), 100));
            let mut other = message(5, 20, Some("<b@example.com>"), 100);
            other.account_id = "b".into();
            add(conn, &other);
            acknowledge_inbox(conn, Some("a"))?;
            assert_eq!(home_unread(conn, Some("a"))?.total, 0);
            assert_eq!(home_unread(conn, Some("b"))?.total, 1);
            assert_eq!(home_unread(conn, None)?.total, 1);
            acknowledge_inbox(conn, None)?;
            assert_eq!(home_unread(conn, None)?.total, 0);
            // Archiving/deleting the highest UID must not move the mark back
            // and turn subsequently fetched older mail into a new arrival.
            conn.execute("DELETE FROM messages WHERE folder_id=1", [])?;
            acknowledge_inbox(conn, Some("a"))?;
            add(conn, &message(1, 10, Some("<a-backfill@example.com>"), 500));
            assert_eq!(home_unread(conn, Some("a"))?.total, 0);
            // A server UID reset must not hide new arrivals behind an old mark.
            conn.execute("UPDATE folders SET uidvalidity=2 WHERE id=5", [])?;
            conn.execute("UPDATE messages SET uid=1 WHERE folder_id=5", [])?;
            assert_eq!(home_unread(conn, None)?.total, 1);
            acknowledge_inbox(conn, Some("b"))?;
            assert_eq!(home_unread(conn, None)?.total, 0);
            // Bad legacy settings recover by showing unread mail.
            queries::set_setting(conn, "home_inbox_seen", "not json")?;
            assert_eq!(home_unread(conn, None)?.total, 2);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn home_unread_is_not_limited_to_the_first_inbox_page() {
        Db::open_in_memory()
            .unwrap()
            .with(|conn| {
                seed(conn)?;
                for uid in 1..=130 {
                    let mut msg = message(
                        1,
                        uid,
                        Some(&format!("<read{uid}@example.com>")),
                        100 + i64::from(uid),
                    );
                    msg.subject = Some(format!("Read {uid}"));
                    msg.is_read = true;
                    add(conn, &msg);
                }
                let (old, _) = add(conn, &message(1, 500, Some("<old-unread@example.com>"), 1));
                add(
                    conn,
                    &message(2, 501, Some("<archive-unread@example.com>"), 1000),
                );
                assert!(list_inbox(conn, None, false, true, 0, 100)?
                    .iter()
                    .all(|r| r.row.is_read));
                let rows = recent_unread(conn, None, 5)?;
                assert_eq!(rows.len(), 1);
                assert_eq!(
                    rows[0].row.id,
                    conn.query_row::<i64, _, _>(
                        "SELECT thread_id FROM messages WHERE id=?1",
                        [old],
                        |r| r.get(0)
                    )?
                );
                assert!(!rows[0].row.is_read);
                Ok(())
            })
            .unwrap();
    }
}
