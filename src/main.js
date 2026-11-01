import { Actor, log } from 'apify';
import { validateInput } from './lib.js';
import { crawl } from './crawler.js';

await Actor.init();

const { input, errors } = validateInput((await Actor.getInput()) ?? {});
if (errors.length) {
    await Actor.fail(`Invalid input: ${errors.join(' ')}`);
}

await Actor.setStatusMessage(`Crawling ${input.startUrls.length} site(s)...`);
let pushed = 0;
let limitReached = false;
const summary = await crawl(input, {
    log: (m) => log.warning(m),
    onRow: async (row) => {
        // One billable "link-checked" event per dataset row, charged right after the row is stored.
        const result = await Actor.pushData(row, 'link-checked');
        pushed++;
        if (pushed % 25 === 0) await Actor.setStatusMessage(`Checked ${pushed} URLs so far`);
        if (result?.eventChargeLimitReached) {
            limitReached = true;
            log.warning('Maximum charged results per run reached; stopping early.');
            return false;
        }
        return true;
    },
});

const c = summary.categories;
const final = { ok: true, startUrls: input.startUrls, rowsSaved: pushed, limitReached, ...summary, finishedAt: new Date().toISOString() };
await Actor.setValue('SUMMARY', final);
const bits = [`broken ${c.broken ?? 0}`, `redirected ${c.redirected ?? 0}`, `timeouts ${c.timeout ?? 0}`, `errors ${c.error ?? 0}`, `robots-skipped ${c['robots-disallowed'] ?? 0}`];
await Actor.setStatusMessage(`Saved ${pushed} rows from ${summary.pagesCrawled} pages: ${bits.join(', ')}${summary.truncated ? ' (stopped at your limit)' : ''}`);
log.info('Done', final);
await Actor.exit();
