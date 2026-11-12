"""Fish Tracker weekly summary.

Reads the lab database, builds one summary per lab member (their own lines, or the
whole lab for people who chose "everything"), and sends it by email and/or phone
notification, following each member's preferences.

Environment (GitHub secrets):
  SUPABASE_DB_URL      Postgres connection string (session pooler)
  GMAIL_USER           sender address (the lab Gmail)
  GMAIL_APP_PASSWORD   Gmail app password
  VAPID_PRIVATE_KEY    private key for phone notifications
Optional:
  ONLY_TO              send only to this email address (testing)
  DRY_RUN              "1" = print the summaries, send nothing
"""
from __future__ import annotations

import json
import os
import smtplib
import ssl
import sys
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from zoneinfo import ZoneInfo

APP_ADDRESS = "mongeralab-fish.github.io/fish-tracker"
APP_URL = "https://" + APP_ADDRESS + "/"
DEFAULTS = {"regenMonths": 15, "regenWarnMonths": 2, "breedGapDays": 60, "minBreedAgeMonths": 3}
SOON_DAYS = 14          # "close to needing a cross"
PPL_WARN_DAYS = 90


# ---------- date helpers ----------
def add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year
    m += 1
    import calendar
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def fmt(d: date | None) -> str:
    return d.strftime("%-d %b %Y") if d else "—"


def as_date(v) -> date | None:
    if v is None or v == "":
        return None
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10])


# ---------- the summary logic (pure, testable) ----------
def build(data: dict, today: date) -> dict:
    """Return {user_id: {"member": m, "sections": [...], "counts": {...}}}."""
    s = {**DEFAULTS, **(data.get("settings") or {})}
    stocks = [x for x in data["stocks"] if x.get("status", "active") == "active"]
    crosses = [c for c in data["crosses"] if not c.get("deleted")]
    plans = [p for p in data["plans"] if p.get("status") == "planned"]
    licences = data.get("licences") or []
    by_id = {x["id"]: x for x in data["stocks"]}
    label = lambda x: f'{x.get("stock") or "?"} · {x.get("name") or "unnamed line"}'

    last = {}
    for c in crosses:
        d = as_date(c.get("date"))
        for sid in (c.get("stock_id"), c.get("stock2_id")):
            if sid and d and (sid not in last or d > last[sid]):
                last[sid] = d

    items = []   # (kind, stock or None, text, sort_key)
    for x in stocks:
        fd = as_date(x.get("fert_date"))
        if not fd or x.get("regen_date"):
            continue
        due = add_months(fd, s["regenMonths"])
        warn = add_months(fd, s["regenMonths"] - s["regenWarnMonths"])
        if today >= due:
            items.append(("regen_now", x, f'{label(x)} — {(today - fd).days // 30} months old, regeneration was due {fmt(due)}', due))
        elif today >= warn:
            items.append(("regen_soon", x, f'{label(x)} — regenerate by {fmt(due)} ({(due - today).days} days left)', due))
        mature = add_months(fd, s["minBreedAgeMonths"])
        if today < mature:
            continue
        lb = last.get(x["id"])
        ref = lb if lb and lb > mature else mature
        since = (today - ref).days
        gap = s["breedGapDays"]
        when = f'last crossed {fmt(lb)} ({(today - lb).days} days ago)' if lb else "never crossed"
        if since >= gap:
            items.append(("breed_now", x, f'{label(x)} — {when}', -since))
        elif since >= gap - SOON_DAYS:
            items.append(("breed_soon", x, f'{label(x)} — {when}, needs a cross within {gap - since} days', gap - since))

    for c in crosses:
        if c.get("success") is None and as_date(c.get("date")) and as_date(c["date"]) < today:
            a = by_id.get(c.get("stock_id"))
            b = by_id.get(c.get("stock2_id")) if c.get("stock2_id") else None
            partner = label(b) if b else (c.get("partner") or "same stock")
            items.append(("pending", a, f'♀ {label(a) if a else c.get("stock_label") or "?"} × ♂ {partner} — set up {fmt(as_date(c["date"]))}, result not added yet', as_date(c["date"])))
    for p in plans:
        d = as_date(p.get("date"))
        if d and d <= today + timedelta(days=7):
            a = by_id.get(p.get("stock_id"))
            b = by_id.get(p.get("stock2_id")) if p.get("stock2_id") else None
            partner = label(b) if b else (p.get("partner") or "same stock")
            when = "overdue" if d < today else d.strftime("%a %-d %b")
            items.append(("plan", a, f'{when}: ♀ {label(a) if a else "?"} × ♂ {partner}{" — " + p["note"] if p.get("note") else ""}', d, p.get("by")))

    ppl_items = []
    for l in licences:
        d = as_date(l.get("expires"))
        if d and (d - today).days <= PPL_WARN_DAYS:
            n = sum(1 for x in stocks if (x.get("ppl") or "").strip().lower() == (l.get("ppl") or "").strip().lower())
            state = f"expired on {fmt(d)}" if d < today else f"expires on {fmt(d)} ({(d - today).days} days)"
            ppl_items.append(f'PPL {l["ppl"]} {state} — {n} active tank{"s" if n != 1 else ""}')

    TITLES = [("breed_now", "Needs a cross (not bred for too long)"), ("breed_soon", "Close to needing a cross"),
              ("regen_now", "Regenerate now"), ("regen_soon", "Regeneration deadline coming up"),
              ("pending", "Crosses waiting for a result"), ("plan", "Planned crosses this week")]

    out = {}
    for m in data["members"]:
        uid = m["user_id"]
        everything = bool(m.get("digest_all"))
        def mine(it):
            kind, x = it[0], it[1]
            if everything:
                return True
            if kind == "plan" and len(it) > 4 and it[4] == uid:
                return True
            return bool(x) and uid in (x.get("keepers") or [])
        secs = []
        counts = {}
        for kind, title in TITLES:
            rows = sorted([it for it in items if it[0] == kind and mine(it)], key=lambda it: it[3])
            counts[kind] = len(rows)
            if rows:
                secs.append((title, [it[2] for it in rows]))
        if ppl_items and (everything or m.get("role") in ("owner", "admin")):
            secs.append(("Project licences", ppl_items))
            counts["ppl"] = len(ppl_items)
        out[uid] = {"member": m, "sections": secs, "counts": counts, "scope": "the whole lab" if everything else "your lines"}
    return out


def render_text(name: str, summ: dict, today: date) -> tuple[str, str, str]:
    c = summ["counts"]
    head_bits = []
    if c.get("breed_now"): head_bits.append(f'{c["breed_now"]} to breed')
    if c.get("regen_now"): head_bits.append(f'{c["regen_now"]} to regenerate')
    if c.get("pending"): head_bits.append(f'{c["pending"]} results to add')
    if c.get("breed_soon") or c.get("regen_soon"): head_bits.append(f'{c.get("breed_soon",0)+c.get("regen_soon",0)} coming up')
    subject = "Fish room this week: " + (", ".join(head_bits) if head_bits else "nothing urgent")
    lines = [f"Hello {name},", "", f"Here is the fish room summary for {summ['scope']} (week of {fmt(today)}).", ""]
    html = [f"<p>Hello {esc(name)},</p><p>Here is the fish room summary for <b>{esc(summ['scope'])}</b> (week of {esc(fmt(today))}).</p>"]
    for title, rows in summ["sections"]:
        lines += [title.upper()] + [f"  • {r}" for r in rows] + [""]
        html.append(f"<h3 style='margin:16px 0 6px;font-family:Arial,sans-serif'>{esc(title)} ({len(rows)})</h3><ul style='margin:0;padding-left:20px'>" + "".join(f"<li>{esc(r)}</li>" for r in rows) + "</ul>")
    lines += [f"Open the tracker: {APP_ADDRESS}", "", "You get this because of your weekly summary settings in the tracker (Settings › Your account)."]
    html.append(f"<p style='margin-top:18px'>Open the tracker: <b>{APP_ADDRESS}</b></p><p style='color:#666;font-size:12px'>You get this because of your weekly summary settings in the tracker (Settings › Your account).</p>")
    return subject, "\n".join(lines), "<div style='font-family:Arial,sans-serif;font-size:14px;line-height:1.45'>" + "".join(html) + "</div>"


def push_text(summ: dict) -> tuple[str, str]:
    c = summ["counts"]
    bits = []
    if c.get("breed_now"): bits.append(f'{c["breed_now"]} to breed')
    if c.get("breed_soon"): bits.append(f'{c["breed_soon"]} soon to breed')
    if c.get("regen_now"): bits.append(f'{c["regen_now"]} to regenerate')
    if c.get("regen_soon"): bits.append(f'{c["regen_soon"]} regeneration soon')
    if c.get("pending"): bits.append(f'{c["pending"]} results to add')
    if c.get("plan"): bits.append(f'{c["plan"]} planned')
    if c.get("ppl"): bits.append("PPL expiring")
    return "Fish room this week", " · ".join(bits)


def esc(s) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------- I/O ----------
def load(db_url: str) -> dict:
    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(db_url, row_factory=dict_row) as conn:
        q = lambda sql: [dict(r) for r in conn.execute(sql).fetchall()]
        settings = q("select data from public.settings where id = 1")
        return {
            "settings": settings[0]["data"] if settings else {},
            "stocks": q("select id::text, stock, name, status, fert_date, regen_date, ppl, keepers::text[] as keepers from public.stocks"),
            "crosses": q("select stock_id::text, stock2_id::text, stock_label, partner, date, success, deleted from public.crosses"),
            "plans": q("select stock_id::text, stock2_id::text, partner, date, note, status, by::text from public.plans"),
            "licences": q("select ppl, expires from public.licences"),
            "members": q("select user_id::text, email, display_name, role, notify_email, notify_push, digest_all from public.members"),
            "subs": q("select endpoint, user_id::text, keys from public.push_subscriptions"),
        }


def delete_sub(db_url: str, endpoint: str) -> None:
    import psycopg
    with psycopg.connect(db_url) as conn:
        conn.execute("delete from public.push_subscriptions where endpoint = %s", (endpoint,))


def main() -> int:
    db_url = os.environ["SUPABASE_DB_URL"]
    dry = os.environ.get("DRY_RUN") == "1"
    only = (os.environ.get("ONLY_TO") or "").strip().lower()
    today = datetime.now(ZoneInfo("Europe/London")).date()
    data = load(db_url)
    result = build(data, today)

    gmail_user, gmail_pw = os.environ.get("GMAIL_USER"), os.environ.get("GMAIL_APP_PASSWORD")
    vapid = os.environ.get("VAPID_PRIVATE_KEY")
    smtp = None
    sent_mail = sent_push = 0
    for uid, summ in result.items():
        m = summ["member"]
        if only and (m.get("email") or "").lower() != only:
            continue
        if not summ["sections"]:
            print(f"- {m['email']}: nothing to report")
            continue
        name = m.get("display_name") or m["email"].split("@")[0]
        subject, text, html = render_text(name, summ, today)
        if dry:
            print("=" * 60, f"\nTO {m['email']} | {subject}\n{text}\n")
            continue
        if m.get("notify_email", True) and gmail_user and gmail_pw:
            if smtp is None:
                smtp = smtplib.SMTP("smtp.gmail.com", 587, timeout=30)
                smtp.starttls(context=ssl.create_default_context())
                smtp.login(gmail_user, gmail_pw)
            msg = EmailMessage()
            msg["Subject"], msg["From"], msg["To"] = subject, f"Fish Tracker <{gmail_user}>", m["email"]
            msg.set_content(text)
            msg.add_alternative(html, subtype="html")
            smtp.send_message(msg)
            sent_mail += 1
        if m.get("notify_push", True) and vapid:
            from pywebpush import WebPushException, webpush
            title, body = push_text(summ)
            for sub in [x for x in data["subs"] if x["user_id"] == uid]:
                try:
                    webpush(subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
                            data=json.dumps({"title": title, "body": body, "url": APP_URL}),
                            vapid_private_key=vapid, vapid_claims={"sub": f"mailto:{gmail_user or 'fish-tracker@example.org'}"}, ttl=86400)
                    sent_push += 1
                except WebPushException as e:
                    code = getattr(e.response, "status_code", None)
                    if code in (404, 410):
                        delete_sub(db_url, sub["endpoint"])   # phone unsubscribed or app removed
                    else:
                        print(f"push failed for {m['email']}: {code}", file=sys.stderr)
    if smtp:
        smtp.quit()
    print(f"Done: {sent_mail} emails, {sent_push} phone notifications.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
