import robotsParser from 'robots-parser';
import { USER_AGENT, ROBOTS_TOKEN, normalizeUrl, sameSite, extractLinks, analyzePage, categorize, issuesFor, parseSitemapLocs } from './lib.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_HTML_BYTES = 2_000_000;

/**
 * Polite crawler. Every request (pages, external links, sitemaps) honours robots.txt for our user agent,
 * is rate limited per host and has a timeout. Emits one row per unique URL via onRow().
 */
export async function crawl(input, { fetchImpl = fetch, sleep = defaultSleep, onRow, log = () => {} }) {
    const timeoutMs = input.timeoutSecs * 1000;
    const robotsCache = new Map();
    const hostNext = new Map();
    const seen = new Set();
    const foundOn = new Map();
    const queue = [];
    const summary = { pagesCrawled: 0, rows: 0, categories: {}, truncated: false, sitemapUrlsAdded: 0 };
    let plannedPages = 0;
    let inFlight = 0;
    let stop = false;

    const isInternal = (url) => input.startUrls.some((s) => sameSite(s, url));

    async function throttle(host) {
        const at = Math.max(Date.now(), hostNext.get(host) ?? 0);
        hostNext.set(host, at + input.delayMs);
        const wait = at - Date.now();
        if (wait > 0) await sleep(wait);
    }

    async function request(url, method, extraHeaders = {}) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const t0 = Date.now();
        try {
            await throttle(new URL(url).host);
            const res = await fetchImpl(url, { method, redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*;q=0.8', ...extraHeaders } });
            return { res, ms: Date.now() - t0 };
        } finally {
            clearTimeout(timer);
        }
    }

    async function robotsFor(url) {
        const origin = new URL(url).origin;
        if (!robotsCache.has(origin)) {
            robotsCache.set(origin, (async () => {
                try {
                    const { res } = await request(`${origin}/robots.txt`, 'GET');
                    if (res.status >= 400) return { allowed: () => true, sitemaps: [] };
                    const p = robotsParser(`${origin}/robots.txt`, await res.text());
                    return { allowed: (u) => p.isAllowed(u, ROBOTS_TOKEN) !== false, sitemaps: p.getSitemaps() };
                } catch {
                    return { allowed: () => true, sitemaps: [] };
                }
            })());
        }
        return robotsCache.get(origin);
    }

    /** One URL: robots check, HEAD (or GET when we need the HTML), fallback GET for hosts that dislike HEAD. */
    async function check(url, wantHtml) {
        const robots = await robotsFor(url);
        if (!robots.allowed(url)) return { robotsBlocked: true };
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                let { res, ms } = await request(url, wantHtml ? 'GET' : 'HEAD');
                if (!wantHtml && [400, 403, 405, 501].includes(res.status)) ({ res, ms } = await request(url, 'GET', { Range: 'bytes=0-0' }));
                if ((res.status === 429 || res.status >= 500) && attempt === 0) { lastError = null; await sleep(500); continue; }
                const contentType = res.headers?.get?.('content-type') ?? '';
                let html = null;
                if (wantHtml && res.status >= 200 && res.status < 300 && /html/i.test(contentType)) {
                    const text = await res.text();
                    html = text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
                }
                return { status: res.status, finalUrl: res.url || url, redirected: Boolean(res.redirected), responseMs: ms, contentType, html };
            } catch (err) {
                lastError = err.name === 'AbortError' ? `timeout after ${input.timeoutSecs}s` : `${err.name}: ${err.message}`;
                if (attempt === 0) await sleep(300);
            }
        }
        return { error: lastError ?? 'request failed' };
    }

    function enqueueLink(link, fromUrl, depth) {
        const internal = isInternal(link.url);
        if (!internal && !input.checkExternal) return;
        if (seen.has(link.url)) {
            const list = foundOn.get(link.url);
            if (list && list.length < 3) list.push({ page: fromUrl, text: link.text });
            return;
        }
        seen.add(link.url);
        foundOn.set(link.url, [{ page: fromUrl, text: link.text }]);
        const crawlIt = internal && depth <= input.maxDepth && plannedPages < input.maxPages;
        if (crawlIt) plannedPages++;
        queue.push({ url: link.url, depth, internal, crawl: crawlIt });
    }

    async function process(item) {
        const result = await check(item.url, item.crawl);
        const isExternal = !item.internal;
        const category = categorize({ ...result, isExternal });
        let page = null;
        if (result.html) {
            summary.pagesCrawled++;
            page = analyzePage(result.html);
            if (item.depth < input.maxDepth + 1) for (const link of extractLinks(result.html, result.finalUrl)) enqueueLink(link, item.url, item.depth + 1);
        }
        const firstRef = foundOn.get(item.url)?.[0];
        const row = {
            type: page ? 'page' : 'link',
            url: item.url,
            finalUrl: result.finalUrl && result.finalUrl !== item.url ? result.finalUrl : null,
            status: result.status ?? null,
            category,
            ok: category === 'ok' || category === 'redirected',
            redirected: Boolean(result.redirected),
            responseMs: result.responseMs ?? null,
            isExternal,
            depth: item.depth,
            foundOn: foundOn.get(item.url)?.map((f) => f.page) ?? [],
            anchorText: firstRef?.text || null,
            error: result.error ?? null,
            ...(page ?? {}),
        };
        row.issues = issuesFor(row);
        summary.categories[category] = (summary.categories[category] ?? 0) + 1;
        if (input.onlyProblems && row.issues.length === 0) return;
        if (summary.rows >= input.maxLinks) { stop = true; summary.truncated = true; return; }
        summary.rows++;
        const keepGoing = await onRow(row);
        if (keepGoing === false || summary.rows >= input.maxLinks) { stop = true; summary.truncated = true; }
    }

    async function seedFromSitemaps() {
        const origins = [...new Set(input.startUrls.map((u) => new URL(u).origin))];
        for (const origin of origins) {
            const robots = await robotsFor(origin);
            const candidates = robots.sitemaps.length ? robots.sitemaps.slice(0, 3) : [`${origin}/sitemap.xml`];
            const todo = [...candidates];
            let fetchedMaps = 0;
            while (todo.length && fetchedMaps < 6 && summary.sitemapUrlsAdded < input.maxPages) {
                const mapUrl = todo.shift();
                if (!robots.allowed(mapUrl) && sameSite(mapUrl, origin)) continue;
                fetchedMaps++;
                try {
                    const { res } = await request(mapUrl, 'GET');
                    if (res.status !== 200) continue;
                    const { urls, isIndex } = parseSitemapLocs((await res.text()).slice(0, MAX_HTML_BYTES));
                    for (const loc of urls) {
                        const n = normalizeUrl(loc);
                        if (!n) continue;
                        if (isIndex) { if (todo.length < 5) todo.push(n); continue; }
                        if (isInternal(n) && !seen.has(n) && plannedPages < input.maxPages) {
                            seen.add(n); foundOn.set(n, [{ page: mapUrl, text: 'sitemap' }]);
                            plannedPages++; summary.sitemapUrlsAdded++;
                            queue.push({ url: n, depth: 1, internal: true, crawl: true });
                        }
                    }
                } catch (err) {
                    log(`Sitemap ${mapUrl} unreadable: ${err.message}`);
                }
            }
        }
    }

    for (const url of input.startUrls) {
        seen.add(url); foundOn.set(url, [{ page: null, text: 'start URL' }]);
        plannedPages++;
        queue.push({ url, depth: 0, internal: true, crawl: true });
    }
    if (input.useSitemap) await seedFromSitemaps();

    const workers = Array.from({ length: input.concurrency }, async () => {
        while (!stop) {
            const item = queue.shift();
            if (!item) {
                if (inFlight === 0) return;
                await sleep(20);
                continue;
            }
            inFlight++;
            try { await process(item); } finally { inFlight--; }
        }
    });
    await Promise.all(workers);
    if (queue.length > 0 && stop) summary.truncated = true;
    return summary;
}
