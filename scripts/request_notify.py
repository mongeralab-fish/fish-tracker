"""Fish-floor requests: tell the lab when someone asks for one of its shared lines,
and tell the person who asked when the lab answers. Runs every hour (GitHub Actions).

Emails go through the lab Gmail account; phone notifications through Web Push.
GitHub run logs are public: this script only ever prints counts, never names or addresses.
"""
from __future__ import annotations

import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from html import escape

sys.path.insert(0, os.path.dirname(__file__))
from weekly_summary import APP_URL  # noqa: E402

STATUS = {"accepted": "said yes", "declined": "can't help this time", "done": "marked it as done"}


def main() -> int:
    import psycopg
    from psycopg.rows import dict_row

    db_url = os.environ["SUPABASE_DB_URL"]
    gmail_user, gmail_pw = os.environ.get("GMAIL_USER"), os.environ.get("GMAIL_APP_PASSWORD")
    vapid = os.environ.get("VAPID_PRIVATE_KEY")
    dry = os.environ.get("DRY_RUN") == "1"
    smtp = None
    n_mail = n_push = n_new = n_rep = 0

    with psycopg.connect(db_url, row_factory=dict_row) as conn:
        q = lambda sql, *a: [dict(r) for r in conn.execute(sql, a).fetchall()]
        if not q("select to_regclass('public.requests') is not null as ok")[0]["ok"]:
            print("No requests table yet (database update 11 not run).")
            return 0

        def name_of(m):
            return (m.get("display_name") or (m.get("email") or "").split("@")[0]) if m else "Someone"

        def send(member, subject, text, html, push_title, push_body):
            nonlocal smtp, n_mail, n_push
            if dry:
                return
            if member.get("notify_email", True) and gmail_user and gmail_pw:
                if smtp is None:
                    smtp = smtplib.SMTP("smtp.gmail.com", 587, timeout=30)
                    smtp.starttls(context=ssl.create_default_context())
                    smtp.login(gmail_user, gmail_pw)
                msg = EmailMessage()
                msg["Subject"], msg["From"], msg["To"] = subject, f"Fish Tracker <{gmail_user}>", member["email"]
                msg.set_content(text)
                msg.add_alternative(html, subtype="html")
                smtp.send_message(msg)
                n_mail += 1
            if member.get("notify_push", True) and vapid:
                from pywebpush import WebPushException, webpush
                for sub in q("select endpoint, keys from public.push_subscriptions where user_id = %s", member["user_id"]):
                    try:
                        webpush(subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
                                data=json.dumps({"title": push_title, "body": push_body, "url": APP_URL + "#floor"}),
                                vapid_private_key=vapid, vapid_claims={"sub": f"mailto:{gmail_user or 'fish-tracker@example.org'}"}, ttl=86400)
                        n_push += 1
                    except WebPushException as e:
                        if getattr(e.response, "status_code", None) in (404, 410):
                            conn.execute("delete from public.push_subscriptions where endpoint = %s", (sub["endpoint"],))

        labs = {r["id"]: r["name"] for r in q("select id::text, name from public.labs")}
        members = q("select lab_id::text, user_id::text, email, display_name, role, notify_email, notify_push from public.members")
        mem = lambda lab, uid: next((m for m in members if m["lab_id"] == lab and m["user_id"] == uid), None)

        # 1) new requests -> the line's contact person (or the lab's admins if there is none)
        for r in q("""select r.id, r.from_lab::text, r.to_lab::text, r.line_name, r.wants, r.message, r.by::text,
                             coalesce(s.share_contact, s.keepers[1], s.created_by)::text as contact
                        from public.requests r left join public.stocks s on s.id = r.stock_id
                       where r.notified_at is null and r.status = 'open'"""):
            asker = mem(r["from_lab"], r["by"])
            contact = mem(r["to_lab"], r["contact"]) if r["contact"] else None
            to = [contact] if contact else [m for m in members if m["lab_id"] == r["to_lab"] and m["role"] in ("owner", "admin")]
            frm = labs.get(r["from_lab"], "Another lab")
            subject = f"{frm} would like {r['line_name']}"
            lines = [f"{name_of(asker)} ({frm}) asked for {r['line_name']}" + (f": {r['wants'].lower()}" if r.get("wants") else "") + "."]
            if r.get("message"):
                lines.append(f"Message: “{r['message']}”")
            lines.append(f"Answer in the Fish Tracker › Fish floor: {APP_URL}#floor")
            lines.append(f"You can also reply directly: {asker['email']}" if asker else "")
            text = "\n\n".join(x for x in lines if x)
            html = "".join(f"<p>{escape(x)}</p>" for x in lines if x).replace(escape(APP_URL + "#floor"), f'<a href="{APP_URL}#floor">{escape(APP_URL)}#floor</a>')
            for m in to:
                send(m, subject, text, html, subject, f"{name_of(asker)}: {r.get('wants') or 'request'}. Tap to answer.")
            conn.execute("update public.requests set notified_at = now() where id = %s", (r["id"],))
            n_new += 1

        # 2) answers -> the person who asked
        for r in q("""select id, from_lab::text, to_lab::text, line_name, status, reply, by::text, replied_by::text
                        from public.requests
                       where replied_at is not null and reply_notified_at is null and status in ('accepted','declined','done')"""):
            asker = mem(r["from_lab"], r["by"])
            if asker:
                lab = labs.get(r["to_lab"], "The lab")
                who = name_of(mem(r["to_lab"], r["replied_by"]))
                subject = f"{lab} {STATUS.get(r['status'], 'answered')}: {r['line_name']}"
                lines = [f"{who} ({lab}) {STATUS.get(r['status'], 'answered')} about {r['line_name']}."]
                if r.get("reply"):
                    lines.append(f"Reply: “{r['reply']}”")
                lines.append(f"See it in the Fish Tracker › Fish floor: {APP_URL}#floor")
                text = "\n\n".join(lines)
                html = "".join(f"<p>{escape(x)}</p>" for x in lines)
                send(asker, subject, text, html, subject, r.get("reply") or "Tap to see it.")
            conn.execute("update public.requests set reply_notified_at = now() where id = %s", (r["id"],))
            n_rep += 1
        if dry:
            conn.rollback()

    if smtp:
        smtp.quit()
    print(f"Done: {n_new} new request(s), {n_rep} answer(s); {n_mail} emails, {n_push} phone notifications.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
