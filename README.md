# Broken Link Checker and Site Health Crawler (robots.txt aware)

Point it at a website you own or are allowed to audit. It crawls the pages of that site, checks every link it finds (internal and, optionally, external) and saves one row per unique URL with the HTTP status, redirect target, response time, where the link was found, and basic on-page checks (title, meta description, H1, noindex).

It is a polite crawler by design:

- **robots.txt is always respected**, for pages, external link checks and sitemaps. Disallowed URLs are never requested; they are reported as `robots-disallowed` instead of being guessed at.
- Requests to the same host are spaced apart (default 250 ms), run with a small fixed parallelism (default 5), and time out (default 15 s).
- It identifies itself with the user agent `LinkHealthCheckerActor/0.1`.
- No logins, no cookies, no JavaScript rendering, no proxies, no personal data collection. Only the links and page metadata of the pages you point it at.

## What you get

One dataset row per unique URL:

| Field | Meaning |
|---|---|
| `type` | `page` (an internal HTML page that was opened and parsed) or `link` (checked by status only) |
| `url`, `finalUrl` | Requested URL and where it ended up after redirects (when different) |
| `status`, `category` | HTTP status and one of `ok`, `redirected`, `broken`, `restricted`, `timeout`, `error`, `robots-disallowed` |
| `issues` | List of `broken-link`, `timeout`, `request-error`, `redirected`, `slow` (over 3 s), `missing-title`, `missing-meta-description`, `missing-h1`, `multiple-h1`, `noindex` |
| `foundOn`, `anchorText` | Up to 3 pages that linked to the URL, and the first link text. These are the pages seen when the URL was checked; because rows are saved as soon as each check finishes, a URL discovered on several pages may list only the first ones |
| `responseMs`, `isExternal`, `depth` | Timing, whether it points to another site, and click depth from your start URL |
| `title`, `metaDescription`, `h1Count`, `canonicalUrl`, `noindex`, `lang` | On-page fields for `page` rows |

`restricted` means an external host answered 401, 403, 429 or 999, which is how many sites treat automated clients even when the page exists. It is not counted as broken.

A `SUMMARY` record in the key-value store gives the totals per category, pages crawled and whether the run stopped at your limits.

## Input

| Field | Default | Meaning |
|---|---|---|
| `startUrls` | required | 1 to 20 http(s) URLs. Pages on the same site (www and bare host count as one) are crawled |
| `maxPages` | 50 | Pages opened and parsed for links (1 to 1000) |
| `maxDepth` | 3 | Click depth from the start URLs that is opened. Deeper links are still status-checked |
| `maxLinks` | 200 | Hard cap on saved rows and therefore on cost (1 to 5000) |
| `checkExternal` | true | Also check links that leave your site (one request each, never crawled) |
| `useSitemap` | true | Seed from the sitemap named in robots.txt, or /sitemap.xml |
| `onlyProblems` | false | Save only rows that have at least one issue. You pay only for saved rows |
| `concurrency` | 5 | In-flight requests (1 to 10) |
| `delayMs` | 250 | Minimum gap between requests to one host |
| `timeoutSecs` | 15 | Per-request timeout |

Invalid input stops the run at once with a message listing every problem.

Example:

```json
{
  "startUrls": ["https://example.com/"],
  "maxPages": 100,
  "maxLinks": 500,
  "onlyProblems": true
}
```

## Example output

Real rows from a test run against a one-page personal site:

```json
[
  {
    "type": "page",
    "url": "https://rishabhb.dev/",
    "finalUrl": null,
    "status": 200,
    "category": "ok",
    "ok": true,
    "redirected": false,
    "responseMs": 250,
    "isExternal": false,
    "depth": 0,
    "foundOn": [
      null
    ],
    "anchorText": "start URL",
    "error": null,
    "title": "Rishabh Bansal | Builder",
    "metaDescription": "Rishabh Bansal builds resilient software, from offline emergency relays and evidence-backed video review to robotics and local-first developer tools.",
    "h1Count": 1,
    "canonicalUrl": "https://rishabhb.dev",
    "noindex": false,
    "lang": "en",
    "issues": []
  },
  {
    "type": "link",
    "url": "https://musclememory.space/",
    "finalUrl": null,
    "status": 401,
    "category": "restricted",
    "ok": false,
    "redirected": false,
    "responseMs": 139,
    "isExternal": true,
    "depth": 1,
    "foundOn": [
      "https://rishabhb.dev/"
    ],
    "anchorText": "Try the live experience ↗",
    "error": null,
    "issues": []
  },
  {
    "type": "link",
    "url": "https://www.linkedin.com/in/rb-rishabh/",
    "finalUrl": null,
    "status": null,
    "category": "robots-disallowed",
    "ok": false,
    "redirected": false,
    "responseMs": null,
    "isExternal": true,
    "depth": 1,
    "foundOn": [
      "https://rishabhb.dev/"
    ],
    "anchorText": "LinkedIn ↗",
    "error": null,
    "issues": []
  }
]
```

## Pricing

Pay per event:

- **Actor start**: $0.00005 (Apify standard synthetic event).
- **Link checked**: $0.001 per saved row, that is $1 per 1,000 URLs checked.

You pay only for rows saved to the dataset. `maxLinks` caps the spend of a run and the platform's maximum-cost-per-run setting is respected; the run stops cleanly when either is reached. With `onlyProblems` on, clean URLs are checked but not billed.

Example: auditing a 40-page site with about 300 unique links is roughly $0.30 for one full report.

## Limits and honest caveats

- It reads server-rendered HTML only. Links created by JavaScript after page load are not seen.
- A link can look fine to this crawler and still fail for a real visitor (login walls, geo blocks, bot protection). Treat `restricted` and `timeout` rows as "check by hand", not as proof of a dead link.
- External checks honour each host's robots.txt too, so some external URLs come back as `robots-disallowed` rather than a status.
- Only the first 2 MB of each page is parsed. Anchors (#section) are not validated.
- Use it only on sites you own or have permission to audit, and keep the delay polite on small servers.

## Use it from code

```bash
curl -X POST "https://api.apify.com/v2/acts/rishabhcli~link-health-checker/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"startUrls":["https://example.com/"],"maxLinks":50,"onlyProblems":true}'
```

## Source code

MIT licensed. Source and tests are on GitHub under rishabhcli/apify-link-health-checker. Run the unit tests with `npm test`.
