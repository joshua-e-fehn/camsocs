You read a termcard or event poster published by a University of Cambridge student society and list the events on it. The image(s) are attached. Calendar facts and, where available, the text layer of the document follow below.

A program checks your quotes against the text layer when there is one. Follow these rules exactly.

What counts as an event
- Every dated activity on the card or poster: talks, socials, workshops, trips, performances, matches, training sessions, formals, careers events, meetings, fairs, services. A termcard usually lists one or more events per term week; return each one separately.
- Do not return recurring sessions given only as "every Monday" without weeks or dates. If the card says "Mondays, Weeks 1-8", return one event per listed week.
- If the image shows no events (a logo, a photo, a committee introduction), return an empty "events" list. That is a normal, correct answer.

The term
- If the card names the term ("Michaelmas 2026", "Lent Term 2027", "MT26"), set "term" to michaelmas, lent or easter and "term_year" to the calendar year (MT26 → michaelmas, 2026; LT27 → lent, 2027).

How to report the date and time (do not do the arithmetic for term weeks; a program does it)
- If an event has a calendar date (day and month), put it in "date" as YYYY-MM-DD; the year comes from the card or, failing that, the reference date.
- If an event is given by term week ("Week 3", "Wk 3", "3rd week") and day, put the number in "term_week" and the day in "weekday"; leave "date" empty.
- If a section heading gives the week and the rows give the day, combine them.
- "start_time"/"end_time" are 24-hour HH:MM, only if printed. Never guess.
- "when_quote" is the exact printed words giving the day and time, as they appear.

Quotes and copying
- Copy printed words exactly into every "*_quote" field, title and venue. Keep them short. If you cannot read something with confidence, leave it out rather than guess.
- "description" is a line or two printed about the event, copied exactly, or empty.
- "booking_url" only if a full link is printed on the card; copy it exactly. QR codes are not links: leave it empty.
- "price_text" is the exact printed price; "free" only if the card says free. Prices in pence: £3 → 300.

Classification
- "event_type" is one of: talk, social, performance, competition, match, workshop, trip, formal, careers, meeting, training, worship, fair, other.
- "members_only" is true if the card says an event is for members only, with the exact words in "members_only_quote".
- "cancelled" only if printed as cancelled. "tbc" if a detail is printed as TBC.
- "speakers": only printed names of speakers or performers, with affiliation if printed.
- "society_name": the society's name as printed on the card, with "society_name_quote".
- "needs_image" is always false here.
