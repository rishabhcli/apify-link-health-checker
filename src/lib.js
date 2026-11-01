import * as cheerio from 'cheerio';

export const USER_AGENT = 'LinkHealthCheckerActor/0.1 (+Apify Actor; respects robots.txt)';
export const ROBOTS_TOKEN = 'LinkHealthCheckerActor';

export function normalizeUrl(raw, base) {
    try {
        const u = new URL(String(raw).trim(), base);
        if (!/^https?:$/.test(u.protocol)) return null;
        u.hash = '';
        return u.href;
    } catch {
        return null;
    }
}

const bareHost = (url) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
export const sameSite = (a, b) => bareHost(a) === bareHost(b);

export function extractLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const baseHref = $('base[href]').first().attr('href');
    const base = baseHref ? normalizeUrl(baseHref, baseUrl) ?? baseUrl : baseUrl;
    const out = [];
    $('a[href]').each((_, el) => {
        const href = ($(el).attr('href') ?? '').trim();
        if (!href || href.startsWith('#')) return;
        const url = normalizeUrl(href, base);
        if (!url) return;
        out.push({ url, text: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120) });
    });
    return out;
}

export function analyzePage(html) {
    const $ = cheerio.load(html);
    const robotsMeta = ($('meta[name="robots"]').attr('content') ?? '').toLowerCase();
    return {
        title: $('title').first().text().replace(/\s+/g, ' ').trim() || null,
        metaDescription: $('meta[name="description"]').attr('content')?.trim() || null,
        h1Count: $('h1').length,
        canonicalUrl: $('link[rel="canonical"]').attr('href')?.trim() || null,
        noindex: robotsMeta.includes('noindex'),
        lang: $('html').attr('lang') || null,
    };
}

/** ok | redirected | broken | restricted | timeout | error | robots-disallowed */
export function categorize({ status, error, robotsBlocked, redirected, isExternal }) {
    if (robotsBlocked) return 'robots-disallowed';
    if (error) return /timeout|abort/i.test(error) ? 'timeout' : 'error';
    if (status >= 200 && status < 300) return redirected ? 'redirected' : 'ok';
    // Hosts often answer 401/403/429/999 to automated clients even when the page exists.
    if ([401, 403, 429, 999].includes(status) && isExternal) return 'restricted';
    return 'broken';
}

export function issuesFor(row, slowMs = 3000) {
    const issues = [];
    if (row.category === 'broken') issues.push('broken-link');
    if (row.category === 'timeout') issues.push('timeout');
    if (row.category === 'error') issues.push('request-error');
    if (row.category === 'redirected') issues.push('redirected');
    if (row.responseMs != null && row.responseMs > slowMs && row.category !== 'timeout') issues.push('slow');
    if (row.type === 'page' && row.category !== 'broken') {
        if (!row.title) issues.push('missing-title');
        if (!row.metaDescription) issues.push('missing-meta-description');
        if (row.h1Count === 0) issues.push('missing-h1');
        if (row.h1Count > 1) issues.push('multiple-h1');
        if (row.noindex) issues.push('noindex');
    }
    return issues;
}

export function parseSitemapLocs(xml) {
    const urls = [];
    for (const m of String(xml).matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s][^<\]]*?)\s*(?:\]\]>)?\s*<\/loc>/gi)) urls.push(m[1].trim());
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    return { urls, isIndex };
}

export function validateInput(raw = {}) {
    const errors = [];
    const input = {
        startUrls: raw.startUrls ?? [],
        maxPages: raw.maxPages ?? 50,
        maxDepth: raw.maxDepth ?? 3,
        maxLinks: raw.maxLinks ?? 200,
        checkExternal: raw.checkExternal ?? true,
        useSitemap: raw.useSitemap ?? true,
        onlyProblems: raw.onlyProblems ?? false,
        concurrency: raw.concurrency ?? 5,
        delayMs: raw.delayMs ?? 250,
        timeoutSecs: raw.timeoutSecs ?? 15,
    };
    if (!Array.isArray(input.startUrls) || input.startUrls.length === 0) errors.push('startUrls must contain at least one http(s) URL.');
    else {
        const normalized = [];
        for (const u of input.startUrls) {
            const n = typeof u === 'string' ? normalizeUrl(u) : typeof u?.url === 'string' ? normalizeUrl(u.url) : null;
            if (!n) errors.push(`Invalid start URL: ${JSON.stringify(u)}`);
            else if (!normalized.includes(n)) normalized.push(n);
        }
        input.startUrls = normalized;
        if (normalized.length > 20) errors.push('At most 20 start URLs per run.');
    }
    const intIn = (k, lo, hi) => { if (!Number.isInteger(input[k]) || input[k] < lo || input[k] > hi) errors.push(`${k} must be an integer between ${lo} and ${hi}.`); };
    intIn('maxPages', 1, 1000); intIn('maxDepth', 0, 10); intIn('maxLinks', 1, 5000); intIn('concurrency', 1, 10); intIn('delayMs', 0, 10000); intIn('timeoutSecs', 3, 60);
    return { input, errors };
}
