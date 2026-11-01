import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, sameSite, extractLinks, analyzePage, categorize, issuesFor, parseSitemapLocs, validateInput } from '../src/lib.js';

test('normalizeUrl resolves relative links, strips fragments, rejects non-http', () => {
    assert.equal(normalizeUrl('/a/b#x', 'https://example.com/z'), 'https://example.com/a/b');
    assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
    for (const bad of ['mailto:a@b.c', 'tel:123', 'javascript:void(0)', 'data:text/plain,hi']) assert.equal(normalizeUrl(bad, 'https://example.com/'), null);
    assert.equal(normalizeUrl('::::'), null, 'unparseable without a base');
});

test('sameSite treats www and bare host as one site', () => {
    assert.equal(sameSite('https://www.example.com/a', 'https://example.com/b'), true);
    assert.equal(sameSite('https://blog.example.com/', 'https://example.com/'), false);
});

test('extractLinks honours <base>, skips anchors and non-http schemes, trims text', () => {
    const html = '<base href="https://example.com/docs/"><a href="#top">top</a><a href="a.html"> A  link </a><a href="mailto:x@y.z">m</a><a href="/root">R</a><a>no href</a>';
    const links = extractLinks(html, 'https://example.com/index');
    assert.deepEqual(links, [{ url: 'https://example.com/docs/a.html', text: 'A link' }, { url: 'https://example.com/root', text: 'R' }]);
});

test('analyzePage reads title, meta, h1 count, canonical, noindex, lang', () => {
    const p = analyzePage('<html lang="en"><head><title> Hi  there </title><meta name="description" content="Desc"><meta name="robots" content="noindex,follow"><link rel="canonical" href="https://e.com/"></head><body><h1>A</h1><h1>B</h1></body></html>');
    assert.deepEqual(p, { title: 'Hi there', metaDescription: 'Desc', h1Count: 2, canonicalUrl: 'https://e.com/', noindex: true, lang: 'en' });
    const empty = analyzePage('<p>x</p>');
    assert.equal(empty.title, null); assert.equal(empty.h1Count, 0);
});

test('categorize separates broken from restricted, robots, timeout, error and redirects', () => {
    assert.equal(categorize({ status: 200 }), 'ok');
    assert.equal(categorize({ status: 200, redirected: true }), 'redirected');
    assert.equal(categorize({ status: 404 }), 'broken');
    assert.equal(categorize({ status: 503 }), 'broken');
    assert.equal(categorize({ status: 403, isExternal: true }), 'restricted');
    assert.equal(categorize({ status: 403, isExternal: false }), 'broken');
    assert.equal(categorize({ robotsBlocked: true }), 'robots-disallowed');
    assert.equal(categorize({ error: 'timeout after 15s' }), 'timeout');
    assert.equal(categorize({ error: 'TypeError: fetch failed' }), 'error');
});

test('issuesFor flags page problems only for pages that loaded', () => {
    const page = { type: 'page', category: 'ok', title: null, metaDescription: null, h1Count: 0, noindex: true, responseMs: 4000 };
    assert.deepEqual(issuesFor(page), ['slow', 'missing-title', 'missing-meta-description', 'missing-h1', 'noindex']);
    assert.deepEqual(issuesFor({ type: 'page', category: 'ok', title: 'T', metaDescription: 'D', h1Count: 2, responseMs: 10 }), ['multiple-h1']);
    assert.deepEqual(issuesFor({ type: 'link', category: 'broken', responseMs: 20 }), ['broken-link']);
    assert.deepEqual(issuesFor({ type: 'page', category: 'broken', title: null, h1Count: 0 }), ['broken-link']);
    assert.deepEqual(issuesFor({ type: 'link', category: 'ok', responseMs: 5 }), []);
});

test('parseSitemapLocs handles urlset, CDATA and sitemap indexes', () => {
    const a = parseSitemapLocs('<urlset><url><loc>https://e.com/a</loc></url><url><loc><![CDATA[https://e.com/b]]></loc></url></urlset>');
    assert.deepEqual(a, { urls: ['https://e.com/a', 'https://e.com/b'], isIndex: false });
    const b = parseSitemapLocs('<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>');
    assert.equal(b.isIndex, true);
});

test('validateInput normalises URLs, dedupes and reports every problem', () => {
    const ok = validateInput({ startUrls: ['https://example.com', { url: 'https://example.com/#frag' }, 'https://other.org/x'] });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.input.startUrls, ['https://example.com/', 'https://other.org/x']);
    assert.equal(ok.input.maxLinks, 200);
    assert.ok(validateInput({}).errors[0].includes('startUrls'));
    const bad = validateInput({ startUrls: ['ftp://x', 'not a url'], maxPages: 0, concurrency: 99, timeoutSecs: 1 });
    assert.equal(bad.errors.length, 5);
});
