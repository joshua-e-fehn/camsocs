# CAMsocs

An unofficial, current directory of Cambridge student societies, sports clubs and their events, live at **[camsocs.uk](https://camsocs.uk)**.

CAMsocs is not affiliated with the University of Cambridge or Cambridge SU.

## What it does

- **Societies:** a profile for each of the ~800 societies and clubs, built from their own public pages and the SU directory. Every field records where it came from and when it was last seen.
- **Events:** one calendar that merges society websites, term cards, calendar feeds and the University's public events programme, with an ICS feed per society.
- **Talks:** public talks and seminars across departments.
- **Corrections:** a request form for societies to correct or remove a listing ([camsocs.uk/request](https://camsocs.uk/request)).

How it works and what it stores are explained at [camsocs.uk/about](https://camsocs.uk/about) and [camsocs.uk/privacy](https://camsocs.uk/privacy).

## How it is built

- `pipeline/`: a Python harvester (run through [pixi](https://pixi.sh)). It fetches public sources politely, extracts structured, quote-checked claims with an LLM and pushes them to the backend.
- `webapp/`: a Next.js 16 site with a [Convex](https://convex.dev) backend, deployed on Vercel.
- `ops/`: scheduled harvests on a VPS (systemd timers) and the Vercel firewall rules.

Start with [`AGENTS.md`](AGENTS.md) for the architecture and conventions, then [`PLAN.md`](PLAN.md) and [`docs/`](docs/).

## Contact

To ask for a correction or removal, use the [request form](https://camsocs.uk/request). For anything else, email hello@camsocs.uk; privacy requests can also go to privacy@camsocs.uk.
