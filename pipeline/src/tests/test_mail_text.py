"""List mail is cut down before the LLM sees it (DPIA-lite R-4):
`extract.mail_text.clean_mail_text` on synthetic mails (fictional people,
reserved example domains and Ofcom drama numbers)."""

from __future__ import annotations

from pathlib import Path

from camsocs_pipeline.extract.mail_text import clean_mail_text

FIXTURES = Path(__file__).parent / "fixtures" / "mail"


def clean(name: str, subject: str | None = None):
    return clean_mail_text((FIXTURES / name).read_text(encoding="utf-8"), subject=subject)


def test_a_digest_keeps_its_events_and_loses_signature_contacts_and_footer():
    result = clean("weekly_digest.txt", subject="This week at the Quokka Society")
    text = result.text
    assert "Wednesday 14 October, 7:30pm — Quokka Pub Quiz" in text
    assert "Week 3 Friday — Formal swap" in text
    # The person, their contacts and the list's footer are gone …
    for gone in ("Anna", "anna.example", "7700", "unsubscribe", "Copyright", "Example Lane"):
        assert gone not in text, gone
    assert "browser" not in text
    # … the organisation's own sign-off line stays: it names no one.
    assert "President, CU Quokka Society" in text
    assert "[email]" in text and "[phone]" in text
    assert result.removed["signature"] == 1
    assert result.removed["list footer"] >= 3
    assert result.summary().startswith("cleaned: ")


def test_a_reply_loses_the_quoted_message_and_the_device_line():
    result = clean("reply_with_quote.txt", subject="Re: Talk tonight")
    text = result.text
    assert 'the talk "Quokkas and Quantum" is tonight, Tuesday 13 October at 6pm' in text
    for gone in ("Carol", "carol.example", "Talks Officer", "iPhone", "Ben", "wrote"):
        assert gone not in text, gone
    assert result.removed["quoted reply"] == 1


def test_an_outlook_forward_keeps_the_forwarded_body_without_its_headers():
    result = clean("outlook_forward.txt", subject="FW: Quokka events this week")
    text = result.text
    assert "Our welcome drinks are on Thursday 8 October from 8pm, Old Library." in text
    # An event's own "From: … / To: …" times are not a mail header.
    assert "From: 8pm" in text and "To: 11pm" in text
    for gone in ("Dan", "Sent:", "soc-cuqas", "Erin", "she/her", "sympa", "____"):
        assert gone not in text, gone
    assert "Fitzwilliam College JCR" in text
    assert result.removed["forwarded headers"] == 1


def test_a_gmail_forward_and_a_german_sign_off():
    result = clean("gmail_forward.txt", subject="Fwd: Stammtisch")
    text = result.text
    assert "Every Wednesday at 7pm in the Maypole, starting Week 1." in text
    assert "The CUGS Committee" in text
    for gone in ("Forwarded message", "cugs@example.org", "Frank", "Date:", "Grüße"):
        assert gone not in text, gone


def test_a_reply_header_block_under_a_reply_subject_is_cut():
    mail = (
        "Yes, see you there.\n\n"
        "From: Grace Example <grace@example.org>\n"
        "Sent: 05 October 2026 18:00\n"
        "To: Henry Example <henry@example.org>\n"
        "Subject: Rowing on Saturday\n\n"
        "Outing at 7am on Saturday 10 October.\n"
    )
    replied = clean_mail_text(mail, subject="RE: Rowing on Saturday").text
    assert replied == "Yes, see you there."
    forwarded = clean_mail_text(mail, subject="FW: Rowing on Saturday").text
    assert "Outing at 7am on Saturday 10 October." in forwarded
    assert "Grace" not in forwarded


def test_a_thanks_line_never_swallows_an_event():
    text = clean_mail_text(
        "Thanks!\nTalk: Quantum Quokkas, Wed 14 Oct, 7pm, Lecture Theatre 1\n"
    ).text
    assert "Talk: Quantum Quokkas, Wed 14 Oct, 7pm, Lecture Theatre 1" in text


def test_plain_text_is_left_alone():
    result = clean_mail_text("Chess club meets every Monday at 7pm in the bar.")
    assert result.text == "Chess club meets every Monday at 7pm in the bar."
    assert result.summary() == ""
