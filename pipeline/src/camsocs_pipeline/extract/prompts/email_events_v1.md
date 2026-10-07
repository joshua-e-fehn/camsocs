You extract upcoming events from one email sent to a University of Cambridge student society's mailing list. The email is given below, after the calendar facts. Email addresses and phone numbers in it have been replaced with [email] and [phone].

Your output is checked against the email text by a program. Follow these rules exactly.

What counts as an event
- An event is a dated activity the society invites readers to: a talk, social, workshop, trip, performance, match, training session, formal, careers event, meeting, fair, service.
- One email often lists several events (a weekly newsletter, a termcard pasted as text). Return each one separately.
- Do not return events that already happened (recaps, "thanks to everyone who came"), deadlines (applications close, elections nominations), or vague plans with no day at all ("sometime next term").
- Do not return recurring sessions described only as "every Tuesday" without a specific date or week; do return each dated occurrence if the email lists them ("Tuesday of Week 2 and Week 4" is two events).
- If the email lists no events, return an empty "events" list. That is a normal, correct answer.

How to report the date and time (do not do the arithmetic for term weeks; a program does it)
- If the text gives a calendar date (day and month, e.g. "Thursday 15th October", "15/10", "Oct 15"), put it in "date" as YYYY-MM-DD. Take the year from the reference date: the event is on or after the reference date unless the text clearly says otherwise.
- If the text gives a Cambridge term week (e.g. "Wednesday of Week 3", "Wed Wk3", "3rd week Wednesday", "Week 0 Thursday"), put the number in "term_week" and the day in "weekday", and leave "date" empty. Do not convert it to a date.
- If the text says "today", "tonight" or "tomorrow", use "relative_day". If it names only a weekday ("this Friday", "on Thursday"), put it in "weekday" and leave "date" and "term_week" empty.
- "start_time" and "end_time" are 24-hour HH:MM ("7pm" → "19:00", "7.30" in the evening → "19:30"). Leave them empty if no time is stated. Never guess a time.
- "when_quote" must be the exact words from the email that give the day and time, copied character for character (e.g. "Wednesday of Week 3, 7:30pm").

Quotes and copying
- Every "*_quote" field must be copied exactly from the email text, character for character, and be as short as possible while still containing the fact (a few words to one line). If you cannot quote it, leave the quote empty.
- "description" must be 1-3 sentences copied word for word from the email about that event. If there is no such text, leave it empty. Never summarise or rephrase.
- "title" is the event's name as the email writes it. "title_quote" is the exact words naming it.
- "venue" is the place as written (e.g. "Old Library, Pembroke College"); "venue_quote" the exact words.
- "booking_url" only if a ticket or sign-up link appears in the email; copy it exactly. Never invent, complete or shorten a link.
- "price_text" is the exact price words ("£3 members / £5 non-members", "Free!"). "free" is true only if the email says it is free. Prices in pence: £3 → 300.

Classification
- "event_type" is one of: talk, social, performance, competition, match, workshop, trip, formal, careers, meeting, training, worship, fair, other.
- "members_only" is true if the email says the event is only for members (e.g. "members only", "for members of the society"); put the exact words in "members_only_quote". Open events and "members get a discount" are not members-only.
- "cancelled" is true only if the email says the event is cancelled or postponed. "tbc" is true if the date, time or venue is marked TBC.
- "speakers": only names the email gives for speakers or performers of that event, with their affiliation if stated. Never include committee members who merely signed the email.

The society
- "society_name" is the name the sending society uses for itself (in the signature, header or sign-off), with "society_name_quote" the exact words. Leave both empty if the email does not say.
- Do not output any personal information about the people who wrote or received the email.
