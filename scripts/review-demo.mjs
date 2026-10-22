import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { main } from './audit.mjs';
const output = path.resolve('../demo-report');
const audit = JSON.parse(await readFile(path.join(output, 'audit.json'), 'utf8'));
const url = suffix => new URL(suffix, audit.target).href;
const finding = id => audit.findings.find(f => f.checkId === id)?.id ?? 'audit.json#findings';
const analysis = {
  executiveSummary: 'Northstar Coffee should first repair the incomplete limited-edition page and its canonical destination, update the broken catalogue link, and remove the intentionally excluded account page from the sitemap. The two coffee product pages need an intent/product review before any consolidation. The measured homepage lab samples were fast; wider product-page and field performance remain unmeasured.',
  businessContext: {
    model: 'Observed retail coffee pages, brewing guidance and a wholesale coffee page.',
    goals: ['Inferred: help retail customers select coffee and generate wholesale enquiries. No conversion data was supplied.'],
    markets: ['English-language content observed; geographic market was not established.']
  },
  contentActions: [
    { url: url('/bad-canonical'), priority: 'p1',
      action: 'Confirm this limited-edition landing page’s actual product purpose, add an accurate title and visible main heading, and replace its missing canonical destination with the intended accessible product URL.',
      reason: 'The page is linked as Limited edition, has an empty title and no main heading, and declares /missing as canonical. The shared template cause is not confirmed without source/CMS access.',
      evidence: [finding('title-missing'), finding('canonical-unindexable'), url('/bad-canonical')] },
    { url: url('/coffee/special'), priority: 'p2',
      action: 'Review whether Special selection is a distinct product. If distinct, add its verified product details and an accurate distinct title; if equivalent, prepare a relevance-preserving consolidation plan for review.',
      reason: 'The coffee pages share titles and extracted product copy. Similarity alone does not prove harmful cannibalisation; there is no query/page history or conversion evidence.',
      evidence: [finding('title-duplicate'), url('/coffee/beans'), url('/coffee/special')] },
    { url: url('/guides/beans'), priority: 'p2',
      action: 'Keep the informational brewing guide distinct from product pages and add a contextual link to the relevant coffee selection page.',
      reason: 'The guide answers how to choose beans, whereas the coffee pages serve buying intent. The evidence supports distinct purposes rather than a merge.',
      evidence: [url('/guides/beans'), url('/coffee/beans')] },
    { url: url('/orphan'), priority: 'p2',
      action: 'Add a relevant Wholesale coffee link from the main site navigation or a clearly related business page if wholesale enquiries are a priority.',
      reason: 'This crawl discovers the wholesale page through the sitemap and observes no incoming internal link. A complete web-wide orphan assessment is not claimed.',
      evidence: [finding('internal-discovery-gap'), url('/orphan')] },
    { url: url('/noindex'), priority: 'p1',
      action: 'Preserve the account page’s intentional noindex policy and remove it from the public XML sitemap.',
      reason: 'The account page is explicitly excluded from indexing but included in the sitemap. Removing noindex would not be justified by this finding.',
      evidence: [finding('sitemap-noindex'), url('/noindex')] }
  ],
  strategicActions: [
    { priority: 'p1', action: 'Replace the homepage’s Old catalogue link with its intended relevant destination, or remove it if the resource is intentionally retired.',
      reason: 'The currently linked /missing destination returns 404. An unrelated blanket redirect is not justified.',
      evidence: [finding('internal-link-broken'), url('/')] },
    { priority: 'p2', action: 'Emit the Seasonal coffee navigation link in response HTML when this page is intended for organic discovery.',
      reason: 'The link is observed after JavaScript rendering. Its existence in the browser is not proof that every search or AI crawler discovers it.',
      evidence: [url('/'), url('/render-only'), 'audit.json#pages'] },
    { priority: 'p3', action: 'Confirm whether the owner intends to exclude brewing guides from OAI-SearchBot retrieval; change that search policy only if it conflicts with the desired visibility.',
      reason: 'The guide path is disallowed for the search crawler. The separate GPTBot training block is not treated as a defect.',
      evidence: [finding('ai-search-policy'), 'audit.json#robots'] },
    { priority: 'p2', action: 'Connect the owner’s own Search Console property or import linked query/page evidence before diagnosing cannibalisation or Google-selected canonicals.',
      reason: 'This demonstration has no live search account, indexing records, backlinks, AI-answer observations or conversion data.',
      evidence: ['audit.json#capabilities', 'audit.json#coverage'] },
    { priority: 'p3', action: 'Extend performance sampling to the coffee and wholesale templates and obtain eligible field data before planning speed changes.',
      reason: 'The completed mobile and desktop Lighthouse homepage samples scored well on this machine. It does not establish real-user experience or every template’s performance.',
      evidence: ['audit.json#performance'] }
  ],
  evidenceLimitations: [
    'This report audits a local demonstration website with deliberately introduced issues.',
    'No source repository or live CMS was supplied; implementation causes and changes remain proposed.',
    'No real Google account was connected and no ranking, revenue or AI-citation outcome was measured.'
  ]
};
await writeFile(path.join(output, 'analysis.json'), JSON.stringify(analysis, null, 2));
await main(['report', path.join(output, 'audit.json'), '--analysis', path.join(output, 'analysis.json'), '--timezone', 'Asia/Dubai', '--pdf']);
