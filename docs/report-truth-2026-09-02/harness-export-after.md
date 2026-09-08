# OSINT Investigation Report

> ⚠️ **25 weak single-artifact signals (account-existence checks, sweep-only handles, breach rows) are listed in the Artifact Table but are NOT shown as standalone identity clusters — they lack a durable selector or corroboration.**

## Executive Summary
Observed 53 artifacts across 16 tools. 3 findings observed in multiple sources or analyst-reviewed. 30 items need verification before reporting. 3 items marked as false positive. Analyst review: 1 analyst-verified, 2 analyst-rejected. All findings are presented as observations from named sources, not as confirmed identity claims.

## Seed Details
- **Selector:** `j.harker@northgate-logistics.com`
- **Type:** email
- **Artifacts recorded:** 53

## Candidate Identity Clusters
### Cluster C001 — j.harker@northgate-logistics.com
- **Confidence:** 88
- **Emails:** j.harker@northgate-logistics.com
- **Source tools:** hunter verify

### Cluster C002 — jharker88
- **Confidence:** 60
- **Usernames:** jharker88
- **Source tools:** deepfind reverse

### Cluster C005 — harker.logistics
- **Confidence:** 60
- **Usernames:** harker.logistics
- **Source tools:** socialfetch

### Cluster C003 — unattributed cluster
- **Confidence:** 55
- **Phones:** +1 415 555 0142 (area 415)
- **Source tools:** indicia footprint

### Cluster C013 — m.keith@mail.example
- **Confidence:** 50
- **Emails:** m.keith@mail.example
- **Source tools:** indicia address

### Cluster C014 — a.keith@mail.example
- **Confidence:** 50
- **Emails:** a.keith@mail.example
- **Source tools:** indicia address

### Cluster C015 — r.plascencia@mail.example
- **Confidence:** 50
- **Emails:** r.plascencia@mail.example
- **Source tools:** indicia address

### Cluster C016 — t.plascencia@mail.example
- **Confidence:** 50
- **Emails:** t.plascencia@mail.example
- **Source tools:** indicia address

### Cluster C006 — support@stocktonfreight.example
- **Confidence:** 45
- **Emails:** support@stocktonfreight.example
- **Source tools:** breach/profile lookup

### Cluster C007 — billing@stocktonfreight.example
- **Confidence:** 45
- **Emails:** billing@stocktonfreight.example
- **Source tools:** breach/profile lookup

### Cluster C008 — dbuse@stocktonfreight.example
- **Confidence:** 45
- **Emails:** dbuse@stocktonfreight.example
- **Source tools:** breach/profile lookup

### Cluster C009 — noreply@stocktonfreight.example
- **Confidence:** 45
- **Emails:** noreply@stocktonfreight.example
- **Source tools:** breach/profile lookup

### Cluster C010 — hr@stocktonfreight.example
- **Confidence:** 45
- **Emails:** hr@stocktonfreight.example
- **Source tools:** breach/profile lookup

### Cluster C011 — sales@stocktonfreight.example
- **Confidence:** 45
- **Emails:** sales@stocktonfreight.example
- **Source tools:** breach/profile lookup

### Cluster C012 — webmaster@stocktonfreight.example
- **Confidence:** 45
- **Emails:** webmaster@stocktonfreight.example
- **Source tools:** breach/profile lookup

### Cluster C004 — unattributed cluster
- **Confidence:** 34
- **IPs:** 203.0.113.47
- **Source tools:** oathnet


## Engine-adjudicated findings

The scoring engine adjudicated no findings on this case. 55 artifacts were collected; everything below is a lead, not an adjudicated finding.

## Key Findings — leads (not engine-adjudicated)
_2 corroborated by 2+ independent source classes, 1 analyst-confirmed; none was scored by the engine (`record_finding` recorded no findings on this case). Listed as strong leads, not adjudicated findings._

- **email** — `j.harker@northgate-logistics.com` _(source indicates via hunter verify, confidence 88)_
- **domain** — `northgate-logistics.com` _(source indicates via domain registration lookup, confidence 92)_
- **email** — `j.harker@harker-legal.example` _(source indicates via hunter verify, confidence 88)_

## Artifact / Entity Table
| Value | Kind | Source | Label | Confidence | First seen |
| --- | --- | --- | --- | --- | --- |
| j.harker@northgate-logistics.com | email | hunter verify | CONFIRMED | 88 | 2026-08-09T03:19:00.000Z |
| jharker88 | username | deepfind reverse | INFERRED | 74 | 2026-08-09T03:22:00.000Z |
| Wattpad (2020) — email, hashed password | breach_exposure | oathnet | VERIFY | 60 | 2026-08-09T03:27:00.000Z |
| +1 415 555 0142 | phone | indicia footprint | VERIFY | 55 | 2026-08-09T03:33:00.000Z |
| northgate-logistics.com | domain | domain registration lookup | CONFIRMED | 92 | 2026-08-09T03:38:00.000Z |
| Oakland, California, US | location | indicia person | FAILED | 41 | 2026-08-09T03:44:00.000Z |
| linkedin.com/in/james-harker-logistics | social_profile | socialfetch | CORRELATED | 79 | 2026-08-09T03:49:00.000Z |
| 203.0.113.47 | ip | oathnet | LOW | 34 | 2026-08-09T03:54:00.000Z |
| +1 209 555 0117 | phone | breach/profile lookup | VERIFY | 45 | 2026-08-09T03:41:00.000Z |
| jharker@stocktonfreight.example | email | breach/profile lookup | VERIFY | 45 | 2026-08-09T03:42:00.000Z |
| harker.logistics | username | socialfetch | CORRELATED | 81 | 2026-08-09T03:45:00.000Z |
| j.harker@harker-legal.example | email | hunter verify | CONFIRMED | 88 | 2026-08-09T03:46:00.000Z |
| Stockton, California, US | location | indicia person | CONFLICT | 38 | 2026-08-09T03:46:00.000Z |
| info@northgate-logistics.com | email | web search | FAILED | 20 | 2026-08-09T03:47:00.000Z |
| https://staff.northgate-logistics.com/directory/operations/james-harker?ref=internal&utm_source=intranet&sid=7f3c19ab-2d44-4e51-9c07-a8be31f0d2c6 | url | firecrawl scrape | INFERRED | 66 | 2026-08-09T03:48:00.000Z |
| bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq9v0x8lm3sq4nzsjhtca8 | crypto_wallet | oathnet | LOW | 29 | 2026-08-09T03:50:00.000Z |
| CONTRADICTION: 1110 Sample Ave is NOT linked to James Harker. The reverse-address lookup returned 31 records and the actual residents are the Keith and Plascencia families — Harker appears in none of them. | contradiction | indicia address | CONFLICT | 65 | 2026-08-09T03:49:00.000Z |
| 203.0.113.57 | ip_address | breach/profile lookup + IP intelligence + exposed-service scan | FAILED | 40 | 2026-08-09T03:48:00.000Z |
| https://social.example/jharker_ops | social_profile | username sweep + AI-assisted deep search | VERIFY | 55 | 2026-08-09T03:49:00.000Z |
| Northgate Logistics LLC | organization | opencorporates + web search | CORRELATED | 62 | 2026-08-09T03:48:00.000Z |
| Sacramento Freight Expo 2025 — listed exhibitor | event | AI-assisted deep search | VERIFY | 48 | 2026-08-09T03:49:00.000Z |
| Sierra — mentioned in a stream title | weak_lead | socialfetch web read | LOW | 20 | 2026-08-09T03:50:00.000Z |
| Gabriel G. Salas | name | indicia address | VERIFY | 45 | 2026-08-09T03:51:00.000Z |
| Esther Salas | name | indicia address | VERIFY | 45 | 2026-08-09T03:52:00.000Z |
| Gabriel Gilbert Gilbert Salas | name | indicia address | VERIFY | 45 | 2026-08-09T03:53:00.000Z |
| Michael O. Wong | name | indicia address | VERIFY | 45 | 2026-08-09T03:54:00.000Z |
| Sandra Salas | name | indicia address | VERIFY | 45 | 2026-08-09T03:55:00.000Z |
| 67 unlinked identities — bulk corpus (gsalas916@icloud.com) | bulk_corpus_harvest | indicia address | VERIFY | 40 | 2026-08-09T03:56:00.000Z |
| support@stocktonfreight.example | email | breach/profile lookup | VERIFY | 45 | 2026-08-09T03:43:00.000Z |
| billing@stocktonfreight.example | email | breach/profile lookup | VERIFY | 45 | 2026-08-09T03:43:00.000Z |
| dbuse@stocktonfreight.example | email | breach/profile lookup | VERIFY | 45 | 2026-08-09T03:43:00.000Z |
| noreply@stocktonfreight.example | email | breach/profile lookup | VERIFY | 45 | 2026-08-09T03:43:00.000Z |
| hr@stocktonfreight.example | email | breach/profile lookup | VERIFY | 45 | 2026-08-09T03:43:00.000Z |
| sales@stocktonfreight.example | email | breach/profile lookup | VERIFY | 45 | 2026-08-09T03:43:00.000Z |
| webmaster@stocktonfreight.example | email | breach/profile lookup | VERIFY | 45 | 2026-08-09T03:43:00.000Z |
| m.keith@mail.example | email | indicia address | VERIFY | 50 | 2026-08-09T03:44:00.000Z |
| a.keith@mail.example | email | indicia address | VERIFY | 50 | 2026-08-09T03:44:00.000Z |
| r.plascencia@mail.example | email | indicia address | VERIFY | 50 | 2026-08-09T03:44:00.000Z |
| t.plascencia@mail.example | email | indicia address | VERIFY | 50 | 2026-08-09T03:44:00.000Z |
| mail.northgate-logistics.com | subdomain | network recon | INFERRED | 70 | 2026-08-09T03:51:00.000Z |
| vpn.northgate-logistics.com | subdomain | network recon | INFERRED | 65 | 2026-08-09T03:51:00.000Z |
| portal.northgate-logistics.com | subdomain | network recon | VERIFY | 60 | 2026-08-09T03:51:00.000Z |
| api.northgate-logistics.com | subdomain | network recon | INFERRED | 70 | 2026-08-09T03:51:00.000Z |
| dev.northgate-logistics.com | subdomain | network recon | INFERRED | 65 | 2026-08-09T03:51:00.000Z |
| staging.northgate-logistics.com | subdomain | network recon | VERIFY | 60 | 2026-08-09T03:51:00.000Z |
| cdn.northgate-logistics.com | subdomain | network recon | INFERRED | 70 | 2026-08-09T03:51:00.000Z |
| git.northgate-logistics.com | subdomain | network recon | INFERRED | 65 | 2026-08-09T03:51:00.000Z |
| docs.northgate-logistics.com | subdomain | network recon | VERIFY | 60 | 2026-08-09T03:51:00.000Z |
| status.northgate-logistics.com | subdomain | network recon | INFERRED | 70 | 2026-08-09T03:51:00.000Z |
| smtp.northgate-logistics.com | subdomain | network recon | INFERRED | 65 | 2026-08-09T03:51:00.000Z |
| ns1.northgate-logistics.com | subdomain | network recon | VERIFY | 60 | 2026-08-09T03:51:00.000Z |
| ns2.northgate-logistics.com | subdomain | network recon | INFERRED | 70 | 2026-08-09T03:51:00.000Z |
| legacy.northgate-logistics.com | subdomain | network recon | INFERRED | 65 | 2026-08-09T03:51:00.000Z |

## Network Connections
**Contact**
- `j.harker@northgate-logistics.com` _(observed via hunter verify)_
- `+1 415 555 0142` _(observed via indicia footprint)_
- `support@stocktonfreight.example` _(observed via breach/profile lookup)_
- `billing@stocktonfreight.example` _(observed via breach/profile lookup)_
- `dbuse@stocktonfreight.example` _(observed via breach/profile lookup)_
- `noreply@stocktonfreight.example` _(observed via breach/profile lookup)_
- `hr@stocktonfreight.example` _(observed via breach/profile lookup)_
- `sales@stocktonfreight.example` _(observed via breach/profile lookup)_
- `webmaster@stocktonfreight.example` _(observed via breach/profile lookup)_
- `m.keith@mail.example` _(observed via indicia address)_
- `a.keith@mail.example` _(observed via indicia address)_
- `r.plascencia@mail.example` _(observed via indicia address)_
- `t.plascencia@mail.example` _(observed via indicia address)_

**Social**
- `jharker88` _(observed via deepfind reverse)_
- `linkedin.com/in/james-harker-logistics` _(observed via socialfetch)_
- `https://social.example/jharker_ops` _(observed via username sweep + AI-assisted deep search)_

**Infrastructure**
- `northgate-logistics.com` _(observed via domain registration lookup)_
- `203.0.113.47` _(observed via oathnet)_
- `mail.northgate-logistics.com` _(observed via network recon)_
- `vpn.northgate-logistics.com` _(observed via network recon)_
- `portal.northgate-logistics.com` _(observed via network recon)_
- `api.northgate-logistics.com` _(observed via network recon)_
- `dev.northgate-logistics.com` _(observed via network recon)_
- `staging.northgate-logistics.com` _(observed via network recon)_
- `cdn.northgate-logistics.com` _(observed via network recon)_
- `git.northgate-logistics.com` _(observed via network recon)_
- `docs.northgate-logistics.com` _(observed via network recon)_
- `status.northgate-logistics.com` _(observed via network recon)_
- `smtp.northgate-logistics.com` _(observed via network recon)_
- `ns1.northgate-logistics.com` _(observed via network recon)_
- `ns2.northgate-logistics.com` _(observed via network recon)_
- `legacy.northgate-logistics.com` _(observed via network recon)_

**Breach / Exposure**
- `Wattpad (2020) — email, hashed password` _(observed via oathnet)_

**Web / Archive**
- `https://staff.northgate-logistics.com/directory/operations/james-harker?ref=internal&utm_source=intranet&sid=7f3c19ab-2d44-4e51-9c07-a8be31f0d2c6` _(observed via firecrawl scrape)_

**Crypto**
- `bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq9v0x8lm3sq4nzsjhtca8` _(observed via oathnet)_

**Organizations / Affiliations**
- `Northgate Logistics LLC` _(observed via opencorporates + web search)_

**Records / Events**
- `Sacramento Freight Expo 2025 — listed exhibitor` _(observed via AI-assisted deep search)_

## Collision / Likely Unrelated
_These artifacts were flagged as namesakes / unrelated entities. They do NOT belong to the subject and do NOT strengthen the main network._

- `j.harker@harker-legal.example` — email _(CONFIRMED, via hunter verify)_

_Conflicts noted across sources — may indicate different people or data errors. Corroborate before merging._

- **3 artifacts** — harvested from a name-only query — same-name collision axis; linkage to the subject is unproven
  - `+1 209 555 0117` _(via breach/profile lookup)_
  - `jharker@stocktonfreight.example` _(via breach/profile lookup)_
  - `harker.logistics` _(via socialfetch)_
- `Stockton, California, US` — contradicts the Oakland record from the same broker — both cannot be the subject's primary residence _(via indicia person)_
- `CONTRADICTION: 1110 Sample Ave is NOT linked to James Harker. The reverse-address lookup returned 31 records and the actual residents are the Keith and Plascencia families — Harker appears in none of them.` — the dossier's address claim does not survive the broker record _(via indicia address)_
- **6 artifacts** — harvested from a bulk corpus return — this one lookup yielded 67 person identities for a single selector, which is a dataset of many people rather than one person's record; appearing in that dataset is not linkage to the subject
  - `Gabriel G. Salas` _(via indicia address)_
  - `Esther Salas` _(via indicia address)_
  - `Gabriel Gilbert Gilbert Salas` _(via indicia address)_
  - `Michael O. Wong` _(via indicia address)_
  - `Sandra Salas` _(via indicia address)_
  - `67 unlinked identities — bulk corpus (gsalas916@icloud.com)` _(via indicia address)_

## Timeline Summary
- `2026-08-09T03:51:00.000Z` — **artifact** — staging.northgate-logistics.com _(via network recon)_
- `2026-08-09T03:51:00.000Z` — **artifact** — cdn.northgate-logistics.com _(via network recon)_
- `2026-08-09T03:51:00.000Z` — **artifact** — git.northgate-logistics.com _(via network recon)_
- `2026-08-09T03:51:00.000Z` — **artifact** — docs.northgate-logistics.com _(via network recon)_
- `2026-08-09T03:51:00.000Z` — **artifact** — status.northgate-logistics.com _(via network recon)_
- `2026-08-09T03:51:00.000Z` — **artifact** — smtp.northgate-logistics.com _(via network recon)_
- `2026-08-09T03:51:00.000Z` — **artifact** — ns1.northgate-logistics.com _(via network recon)_
- `2026-08-09T03:51:00.000Z` — **artifact** — ns2.northgate-logistics.com _(via network recon)_
- `2026-08-09T03:51:00.000Z` — **artifact** — legacy.northgate-logistics.com _(via network recon)_
- `2026-08-09T03:52:00.000Z` — **artifact** — Esther Salas _(via indicia address)_
- `2026-08-09T03:53:00.000Z` — **artifact** — Gabriel Gilbert Gilbert Salas _(via indicia address)_
- `2026-08-09T03:54:00.000Z` — **artifact** — 203.0.113.47 _(via oathnet)_
- `2026-08-09T03:54:00.000Z` — **artifact** — Michael O. Wong _(via indicia address)_
- `2026-08-09T03:55:00.000Z` — **artifact** — Sandra Salas _(via indicia address)_
- `2026-08-09T03:56:00.000Z` — **artifact** — 67 unlinked identities — bulk corpus (gsalas916@icloud.com) _(via indicia address)_

## Activity Log
_No message activity recorded._

## Tool Coverage Summary
- Running network reconnaissance — 14 results, 10 high-confidence, 4 need verification
- Analyst — Indicia Address — 11 results, 0 high-confidence, 10 need verification
- Deep-scanning credential signals — 10 results, 0 high-confidence, 9 need verification, 1 failed
- Analyst — Oathnet — 3 results, 0 high-confidence, 3 need verification
- Analyst — Hunter Verify — 2 results, 2 high-confidence, 0 need verification
- Analyst — Indicia Person — 2 results, 0 high-confidence, 0 need verification, 1 failed
- Analyst — Socialfetch — 2 results, 0 high-confidence, 0 need verification
- Analyst — Deepfind Reverse — 1 result, 1 high-confidence, 0 need verification
- Analyst — Indicia Footprint — 1 result, 0 high-confidence, 1 need verification
- Querying domain registration — 1 result, 1 high-confidence, 0 need verification
- Searching semantic web index — 1 result, 0 high-confidence, 0 need verification, 1 failed
- Analyst — Firecrawl Scrape — 1 result, 1 high-confidence, 0 need verification
- Sweeping platforms for handle matches — 1 result, 0 high-confidence, 1 need verification
- Analyst — Opencorporates — 1 result, 0 high-confidence, 0 need verification
- Running AI-assisted deep search — 1 result, 0 high-confidence, 1 need verification
- Analyst — Socialfetch Web Read — 1 result, 0 high-confidence, 1 need verification

## Weak Areas
- 27 items flagged as possible matches that need verification.
- 3 low-confidence leads — treat as leads, not findings.

## Recommended Next Steps
- **email** — consider: Reviewing restricted indicators, Checking linked avatar data, Verifying email deliverability, Evaluating sensitive-source indicators
- **username** — consider: Checking developer profile traces, Reviewing community activity history, Reviewing tech community footprint, Building targeted search queries
- **domain** — consider: Resolving DNS records, Enumerating certificate transparency, Enumerating domain-linked contacts, Scanning URL threat history
- **ip** — consider: Gathering IP intelligence, Fingerprinting exposed services
- **url** — consider: Fingerprinting web server, Archiving source for chain of custody, Searching archived page snapshots, Scanning URL threat history

## Source Appendix
- Running network reconnaissance — produced subdomain
- Analyst — Indicia Address — produced contradiction, name, bulk_corpus_harvest, email
- Deep-scanning credential signals — produced phone, email, ip_address
- Analyst — Oathnet — produced breach_exposure, ip, crypto_wallet
- Analyst — Hunter Verify — produced email
- Analyst — Indicia Person — produced location
- Analyst — Socialfetch — produced social_profile, username
- Analyst — Deepfind Reverse — produced username
- Analyst — Indicia Footprint — produced phone
- Querying domain registration — produced domain
- Searching semantic web index — produced email
- Analyst — Firecrawl Scrape — produced url
- Sweeping platforms for handle matches — produced social_profile
- Analyst — Opencorporates — produced organization
- Running AI-assisted deep search — produced event
- Analyst — Socialfetch Web Read — produced weak_lead

---
_All items are presented as observations from named sources. Wording such as "observed", "source indicates", "possible match", and "needs verification" is used deliberately. No identity claim should be treated as confirmed without independent corroboration._