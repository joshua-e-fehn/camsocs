/**
 * CAMsocs: the Art 14 notice mail merge (PLAN.md J7, Linear ENG-40).
 *
 * A Google Apps Script bound to the Google Sheet the outreach CSV is imported
 * into (`/dashboard/reports` → "Download outreach CSV"). It sends each row's
 * `notice` from the contact address, one email per row (never To/Cc/Bcc to
 * more than one address: breach-procedure.md), writes the date into `sent_on`
 * as each one goes out, marks bounces in `bounced` and queues the row's next
 * address (`next_emails`) after a bounce. The sheet is then downloaded as CSV
 * and imported back on the same dashboard page ("Import send log"), which
 * records one interaction per send. The procedure is docs/webapp.md
 * "Sending the Art 14 notice".
 *
 * Every menu item works on the sheet (tab) in front, so one spreadsheet can
 * hold both exports: the outreach CSV, and the webmail-only CSV ("Download
 * webmail-only CSV (Art 14)", societies whose only usable address is webmail;
 * `email_kind` is `webmail` on each row). Joshua decides whether to send the
 * second. To use it, import it as a new sheet (File → Import → Upload →
 * "Insert new sheet(s)", "Convert text to numbers, dates and formulas" off)
 * or into a separate spreadsheet with its own copy of this script; select
 * its tab, then the same menu flow (check, test, batches, bounces, next
 * address), and download that tab as CSV for "Import send log" as well.
 *
 * Install: in the sheet, Extensions → Apps Script, replace Code.gs with this
 * file, save, reload the sheet; the "Art 14 notice" menu appears. The script
 * runs as the signed-in Google account, which must have `CONFIG.from` as its
 * own address or as a "Send mail as" address: since D11 that is
 * joshua@camsocs.uk (CAMsocs' own Workspace), where privacy@ is set up as one.
 * The first notice (ENG-40, 4 Nov 2026) went out from camsocs@joshua-fehn.de,
 * which forwards to the camsocs.uk mailbox.
 *
 * Limits: Apps Script sends to at most 1,500 recipients a day from a Google
 * Workspace account (100 from a consumer account); each batch is capped by
 * `CONFIG.batchSize` and by the quota left, and a run must finish inside
 * Apps Script's 6 minutes.
 *
 * `bun test` in webapp/ runs this file against a fake sheet and Gmail
 * (webapp/lib/broker/art14-mail-merge.test.ts).
 */

const CONFIG = {
  /** The published contact address (webapp/lib/site.ts `CONTACT_EMAIL`). */
  from: "privacy@camsocs.uk",
  name: "Joshua Fehn (CAMsocs)",
  /** Rows per "Send the next batch". */
  batchSize: 100,
  /** Pause between two emails, so a batch is not one burst. */
  pauseMs: 1000,
  /** Where Gmail and the receiving servers put bounces. */
  bounceSearch: "from:(mailer-daemon OR postmaster) newer_than:30d",
  timeZone: "Europe/London",
}

/** The export's columns this script reads or writes. */
const REQUIRED_COLUMNS = ["org_name", "org_key", "email", "notice", "sent_on", "bounced"]

/** A bounce, not a delay warning or an auto-reply. */
const BOUNCE_SUBJECT = /failure|failed|undeliverable|undelivered|not delivered|returned mail/i
const DELAY_SUBJECT = /delay/i
const BOUNCE_SENDER = /mailer-daemon|postmaster/i

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Art 14 notice")
    .addItem("1. Check the setup", "checkSetup")
    .addItem("2. Send a test to me", "sendTest")
    .addItem("3. Send the next batch", "sendBatch")
    .addItem("4. Mark bounces", "markBounces")
    .addItem("5. Queue the next address for bounces", "queueNextAddresses")
    .addToUi()
}

// --- menu items (each wraps one function the tests call) -------------------

function checkSetup() {
  const status = setupStatus_()
  SpreadsheetApp.getUi().alert(
    [
      `Sheet: "${status.sheet}".`,
      status.senderProblem || `Sending as ${CONFIG.from}: ready.`,
      `Rows to send: ${status.pending}. Sent: ${status.sent}. Bounced: ${status.bounced}.`,
      `Recipients left in today's quota: ${status.quota}.`,
    ].join("\n"),
  )
}

function sendTest() {
  const ui = SpreadsheetApp.getUi()
  const me = Session.getActiveUser().getEmail()
  const answer = ui.prompt(
    "Send a test",
    `Send the first unsent row's notice to which address? (empty: ${me})`,
    ui.ButtonSet.OK_CANCEL,
  )
  if (answer.getSelectedButton() !== ui.Button.OK) return
  const to = answer.getResponseText().trim() || me
  ui.alert(sendTestTo_(to))
}

function sendBatch() {
  const ui = SpreadsheetApp.getUi()
  const status = setupStatus_()
  const size = Math.min(CONFIG.batchSize, status.pending, status.quota)
  if (status.senderProblem) return ui.alert(status.senderProblem)
  if (size === 0) {
    return ui.alert(status.pending === 0 ? "Nothing left to send." : "Today's quota is used up.")
  }
  const ok = ui.alert(
    "Send the next batch",
    `Send ${size} notices from ${CONFIG.from} now, from the sheet "${status.sheet}"? (${status.pending} rows to send in all)`,
    ui.ButtonSet.OK_CANCEL,
  )
  if (ok !== ui.Button.OK) return
  const result = sendNext_(size)
  ui.alert(
    [
      `Sent ${result.sent}. Rows still to send: ${result.remaining}.`,
      result.skipped.length > 0
        ? `Skipped rows with no valid address or notice: ${result.skipped.join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  )
}

function markBounces() {
  const marked = markBounces_()
  SpreadsheetApp.getUi().alert(
    marked.length > 0
      ? `Marked ${marked.length} bounced: ${marked.join(", ")}. Run "Queue the next address" next.`
      : "No new bounces found.",
  )
}

function queueNextAddresses() {
  const result = queueNextAddresses_()
  SpreadsheetApp.getUi().alert(
    [
      `Queued ${result.queued} rows for their next address; send them with "Send the next batch".`,
      result.noRoute.length > 0
        ? `No address left (send the notice another way and log it in the dashboard): ${result.noRoute.join("; ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  )
}

// --- the work --------------------------------------------------------------

/** The sheet (tab) in front: the outreach export or the webmail-only one. */
function sheet_() {
  return SpreadsheetApp.getActiveSheet()
}

/** The sheet's rows and a column index by (lowercased) header name. */
function table_(sheet) {
  const values = sheet.getDataRange().getValues()
  const col = {}
  ;(values[0] || []).forEach((name, i) => {
    const key = String(name).trim().toLowerCase()
    if (key && !(key in col)) col[key] = i
  })
  const missing = REQUIRED_COLUMNS.filter((name) => !(name in col))
  if (missing.length > 0) {
    throw new Error(
      `The sheet needs the columns ${missing.join(", ")}: import the outreach CSV from /dashboard/reports.`,
    )
  }
  return { values, col }
}

function cell_(row, col, name) {
  return name in col ? String(row[col[name]] ?? "").trim() : ""
}

function today_() {
  return Utilities.formatDate(new Date(), CONFIG.timeZone, "yyyy-MM-dd")
}

function isAddress_(email) {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)
}

function subject_(orgName) {
  return `Your CAMsocs listing (${orgName}): what we hold and how to change it`
}

/** Why the account cannot send as `CONFIG.from`, or "" when it can. */
function senderProblem_() {
  const me = String(Session.getEffectiveUser().getEmail()).toLowerCase()
  const from = CONFIG.from.toLowerCase()
  if (me === from) return ""
  if (GmailApp.getAliases().some((alias) => String(alias).toLowerCase() === from)) return ""
  return `${CONFIG.from} is not a "Send mail as" address of ${me}. Add it in Gmail → Settings → Accounts → Send mail as, then reload the sheet.`
}

function send_(to, subject, body) {
  const me = String(Session.getEffectiveUser().getEmail()).toLowerCase()
  const options = { name: CONFIG.name, replyTo: CONFIG.from }
  if (me !== CONFIG.from.toLowerCase()) options.from = CONFIG.from
  GmailApp.sendEmail(to, subject, body, options)
}

/** Rows (sheet row numbers, 1 = header) that still need sending. */
function pendingRows_(values, col) {
  const rows = []
  for (let i = 1; i < values.length; i++) {
    const row = values[i]
    if (cell_(row, col, "sent_on") !== "") continue
    if (cell_(row, col, "email") === "" && cell_(row, col, "notice") === "") continue
    rows.push(i + 1)
  }
  return rows
}

function setupStatus_() {
  const sheet = sheet_()
  const { values, col } = table_(sheet)
  let sent = 0
  let bounced = 0
  for (const row of values.slice(1)) {
    if (cell_(row, col, "sent_on") !== "") sent++
    if (cell_(row, col, "bounced") !== "") bounced++
  }
  return {
    sheet: sheet.getName(),
    senderProblem: senderProblem_(),
    pending: pendingRows_(values, col).length,
    sent,
    bounced,
    quota: MailApp.getRemainingDailyQuota(),
  }
}

/** Sends the first unsent row's notice to `to`, marked as a test. Writes
 * nothing to the sheet. */
function sendTestTo_(to) {
  const problem = senderProblem_()
  if (problem) return problem
  if (!isAddress_(to)) return `"${to}" is not an address.`
  const { values, col } = table_(sheet_())
  const [first] = pendingRows_(values, col)
  if (!first) return "There is no unsent row to test with."
  const row = values[first - 1]
  send_(to, `[Test] ${subject_(cell_(row, col, "org_name"))}`, cell_(row, col, "notice"))
  return `Sent row ${first} (${cell_(row, col, "org_name")}) to ${to} as a test. Nothing was written to the sheet.`
}

/**
 * Sends up to `limit` unsent rows, one email each, and writes today's date
 * into each row's `sent_on` straight after its email goes, so a run that
 * stops halfway leaves an exact log. A row whose address or notice is not
 * usable is skipped and left unsent.
 */
function sendNext_(limit) {
  const problem = senderProblem_()
  if (problem) throw new Error(problem)
  const lock = LockService.getDocumentLock()
  if (!lock.tryLock(1000)) throw new Error("Another batch is running; wait for it to finish.")
  try {
    const sheet = sheet_()
    const { values, col } = table_(sheet)
    const max = Math.max(0, Math.min(limit, MailApp.getRemainingDailyQuota()))
    const pending = pendingRows_(values, col)
    const skipped = []
    let sent = 0
    for (const number of pending) {
      if (sent >= max) break
      const row = values[number - 1]
      const email = cell_(row, col, "email").toLowerCase()
      const notice = cell_(row, col, "notice")
      if (!isAddress_(email) || notice === "") {
        skipped.push(number)
        continue
      }
      if (sent > 0) Utilities.sleep(CONFIG.pauseMs)
      send_(email, subject_(cell_(row, col, "org_name")), notice)
      sheet
        .getRange(number, col.sent_on + 1)
        .setNumberFormat("@")
        .setValue(today_())
      SpreadsheetApp.flush()
      sent++
    }
    return { sent, remaining: pending.length - sent - skipped.length, skipped }
  } finally {
    lock.releaseLock()
  }
}

/** Whether `text` names `email` as a whole address (so `chess@srcf.net` is
 * not found inside `cuchess@srcf.net`). */
function mentions_(text, email) {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-z0-9._%+-])${escaped}($|[^a-z0-9.-]|\\.(?![a-z0-9]))`, "i").test(text)
}

/**
 * Reads the bounce messages in the mailbox and puts `yes` in `bounced` for
 * each sent, not yet bounced row whose address a bounce names. Delay
 * warnings ("will retry") are not bounces. Returns the addresses marked.
 */
function markBounces_() {
  const sheet = sheet_()
  const { values, col } = table_(sheet)
  const open = new Map()
  for (let i = 1; i < values.length; i++) {
    const row = values[i]
    if (cell_(row, col, "sent_on") === "" || cell_(row, col, "bounced") !== "") continue
    const email = cell_(row, col, "email").toLowerCase()
    if (!open.has(email)) open.set(email, [])
    open.get(email).push(i + 1)
  }
  const marked = []
  for (const thread of GmailApp.search(CONFIG.bounceSearch, 0, 200)) {
    for (const message of thread.getMessages()) {
      // A thread holds the notice that bounced too: only the daemon's report counts.
      if (!BOUNCE_SENDER.test(String(message.getFrom()))) continue
      const subject = String(message.getSubject())
      if (!BOUNCE_SUBJECT.test(subject) || DELAY_SUBJECT.test(subject)) continue
      const body = String(message.getPlainBody())
      for (const [email, rows] of open) {
        if (!mentions_(body, email)) continue
        for (const number of rows) sheet.getRange(number, col.bounced + 1).setValue("yes")
        marked.push(email)
        open.delete(email)
      }
    }
  }
  SpreadsheetApp.flush()
  return marked
}

/**
 * For each organisation whose every sent row bounced and that has nothing
 * left to send, appends a row for the next address in `next_emails` it has
 * not tried yet (the same notice; `sent_on` and `bounced` empty). Returns how
 * many it queued and the organisations with no address left.
 */
function queueNextAddresses_() {
  const sheet = sheet_()
  const { values, col } = table_(sheet)
  const byOrg = new Map()
  for (const row of values.slice(1)) {
    const key = cell_(row, col, "org_key")
    if (!key) continue
    if (!byOrg.has(key)) byOrg.set(key, [])
    byOrg.get(key).push(row)
  }
  let queued = 0
  const noRoute = []
  for (const rows of byOrg.values()) {
    const done = rows.some(
      (row) => cell_(row, col, "sent_on") === "" || cell_(row, col, "bounced") === "",
    )
    if (done) continue
    const tried = new Set(rows.map((row) => cell_(row, col, "email").toLowerCase()))
    const last = rows[rows.length - 1]
    const next = cell_(last, col, "next_emails")
      .split(/[;,\s]+/)
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== "" && isAddress_(email) && !tried.has(email))
    if (next.length === 0) {
      noRoute.push(cell_(last, col, "org_name") || cell_(last, col, "org_key"))
      continue
    }
    const copy = last.slice()
    copy[col.email] = next[0]
    if ("next_emails" in col) copy[col.next_emails] = next.slice(1).join("; ")
    if ("role" in col) copy[col.role] = ""
    // The webmail-only export's next addresses are webmail too: keep its flag.
    if ("email_kind" in col && copy[col.email_kind] !== "webmail") copy[col.email_kind] = ""
    copy[col.sent_on] = ""
    copy[col.bounced] = ""
    sheet.appendRow(copy)
    queued++
  }
  SpreadsheetApp.flush()
  return { queued, noRoute }
}
