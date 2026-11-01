"""Synthetic talks for the dev deployment (`camsocs talks-demo-seed`).

The UI is built and screenshot-tested by people and agents who must never see
real talks.cam content (spec §1), so dev holds invented talks: real department
names from the registry, made-up titles and speakers, real-looking times.
Deterministic (seeded) so screenshots are stable. Never for production.
"""

from __future__ import annotations

import random
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from camsocs_pipeline.talks.model import Speaker, TalkRecord
from camsocs_pipeline.talks.registry import Department

LONDON = ZoneInfo("Europe/London")

_TOPICS = [
    "Sparse attention for long documents",
    "Glacial hydrology under warming scenarios",
    "Rethinking the Carolingian court",
    "Single-cell atlases of the developing heart",
    "Mechanism design for public goods",
    "Quantum error correction in practice",
    "The politics of urban water",
    "Protein folding at the membrane",
    "Late Antique letter networks",
    "Bayesian methods for clinical trials",
    "Soft robotics for surgery",
    "Language contact in the Indian Ocean",
    "Dark matter in dwarf galaxies",
    "Housing markets and inequality",
    "Neural circuits of decision making",
    "Catalysis with earth-abundant metals",
    "Reading Milton after empire",
    "Machine learning for weather forecasting",
    "Microbial ecology of the gut",
    "Constitutional courts under pressure",
]
_FORMS = [
    "{t}",
    "{t}: new evidence",
    "Towards {tl}",
    "{t} — a progress report",
    "What we know about {tl}",
]
_FIRST = ["Alex", "Priya", "Tomasz", "Mei", "Jonas", "Amara", "Luca", "Sofia", "Kwame", "Hannah"]
_LAST = ["Example", "Placeholder", "Sample", "Demo", "Testwell", "Mockford", "Fakesmith"]
_AFFILS = ["University of Somewhere", "Example Institute", "Cambridge", "Imaginary College London"]
_VENUES = ["Seminar Room 1", "Lecture Theatre A", "Room G.21", "Main Lecture Hall", "Online (Zoom)"]
_SERIES = ["Departmental Seminar", "Research Colloquium", "Lunchtime Talks", "Graduate Workshop"]
_KINDS = ["seminar"] * 6 + ["lecture"] * 2 + ["workshop", "conference"]


def demo_talks(departments: list[Department], start: datetime, days: int = 35) -> list[TalkRecord]:
    rng = random.Random(20261031)
    out: list[TalkRecord] = []
    depts = departments or []
    for day in range(days):
        date = (start + timedelta(days=day)).date()
        weekend = date.weekday() >= 5
        for n in range(rng.randint(0, 3) if weekend else rng.randint(6, 18)):
            dept = rng.choice(depts) if depts and rng.random() > 0.08 else None
            hour = rng.choice([9, 11, 12, 13, 14, 16, 17, 18])
            starts = datetime.combine(date, time(hour, rng.choice([0, 0, 15, 30])), LONDON)
            topic = rng.choice(_TOPICS)
            title = rng.choice(_FORMS).format(t=topic, tl=topic[0].lower() + topic[1:])
            venue = rng.choice(_VENUES)
            speakers = [
                Speaker(f"{rng.choice(_FIRST)} {rng.choice(_LAST)}", rng.choice(_AFFILS))
                for _ in range(1 if rng.random() > 0.15 else 2)
            ]
            ext = f"demo-{date.isoformat()}-{n}"
            out.append(
                TalkRecord(
                    source_type="dept_ics" if dept else "talks_cam",
                    source=f"{dept.key}#0" if dept else "talks_cam",
                    external_id=ext,
                    url=f"https://example.org/talks/{ext}",
                    source_url="https://example.org/talks.ics",
                    title=title,
                    starts_at=starts,
                    ends_at=starts + timedelta(minutes=rng.choice([45, 60, 60, 90])),
                    retrieved_at=start,
                    speakers=speakers,
                    series=f"{dept.short_name} {rng.choice(_SERIES)}"
                    if dept
                    else rng.choice(_SERIES),
                    department_keys=[dept.key] if dept else [],
                    venue=venue,
                    online="Zoom" in venue or rng.random() < 0.1,
                    kind=rng.choice(_KINDS),
                    cancelled=rng.random() < 0.03,
                    abstract=(
                        f"This is an invented abstract for a demo talk about {topic.lower()}. "
                        "It exists so the camsocs talks pages can be designed and tested "
                        "without real listings. Nothing here describes a real event."
                    ),
                )
            )
    return out
