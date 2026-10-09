"""HTML fragments → the plain markdown stored in free-text fields
(`description`, `howToJoin`, …; data-model §2: "Long description in markdown").

Deliberately small: paragraphs, line breaks, headings, lists, bold/italic and
links — what society profile editors produce. Images, scripts, styles and
forms are dropped (an image in a description would be a hotlink). Links keep
only http(s) targets (`links.absolute_url`, after unwrapping Outlook
SafeLinks); ``mailto:`` links become their visible text, and so does a link
to a person's profile (LinkedIn ``/in/``, never stored, source-research §14).
Personal CRSid addresses and chat invite links are withheld from the result
(`links.withhold_personal_emails`, `links.withhold_chat_invites`).
"""

from __future__ import annotations

import re

from selectolax.lexbor import LexborHTMLParser, LexborNode

from camsocs_pipeline.sources.links import (
    absolute_url,
    chat_platform,
    is_personal_profile,
    unwrap_redirect,
    withhold_chat_invites,
    withhold_private,
)

_BLOCKS = frozenset(
    {"p", "div", "section", "article", "blockquote", "table", "tr", "dl", "dt", "dd", "center"}
)
_HEADINGS = frozenset({"h1", "h2", "h3", "h4", "h5", "h6"})
_DROPPED = frozenset(
    {"script", "style", "img", "picture", "svg", "iframe", "form", "input", "button", "noscript"}
)
_SPACES = re.compile(r"[ \t\f\v\u00a0\u200b]+")


def html_to_markdown(fragment: str | LexborNode, base_url: str | None = None) -> str:
    """Markdown for an HTML fragment (a string or a parsed node's contents)."""
    if isinstance(fragment, str):
        root = LexborHTMLParser(fragment).body
        if root is None:
            return ""
    else:
        root = fragment
    out = _Writer(base_url)
    out.children(root, list_depth=0)
    return withhold_private(out.result())


def html_to_text(node: LexborNode | None) -> str:
    """A node's visible text on one line: text nodes joined by a space (so a
    ``<br>`` never glues two words), whitespace collapsed, and no space left
    inside brackets or before punctuation ("Society ( CU )" → "Society (CU)")."""
    if node is None:
        return ""
    text = node.text(separator=" ").replace("\r", " ").replace("\n", " ")
    text = _SPACES.sub(" ", text)
    text = re.sub(r"\(\s+", "(", text)
    text = re.sub(r"\s+([),.;:!?])", r"\1", text)
    return text.strip()


class _Writer:
    def __init__(self, base_url: str | None) -> None:
        self.base_url = base_url
        self.parts: list[str] = []

    # -- output ----------------------------------------------------------------

    def text(self, text: str) -> None:
        text = _SPACES.sub(" ", text.replace("\r", " ").replace("\n", " "))
        if not text:
            return
        if text.startswith(" ") and (not self.parts or self.parts[-1].endswith((" ", "\n"))):
            text = text.lstrip(" ")
        self.parts.append(text)

    def newline(self, count: int = 1) -> None:
        self.parts.append("\n" * count)

    def result(self) -> str:
        joined = "".join(self.parts)
        lines = [line.rstrip() for line in joined.split("\n")]
        text = "\n".join(lines)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

    # -- traversal ---------------------------------------------------------------

    def children(self, node: LexborNode, *, list_depth: int) -> None:
        child = node.first_child
        while child is not None:
            self.node(child, list_depth=list_depth)
            child = child.next

    def inline(self, node: LexborNode) -> str:
        """Render a node's children on their own, for wrapping (links, emphasis)."""
        inner = _Writer(self.base_url)
        inner.children(node, list_depth=0)
        return re.sub(r"\s+", " ", "".join(inner.parts)).strip()

    def node(self, node: LexborNode, *, list_depth: int) -> None:
        if node.is_text_node:
            self.text(node.text_content or "")
            return
        if not node.is_element_node:
            return
        tag = (node.tag or "").lower()
        if tag in _DROPPED:
            return
        if tag == "br":
            self.newline()
        elif tag == "hr":
            self.newline(2)
        elif tag in _HEADINGS:
            heading = self.inline(node)
            if heading:
                self.newline(2)
                self.parts.append(f"### {heading}")
                self.newline(2)
        elif tag in ("ul", "ol"):
            self.newline(2 if list_depth == 0 else 1)
            number = 0
            for item in node.css("li"):
                if item.parent is None or item.parent.mem_id != node.mem_id:
                    continue
                number += 1
                bullet = f"{number}." if tag == "ol" else "-"
                self.parts.append("  " * list_depth + bullet + " ")
                self.children(item, list_depth=list_depth + 1)
                self.newline()
            self.newline(1 if list_depth else 2)
        elif tag in ("strong", "b"):
            self.wrap(node, "**")
        elif tag in ("em", "i"):
            self.wrap(node, "*")
        elif tag == "a":
            self.link(node)
        elif tag in _BLOCKS:
            self.newline(2)
            self.children(node, list_depth=list_depth)
            self.newline(2)
        else:
            self.children(node, list_depth=list_depth)

    def wrap(self, node: LexborNode, marker: str) -> None:
        inner = self.inline(node)
        if inner:
            self.parts.append(f"{marker}{inner}{marker}")

    def link(self, node: LexborNode) -> None:
        label = self.inline(node)
        href = node.attributes.get("href") or ""
        url = absolute_url(unwrap_redirect(href) if href else None, self.base_url)
        if not label:
            return
        if url is not None and chat_platform(url) is not None:
            # An invite link is never stored; its label still says the channel exists.
            self.text(withhold_chat_invites(label))
            return
        if url is not None and is_personal_profile(url):
            # A person's profile is never stored; the label is redacted (D1).
            if label.rstrip("/") != url.rstrip("/"):
                self.text(label)
            return
        if url is None or label == url or label.rstrip("/") == url.rstrip("/"):
            self.text(label if url is None else url)
            return
        self.parts.append(f"[{label}]({url})")


__all__ = ["html_to_markdown", "html_to_text"]
