# Canon roadmap

**English** · [Русский](roadmap.ru.md)

Canon already does what site builders like Tilda don't: a fact graph, an AI agent team, a
headless API, self-hosting, audit and SSO. The next phases bet on what will matter for websites in
the coming years: **a site has to be found and quoted by AI assistants, it has to be legally
sound, and it has to improve itself**.

## Phase 8 — Foundation ✅

- CI: every package is built before the integration tests; added linting (ESLint 9), Playwright E2E and Docker image builds.
- AGPL-3.0 license, with a source-code link in the admin.
- Images: API from 2.17 GB to 975 MB, migrate from 2.78 GB to 852 MB; admin, web and migrate verified by running them.
- Fixed: large uploads through presigned URLs (S3 rejected the signature), monthly partitions created by the worker role, the DNS-rebinding window in webhooks, a rules-of-hooks violation in site settings.
- Raw analytics retention (`ANALYTICS_RAW_RETENTION_MONTHS`); the audit trail is never dropped.
- A prompt evaluation suite on real models (`pnpm --filter @canon/api eval`).

## Phase 9 — Essentials ✅

- **Forms**: a form block with a field builder and templates; submissions checked by a honeypot, timing and heuristics, with AI deciding the doubtful ones; IPs shortened before storage; an inbox with statuses, CSV export (formula-injection safe) and erasure; delivery by e-mail, in-app notifications, `form.submitted` webhooks and Slack. Works without JavaScript.
- **Notification center**: a bell with the unread count, a full inbox, and per-type e-mail preferences (instant, daily digest, off). Billing, webhooks, Canon branches, reviews, mentions and domains all notify through it.
- **Custom domains**: a claim is pending until a DNS TXT record proves control; only verified domains are served and get certificates (Caddy on-demand TLS asks `GET /v1/tls/ask`). Daily re-checks warn owners and release a domain after 7 days without proof. Verified hostnames are unique across workspaces; unproven claims block nobody.
- **Review workflow**: ask for review of an exact draft version, approve or request changes (four-eyes: never your own request), a review queue per site, and comments anchored to blocks with @mentions and resolvable threads. With “Require review before publishing” any edit after approval makes it stale; owners and admins can override, and the override is audited. Scheduled publishes refuse to ship edits made after approval.
- **Admin in English and Russian**: dictionaries with plural rules, the choice saved to the profile (`PATCH /v1/auth/me`). Translated now: navigation, sign-in and sign-up, the dashboard, notifications, forms, reviews, domains and SCIM; the remaining screens follow.
- **`@canon/sdk`**: a typed client generated from the OpenAPI document. The document now describes 97 request bodies from the Zod schemas the API validates with. MIT-licensed so it can be embedded in any frontend.
- **SCIM 2.0** (`/scim/v2`, Enterprise): Users with filters, PATCH in both the Okta and Entra styles, roles through a Canon extension attribute, deprovisioning that ends access at once; only e-mails on verified SSO domains, and the last owner can never be removed.

## Phase 10 — What no other CMS does

1. **AI search visibility (GEO).** People increasingly ask ChatGPT, Perplexity or Alice instead of a search engine. Canon generates `llms.txt` and schema.org markup straight from the facts (plans, FAQ, organization). It shows which AI bots read which pages and scores how ready a page is to become an answer, with concrete fixes.
2. **Living facts.** Facts sync from the sources of truth: prices from Stripe or YooKassa, Google Sheets, a JSON/CSV URL, a 1C export. When the price changes in billing, a minute later every page in every language has been rewritten and is waiting for approval. Expiry reminders included ("the promo ends tomorrow").
3. **Brand and legal guard.** Workspace rules: tone, forbidden promises, mandatory disclaimers, advertising-law checks ("best", "#1" without proof, medical and financial promises). Checked on every save; a violation blocks publishing and suggests a corrected text.
4. **Site time machine.** Any page as of any date, with snapshots signed in a hash chain like the audit log. It answers "what did we promise customers on 3 March?" with evidence for disputes and regulators.
5. **Growth autopilot.** Once a week an agent reads the analytics, forms hypotheses, prepares A/B variants, starts the tests once approved, and reports winners to Telegram or e-mail.
6. **One-click migration** from Tilda, WordPress and Webflow: Canon crawls the site and AI maps its sections onto Canon blocks. It extracts facts and media, keeps URLs and sets up redirects.
7. **Omnichannel.** The same entries are published to the site, a Telegram channel, VK and a newsletter, and the facts stay consistent everywhere.
8. **Accessibility and speed autopilot.** WCAG checks on publish (contrast, alt text, headings) with automatic fixes, and a Core Web Vitals budget per page.

## Phase 11 — Russia and the world

- **YooKassa** (and CloudPayments) alongside Stripe — for subscriptions and for price facts.
- **GigaChat and YandexGPT** in the AI gateway next to Anthropic, OpenAI, Google and local models.
- **Yandex Metrica and Webmaster**: their data in reports and AI recommendations.
- **152-FZ**: a guide to deploying on Russian clouds (Yandex Cloud, Selectel), and a per-workspace choice of data region.
- Documentation in Russian.

## How Canon differs

- **Tilda and similar builders** are closed SaaS. The site lives only on their platform, there is no headless API for your own frontends, it cannot be self-hosted, and AI is limited to generating text. Canon makes facts the source of truth, keeps the site current with agents, and adds AGPL self-hosting, audit, SSO and an API.
- **Headless CMSs (Contentful, Strapi, Sanity)** provide an API, but no visual builder for marketing, and nothing that keeps the site truthful. Canon has both out of the box.
- **Across all of them**, nobody prepares a site to be quoted by AI assistants, ties copy to its sources of truth, or keeps a legally meaningful history of what was published. That is the focus of phases 10 and 11.
