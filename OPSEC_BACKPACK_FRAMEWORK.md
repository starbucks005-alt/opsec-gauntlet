# OPSEC Gauntlet — MCP Backpack Framework

**For:** Claude Code · **Owner:** Dr. Terry L. Oroszi · **Generated:** 2026-06-13
**Machine-readable spec:** `config/opsec-backpacks.json`.

## What this is

The 16 OPSEC Gauntlet sector judges plus the OPSEC specialist offices each carry a **backpack**: a portable, read-only live-tool capability that travels with the character.

## Intake flow

**Host:** Iris S. King hosts the Corridor. Her welcome panel sits at the top of the Corridor landing page in her own voice and register: she orients the visitor, explains what the Corridor is, and surfaces the OSINT option as a natural aside (not a banner or separate system prompt). Her card stays in the grid as a link to her full office, but her landing-page presence is the greeter role.

**Order:** Iris S. King (host / greets at intake) -> Ms. Ivy (Concept Integrity) -> Dr. Sahini Rao (Dual-Use Systems, second stop) -> corridor specialist offices (Structure/Alicia James, Legal/Kimberly Pass, Human Factors/Sasha Moreno, Financial/Leo Vance, Risk Discipline/Rowan Tate, Discovery/Jax Rivera, Visual/Yuki Mendel) -> 16 sector judges -> Dr. Ali Malik (OSINT, final desk) -> consolidated findings.

> Iris's aside: "One thing before you start: Dr. Malik at the end of the corridor runs a live search on whoever is presenting. It takes a few minutes. If you want it, give him the name now and he will have results waiting by the time you get there."

- **Opt-in gate:** Inline beneath Iris's welcome: Ali Malik's subject-identifier form, collapsed by default. Expand -> provide the name -> submit -> confirmation that Ali is running. Skip -> proceed to Ms. Ivy with no friction.
- **Ali's office:** Ali Malik's office page has no gate; it opens straight to the flanking layout. If the visitor submitted through Iris, the brief panel is pre-populated with the subject dossier. If they skipped, the brief panel placeholder prompts them to enter the subject there.
- Ali Malik runs asynchronously from the moment of opt-in at intake so his exposure map is ready when the visitor reaches the final desk.

## Reasoning-only offices (intentionally backpack-less)

- Iris S. King (Frontline Communications / host) — comms and intake judgement; no live-data backpack.
- Sasha Moreno (Human Factors & Insider Risk) — role/access/culture analysis; judgement, no live backpack.
- Rowan Tate (Risk Discipline & Guardrails) — converts intentions into rules; judgement, no live backpack.
- Yuki Mendel (Visual Surface) — brand/visual-leakage review; judgement, no live backpack.
- _Deferred:_ Leo Vance (Financial Exposure) — fragility analysis is largely reasoning; revisit only if live financial-exposure data is wanted.

_These offices are intentionally backpack-less, not missing. Home-platform MCP tools (where any) are out of scope for OPSEC and are not invoked at the OPSEC desk._

## Design rules

- Traveling characters carry their own backpack: the tools below belong to the judge, not to a single site framework.
- Read-only. No write, no transaction, no actuation against any real system.
- Public and open sources only: government registries, regulator data, standards bodies. No classified, proprietary, or personal data.
- Backpacks are advisory: they return regulatory, safety, and resilience CONTEXT, never operational attack detail.
- Until backpack_shipped flips true, the judge runs on static sector knowledge; the price holds at 89.99 either way.

## Global guardrails (apply to everyone)

- Provide only regulatory, safety, and resilience context.
- Never provide synthesis, exploit, intrusion, sabotage, or weaponization detail.
- Never identify specific exploitable weaknesses, soft targets, or protected locations.
- Never handle classified, proprietary, or personal data.
- Any request that resembles causing harm is refused and escalated, not answered.

## Escalation policy

**On trigger:** Stop the sector analysis, refuse the operational detail, and return an escalation notice to the OPSEC Gauntlet intake (Iris S. King / Office of Frontline Communications) for human review.

**Shared triggers:** weaponization, sabotage, bypassing controls or sanctions, unauthorized access, harm to people or critical infrastructure.

## Currency policy

CBRN and export-control sources are a mix of live feeds and versioned lists. Most control lists update only at regime plenaries or via Federal Register rules, so they must be re-pulled on a cadence, not assumed static.

- **Live:** WHO Disease Outbreak News, CDC HAN, IAEA ITDB, BIS Federal Register rule changes, Consolidated Screening List, NRC ADAMS.
- **Refresh after:** Australia Group / NSG / MTCR / Wassenaar plenary updates, OPCW Annex changes, Federal Select Agent list revisions, ODNI annual threat assessment release.
- **Cadence:** Weekly for live feeds; re-validate versioned control lists monthly and immediately after any regime plenary or Federal Register amendment.

## Legend

- `dataset_api` — Live queryable government/regulator dataset.
- `reference_api` — Live but used as reference context, not monitoring.
- `reference` — Static standards/regulatory document corpus.
- `live_feed` — Continuously updated public feed (e.g., outbreak/alert notices).
- auth `none` — No credential.
- auth `api_key` — Free API key required.
- auth `api_key_optional` — Key raises rate limits.
- auth `app_token_optional` — Socrata app token optional.

## The 16 sector judges and their backpacks

### Dr. Helena Ward — Chemical
*Chemical Security & Hazard Mitigation Director* · tier `board_level` · $89.99/mo · `id: helena-ward` · CISA sector: Chemical

| Capability | Source | Type | Auth |
|---|---|---|---|
| Chemical facility risk lookup | EPA RMP*Info via Envirofacts REST API | dataset_api | none |
| Toxic release / chemical inventory | EPA Toxics Release Inventory (TRI) Envirofacts API | dataset_api | none |
| Hazard classification reference | OSHA Hazard Communication (GHS) + PubChem GHS | reference_api | none |
| Precursor chemical reference | DEA Diversion Control List I / List II (public lists) | reference | none |
| Hazmat shipping rules | PHMSA 49 CFR HMR + public incident data | reference_api | none |

**Guardrails:** Never gives synthesis instructions; Never provides quantities, ratios, or reaction steps; Only describes regulatory and safety context; Escalates any question that resembles weaponization.

### Col. Rafael "Rafe" Dominguez (Ret.) — Defense Industrial Base
*Defense Supply-Chain Integrity Analyst* · tier `board_level` · $89.99/mo · `id: rafael-dominguez` · CISA sector: Defense Industrial Base

| Capability | Source | Type | Auth |
|---|---|---|---|
| Defense supplier verification | SAM.gov Entity Management API (entity + CAGE) | dataset_api | api_key |
| Contract history | USAspending.gov Award API | dataset_api | none |
| Screening / foreign-influence | trade.gov Consolidated Screening List API + BIS Entity List | dataset_api | api_key |
| Export-control reference | eCFR EAR (15 CFR 730-774) + ITAR (22 CFR 120-130) | reference | none |
| Counterfeit-parts reference | CISA / GAO counterfeit-component guidance (public) | reference | none |

**Guardrails:** Never provides procurement shortcuts; Never identifies classified vendors; Never advises bypassing export controls; Escalates anything involving weapons design.

### Dr. Liyun Zhao — Communications
*Network Resilience Architect* · tier `board_level` · $89.99/mo · `id: liyun-zhao` · CISA sector: Communications

| Capability | Source | Type | Auth |
|---|---|---|---|
| Telecom license / facility lookup | FCC License View + ULS + Antenna Structure Registration | dataset_api | none |
| Routing / BGP anomaly | RIPEstat Data API | dataset_api | none |
| Route redundancy / peering | RouteViews + PeeringDB (public) | reference_api | none |
| Outage reference | FCC NORS public summaries + ECFS | reference | none |
| Spectrum / interference reference | FCC Spectrum Dashboard | reference | none |

**Guardrails:** Never provides signal-jamming instructions; Never maps private fiber routes; Never provides exploit code for telecom systems; Escalates any request to degrade communications.

### Miles Harrington — Financial Services
*Financial-Systems Threat Analyst* · tier `board_level` · $89.99/mo · `id: miles-harrington` · CISA sector: Financial Services

| Capability | Source | Type | Auth |
|---|---|---|---|
| Sanctions screening | OFAC Sanctions List Search / SDN API (Treasury) | dataset_api | none |
| Institution verification | FFIEC NIC API + NMLS Consumer Access | dataset_api | none |
| Filings / disclosures | SEC EDGAR full-text + submissions API | dataset_api | none |
| Fraud-pattern reference | FinCEN advisories + FTC/CFPB public complaint data | reference_api | none |
| Fintech-vendor risk | Public breach + enforcement records (cross-ref CISA KEV, FTC actions) | reference | none |

**Guardrails:** Never advises evading AML controls; Never provides laundering patterns; Never touches personal financial data; Escalates any request to bypass sanctions.

### Dr. Amina Farouk — Healthcare & Public Health
*Medical Infrastructure Continuity Specialist* · tier `board_level` · $89.99/mo · `id: amina-farouk` · CISA sector: Healthcare and Public Health

| Capability | Source | Type | Auth |
|---|---|---|---|
| Device recall / enforcement | openFDA device recall + enforcement API | dataset_api | api_key_optional |
| Outbreak / health alerts | CDC data.cdc.gov + Health Alert Network (HAN) | dataset_api | app_token_optional |
| Drug / supply shortage | FDA Drug Shortages API | dataset_api | none |
| Sector advisory reference | HHS HC3 / HPH sector advisories | reference | none |
| Cold-chain reference | CDC Vaccine Storage & Handling Toolkit | reference | none |

**Guardrails:** Never provides medical diagnosis; Never gives treatment plans; Never shares patient data; Escalates anything resembling biological misuse.

### Jonas McCrae — Emergency Services
*Incident-Command Systems Advisor* · tier `board_level` · $89.99/mo · `id: jonas-mccrae` · CISA sector: Emergency Services

| Capability | Source | Type | Auth |
|---|---|---|---|
| Disaster / declaration data | OpenFEMA API (declarations, IPAWS) | dataset_api | none |
| Weather / hazard alerts | NWS api.weather.gov | dataset_api | none |
| Geohazard feeds | USGS earthquake + hazard feeds | dataset_api | none |
| ICS / NIMS reference | FEMA NIMS doctrine + ICS forms library | reference | none |
| Dispatch / continuity reference | CISA SAFECOM + FCC NG911 resources | reference | none |

**Guardrails:** Never provides tactical response plans; Never gives instructions to exploit emergency systems; Never simulates real-time emergency routing; Escalates any request to disrupt emergency services.

### Dr. Priyanka "Pri" Nanduri — Energy
*Grid Stability & SCADA Security Engineer* · tier `board_level` · $89.99/mo · `id: priyanka-nanduri` · CISA sector: Energy

| Capability | Source | Type | Auth |
|---|---|---|---|
| Energy / load data | EIA Open Data API | dataset_api | api_key |
| Disturbance reporting | DOE OE-417 public electric disturbance reports | reference | none |
| Reliability standards | NERC CIP reliability standards (public) | reference | none |
| ICS advisory feed | CISA ICS Advisories (ICS-CERT) | dataset_api | none |
| Market / demand reference | EIA + FERC public market data | reference_api | none |

**Guardrails:** Never provides exploit code; Never maps real substation vulnerabilities; Never simulates grid-attack scenarios; Escalates any request to degrade energy systems.

### Elias "Eli" Kade — Water & Wastewater Systems
*Water-System Integrity Analyst* · tier `board_level` · $89.99/mo · `id: elias-kade` · CISA sector: Water and Wastewater Systems

| Capability | Source | Type | Auth |
|---|---|---|---|
| Drinking-water system lookup | EPA SDWIS via Envirofacts API | dataset_api | none |
| Compliance / enforcement | EPA ECHO API | dataset_api | none |
| Flow / reservoir data | USGS Water Services / NWIS | dataset_api | none |
| Sector advisory feed | CISA Water & Wastewater sector advisories | dataset_api | none |
| Contaminant reference | EPA CCL + NPDWR + health advisories | reference | none |

**Guardrails:** Never provides contamination instructions; Never identifies exploitable plant weaknesses; Never simulates water-system failures; Escalates any request involving water sabotage.

### Dr. Mirela Stanescu — Transportation Systems
*Transportation Threat & Infrastructure Analyst* · tier `board_level` · $89.99/mo · `id: mirela-stanescu` · CISA sector: Transportation Systems

| Capability | Source | Type | Auth |
|---|---|---|---|
| Aviation status | FAA NOTAM API + ASWS + airport facility data | dataset_api | api_key |
| Rail safety data | FRA Office of Safety Analysis | dataset_api | none |
| Port / freight stats | MARAD + USACE port statistics + BTS TranStats | dataset_api | none |
| Maritime reference | NOAA marine + public AIS reference | reference | none |
| Security reference | DOT/TSA public security guidance | reference | none |

**Guardrails:** Never provides routing to bypass security; Never identifies soft targets; Never simulates transportation disruption; Escalates any request involving harm to transit systems.

### Gunnar Thorsen — Critical Manufacturing
*Industrial-Process Security Auditor* · tier `board_level` · $89.99/mo · `id: gunnar-thorsen` · CISA sector: Critical Manufacturing

| Capability | Source | Type | Auth |
|---|---|---|---|
| ICS advisory feed | CISA ICS Advisories + ICS-CERT | dataset_api | none |
| Vulnerability lookup | NIST NVD/CVE API (ICS/OT filter) | dataset_api | none |
| OSHA compliance | OSHA Establishment Search + enforcement API | dataset_api | none |
| Vendor PSIRT reference | Siemens / Rockwell / public PSIRT bulletins | reference | none |
| Component provenance | SAM.gov + Consolidated Screening List | dataset_api | api_key |

**Guardrails:** Never provides exploit code for industrial systems; Never identifies specific factory weaknesses; Never gives sabotage instructions; Escalates any request to disrupt manufacturing lines.

### Dr. Selah Okonjo — Food & Agriculture
*Ag-Supply Chain & Biosecurity Specialist* · tier `board_level` · $89.99/mo · `id: selah-okonjo` · CISA sector: Food and Agriculture

| Capability | Source | Type | Auth |
|---|---|---|---|
| Animal / plant disease alerts | USDA APHIS disease alerts (public) | dataset_api | none |
| Food recall / enforcement | USDA FSIS + openFDA food enforcement API | dataset_api | api_key_optional |
| Ag statistics | USDA NASS Quick Stats API | dataset_api | api_key |
| Foodborne outbreak data | CDC FoodNet / outbreak surveillance | dataset_api | none |
| Pesticide / cold-chain reference | EPA pesticide registry + cold-chain standards | reference | none |

**Guardrails:** Never provides pathogen-handling instructions; Never gives contamination vectors; Never simulates crop or livestock failure; Escalates any request involving food-system harm.

### Victor Hale — Government Facilities
*Physical Security & Insider-Threat Advisor* · tier `board_level` · $89.99/mo · `id: victor-hale` · CISA sector: Government Facilities

| Capability | Source | Type | Auth |
|---|---|---|---|
| Physical-security standards | ISC (Interagency Security Committee) standards | reference | none |
| Insider-threat reference | CISA + NITTF public insider-threat resources | reference | none |
| Facility registry | GSA public buildings (IOLP) data | dataset_api | none |
| Advisory feed | CISA physical-security advisories | dataset_api | none |
| Access-control reference | FSL methodology + FPS public guidance | reference | none |

**Guardrails:** Never provides bypass instructions; Never maps secure-facility layouts; Never identifies guard rotations or weak points; Escalates any request involving unauthorized access.

### Dr. Yara Ben-Saïd — Nuclear Reactors, Materials & Waste
*Nuclear-Materials Safeguards Analyst* · tier `board_level` · $89.99/mo · `id: yara-ben-said` · CISA sector: Nuclear Reactors, Materials, and Waste

| Capability | Source | Type | Auth |
|---|---|---|---|
| License / document lookup | NRC ADAMS + license & facility lookup | dataset_api | none |
| Event reports | NRC Event Notification Reports | dataset_api | none |
| Safeguards reference | IAEA safeguards + INFCIRC documents | reference | none |
| Transport reference | DOT 49 CFR radiological transport rules | reference | none |
| Material-accounting reference | NRC 10 CFR 74 material-control & accounting | reference | none |

**Guardrails:** Never provides enrichment or reactor instructions; Never identifies nuclear-material locations; Never simulates radiological dispersal; Escalates any request involving nuclear misuse.

### Owen Kessler — Information Technology
*Enterprise Cyber & Zero-Trust Architect* · tier `board_level` · $89.99/mo · `id: owen-kessler` · CISA sector: Information Technology

| Capability | Source | Type | Auth |
|---|---|---|---|
| Vulnerability lookup | NIST NVD/CVE API | dataset_api | none |
| Exploited-vuln catalog | CISA Known Exploited Vulnerabilities (KEV) | dataset_api | none |
| Breach-exposure data | Have I Been Pwned (HIBP) API | dataset_api | api_key |
| Framework reference | MITRE ATT&CK + NIST 800-207 (zero trust) + 800-53 | reference | none |
| Advisory feed | CISA cybersecurity advisories + bulletins | dataset_api | none |

**Guardrails:** Never provides exploit code; Never gives step-by-step intrusion guidance; Never scans real networks; Escalates any request to compromise systems.

### Dr. Marisol Quintero — Dams
*Hydrologic & Structural-Risk Engineer* · tier `board_level` · $89.99/mo · `id: marisol-quintero` · CISA sector: Dams

| Capability | Source | Type | Auth |
|---|---|---|---|
| Dam inventory | USACE National Inventory of Dams (NID) API | dataset_api | none |
| Streamflow data | USGS NWIS / Water Services | dataset_api | none |
| Flood forecast | NOAA/NWS AHPS flood forecasts | dataset_api | none |
| Dam-safety reference | FEMA National Dam Safety Program + hazard classification | reference | none |
| Emergency-action reference | FEMA P-64 Emergency Action Plan guidance | reference | none |

**Guardrails:** Never provides breach modeling; Never identifies structural weak points; Never simulates destructive water release; Escalates any request involving dam sabotage.

### Soren Veldt — Commercial Facilities
*High-Risk Venue Security Strategist* · tier `board_level` · $89.99/mo · `id: soren-veldt` · CISA sector: Commercial Facilities

| Capability | Source | Type | Auth |
|---|---|---|---|
| Sector resources | CISA Commercial Facilities + Soft Targets/Crowded Places | reference | none |
| Venue best-practice reference | DHS SAFETY Act + venue security guidance | reference | none |
| Crowd-management standards | NFPA 101 + crowd-management standards | reference | none |
| Access / surveillance reference | Access-control + CCTV best-practice guidance | reference | none |
| Incident reference | Public venue-incident / threat reference | reference | none |

**Guardrails:** Never provides attack modeling; Never identifies soft targets; Never maps blind spots in surveillance; Escalates any request involving harm to public venues.

## OPSEC specialist offices

### Ms. Ivy (Ivy Sinclair) — Office of Concept Integrity (first stop)
*Concept Integrity / SLR Gap-Finder* · tier `specialty_hire` · $69.99/mo · `id: ms-ivy-ivy-sinclair` · Office of Concept Integrity (first stop) · cross-platform (home: The Dose / The Gauntlet)

_Run the SLR Method on a concept before it enters OPSEC review: find prior art, missing components, and unsupported assumptions, and produce a gap map._

**Academic literature**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Scholarly corpus | OpenAlex + Crossref + Semantic Scholar | dataset_api | live |
| Biomedical literature | PubMed / PMC (NCBI E-utilities) | dataset_api | live |
| Preprints | arXiv + bioRxiv / medRxiv | dataset_api | live |

**Prior art & patents**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Patent corpus / prior art | USPTO PatentsView + Google Patents Public Data | dataset_api | live |

**Clinical & evidence**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Clinical evidence | ClinicalTrials.gov API | dataset_api | live |

**Method**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Gap-finding method | SLR Studio systematic-review methodology | reference | versioned |

**Guardrails:** Maps evidence, prior art, and gaps; never fabricates a citation or source.; Flags unsupported claims and assumptions rather than filling them in.; Labels preprints and non-peer-reviewed sources as such.; Does not evaluate operational security; routes that to the OPSEC offices..

### Dr. Sahini Rao — Office of Dual Use Systems Analysis (second stop)
*Dual-Use Technology & Systems Analyst* · tier `specialty_hire` · $69.99/mo · `id: sahini-rao` · Office of Dual Use Systems Analysis (second stop)

_Determine whether an idea touches controlled CBRN or national-security dual-use territory, classify it against the authoritative control regimes, and surface current threat-awareness context, so the concept can be routed and mitigated. Classification and awareness only._

**Chemical**

| Capability | Source | Type | Currency |
|---|---|---|---|
| CWC scheduled chemicals (Sched 1/2/3) | OPCW — Chemical Weapons Convention Annex on Chemicals | reference | versioned |
| Chemical-weapons precursors + dual-use production equipment | Australia Group chemical control lists | reference | versioned (AG plenary) |
| Chemicals of interest / facility risk | CISA Chemicals of Interest (CFATS Appendix A) + ATSDR agent data | reference | versioned |

**Biological**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Select agents & toxins | HHS/USDA Federal Select Agent Program list | reference | versioned (Federal Register) |
| Biological agents, toxins & dual-use equipment | Australia Group biological control lists | reference | versioned (AG plenary) |
| Gene-synthesis screening standard | IGSC Harmonized Screening Protocol + HHS synthetic-nucleic-acid screening guidance | reference | versioned |
| Current outbreak / IHR events | WHO Disease Outbreak News + CDC Health Alert Network (HAN) | live_feed | live |
| Biological Weapons Convention reference | UNODA BWC + implementation guidance | reference | versioned |

**Radiological/Nuclear**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Nuclear & nuclear-dual-use items | Nuclear Suppliers Group Trigger List + Dual-Use List | reference | versioned (NSG plenary) |
| Sealed-source security categories | IAEA Code of Conduct (Category 1-2) + NRC source security | reference | versioned |
| Illicit trafficking awareness | IAEA Incident and Trafficking Database (ITDB) public summaries | reference | live |
| Licensing / safeguards | NRC license & ADAMS lookup + IAEA INFCIRC safeguards | dataset_api | live/versioned |

**Delivery Systems**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Missile, UAV & delivery technology | Missile Technology Control Regime (MTCR) Annex Cat I/II | reference | versioned (MTCR plenary) |

**Cross-cutting controls**

| Capability | Source | Type | Currency |
|---|---|---|---|
| US dual-use commodity classification | BIS Commerce Control List / EAR (15 CFR 774) + Federal Register rule updates | dataset_api | live (rule changes) |
| Defense-article crossover | ITAR US Munitions List (22 CFR 121) | reference | versioned |
| Conventional + dual-use list | Wassenaar Arrangement dual-use & munitions lists | reference | versioned (WA plenary) |
| Restricted-party screening | BIS Entity List + trade.gov Consolidated Screening List | dataset_api | live |
| WMD nonproliferation obligations | UN Security Council 1540 Committee + UN sanctions | reference | versioned |

**Threat awareness**

| Capability | Source | Type | Currency |
|---|---|---|---|
| National threat assessment | ODNI Annual Threat Assessment + public NCTC/DNI products | reference | annual/current |
| Policy & analysis reference | CRS + GAO CBRN / nonproliferation reports + CISA advisories | reference | current |
| Adversarial reinterpretation | MITRE ATT&CK + MITRE ATLAS | reference | current |
| AI-enabled uplift framing | NIST AI Risk Management Framework + GenAI profile | reference | versioned |

**Research security**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Federal research-security program requirements | NSPM-33 + OSTP research-security implementation guidance | reference | versioned |
| Funder disclosure & foreign-influence rules | NIH (foreign component / FCOI) + NSF research-security policies | reference | current |
| Dual-use research of concern oversight | US Policy for Oversight of DURC + P3CO (2024 unified policy) | reference | versioned |
| Controlled unclassified information | NARA CUI program (32 CFR 2002) + NIST SP 800-171 | reference | versioned |
| Academic export-control posture | EAR/ITAR fundamental-research exclusion + deemed-export rules | reference | versioned |
| Foreign investment / influence review | CFIUS reference + institutional foreign-gift (Section 117) reporting | reference | current |

**Guardrails:** Provides only control-status, regulatory classification, threat-awareness context, and mitigation framing.; Never provides synthesis, production, acquisition, enhancement, or weaponization detail for any chemical, biological, radiological, or nuclear material.; Never identifies acquisition sources, facility vulnerabilities, or specific exploitable pathways.; Treats any request that seeks CBRN or WMD uplift as an immediate refusal and escalation.; Read-only official and public sources only; no classified, proprietary, or personal data..

### Alicia James — Office of Structure and Compliance
*Structure & Compliance* · tier `core_six_pack` · $199/mo · `id: alicia-james` · Office of Structure and Compliance · cross-platform (home: Founder Studio)

_Check whether the idea's legal entity, registrations, and filings match the real activity, and flag where structure creates exposure._

**Federal registration**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Entity & CAGE verification | SAM.gov Entity Management API | dataset_api | live |

**Corporate disclosure**

| Capability | Source | Type | Currency |
|---|---|---|---|
| SEC filings | SEC EDGAR submissions + full-text | dataset_api | live |
| Nonprofit / EIN reference | IRS Tax Exempt Organization Search | dataset_api | live |

**State filings**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Business registries | Secretary-of-State registries + OpenCorporates | dataset_api | live |

**Liens & awards**

| Capability | Source | Type | Currency |
|---|---|---|---|
| UCC lien search | State UCC (Article 9) filing systems | dataset_api | live |
| Federal award history | USAspending API | dataset_api | live |

**Guardrails:** Verifies registration and structure status; flags mismatch between the entity and the real activity.; Provides structural and compliance information, not legal advice; routes legal questions to the Legal Surface office or a licensed attorney.; Reads public filings only; never submits, alters, or files anything.; Never handles personal financial or tax-return data..

### Kimberly Pass — Office of Legal Surface Review
*Legal Surface Review* · tier `core_six_pack` · $199/mo · `id: kimberly-pass` · Office of Legal Surface Review · cross-platform (home: Founder Studio)

_Map where the idea intersects regulations, terms, and processes that create exposure, and where a licensed attorney is required. Information, not legal advice._

**Regulations**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Federal regulations | eCFR (Electronic Code of Federal Regulations) API | dataset_api | live |
| Export-control regs | EAR + ITAR via eCFR | reference | versioned |

**Rulemaking & statute**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Rules & notices | Federal Register API | dataset_api | live |
| Statutes & bills | Congress.gov + GovInfo | dataset_api | live |

**Guidance**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Cyber / infrastructure guidance | CISA advisories and guidance | reference | current |

**Case law**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Court records | CourtListener / RECAP | dataset_api | live |

**Guardrails:** Provides general legal information, never legal advice, and says so.; Maps which questions require a licensed attorney rather than answering them.; Never represents itself as counsel or creates an attorney-client relationship.; On export-control or CBRN-adjacent questions, coordinates with Dr. Rao and escalates..

### Dr. Ali Malik — National OSINT, OPSEC Gauntlet
*National OSINT Subject-Matter Expert* · tier `specialty_hire` · $69.99/mo · `id: ali-malik` · National OSINT, OPSEC Gauntlet

_Map what an adversary can learn about a participant or organization from open sources alone, then show what to close. Exposure mapping only._

**Workflow**

- Final desk at the end of the corridor, after Iris greets, Ivy, Rao, the specialist offices, and the sector judges.
- Surfaced by Iris as a natural aside on the Corridor landing page (collapsed identifier form), not at his desk.
- If accepted, the sweep starts at opt-in and runs in the background while the participant walks the other offices, so results are ready by the time they reach his desk. He needs the lead time; do not run it on-demand at the desk.
- His office opens straight to the flanking layout (no gate). Brief panel is pre-populated if the visitor opted in via Iris, otherwise it prompts for the subject.

**Data handling.** Nothing found stays on the net or with ETL. The sweep only reads what is already public, never republishes or indexes it, and ETL retains none of it after your session.

- Reads public sources only; never posts, indexes, mirrors, or otherwise creates new exposure.
- Findings live only for the participant's review and are purged after the deliverable is produced; ETL stores nothing.
- Results are shown only to the participant, never shared or sold.
- Implement as an ephemeral, auto-purging store scoped to the session; retention must be enforced in code, not by policy alone.

**Digital footprint**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Domain registration / WHOIS | ICANN RDAP + WHOIS | dataset_api | live |
| DNS & certificate transparency | Public DNS + crt.sh certificate logs | dataset_api | live |
| Historical web | Internet Archive Wayback Machine | dataset_api | live |

**Infrastructure exposure**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Internet-exposed assets | Shodan + Censys | dataset_api | live |
| Breach / credential exposure | Have I Been Pwned | dataset_api | live |

**Entity & corporate**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Corporate registries | OpenCorporates + SEC EDGAR | dataset_api | live |
| Federal footprint | SAM.gov + USAspending | dataset_api | live |
| Sanctions & PEP | OFAC + OpenSanctions | dataset_api | live |

**Geospatial & transit**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Mapping | OpenStreetMap (Nominatim / Overpass) | dataset_api | live |
| Open satellite imagery | Copernicus / Sentinel open data | dataset_api | live |
| Flight tracking | OpenSky Network (ADS-B) | dataset_api | live |

**Media & events**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Global events / news | GDELT Project | dataset_api | live |

**Records**

| Capability | Source | Type | Currency |
|---|---|---|---|
| Court records | CourtListener / RECAP | dataset_api | live |
| Patents & IP | USPTO PatentsView | dataset_api | live |

**Guardrails:** Aggregates only public, open-source information.; Maps the participant's own exposure or an organization's footprint; never builds a targeting or surveillance package on a private individual.; Never deanonymizes, locates, or profiles a person for harm.; Refuses and escalates any request that resembles stalking, doxxing, or targeting.; Read-only public sources only; no intrusion and no credential use..
