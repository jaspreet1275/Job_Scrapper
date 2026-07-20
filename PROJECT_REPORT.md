# Job Scraper AI Dashboard - Project Report
**Date:** 16 April 2026  
**Project Name:** Job Scraper AI Dashboard  
**Tech Stack:** Next.js 16.2.3, React 19, TypeScript, Tailwind CSS 4  
**Status:** In Development

---

## 1. Project Overview

Job Scraper AI Dashboard is a web-based application that scrapes job listings from multiple platforms (Indeed, LinkedIn, Upwork), filters them using AI, and provides features to save and export job data to Excel. The goal is to automate the job search process across multiple platforms from a single dashboard.

---

## 2. Work Completed

### 2.1 Dashboard UI (Frontend)
- Built responsive dark-themed dashboard with sidebar navigation
- **Sidebar** with Job Search and Saved Jobs pages
- **Multi-select dropdown** for Platform selection with Select All / Clear All buttons
- **Multi-select dropdown** for Job Role selection (Python Developer, Laravel Developer, Web Designer, Data Scientist, Data Analyst, React Developer, Node.js Developer, Full Stack Developer, AI/ML Engineer, DevOps Engineer)
- **Checkbox dropdown** for Filters (Remote only, Budget $500+, Entry level, Full time, Part time, Freelance)
- Selected items displayed as chips with remove button
- Top bar showing active page and selection summary

### 2.2 Job Search - Multi Platform Scraping
- **Indeed:** Using `misceres~indeed-scraper` Apify actor
  - Keyword search working
  - Sort by date enabled
  - Last 24 hours filter (`fromage: "1"`)
  - Returns: title, company, salary, location, job type, URL, posted date
  - Status: **Working**

- **LinkedIn:** Using `curious_coder~linkedin-jobs-scraper` Apify actor
  - Keyword search working
  - Sort by newest (`sortBy=DD`)
  - Last 24 hours filter (`f_TPR=r86400`)
  - Supports remote, experience level, job type filters
  - Returns: title, company, location, job type, URL, posted date, skills
  - Status: **Working**

- **Upwork:** Using `getdataforme~upwork-actor` Apify actor
  - Keyword search works (finds correct jobs)
  - Actor has hardcoded 5-hour time threshold (cannot be changed via input)
  - Returns data only when jobs are posted within last 5 hours
  - Status: **Partially Working** (data available only for very recent posts)

### 2.3 AI Job Filtering
- Integrated Groq LLM (llama-3.3-70b-versatile) for intelligent job filtering
- AI ranks jobs by relevance to selected roles and filters
- Match score assigned to each job (0-100%)
- Strict filtering: removes irrelevant jobs, applies budget/remote/job-type filters
- Gemini API (gemini-2.0-flash-lite) configured as alternative AI provider
- Status: **Working**

### 2.4 Sequential Multi-Platform Search
- Platforms scraped one by one in order
- Results displayed progressively as each platform completes
- Progress indicator shows current platform and jobs found so far
- If one platform fails, others continue
- Error messages and info messages shown separately

### 2.5 Saved Jobs System
- Save individual jobs or save all results at once
- Duplicate detection by URL or title+company combination
- Jobs persist in browser localStorage across sessions
- Checkbox selection in saved jobs table
- Select All / Deselect All functionality
- Status: **Working**

### 2.6 Excel Export
- Export to single persistent file `saved_jobs.xlsx`
- Export selected jobs only, or export all if none selected
- Columns: S.No, Job Name, Job ID, URL, Email (HR/Company), Budget, Skills, Job Type, Posted Time, Platform, Company, Location, Match Score
- Auto-width columns for readability
- Status: **Working**

### 2.7 Data Normalization
- Each platform returns different data format
- Normalization layer converts all platforms to unified format
- Unified fields: title, jobId, company, email, budget, skills, location, jobType, description, url, postedAt, platform
- Email extraction from job descriptions using regex
- Status: **Working**

---

## 3. Known Issues & Challenges

### 3.1 Upwork Scraping (Primary Issue)
**Problem:** No free method reliably scrapes Upwork with keyword search.

| Approach Tried | Result |
|----------------|--------|
| `getdataforme~upwork-actor` (Apify) | Searches correctly, finds jobs, but hardcoded 5-hour time filter drops all older jobs |
| `devcake~upwork-jobs-scraper` (Apify) | Ignores keyword input, returns random jobs from all categories |
| `neatrat~upwork-job-scraper` (Apify) | Free tier exhausted (100 result limit) |
| Direct Puppeteer/Playwright scraping | Cloudflare Enterprise blocks all automated browsers |
| `puppeteer-extra-plugin-stealth` | Still blocked by Cloudflare |
| Custom Apify Actor (Python + Camoufox) | Dependency version conflicts during build |
| `igview-owner~jobs-scraper` (Google Jobs) | API returns 403 (Google blocked access) |
| Upwork RSS Feed | Returns 404 (discontinued) |
| `junipr~upwork-jobs` (Paid actor) | Needs residential proxy (paid Apify plan $49/mo) |

**Root Cause:** Upwork uses Cloudflare Enterprise protection that blocks all automated access. Only the `getdataforme` actor bypasses it using Camoufox (special anti-detection browser), but its 5-hour threshold is hardcoded in hidden source code.

**Proposed Solution:** Upwork Official API with OAuth 2.0 authentication. This provides:
- Direct API access (no Cloudflare)
- Keyword search with sort by newest
- Real-time fresh data
- Free to use for personal/development purposes
- Future: proposal submission via API

**Status:** Upwork Developer API application in progress.

### 3.2 Groq Rate Limiting
- Groq free tier has 100K tokens/day limit
- Heavy usage causes rate limit errors (429)
- Gemini API added as alternative but free quota also limited
- Current workaround: wait for daily reset

### 3.3 Email Data Quality
- Email extraction depends on job description content
- Most job postings don't include direct HR/company email
- Previously generated fake `careers@domain` emails - now removed
- Shows "N/A" when no real email found in description

---

## 4. Technical Architecture

```
Frontend (Next.js 16 + React 19 + Tailwind CSS 4)
├── app/page.tsx          → Main dashboard UI
├── app/layout.tsx        → Root layout
└── app/globals.css       → Global styles

Backend (Next.js API Routes)
├── api/scrape-jobs/      → Indeed & LinkedIn scraping via Apify
├── api/scrape-upwork/    → Upwork scraping (separate route)
├── api/filter-jobs/      → AI job filtering via Groq/Gemini
└── api/extract-query/    → Query extraction via AI

External Services
├── Apify API             → Web scraping actors
├── Groq API              → LLM for job filtering
├── Gemini API            → Alternative LLM
└── Upwork API            → (Planned) Direct job search
```

---

## 5. Files Structure

```
job-scraper-dashboard/
├── app/
│   ├── api/
│   │   ├── extract-query/route.ts
│   │   ├── filter-jobs/route.ts
│   │   ├── scrape-jobs/route.ts
│   │   └── scrape-upwork/route.ts
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── .env.local
├── package.json
├── tsconfig.json
├── next.config.ts
└── README.md
```

---

## 6. Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| next | 16.2.3 | React framework |
| react | 19.2.4 | UI library |
| axios | ^1.15.0 | HTTP client for API calls |
| xlsx | ^0.18.5 | Excel file generation |
| typescript | ^5 | Type safety |
| tailwindcss | ^4 | Styling |

---

## 7. Environment Variables

| Variable | Service | Purpose |
|----------|---------|---------|
| APIFY_API_KEY | Apify | Web scraping actors |
| GROQ_API_KEY | Groq | LLM job filtering |
| GEMINI_API_KEY | Google | Alternative LLM |

---

## 8. Next Steps (Planned)

| Priority | Task | Approach |
|----------|------|----------|
| High | Upwork API integration | OAuth 2.0 + Official API |
| High | Settings page for platform connections | OAuth connect buttons |
| Medium | Upwork proposal submission | Upwork API |
| Medium | LinkedIn job apply | Chrome Extension / API |
| Low | Indeed job apply | Redirect to Indeed page |
| Low | Database for persistent storage | Replace localStorage |

---

## 9. Summary

| Feature | Status |
|---------|--------|
| Dashboard UI | Done |
| Indeed scraping | Working |
| LinkedIn scraping | Working |
| Upwork scraping | Partial (5hr limit, API integration planned) |
| AI job filtering | Working |
| Multi-platform search | Working |
| Save jobs | Working |
| Excel export with selection | Working |
| Duplicate detection | Working |
| Upwork Official API | In Progress |
| Job apply/proposal | Planned |
