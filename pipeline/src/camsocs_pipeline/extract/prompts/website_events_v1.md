You extract the events listed on one page of a University of Cambridge student society's own website (its events, "what's on", calendar or term card page, or a home page that lists upcoming events). The page text is given below, after the calendar facts; the reference date is the day the page was read.

Your output is checked against the page text by a program. Follow these rules exactly.

What counts as an event
- An event is a dated activity this society runs or co-runs and invites people to: a talk, social, workshop, trip, performance, match, training session, formal, careers event, meeting, fair, service.
- A page often lists several events (a term card, an events list). Return each one separately, past or future: a program decides which are current.
- Do not return: weekly sessions given only as "every Monday" without dates or weeks; deadlines, applications, elections, newsletters, merchandise; events of other organisations the page merely mentions; vague plans with no day.
- If the page lists no dated event, return an empty "events" list. That is a normal, correct answer.

How to report the date and time (do not do the arithmetic for term weeks; a program does it)
- If an event has a calendar date (day and month), put it in "date" as YYYY-MM-DD. Take the year from the page when it states one; otherwise use the year that makes the date nearest to the reference date.
- If an event is given by Cambridge term week ("Week 3", "Wk 3", "3rd week") and day, put the number in "term_week" and the day in "weekday"; leave "date" empty. If the page names the term ("Michaelmas 2026", "Lent Term 2027", "MT26"), set "term" to michaelmas, lent or easter and "term_year" to the calendar year (MT26 → michaelmas, 2026).
- If a heading gives the date and the rows give the times, combine them.
- Never use "today", "tomorrow" or a bare weekday: a web page has no date of its own. Leave such an event out.
- "start_time"/"end_time" are 24-hour HH:MM, only if the page states them. Never guess.
- "when_quote" is required: the exact words from the page that give the event's day (and time), including the day number or the term week, character for character. An event without such words is left out.

Quotes and copying
- Copy page words exactly into every "*_quote" field, the title and the venue. Keep quotes short.
- "description" is 1-2 sentences copied word for word from the page about that event, or empty. Never summarise. Do not copy sentences that name committee members, performers or other private individuals; named speakers go only in "speakers".
- "booking_url" only if a full link to tickets or sign-up appears in the page text; copy it exactly.
- "price_text" is the exact price words; "free" is true only if the page says it is free. Prices in pence: £3 → 300.

Classification
- "event_type" is one of: talk, social, performance, competition, match, workshop, trip, formal, careers, meeting, training, worship, fair, other.
- "members_only" is true if the page says only members may come; put the exact words in "members_only_quote".
- "cancelled" only if the page says the event is cancelled or postponed. "tbc" if a detail is marked TBC, with the words in "tbc_quote".
- "speakers": only named speakers or performers announced for that event, with affiliation if stated.

The society
- "society_name" only if the page names the society; with "society_name_quote".
- "needs_image" is always false here.
- Never output personal information (addresses, phone numbers, names of committee members) other than announced speakers.
