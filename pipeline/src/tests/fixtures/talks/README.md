# Department-site talk fixtures

Recorded on 2026-10-31 by camsocs-bot through the polite client, from sites whose
robots.txt allows the pages and names no AI crawler. Each file is trimmed to a few
items; HTML and XML files say so in a header comment, ICS in `X-CAMSOCS-FIXTURE`,
JSON objects in `_fixture`.

| File | Source |
|---|---|
| `uis_listing_zoology.html` | https://www.zoo.cam.ac.uk/events |
| `uis_listing_ames_page0.html` | https://www.ames.cam.ac.uk/events |
| `uis_detail_zoology.html` | https://www.zoo.cam.ac.uk/events/zoology-department-seminar-internet-animals |
| `ucam_talks_damtp.html` | synthetic (2026-10-31), ucam_talks mirror markup with invented content — real talks.cam text never reaches a model |
| `ucam_talks_chemistry.html` | synthetic (2026-10-31), ucam_talks mirror markup with invented content — real talks.cam text never reaches a model |
| `views_cst_seminars.html` | synthetic (2026-11-01), Computer Science seminar-list markup with invented content — the list mirrors talks.cam, so real talks.cam text never reaches a model |
| `views_econ_seminars.html` | https://www.econ.cam.ac.uk/seminars/upcoming |
| `views_janeway.html` | https://www.janeway.econ.cam.ac.uk/seminars-talks |
| `articles_murray_edwards.html` | https://www.murrayedwards.cam.ac.uk/news-events/upcoming-events |
| `law_detail.html` | https://www.law.cam.ac.uk/press/events/2026/11/cels-lunchtime-seminar-social-pathology-eu-law |
| `rss_cst_seminars.xml` | synthetic (2026-11-01), Computer Science seminar-feed markup with invented content — the feed mirrors talks.cam, so real talks.cam text never reaches a model |
| `rss_law_events.xml` | https://www.law.cam.ac.uk/press/events/feed.xml/10 |
| `rss_cms_events.xml` | https://cms.mus.cam.ac.uk/events/index.xml |
| `ics_bas_events.ics` | https://www.bas.ac.uk/events/list/?ical=1 |
| `json_tribe_neuroscience.json` | https://neuroscience.cam.ac.uk/wp-json/tribe/events/v1/events |
| `json_aicam_events.json` | https://www.ai.cam.ac.uk/events.json (first 3 entries) |
| `json_cjbs_search.json` | https://www.jbs.cam.ac.uk/wp-json/cjbs-event/v1/search?pagination=1 |

No talks.cam page, and no page that mirrors talks.cam (a department's ucam_talks
list, Computer Science's `/seminars/list/<id>`), is recorded here: talks.cam is
read by parser code only, and a mirror fixture is written by hand with invented
content (`test_fixtures_that_carry_a_talks_cam_mirror_link_are_synthetic`).
