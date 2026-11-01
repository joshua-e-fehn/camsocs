# Talks coverage (department registry, checked 2026-10-31)

Which University units the talks pillar reads, and how (spec §2). Generated from
`pipeline/src/camsocs_pipeline/talks/departments.json`, the 2026-10-31 source research
(310 units) and a full `talks-verify` run on 2026-10-31 (`pixi run pipeline -- talks-verify`).

- **talks.cam**: the registry holds the talks.cam list ids the department's own site links;
  the talks.cam collector reads those lists (another builder's stage).
- **own site**: a parser reads the department's listing, feed or API; the count is the talks it
  gave for the next 70 days on 2026-10-31 (vacation lulls and empty listings show as 0).
- Counts on the own-site side overlap talks.cam where a department mirrors its talks.cam lists
  (Computer Science, DAMTP, Chemistry); dedupe keeps one record per talk.

## Summary

- 134 departments in the registry: 42 with talks.cam lists (117 list ids), 108 with an own-site source (111 sources).
- Verify run: 71 sources gave upcoming talks, 40 were valid but empty, 0 errors; **517 upcoming talks** from department sites in the next 70 days.
- 114 researched units are not covered (reasons below).

## School of Arts and Humanities

| Department | talks.cam lists | Own site (kind: upcoming) |
|---|---:|---|
| AMES (Faculty of Asian and Middle Eastern Studies) | – | Drupal listing: 17 |
| Architecture (Department of Architecture) | – | Drupal listing: 5 |
| Divinity (Faculty of Divinity) | – | Drupal listing: 22 |
| English (Faculty of English) | – | Drupal listing: 24 |
| Greek Studies (Cambridge Centre for Greek Studies) | – | Drupal listing: 2 |
| History of Art (Department of History of Art) | – | Drupal listing: 7 |
| Interfaith Programme (Cambridge Interfaith Programme) | – | Drupal listing: 11 |
| MMLL (Faculty of Modern and Medieval Languages and Linguistics) | 1 | Drupal listing: 0 |
| Music (Faculty of Music) | – | Drupal listing: 10 |
| Music and Science (Centre for Music and Science) | – | RSS: 0 |

Not covered:

- Ax:son Johnson Centre for the Study of Classical Architecture (CSCA): HTML term card / prose only (no structured dates)
- Cambridge Centre for the Study of Christianity Worldwide (CCCW): listing without machine-readable dates (WordPress / other CMS)
- Cambridge Centre for the Study of Platonism: talks posted as news, the date only in the title
- Cambridge Digital Humanities (CDH): listing rendered by JavaScript
- Cambridge Film and Screen: listing without machine-readable dates (WordPress / other CMS)
- Centre for Human-Inspired AI (CHIA): cards without machine-readable dates
- Centre for Music Performance: listing without machine-readable dates (WordPress / other CMS)
- Centre for Research in the Arts, Social Sciences and Humanities (CRASSH): listing rendered by JavaScript
- Centre for the Study of Existential Risk (CSER): listing rendered by JavaScript
- Department of Anglo-Saxon, Norse and Celtic (ASNC): HTML term card / prose only (no structured dates)
- Faculty of Classics: HTML term card / prose only (no structured dates)
- Faculty of Philosophy: free-text term cards; its Google Calendar is never fetched (spec §1)
- Faraday Institute for Science and Religion: listing without machine-readable dates (WordPress / other CMS)
- Fitzwilliam Museum: listing rendered by JavaScript
- HRH Prince Alwaleed Bin Talal Centre of Islamic Studies (CIS): listing without machine-readable dates (WordPress / other CMS)
- Institute for Orthodox Christian Studies (IOCS): news feed: dates only in titles
- Institute for Technology and Humanity (ITH): no events listing found
- Judith E Wilson Centre for Poetry and Poetics: blog feed: event dates only in post text
- Kettle's Yard: listing without machine-readable dates (WordPress / other CMS)
- Leverhulme Centre for the Future of Intelligence (LCFI / CFI): listing without machine-readable dates (WordPress / other CMS)
- Minderoo Centre for Technology and Democracy (MCTD): WordPress listing; its API carries publication dates only
- School of Arts and Humanities (School office): no events listing found
- University of Cambridge Language Centre: no events listing found
- Woolf Institute: listing without machine-readable dates (WordPress / other CMS)

## School of the Humanities and Social Sciences

| Department | talks.cam lists | Own site (kind: upcoming) |
|---|---:|---|
| 3CL (Centre for Corporate and Commercial Law) | – | RSS: 2 |
| African Studies (Centre of African Studies) | – | Drupal listing: 5 |
| Archaeology (Department of Archaeology) | 16 | Drupal listing: 1 |
| CAFR (Centre for Child, Adolescent and Family Research) | – | Drupal listing: 0 |
| CAMPOP (Cambridge Group for the History of Population and Social Structure) | 4 | – |
| CELS (Centre for European Legal Studies) | – | RSS: 3 |
| CFLPP (Cambridge Forum for Legal and Political Philosophy) | – | RSS: 3 |
| CIPIL (Centre for Intellectual Property and Information Law) | – | RSS: 4 |
| Criminology (Institute of Criminology) | – | Drupal listing: 4 |
| CSHSS (School of the Humanities and Social Sciences) | – | Drupal listing: 0 |
| Development Studies (Centre of Development Studies) | – | Drupal listing: 3 |
| Economics (Faculty of Economics) | – | Drupal listing: 41 |
| Heritage Research Centre (Cambridge Heritage Research Centre) | – | Drupal listing: 2 |
| History (Faculty of History) | 2 | – |
| HPS (Department of History and Philosophy of Science) | 1 | – |
| HSPS (Faculty of Human, Social and Political Science) | – | Drupal listing: 0 |
| Janeway Institute (Janeway Institute for Economics) | – | Drupal listing: 18 |
| Land Economy (Department of Land Economy) | – | Drupal listing: 10 |
| Lauterpacht Centre (Lauterpacht Centre for International Law) | – | RSS: 5 |
| Law (Faculty of Law) | – | RSS: 51 |
| POLIS (Department of Politics and International Studies) | – | Drupal listing: 2 |
| Prisons Research Centre (Prisons Research Centre) | – | Drupal listing: 0 |
| Private Law (Cambridge Private Law Centre) | – | RSS: 4 |
| Public Law (Centre for Public Law) | – | RSS: 4 |
| Social Anthropology (Department of Social Anthropology) | – | Drupal listing: 16; Drupal listing: 2 |
| Sociology (Department of Sociology) | – | Drupal listing: 3 |
| Tax Law (Centre for Tax Law) | – | RSS: 0 |

Not covered:

- Bennett School of Public Policy (formerly Bennett Institute): events feed carries post dates only and its pages have no machine-readable date
- Cambridge Centre for Political Thought: HTML term card / prose only (no structured dates)
- Cambridge-Africa Programme: University CMS listing (Contensis event blocks) not parsed
- Centre for Gender Studies: HTML term card / prose only (no structured dates)
- Centre for Geopolitics (POLIS-linked): no events page found
- Centre for History and Economics (Magdalene College; listed by the School): HTML term card / prose only (no structured dates)
- Centre of Governance and Human Rights (CGHR, POLIS): events feed carries post dates only; pages have no machine-readable date
- Centre of Latin American Studies: HTML term card / prose only (no structured dates)
- Centre of South Asian Studies: HTML term card / prose only (no structured dates)
- Faculty of Education: HTML term card / prose only (no structured dates)
- Museum of Archaeology and Anthropology (MAA): listing markup not parsed (mostly non-talk events)

## School of the Biological Sciences

| Department | talks.cam lists | Own site (kind: upcoming) |
|---|---:|---|
| Biochemistry (Department of Biochemistry) | 1 | Drupal listing: 0 |
| CAIC (Cambridge Advanced Imaging Centre) | – | Drupal listing: 0 |
| CSLB (Centre for Speech, Language and the Brain) | – | Drupal listing: 0 |
| Genetics (Department of Genetics) | 1 | Drupal listing: 7 |
| MRC Tox (MRC Toxicology Unit) | – | Drupal listing: 2 |
| Neuroscience in Education (Centre for Neuroscience in Education) | – | Drupal listing: 0 |
| Pathology (Department of Pathology) | – | Drupal listing: 0 |
| PDN (Department of Physiology, Development and Neuroscience) | – | Drupal listing: 0 |
| Pharmacology (Department of Pharmacology) | 1 | Drupal listing: 0 |
| Plant Sciences (Department of Plant Sciences) | 1 | Drupal listing: 0 |
| PSLS (Postgraduate School of Life Sciences) | – | Drupal listing: 0 |
| Psychology (Department of Psychology) | 1 | Drupal listing: 0 |
| Sainsbury Lab (Sainsbury Laboratory Cambridge University) | – | Drupal listing: 1 |
| Stem Cell Institute (Cambridge Stem Cell Institute) | – | Drupal listing: 1 |
| Vet Medicine (Department of Veterinary Medicine) | 2 | Drupal listing: 0 |
| Zoology (Department of Zoology) | 1 | Drupal listing: 5 |

Not covered:

- Cambridge University Botanic Garden: listing without machine-readable dates (WordPress / other CMS)
- Crop Science Centre: no events listing found
- Loke Centre for Trophoblast Research: HTML term card / prose only (no structured dates)
- Milner Therapeutics Institute: HTML term card / prose only (no structured dates)
- School of the Biological Sciences / Faculty of Biology (School office): no events listing found
- Wellcome/CRUK Gurdon Institute: events feed carries post dates only (public engagement); seminar page is free text

## School of Clinical Medicine

| Department | talks.cam lists | Own site (kind: upcoming) |
|---|---:|---|
| Autism Research Centre (Autism Research Centre) | 1 | – |
| CIMR (Cambridge Institute for Medical Research) | – | Drupal listing: 0 |
| Clinical Neurosciences (Department of Clinical Neurosciences) | – | Drupal listing: 0 |
| CRUK Cambridge Centre (Cancer Research UK Cambridge Centre) | 1 | RSS: 0 |
| CRUK CI (Cancer Research UK Cambridge Institute) | 1 | – |
| Early Cancer Institute (Early Cancer Institute) | – | Drupal listing: 1 |
| Haematology (Department of Haematology) | – | Drupal listing: 1 |
| IMS-MRL (Institute of Metabolic Science – Metabolic Research Laboratories) | – | Drupal listing: 4 |
| Medicine (Department of Medicine) | – | Drupal listing: 0 |
| MRC BSU (MRC Biostatistics Unit) | – | Drupal listing: 1 |
| MRC Epidemiology (MRC Epidemiology Unit) | – | ICS: 0 |
| MRC MBU (MRC Mitochondrial Biology Unit) | 1 | Drupal listing: 3 |
| PHPC (Department of Public Health and Primary Care) | – | Drupal listing: 0 |
| Psychiatry (Department of Psychiatry) | – | Drupal listing: 0 |
| WBIC (Wolfson Brain Imaging Centre) | – | Drupal listing: 1 |

Not covered:

- Cambridge Centre for Ageing and Neuroscience (Cam-CAN): blog feed, no events
- Cambridge Institute for Therapeutic Immunology and Infectious Disease (CITIID): mirrors the Cambridge Immunology talks.cam list (on the Immunology Network)
- Cambridge Mind and Brain Institute (CMBI): HTML term card / prose only (no structured dates)
- Department of Genomic Medicine (formerly Medical Genetics): no events listing found
- Department of Obstetrics and Gynaecology: no events listing found
- Department of Oncology: its talks.cam lists belong to the CRUK Cambridge Institute and the CRUK Cambridge Centre
- Department of Paediatrics: no events listing found
- Department of Radiology: no events listing found
- Department of Surgery: no events listing found
- MRC Cognition and Brain Sciences Unit (CBU): HTML term card / prose only (no structured dates)
- MRC Laboratory of Molecular Biology (LMB): HTML term card / prose only (no structured dates)
- NIHR Cambridge Biomedical Research Centre (BRC): site answers 403 to non-browser clients
- THIS Institute (The Healthcare Improvement Studies Institute): site answers 403 to non-browser clients
- UK Dementia Research Institute (Cambridge centre): listing stale or archive only
- Victor Phillip Dahdaleh Heart & Lung Research Institute (VPD-HLRI): no events listing found
- Wellcome Sanger Institute (Wellcome Genome Campus, Hinxton): listing stale or archive only

## School of the Physical Sciences

| Department | talks.cam lists | Own site (kind: upcoming) |
|---|---:|---|
| Astronomy (Institute of Astronomy) | 1 | Drupal listing: 3; Drupal listing: 8 |
| Atmospheric Science (Centre for Atmospheric Science) | – | Drupal listing: 3 |
| Chemistry (Yusuf Hamied Department of Chemistry) | – | Drupal listing: 14 |
| CQIF (Centre for Quantum Information and Foundations) | 1 | – |
| CTC (Centre for Theoretical Cosmology) | 3 | – |
| DAMTP (Department of Applied Mathematics and Theoretical Physics) | 6 | Drupal listing: 15 |
| DPMMS (Department of Pure Mathematics and Mathematical Statistics) | 10 | – |
| Earth Sciences (Department of Earth Sciences) | 1 | Drupal listing: 0 |
| ICCS (Institute of Computing for Climate Science) | – | Drupal listing: 2 |
| KICC (Kavli Institute for Cosmology Cambridge) | – | Drupal listing: 11 |
| LCLU (Leverhulme Centre for Life in the Universe) | 2 | Drupal listing: 2 |
| Lennard-Jones Centre (Lennard-Jones Centre) | 1 | – |
| Maxwell Centre (Maxwell Centre) | – | Drupal listing: 1 |
| Physics (Department of Physics) | 5 | – |
| Quantum Matter (Quantum Matter Group) | 1 | – |
| Quaternary (Cambridge Quaternary) | 1 | – |
| Semiconductor Physics (Semiconductor Physics Group) | – | Drupal listing: 0 |
| Statslab (Statistical Laboratory) | 7 | – |
| TCM (Theory of Condensed Matter Group) | 1 | – |

Not covered:

- Cambridge Centre for Data-Driven Discovery (C2D3) - interdisciplinary, overlaps the School: listing markup not parsed (date ranges for series, talks mirrored from talks.cam)
- Cambridge Coastal Research Unit (CCRU, Geography): HTML term card / prose only (no structured dates)
- Cantab Capital Institute for the Mathematics of Information (CCIMI): no events listing found
- Cavendish - Biological and Soft Systems (BSS) and Centre for Physical Biology: static text, no listing
- Cavendish - High Energy Physics (HEP) group: seminar table with dates as text, not parsed; no talks.cam list known
- Centre for Scientific Computing (CSC) incl. CDT in Computational Methods for Materials Science: no events listing found
- Department of Geography: listing not inspected: robots.txt asks AI agents not to read the site (a parser would need building blind)
- Department of Materials Science and Metallurgy (MSM): listing rendered by JavaScript from a robots-disallowed path
- Faculty of Earth Sciences and Geography (faculty level): faculty site retired (redirects)
- Faculty of Mathematics (Centre for Mathematical Sciences): its talk pages mirror DAMTP's and DPMMS's talks.cam lists (covered there)
- Isaac Newton Institute for Mathematical Sciences (INI): robots.txt disallows the listing
- NanoDTC / Nanoscience Centre / NanoPhotonics Centre: no events listing found
- Scott Polar Research Institute (SPRI) and Polar Museum: listing not inspected: robots.txt asks AI agents not to read the site (a parser would need building blind)
- Theory of Living Matter group (TLM): free-text term cards; its Google Calendar is never fetched (spec §1)

## School of Technology

| Department | talks.cam lists | Own site (kind: upcoming) |
|---|---:|---|
| 4C (Cambridge Centre for Carbon Credits) | – | Drupal listing: 0 |
| CCAIM (Cambridge Centre for AI in Medicine) | 1 | – |
| CEB (Department of Chemical Engineering and Biotechnology) | 1 | – |
| CISL (Cambridge Institute for Sustainability Leadership) | – | Drupal listing: 0 |
| Civil Engineering (Civil Engineering Division) | 1 | – |
| Computer Science (Department of Computer Science and Technology) | 11 | Drupal listing: 37 |
| Control Group (Control Group) | 1 | – |
| CSIC (Cambridge Centre for Smart Infrastructure and Construction) | – | Drupal listing: 1 |
| EDC (Engineering Design Centre) | 1 | – |
| ELLIS (Cambridge ELLIS Unit) | 1 | – |
| Engineering (Department of Engineering) | 17 | – |
| IfM (Institute for Manufacturing) | 2 | – |
| Judge (Cambridge Judge Business School) | – | JSON API: 22 |
| Laing O'Rourke Centre (Laing O'Rourke Centre for Construction Engineering and Technology) | – | Drupal listing: 0 |
| Machine Learning Group (Machine Learning Group) | 2 | – |
| PSI2 (Probabilistic Systems, Information and Inference Group) | 1 | – |
| QAMSS (Quantum and Advanced Materials for a Sustainable Society) | – | Drupal listing: 8; Drupal listing: 0 |
| Sustainable Development (Centre for Sustainable Development) | – | Drupal listing: 0 |

Not covered:

- Accelerate Programme for Scientific Discovery (Dept of Computer Science and Technology): HTML term card / prose only (no structured dates)
- Institute for Energy and Environmental Flows (IEEF): listing without machine-readable dates (WordPress / other CMS)
- Raspberry Pi Computing Education Research Centre (Dept of Computer Science and Technology): blog category feed: dates only in post text
- Whittle Laboratory (CUED Division A, turbomachinery): no events listing found

## Other: non-School institutions, museums, colleges, partner institutes

| Department | talks.cam lists | Own site (kind: upcoming) |
|---|---:|---|
| ai@cam (ai@cam) | – | JSON API: 1 |
| Alumni (University Development and Alumni Relations) | – | Drupal listing: 1 |
| BAS (British Antarctic Survey) | – | ICS: 0 |
| Cambridge Festival (Cambridge Festival) | – | Drupal listing: 0 |
| Cambridge Neuroscience (Cambridge Neuroscience) | – | JSON API: 1 |
| Cambridge Public Health (Cambridge Public Health) | – | Drupal listing: 1 |
| Cambridge Zero (Cambridge Zero) | – | Drupal listing: 1 |
| Cardiovascular (Cambridge Cardiovascular) | – | Drupal listing: 15 |
| Christ's (Christ's College) | – | Drupal listing: 1 |
| Conservation (Conservation Research Institute) | – | Drupal listing: 4 |
| Energy IRC (Energy Interdisciplinary Research Centre) | – | Drupal listing: 25 |
| Engineering Biology (Engineering Biology Interdisciplinary Research Centre) | – | Drupal listing: 8 |
| Gates Cambridge (Gates Cambridge Trust) | – | ICS: 0 |
| Girton (Girton College) | – | Drupal listing: 0 |
| Global Food (Cambridge Global Food Systems) | – | Drupal listing: 1 |
| Immunology (Cambridge Immunology Network) | 1 | – |
| Infectious Diseases (Cambridge Infectious Diseases) | – | Drupal listing: 0 |
| Intellectual Forum (Intellectual Forum, Jesus College) | – | Drupal listing: 8 |
| Language Sciences (Cambridge Language Sciences Interdisciplinary Research Centre) | – | Drupal listing: 1 |
| Lucy Cavendish (Lucy Cavendish College) | – | Drupal listing: 1 |
| Murray Edwards (Murray Edwards College) | – | Drupal listing: 4 |
| Museum of Zoology (Museum of Zoology) | – | Drupal listing: 0 |
| Newnham (Newnham College) | – | Drupal listing: 5 |
| NIAB (NIAB) | – | Drupal listing: 1 |
| PACE (Professional and Continuing Education) | – | Drupal listing: 1 |
| Philosophical Society (Cambridge Philosophical Society) | 1 | – |
| Reproduction (Cambridge Reproduction) | – | Drupal listing: 2 |
| Sedgwick Museum (Sedgwick Museum of Earth Sciences) | – | Drupal listing: 0 |
| Whipple Museum (Whipple Museum of the History of Science) | – | Drupal listing: 0 |

Not covered:

- Babraham Institute: seminar pages give dates as text only
- Cambridge Academy of Therapeutic Sciences (ATS) - IRC: free-text blocks with Eventbrite links
- Cambridge CARES (Singapore): Singapore events, post-dated feed
- Cambridge Centre for Teaching and Learning (CCTL): HTML term card / prose only (no structured dates)
- Cambridge Conservation Initiative (CCI): site answers 403 to non-browser clients
- Cambridge Crystallographic Data Centre (CCDC): event pages carry no machine-readable date
- Cambridge Enterprise: WordPress listing without machine-readable dates
- Cambridge Global Challenges (GCI) - IRC: nested pages, no listing
- Cambridge Theological Federation: news feed stale since 2018
- Cambridge Union Society (not a University dept; major speaker events): events and tickets on a members' platform that blocks bots
- Cambridge University Library: listing without machine-readable dates
- Cambridge University Press & Assessment: no talk listing identified
- Careers Service: dates as text; details live in Handshake
- Centre for Science and Policy (CSaP): events feed carries post dates only; pages have no machine-readable date
- Churchill College (incl. Churchill Archives Centre): listing not inspected: robots.txt asks AI agents not to read the site (a parser would need building blind)
- Clare Hall: WordPress listing; event dates hidden from its API
- Collections, Connections, Communities (Strategic Research Initiative): listing without machine-readable dates (WordPress / other CMS)
- Darwin College Lecture Series (Darwin College): WordPress listing; event dates hidden from its API
- Downing College (incl. Heong Gallery): robots.txt disallows the listing
- EMBL-EBI (European Bioinformatics Institute, Wellcome Genome Campus): listing stale or archive only
- Great St Mary's, the University Church: HTML term card / prose only (no structured dates)
- Hamilton Kerr Institute: no dated items
- Hughes Hall: listing without machine-readable dates (WordPress / other CMS)
- Kavli Centre for Ethics, Science, and the Public (KCESP): listing stale or archive only
- Madingley Hall: listing without machine-readable dates (WordPress / other CMS)
- Margaret Beaufort Institute of Theology (MBIT): WordPress cards with dates as text only
- Metabolism Network / Precision Health SRI: no events listing found
- Other colleges (Clare, Corpus Christi, Magdalene, King's, St Catharine's, Pembroke, Selwyn, Fitzwilliam, Robinson, Emmanuel, Sidney Sussex, Gonville & Caius, Trinity Hall, Peterhouse, Homerton, Queens', St John's): listing without machine-readable dates (WordPress / other CMS)
- PHG Foundation: site answers 403 to non-browser clients
- Postdoc Academy: listing has no dated items in its HTML
- Postdocs of Cambridge Society (PdOC): social events and a careers-workshop calendar, not talks
- St Edmund's College (incl. Von Hügel Institute): WordPress listing; event dates hidden from its API
- Trinity College: its calendar lists alumni and chapel events only
- Tyndale House (biblical studies research institute): listing without machine-readable dates (WordPress / other CMS)
- University of Cambridge Museums (UCM consortium): site unreachable at research time (use the museums' own sites)
- Wellcome Connecting Science (Genome Campus courses and conferences): listing without machine-readable dates (WordPress / other CMS)
- Westminster College, Cambridge (incl. Cambridge Centre for Christianity Worldwide, CCCW): HTML term card / prose only (no structured dates)
- Wolfson College: listing markup not parsed
- ideaSpace (Hauser Forum, West Cambridge): category feed stale since 2024

## Notes

- Google Calendar feeds (History, HPS, Philosophy, Downing, Theory of Living Matter) are never
  fetched (spec §1), so those units rely on talks.cam lists where they have them.
- Sites whose robots.txt names AI crawlers (Geography, SPRI, Churchill) were not inspected by the
  research agent. The parser bot is not an AI agent and may read them, but no parser was written
  for an unseen page; a person can add their listing to the registry once its shape is known.
- Free-text term cards (Classics, Philosophy, POLIS series pages, Pharmacology, PDN, many centres)
  are the largest remaining gap; they need a term-card reader, not one of these parsers.
- Mixed listings (museums, gardens, colleges, careers) keep only items whose title or category
  names a talk (`talks/sites/filters.py`).
