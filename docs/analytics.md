# Product analytics: the event taxonomy (ENG-5)

What the site records about how it is used, beyond page views, and the rules that keep it free of
personal data and talks.cam content. The browser client, its consent gate and its `before_send` are
described in `docs/webapp.md` ("Analytics consent", "Analytics client") and `docs/deploy.md`
("PostHog"). What visitors are told is on `/privacy` ("When you browse", "Cookies"). The legal
record is `docs/compliance/record-of-processing.md` P11 (browser) and P12 (server counts).

Nothing here is sent unless the visitor chose "Accept analytics", a project key is set
(`NEXT_PUBLIC_POSTHOG_KEY`) and the browser is not automated. Without a key (CI, previews, local
runs, e2e) every call below is a no-op.

## The taxonomy

One table, `webapp/lib/analytics-events.ts` (`ANALYTICS_EVENTS`), lists every event of ours with the
properties it may carry and the values each may hold. `track()` (`lib/analytics.ts`) and the
client's `before_send` (`sanitizeEvent` in `lib/analytics-client.ts`) both read it.

| Event | Where it fires | Properties | Why |
|---|---|---|---|
| `society_viewed` | A society's page (`app/(site)/societies/[slug]`, `<TrackView>`) | `orgKey` (`org-<slug>`), `categories` (our taxonomy slugs, `lib/vocab.ts` `CATEGORIES`) | Which listings and kinds of society people look at |
| `event_viewed` | An event's page (`app/(site)/events/[key]`) and the calendar's sheet (`organisms/events-calendar.tsx`) | `eventKey` (`evt-<sha1>`), `orgKeys?` (organisers but sponsors, `org-…`), `hosting?` (`hosts` \| `takes_part`) | Which events are opened, and whose |
| `talk_viewed` | A talk's page (`app/(site)/talks/[key]`) and the talks sheet (`organisms/talks-browser.tsx`) | `talkKey` (`talk-<20 hex>`), `departmentKey?` (`dept-<slug>`) | Which departments' talks are read. **Keys only**: never a title, speaker, series or venue |
| `search_performed` | Every search box once its results are in: societies directory, events calendar, talks agenda, the ⌘K palette (queries of two or more characters), once per query and surface (`hooks/use-analytics.ts` `useTrackSearch`) | `surface` (`societies` \| `events` \| `talks` \| `palette`), `queryLength` (characters), `resultCount` (see below: not comparable across surfaces) | How much search is used and how well it answers. **Never the query** |
| `search_zero_results` | The same, when a settled search found nothing | `surface`, `queryLength` | Where search fails, to fix data or matching |
| `calendar_subscribe_clicked` | Any choice in "Add to calendar" (event or talk, page or sheet; `molecules/add-to-calendar.tsx`), the talks feed's "Open in Calendar" and copy buttons (`molecules/talks-subscribe-dialog.tsx`), a talk page's "Subscribe to its talks" (webcal) | `feed` (`event` \| `talk` \| `talks` \| `events`; `events` reserved for a future events feed), `key?` (`evt-…`, `talk-…` or the feed's `dept-…`) | Whether calendar export is worth maintaining, and for what |
| `outbound_link_clicked` | Society profile: website, socials, join, mailing list, contact form, termcard, relationship evidence; provenance links under facts; event and talk "Read at source" / source / booking links | `kind` (`website` \| `social` \| `source` \| `other`), `orgKey?` (the profile's society, or the event's lead organiser; absent on provenance links inside a fact's "sourced" popover, which renders outside the profile) | Whether we send people on to societies. **Never the URL or link text** |
| `listing_request_submitted` | The request form, after the server accepted it (not the honeypot's fake success; `organisms/request-form.tsx`) | `kind` (`claim` \| `correct` \| `remove` \| `object` \| `add`) | How often each kind of request is used. **Never the listing, email or message** |
| `sign_in_completed` | The page a Cambridge sign-in link lands on, once a session is confirmed (`providers/sign-in-tracker.tsx`, marker `?signed_in=cam` set in `organisms/login-form.tsx`) | `method` (`cam`) | How many readers unlock Cambridge-only events. **Never identified**; the admin's Google sign-in lands on `/dashboard` and is never tracked |

`?` marks an optional property.

`resultCount` counts what each surface shows, so compare it within a surface, never across:
`societies` is the directory's total number of matches; `events` the matches inside the calendar's
visible window; `talks` the agenda's page of matches inside its date window; `palette` the rows the
palette shows (capped per group, including page shortcuts), not the "see all" links. A search
counts once per surface: the same query arriving again (Back to a results page, a shared `?q=`
link) is not sent again on this page load, while the palette's "see all" link counts the search
again on the page it opens (`societies`, `events` or `talks`).

The SDK adds its own context to every event (page path without
query or fragment, browser and OS name and version, language, time zone, device type, screen
size, random identifiers); `before_send` strips everything else, as `/privacy` lists.

Every event, ours and the SDK's, browser and server, also carries `environment` (`production` or
`development`) and `campus`, the campus the deployment serves (decision D8: `cam`, from
`NEXT_PUBLIC_CAMPUS` in Next and `CAMSOCS_CAMPUS` in Convex; `docs/webapp.md` "Campus profile").
It names a deployment, not a visitor. Events from before it was added have none, so every query
splits campuses with `ifNull(properties.campus,'cam')`.

Server-side counts without consent (`ics_feed_fetched`, `listing_request_received`, ENG-7) and
errors (ENG-6) are separate: see `docs/webapp.md` "Server counts" and
`docs/compliance/record-of-processing.md` P12.

## Privacy rules

These follow the binding spec's hard rules 1-3 and are enforced in code, not by convention.

- **Values are keys, enums, counts and booleans only.** Every property has a rule: a key must have
  its exact shape (`org-…`, `evt-<40 hex>`, `talk-<20 hex>`, `dept-…`), an enum one of its listed
  values, a count a whole number in range, a list a bounded list of those. A title, name, email,
  query or URL fails every rule.
- **Unknown events and properties are dropped**, by `track()` and again by `before_send`. A
  required property that is missing or fails its rule stops the whole event in both. Of the SDK's
  own `$` properties, our events keep only the context `/privacy` names (`SDK_CONTEXT_PROPS` in
  `lib/analytics-client.ts`); person properties (`$set`, `$set_once`, `$unset`) never travel.
- **talks.cam content never leaves.** Talk events carry the talk's and department's keys only;
  `before_send` deletes `title` / `$title` (a talk page's `<title>` is the talk's title) and element
  text from every event.
- **No free text.** Search events carry the query's length, never its text; the request form sends
  its kind only; outbound links send their kind, never the address.
- **Nobody is identified.** No `identify()`, no person profiles; the sign-in event says how, not who.
- **`/dashboard*` and `/sign-in*` are never tracked**: `before_send` drops every event there.
- **Consent first.** `track()` does nothing unless the client runs (consent granted, key set, not
  automated). On the page a visitor lands on, a view fired before posthog-js has finished loading
  waits for that load (`posthogReady()`), and is dropped if consent was withdrawn meanwhile.

## How events are sent

- **Client components** call `track(event, props)` directly (typed from the table), or use the
  hooks in `webapp/hooks/use-analytics.ts`:
  - `useTrackView(event, props | null)`: once per distinct `props` while mounted (sheets);
  - `useTrackSearch(surface, query, resultCount | undefined)`: once per settled query and
    surface (remembered for the page load, so a remount with the same query sends nothing); pass
    `undefined` while the results are loading or stale.
- **Server components** stay server components:
  - views: render `<TrackView event="…" props={{…}} />` (`components/molecules/track-view.tsx`), a
    client island that renders nothing;
  - clicks: spread `analyticsAttrs(event, props)` on the link
    (`<a {...analyticsAttrs("outbound_link_clicked", { kind: "website" })}>`), or pass
    `outbound={{ kind }}` to `ExternalLink` / `QuickAction`. One capture-phase listener
    (`startClickTracking()`, started in `instrumentation-client.ts`) reads the attributes on click
    or middle click and calls `track()`.
  - `analyticsContext({ orgKey })` on a container adds `orgKey` to every tracked click inside it
    (a profile's `<article>`, an event's details) where the event allows it; the link's own props
    win, and an event that does not allow `orgKey` drops it.

## Adding an event

1. Add it to `ANALYTICS_EVENTS` in `webapp/lib/analytics-events.ts`, with a rule for each property
   (`keyOf`, `oneOf`, `count`, `listOf`, `optional`). Reuse the vocabularies in `lib/vocab.ts`. If a
   property is not a key, an enum, a count or a boolean, it does not belong in an event.
2. Add it to the table above and to `/privacy` ("When you browse", the list of things you do) and
   `docs/compliance/record-of-processing.md` P11 **in the same PR**: the notice must name every
   event and property that ships.
3. Fire it with `track()`, a hook, `<TrackView>` or `analyticsAttrs` as above. Never pass a title,
   name, email, query, message or URL, even into a property that would drop it.
4. Test it in `webapp/lib/analytics.test.ts` (the rule refuses text) and, for a new hook or
   component, in `webapp/hooks/use-analytics.test.tsx`.
5. Check it arrives in PostHog's EU project (`camsocs`, Activity) from a production deployment
   with consent given; previews and local runs have no key and send nothing.
