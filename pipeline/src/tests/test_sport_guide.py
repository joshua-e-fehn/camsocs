"""The Sports Club Guide PDF (source-research §4): club sections, and the
"at a glance" ticks read from glyph positions with a text-layer cross-check."""

from __future__ import annotations

from camsocs_pipeline.sources.sport import gender_of
from camsocs_pipeline.sources.sport_guide import (
    Chunk,
    Glance,
    GlanceRow,
    Glyph,
    KnownClub,
    PageLayout,
    Section,
    assign_rows,
    build_observations,
    glance_fields,
    link_club,
    match_names,
    parse_glance,
    parse_sections,
    pdf_layout,
)
from tests.seedkit import FakeClient, ok

PDF_URL = "https://www.sport.cam.ac.uk/sites/default/files/guide.pdf"
HEADER = [
    Chunk(175, 561, 7, "HelveticaNeueLTStd-Lt", "We're open to: We cater for: Status:"),
    Chunk(336, 553, 7, "HelveticaNeueLTStd-Lt", "Blue, Half Blue"),
    Chunk(370, 545, 7, "HelveticaNeueLTStd-Lt", "College Competi-tion"),
    Chunk(370, 545, 7, "HelveticaNeueLTStd-Lt", "Students Staff Beginner Intermediate Elite"),
    Chunk(35, 551, 9, "HelveticaNeueLTStd-Md", "Sports Clubs at a Glance"),
    Chunk(39, 8, 7, "HelveticaNeueLTStd-Bd", "4"),
]
TICK, SPACE = "b'\\x00D'", "b'\\x00\\x03'"


def table_page(number: int, x0: float, rows: dict[str, list[int]], extra=()) -> PageLayout:
    """A glance page: each row's label, its text-layer run "a a a", and one
    tick glyph per ticked column (34.02 pt apart from `x0`)."""
    page = PageLayout(number, chunks=list(HEADER))
    y = 530.0
    for label, columns in rows.items():
        page.chunks.append(Chunk(25.8, y + 1.85, 7.5, "HelveticaNeueLTStd-Bd", label))
        page.chunks.append(Chunk(x0, y, 9, "Webdings", " ".join("a" for _ in columns)))
        page.glyphs += [Glyph(x0 + 34.02 * c, y, "Webdings", TICK) for c in columns]
        y -= 12.9
    page.glyphs += list(extra)
    return page


ALL = list(range(7))


class TestGlance:
    def test_columns_from_positions_on_facing_pages(self) -> None:
        pages = [
            table_page(6, 176.13, {"Aikido": [0, 2, 3], "Automobile": ALL}),
            table_page(7, 170.5, {"Rambling": [0, 1, 2, 3], "Yacht": [0, 1, 2, 3, 4, 5], "X": ALL}),
        ]
        glance = parse_glance(pages)
        assert glance.problem is None
        rows = {row.label: row.columns for row in glance.rows}
        assert rows["Aikido"] == {"students", "beginner", "intermediate"}
        assert rows["Rambling"] == {"students", "staff", "beginner", "intermediate"}
        assert "blue" in rows["Yacht"] and "college_competition" not in rows["Yacht"]

    def test_a_space_drawn_in_the_tick_font_is_not_a_tick(self) -> None:
        page = table_page(
            6,
            176.13,
            {"Kabaddi": [0, 1, 2, 3, 4], "Other": ALL},
            extra=[Glyph(176.13 + 34.02 * 6, 530.0, "Webdings", SPACE)],
        )
        rows = {row.label: row.columns for row in parse_glance([page]).rows}
        assert "college_competition" not in rows["Kabaddi"]

    def test_rows_that_do_not_cross_check_are_skipped(self) -> None:
        page = table_page(6, 176.13, {"Aikido": [0, 2], "Other": ALL})
        page.chunks.append(Chunk(176.13, 530.0, 9, "Webdings", "a"))  # text layer says 3
        glance = parse_glance([page])
        assert [row.label for row in glance.rows] == ["Other"]
        assert glance.skipped and "Aikido" in glance.skipped[0]

    def test_uneven_or_missing_columns_skip_the_table(self) -> None:
        # A column no row ticks cannot be placed: the page is skipped, not guessed.
        page = table_page(6, 176.13, {"Aikido": [0, 2], "Other": [0, 1, 2, 3, 4, 5]})
        assert "expected 7" in parse_glance([page]).problem

    def test_changed_headings_skip_the_table(self) -> None:
        page = table_page(6, 176.13, {"Aikido": ALL})
        page.chunks = [c for c in page.chunks if "Elite" not in c.text]
        assert "Elite" in parse_glance([page]).problem

    def test_fields_from_ticks(self) -> None:
        rows = [
            GlanceRow("Basketball - Men", 6, frozenset({"students", "beginner", "blue"})),
            GlanceRow("Basketball - Women", 6, frozenset({"students", "staff"})),
        ]
        fields = {f.field: f for f in glance_fields(rows)}
        assert fields["audiences"].value == [
            "undergraduates",
            "postgraduates",
            "staff",
            "beginners",
        ]
        assert fields["beginnerFriendly"].value is True
        assert fields["sport.collegeCompetition"].value is False
        assert "sport.blueStatus" not in fields  # a tick says *some* Blue, not which
        assert fields["sport.genderCategories"].value == ["men", "women"]

    def test_no_blue_tick_is_a_published_none(self) -> None:
        fields = {
            f.field: f for f in glance_fields([GlanceRow("Padel", 7, frozenset({"students"}))])
        }
        assert (fields["sport.blueStatus"].value, fields["sport.blueStatus"].evidence) == (
            "none",
            "primary",
        )


class TestNames:
    def test_best_subset_match(self) -> None:
        headings = ["Football", "American Football", "Australian Rules Football", "Athletics"]
        assert match_names("Football - Men", headings) == [0]
        assert match_names("Athletic", headings) == [3]
        assert match_names("Yacht", ["Yachting"]) == [0]
        assert match_names("Ski & Snowboarding", ["Ski and Snowboard"]) == [0]
        assert match_names("Dancers (Dancesport/Rock'n'Roll)", ["Dancesport & Rock ‘n’ Roll"]) == [
            0
        ]

    def test_genders_must_agree(self) -> None:
        headings = ["Lacrosse (Men)", "Lacrosse (Mixed)", "Lacrosse (Women)"]
        assert match_names("Lacrosse - Women", headings) == [2]
        assert match_names("Cricket", ["Cricket (Men)", "Cricket (Women)"]) == [0, 1]
        assert gender_of("Mixed Martial Arts") is None

    def test_rows_of_different_names_do_not_share_a_section(self) -> None:
        rows = [
            GlanceRow("Rowing (Boat Club)", 7, frozenset({"students"})),
            GlanceRow("Rowing (College)", 7, frozenset({"beginner"})),
            GlanceRow("Basketball - Men", 6, frozenset({"students"})),
            GlanceRow("Basketball - Women", 6, frozenset({"staff"})),
        ]
        assigned, standalone = assign_rows(rows, ["Rowing", "Basketball"])
        assert 0 not in assigned and [r.label for r in standalone] == [
            "Rowing (Boat Club)",
            "Rowing (College)",
        ]
        assert len(assigned[1]) == 2

    def test_link_to_the_az_by_instagram_then_name(self) -> None:
        clubs = [
            KnownClub("boat-club-rowing", ("Boat Club (Rowing)",), "cubc_example"),
            KnownClub("hockey-club", ("Hockey Club", "Cambridge University Hockey Club"), None),
            KnownClub("ice-hockey-club", ("Ice Hockey Club",), None),
        ]
        assert link_club("Rowing", "cubc_example", clubs) == "boat-club-rowing"
        assert link_club("Rowing (Boat Club)", None, clubs) == "boat-club-rowing"
        assert link_club("Hockey", None, clubs) == "hockey-club"
        assert link_club("Rowing (College)", None, clubs) is None


def club_page(number: int, *chunks: Chunk) -> PageLayout:
    tab = Chunk(9, 300, 0.0, "HelveticaNeueLTStd-Bd", "Cricket • Cycling")
    return PageLayout(number, chunks=[tab, *chunks])


class TestSections:
    def test_heading_description_links_and_contacts(self) -> None:
        page = club_page(
            13,
            Chunk(144, 554, 10, "HelveticaNeueLTStd-Hv", "Cricket"),
            Chunk(190, 554, 10, "HelveticaNeueLTStd-Lt", " (Women)"),
            Chunk(144, 541, 7.5, "HelveticaNeueLTStd-Lt", "We play cricket all sum-"),
            Chunk(144, 531, 7.5, "HelveticaNeueLTStd-Lt", "mer, from beginners up."),
            Chunk(
                144,
                520,
                7.5,
                "HelveticaNeueLTStd-Lt",
                "instagram.com/cuwcc_example/ facebook.com/CUWCC",
            ),
            Chunk(
                144, 505, 10, "HelveticaNeueLTStd-Roman", "cuwcc.example   Instagram: @cuwcc_two"
            ),
            Chunk(
                144,
                493,
                10,
                "HelveticaNeueLTStd-Lt",
                "contact: captain@cuwcc.example ab12@cam.ac.uk",
            ),
            Chunk(144, 470, 10, "HelveticaNeueLTStd-Hv", "Cycling"),
            Chunk(144, 458, 7.5, "HelveticaNeueLTStd-Lt", "We ride bikes."),
            Chunk(144, 446, 10, "HelveticaNeueLTStd-Lt", "contact: cycling@sport.cam.ac.uk"),
            Chunk(39, 17, 7, "HelveticaNeueLTStd-Bd", "11"),
        )
        image_page = PageLayout(14)
        late = club_page(15, Chunk(144, 554, 10, "HelveticaNeueLTStd-Hv", "Yachting"))
        college_sport = PageLayout(
            16, chunks=[Chunk(144, 554, 10, "HelveticaNeueLTStd-Hv", "College Sport")]
        )
        cricket, cycling, yachting = parse_sections([page, image_page, late, college_sport])
        assert cricket.heading == "Cricket (Women)"
        # A line-end hyphen is kept: "non-" + "students" is a word, and the text
        # layer cannot tell it from a hyphenated "sum-" + "mer".
        assert cricket.description == "We play cricket all sum-mer, from beginners up."
        assert cricket.website == "https://cuwcc.example"
        assert [s["url"] for s in cricket.socials] == [
            "https://www.instagram.com/cuwcc_two/",
            "https://instagram.com/cuwcc_example/",
            "https://facebook.com/CUWCC",
        ]
        assert cricket.emails == ["captain@cuwcc.example", "ab12@cam.ac.uk"]
        assert cycling.website is None and cycling.emails == ["cycling@sport.cam.ac.uk"]
        assert yachting.heading == "Yachting"

    def test_observations_merge_entries_of_one_club_and_never_claim_a_name(self) -> None:
        swim = Section("Swimming", 28, description="Swim.", emails=["swim@sport.cam.ac.uk"])
        polo = Section("Water Polo", 31, description="Polo.", emails=["polo@sport.cam.ac.uk"])
        cadmus = Section("Disability Multisport", 31, description="A community club.")
        for section in (swim, polo):
            section.socials = [
                {"platform": "instagram", "url": "https://instagram.com/cuswpc", "handle": "cuswpc"}
            ]
        clubs = [
            KnownClub("swimming-and-waterpolo-club", ("Swimming and Waterpolo Club",), "cuswpc")
        ]
        glance = Glance(rows=[GlanceRow("Swimming", 7, frozenset({"students", "blue"}))])
        observations, notes = build_observations(
            ok(PDF_URL, b"%PDF"), FakeClient(), [swim, polo, cadmus], glance, clubs
        )
        assert len(observations) == 2
        merged = next(o for o in observations if o.identity.sport_slug)
        fields = {f.field: f for f in merged.fields}
        assert fields["email"].value == "swim@sport.cam.ac.uk"
        assert fields["audiences"].value == ["undergraduates", "postgraduates"]
        assert "sport.blueStatus" not in fields
        assert all("name" not in {f.field for f in o.fields} for o in observations)
        assert any("merged Swimming, Water Polo" in note for note in notes)
        # The personal CRSid in a contact line never becomes a value.
        assert "ab12@cam.ac.uk" not in str([o.model_dump() for o in observations])


def _pdf(content: bytes) -> bytes:
    """A one-page PDF with a heavy face and a Webdings face (offsets computed)."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+HelveticaNeueLTStd-Hv >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /GHIJKL+Webdings >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    return bytes(out)


def test_pdf_layout_reports_fonts_and_glyph_positions() -> None:
    content = (
        b"BT /F1 10 Tf 1 0 0 1 100 700 Tm (Aikido) Tj ET\n"
        b"BT /F2 9 Tf 1 0 0 1 176 698 Tm (a) Tj 34 0 Td (a) Tj ET"
    )
    [page] = pdf_layout(_pdf(content))
    heading = next(c for c in page.chunks if "Aikido" in c.text)
    assert heading.font == "HelveticaNeueLTStd-Hv" and heading.size == 10
    ticks = [(g.x, g.y) for g in page.glyphs if g.font == "Webdings"]
    assert ticks == [(176.0, 698.0), (210.0, 698.0)]
