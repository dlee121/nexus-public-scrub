# Content Publishing System — Ops Guide

## System Overview

```
Nexus Content Pipeline
├── 3 Niche WordPress Sites (money sites)
│   ├── ai-tools       — AI tools reviews & guides
│   ├── productivity   — Automation & productivity systems
│   └── saas           — SaaS reviews & comparisons
└── Medium             — Personal brand thought leadership
```

**Daily output target:** 3 SEO articles (1 per site) + 1 Medium article/week

---

## One-Time Setup

### 1. Deploy WordPress Sites

For each of the 3 sites, provision a VPS (Hetzner CX21 ~$5/mo recommended):

```bash
# SSH into VPS, then:
curl -sSL <raw-url-of-wp-deploy.sh> | sudo bash -s -- yourdomain.com wp_db wp_user wp_pass
```

After deploy, the script outputs your admin credentials. Save them.

In WP Admin → Users → Profile → Application Passwords:
- Create an app password named "Nexus"
- Copy the generated password

### 2. Configure Sites

Edit `config/content-sites.json` — replace all `PLACEHOLDER_*` values:

```json
"wordpress": {
  "url": "https://yourdomain.com",
  "username": "admin",
  "appPassword": "xxxx xxxx xxxx xxxx xxxx xxxx"
}
```

### 3. Configure Medium

1. Go to Medium → Settings → Security → Integration tokens
2. Generate a token, add to config:

```json
"medium": {
  "integrationToken": "your_token_here",
  "authorId": ""   // leave blank — auto-resolved on first publish
}
```

### 4. Install WordPress Theme

For each site, install GeneratePress (fast, SEO-friendly, minimal):

```bash
wp theme install generatepress --activate --path=/var/www/yourdomain.com --allow-root
```

Recommended plugins (already installed by deploy script):
- **Yoast SEO** — meta descriptions, sitemaps, focus keywords
- **W3 Total Cache** — performance
- **Wordfence** — security

---

## Daily Operations

### Fully Automated (Recommended)

Add to crontab on your Mac or server:

```bash
# Daily: write + publish 3 articles (8am ET)
0 8 * * * cd /Users/<user>/Nexus/core && bun scripts/content/pipeline.ts daily

# Weekly: write Medium article (Tuesday 9am)
0 9 * * 2 cd /Users/<user>/Nexus/core && bun scripts/content/pipeline.ts medium --write --publish
```

### Manual Commands

```bash
# Generate topic ideas for a site
bun scripts/content/pipeline.ts topics ai-tools --count=20
bun scripts/content/pipeline.ts topics productivity --count=20
bun scripts/content/pipeline.ts topics saas --count=20

# Write one article for a site
bun scripts/content/pipeline.ts write ai-tools

# Write for a specific keyword
bun scripts/content/pipeline.ts write ai-tools --topic="best AI writing tools 2026"

# Publish ready articles as DRAFTS (for your review before going live)
bun scripts/content/pipeline.ts publish --draft

# Publish ready articles LIVE
bun scripts/content/pipeline.ts publish

# Check queue status
bun scripts/content/pipeline.ts status

# Medium workflow
bun scripts/content/pipeline.ts medium --write          # write only
bun scripts/content/pipeline.ts medium --write --publish # write + publish as draft
```

---

## Supervision Model (Minimal Effort)

The pipeline publishes to **WordPress drafts** by default. Your supervision workflow:

1. **Monday morning (~10 min):** Check WP draft queue for all 3 sites. Skim titles and approve/tweak.
2. **Tuesday:** Check Medium draft. Polish intro/conclusion if needed, then publish.
3. **As needed:** Review queue stats with `pipeline.ts status`.

To go fully hands-off (auto-publish live without review), remove `--draft` from the cron job.

---

## Entity Responsibilities

| Entity | Role |
|--------|------|
| **Orchestrator** | Orchestrates pipeline, runs daily cron, monitors queue |
| **Engineer** | VPS setup, WP configuration, infrastructure issues |
| **Advisor** | Content strategy, keyword research direction, editorial review |
| **Monitor** | Monitors pipeline health, alerts on failures |

---

## Content Strategy

### Niche Site Article Types (Target Mix)

| Type | % of Output | Example |
|------|------------|---------|
| "Best X" listicles | 40% | "7 Best AI Writing Tools for Bloggers" |
| Comparisons (X vs Y) | 25% | "Zapier vs Make: Which Automation Tool Wins?" |
| How-To guides | 20% | "How to Set Up a Zettelkasten in Notion" |
| Deep reviews | 10% | "Jasper AI Review: Is It Worth $49/Month?" |
| News/trending | 5% | "What GPT-5 Means for Content Marketers" |

### Monetization

**Affiliate links:** Include naturally within articles. Each site has a list of affiliate programs in config. Link to tools mentioned in the article using affiliate URLs (add them manually to WP posts after publish, or add affiliate URL mapping to config later).

**Display ads:** Once sites hit 10k pageviews/month, apply to:
- Mediavine (25k sessions required) or
- Ezoic (no minimum) or
- Google AdSense (immediate, lower RPM)

### Internal Linking

Articles include `INTERNAL_LINK_PLACEHOLDER` anchors. After accumulating 10+ articles per site:
- Use a WP plugin like "Link Whisper" to automate internal linking
- Or manually update older articles to link to newer ones

### Medium Strategy

Publish 1 thought-leadership article per week. Topics:
- Building Nexus: architecture decisions, agent design
- AI agent patterns: real lessons from orchestration
- Entrepreneurship: systems thinking, operating leverage
- Predictions and takes on where AI is heading

Goal: build audience → newsletter → eventually product or consulting funnel.

---

## Costs

| Item | Cost/Mo |
|------|---------|
| 3x Hetzner CX21 VPS | ~$15 |
| 3x Domain names | ~$3 (amortized) |
| Claude API (articles) | ~$10-20 |
| Total | ~$30/mo |

---

## Scaling

When ready to scale:
- Increase `articlesPerDay` in config per site
- Add more seed keywords to improve topic diversity
- Add keyword difficulty scoring (via DataForSEO API) to prioritize easy wins
- Add image generation (DALL·E or Stability) for featured images
- Automate internal link resolution using a keyword→URL map in config
