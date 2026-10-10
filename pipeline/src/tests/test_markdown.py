"""HTML fragments → the markdown stored in free-text fields (sources/markdown.py)."""

from __future__ import annotations

from camsocs_pipeline.sources.links import INVITE_WITHHELD, WITHHELD
from camsocs_pipeline.sources.markdown import html_to_markdown, html_to_text


def test_paragraphs_breaks_and_emphasis() -> None:
    html = (
        "<p>We play <strong>chess</strong> and <em>go</em>.</p>"
        "<p>Mondays&nbsp;7pm<br />Wednesdays 8pm</p><p>&nbsp;</p>"
    )
    assert html_to_markdown(html) == "We play **chess** and *go*.\n\nMondays 7pm\nWednesdays 8pm"


def test_emphasis_keeps_its_spaces_outside_and_joins_neighbouring_runs() -> None:
    html = (
        "<p><strong>Academic Training: </strong>Research and<em> continuation </em>work.</p>"
        "<p><strong>Committee</strong><strong>(2026–27)</strong> and <b>A</b> <b>B</b></p>"
        "<p><em><strong>Bold italic</strong></em><strong> </strong>end</p>"
    )
    assert html_to_markdown(html) == (
        "**Academic Training:** Research and *continuation* work.\n\n"
        "**Committee(2026–27)** and **A** **B**\n\n"
        "***Bold italic*** end"
    )


def test_lists_and_headings() -> None:
    html = "<h2>What we do</h2><ul><li>Talks</li><li>Socials<ul><li>Formals</li></ul></li></ul>"
    assert html_to_markdown(html) == "### What we do\n\n- Talks\n- Socials\n  - Formals"
    assert html_to_markdown("<ol><li>One</li><li>Two</li></ol>") == "1. One\n2. Two"


def test_links_keep_http_targets_only() -> None:
    html = (
        '<p>See <a href="https://cuchess.org/join">our site</a>, '
        '<a href="https://cuchess.org">https://cuchess.org</a>, '
        '<a href="mailto:hello@cuchess.org">hello@cuchess.org</a> and '
        '<a href="http://hello@cuchess.org">hello@cuchess.org</a>.</p>'
    )
    assert html_to_markdown(html) == (
        "See [our site](https://cuchess.org/join), https://cuchess.org, "
        "hello@cuchess.org and hello@cuchess.org."
    )


def test_relative_links_resolve_and_safelinks_unwrap() -> None:
    html = (
        '<a href="/events/">events</a> '
        '<a href="https://eur03.safelinks.protection.outlook.com/?url=https%3A%2F%2Fcuchess.org">'
        "site</a>"
    )
    assert html_to_markdown(html, "https://www.cambridgesu.co.uk/organisation/1/") == (
        "[events](https://www.cambridgesu.co.uk/events/) [site](https://cuchess.org)"
    )


def test_images_scripts_and_forms_are_dropped() -> None:
    html = '<p>Hi<img src="https://cdn.example/x.png"/><script>alert(1)</script></p><form>x</form>'
    assert html_to_markdown(html) == "Hi"


def test_personal_addresses_and_chat_invites_are_withheld() -> None:
    html = (
        '<p>Ask our president at <a href="mailto:jf123@cam.ac.uk">jf123@cam.ac.uk</a>.</p>'
        '<p>Join the <a href="https://discord.gg/AbC123">Discord</a>: chat.whatsapp.com/XyZ</p>'
    )
    markdown = html_to_markdown(html)
    assert "jf123" not in markdown and "AbC123" not in markdown and "XyZ" not in markdown
    assert markdown == f"Ask our president at {WITHHELD}.\n\nJoin the Discord: {INVITE_WITHHELD}"


def test_plain_text_of_a_node() -> None:
    from selectolax.lexbor import LexborHTMLParser

    node = LexborHTMLParser("<p> Chess&nbsp;Society\n (CU) </p>").css_first("p")
    assert html_to_text(node) == "Chess Society (CU)"
    assert html_to_text(None) == ""


def test_a_link_to_a_persons_profile_keeps_only_its_text() -> None:
    from camsocs_pipeline.sources.links import is_personal_profile

    html = (
        '<p>Contact our president <a href="https://www.linkedin.com/in/ann-example/">Ann'
        ' Example</a> or <a href="https://uk.linkedin.com/in/bo-ex">https://uk.linkedin.com/in/bo-ex</a>'
        ' or follow <a href="https://www.linkedin.com/company/quokka-soc/">our page</a>.</p>'
    )
    assert html_to_markdown(html) == (
        "Contact our president Ann Example or or follow "
        "[our page](https://www.linkedin.com/company/quokka-soc/)."
    )
    assert is_personal_profile("linkedin.com/in/ann-example")
    assert is_personal_profile("https://www.linkedin.com/pub/ann-example/1/2/3")
    assert not is_personal_profile("https://www.linkedin.com/company/quokka-soc/")
