import test from 'node:test';
import assert from 'node:assert/strict';
import { crawl } from '../src/crawler.js';
import { validateInput } from '../src/lib.js';

const noSleep = async () => {};
const html = (body, head = '<title>T</title><meta name="description" content="d">') => `<html lang="en"><head>${head}</head><body>${body}</body></html>`;

/** In-memory "internet". Each entry: { status, body, type, redirectedTo, headStatus, throwErr } */
function fakeWeb(sites, log = []) {
    return async (url, opts = {}) => {
        const method = opts.method ?? 'GET';
        log.push(`${method} ${url}`);
        const u = new URL(url);
        const entry = sites[u.href] ?? sites[`${u.origin}${u.pathname}`];
        if (!entry) return { status: 404, url, redirected: false, headers: { get: () => 'text/html' }, text: async () => 'nf' };
        if (entry.throwErr) { const e = new Error(entry.throwErr); e.name = entry.errName ?? 'TypeError'; throw e; }
        const status = method === 'HEAD' && entry.headStatus ? entry.headStatus : entry.status ?? 200;
        return {
            status, url: entry.redirectedTo ?? url, redirected: Boolean(entry.redirectedTo),
            headers: { get: (k) => (k.toLowerCase() === 'content-type' ? entry.type ?? 'text/html; charset=utf-8' : null) },
            text: async () => entry.body ?? '',
        };
    };
}
const run = async (sites, raw, log = []) => {
    const { input, errors } = validateInput({ delayMs: 0, concurrency: 3, ...raw });
    assert.deepEqual(errors, []);
    const rows = [];
    const summary = await crawl(input, { fetchImpl: fakeWeb(sites, log), sleep: noSleep, onRow: async (r) => { rows.push(r); return true; } });
    return { rows, summary, byUrl: Object.fromEntries(rows.map((r) => [r.url, r])) };
};

const SITE = {
    'https://site.test/robots.txt': { body: 'User-agent: *\nDisallow: /private\n', type: 'text/plain' },
    'https://site.test/': { body: html('<a href="/about">About</a><a href="/missing">Gone</a><a href="/moved">Moved</a><a href="/private/x">Secret</a><a href="https://ext.test/ok">Ext ok</a><a href="https://dead.test/x">Ext dead</a><a href="https://picky.test/p">Picky</a><a href="https://slow.test/">Slow</a><a href="https://blocked.test/">Blocked</a>', '<title>Home</title>') },
    'https://site.test/about': { body: html('<h1>About</h1><a href="/">Home again</a><a href="/missing">Gone again</a>') },
    'https://site.test/moved': { body: html('<h1>Moved</h1>'), redirectedTo: 'https://site.test/about' },
    'https://site.test/missing': { status: 404, body: 'nope' },
    'https://ext.test/robots.txt': { status: 404 },
    'https://ext.test/ok': { status: 200 },
    'https://dead.test/robots.txt': { status: 404 },
    'https://dead.test/x': { status: 404 },
    'https://picky.test/robots.txt': { status: 404 },
    'https://picky.test/p': { status: 200, headStatus: 405 },
    'https://slow.test/robots.txt': { status: 404 },
    'https://slow.test/': { throwErr: 'aborted', errName: 'AbortError' },
    'https://blocked.test/robots.txt': { body: 'User-agent: *\nDisallow: /\n', type: 'text/plain' },
};

test('crawl finds broken, redirected, restricted-by-robots, timeout and picky-HEAD links', async () => {
    const log = [];
    const { byUrl, summary } = await run(SITE, { startUrls: ['https://site.test/'], useSitemap: false }, log);
    assert.equal(byUrl['https://site.test/'].type, 'page');
    assert.equal(byUrl['https://site.test/'].title, 'Home');
    assert.ok(byUrl['https://site.test/'].issues.includes('missing-h1'));
    assert.equal(byUrl['https://site.test/missing'].category, 'broken');
    assert.ok(byUrl['https://site.test/missing'].foundOn.includes('https://site.test/'), 'records which page linked to it (partial list: more pages may link to it after the row is emitted)');
    assert.equal(byUrl['https://site.test/moved'].category, 'redirected');
    assert.equal(byUrl['https://site.test/moved'].finalUrl, 'https://site.test/about');
    assert.equal(byUrl['https://site.test/private/x'].category, 'robots-disallowed', 'robots.txt Disallow respected');
    assert.equal(byUrl['https://ext.test/ok'].ok, true);
    assert.equal(byUrl['https://ext.test/ok'].type, 'link');
    assert.equal(byUrl['https://dead.test/x'].category, 'broken');
    assert.equal(byUrl['https://picky.test/p'].category, 'ok', 'falls back to GET when HEAD gives 405');
    assert.equal(byUrl['https://slow.test/'].category, 'timeout');
    assert.equal(byUrl['https://blocked.test/'].category, 'robots-disallowed');
    assert.ok(!log.some((l) => l.includes('/private/x')), 'never requested a disallowed path');
    assert.ok(!log.some((l) => l.startsWith('GET https://blocked.test/') && !l.endsWith('robots.txt')), 'never requested a disallowed external URL');
    assert.equal(summary.pagesCrawled, 2 + 1, 'home, about and moved are opened');
});

test('start URL rows have string-only foundOn so they pass dataset schema validation', async () => {
    const { byUrl, rows } = await run(SITE, { startUrls: ['https://site.test/'], useSitemap: false });
    assert.deepEqual(byUrl['https://site.test/'].foundOn, []);
    assert.equal(byUrl['https://site.test/'].anchorText, null);
    for (const r of rows) assert.ok(r.foundOn.every((x) => typeof x === 'string'));
});

test('each URL is checked once even when many pages link to it', async () => {
    const log = [];
    await run(SITE, { startUrls: ['https://site.test/'], useSitemap: false }, log);
    assert.equal(log.filter((l) => l.endsWith('https://site.test/missing')).length, 1);
});

test('checkExternal=false skips other hosts entirely', async () => {
    const log = [];
    const { rows } = await run(SITE, { startUrls: ['https://site.test/'], useSitemap: false, checkExternal: false }, log);
    assert.ok(rows.every((r) => !r.isExternal));
    assert.ok(!log.some((l) => l.includes('ext.test')));
});

test('maxDepth=0 checks first-level links by status but opens only the start page', async () => {
    const { byUrl, summary } = await run(SITE, { startUrls: ['https://site.test/'], useSitemap: false, maxDepth: 0 });
    assert.equal(summary.pagesCrawled, 1);
    assert.equal(byUrl['https://site.test/about'].type, 'link');
    assert.equal(byUrl['https://site.test/about'].category, 'ok');
});

test('maxLinks stops the crawl and flags truncation', async () => {
    const { rows, summary } = await run(SITE, { startUrls: ['https://site.test/'], useSitemap: false, maxLinks: 3 });
    assert.equal(rows.length, 3);
    assert.equal(summary.truncated, true);
});

test('onlyProblems drops rows without issues', async () => {
    const { rows } = await run(SITE, { startUrls: ['https://site.test/'], useSitemap: false, onlyProblems: true });
    assert.ok(rows.length > 0 && rows.every((r) => r.issues.length > 0));
    assert.ok(!rows.some((r) => r.url === 'https://ext.test/ok'));
});

test('sitemap URLs are added and robots-listed sitemap is used', async () => {
    const web = {
        ...SITE,
        'https://site.test/robots.txt': { body: 'User-agent: *\nDisallow: /private\nSitemap: https://site.test/map.xml\n', type: 'text/plain' },
        'https://site.test/map.xml': { body: '<urlset><url><loc>https://site.test/orphan</loc></url><url><loc>https://other.test/zzz</loc></url></urlset>', type: 'application/xml' },
        'https://site.test/orphan': { body: html('<h1>Orphan</h1>') },
    };
    const { byUrl, summary } = await run(web, { startUrls: ['https://site.test/'] });
    assert.equal(byUrl['https://site.test/orphan'].type, 'page');
    assert.deepEqual(byUrl['https://site.test/orphan'].foundOn, ['https://site.test/map.xml']);
    assert.equal(summary.sitemapUrlsAdded, 1, 'off-site sitemap entries ignored');
});

test('onRow returning false stops the crawl (spend limit reached)', async () => {
    const { input } = validateInput({ startUrls: ['https://site.test/'], useSitemap: false, delayMs: 0, concurrency: 1 });
    let n = 0;
    const summary = await crawl(input, { fetchImpl: fakeWeb(SITE), sleep: noSleep, onRow: async () => (++n < 2) });
    assert.equal(n, 2);
    assert.equal(summary.truncated, true);
});
