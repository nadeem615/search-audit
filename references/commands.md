# Commands and operation

Requires Node.js 22.19+ and npm ci in the skill directory. On Windows PowerShell use npm.cmd. Examples run from the skill directory; absolute script paths work from any working directory.

## Audit and report

    node scripts/audit.mjs audit https://example.com/ --output ./audit-output/example --data-dir ./.search-audit

Default: 200 fetched pages, 150 ms HTTP delay, 15-second request timeout, three rendered pages and three mobile Lighthouse URL samples. Lighthouse can take several minutes. Use --devices mobile,desktop --lighthouse-runs 3 for repeated measurements and medians.

- --max-pages 1000 --render 10 --lighthouse 6: larger budgets.
- --no-performance --render 0: HTTP only; deeper checks marked not assessed.
- --pdf: export PDF with local Chrome/Chromium.
- --timezone Asia/Dubai: display report completion times in an IANA timezone; default is the local timezone. Raw evidence timestamps stay UTC.
- --browser "<executable>": select browser; CHROME_PATH also supported.
- --seed https://example.com/orphan: extra known discovery seed; repeatable.
- --important https://example.com/services/: business-important URL/prefix; repeatable.
- --resume: continue saved queue/evidence. Increase --max-pages to extend a capped crawl. Omit for fresh post-change verification.
- --previous ./prior/audit.json: compare the same scope. Otherwise the project remembers its latest audit.
- --allow-private: permit owned local/private fixtures or intranet targets.
- --data-dir: project state and profile metadata; credential payloads use the OS backend.
- --output: destination. Preserve baseline folders; an explicitly reused destination regenerates its artifacts.

    node scripts/audit.mjs report ./audit-output/example/audit.json --analysis ./audit-output/example/analysis.json --pdf

Regenerate reports after the assistant's semantic review.

## Imports

    --import gsc=./query-page.csv --import backlinks=./links.csv --import citations=./observations.json

CSV/JSON imports retain provenance and limitations. Use linked query/page data for overlap; separate query and page summaries do not establish their relationship. Only import data for the audit scope.

## Per-user Search Console

    node scripts/audit.mjs auth connect --profile personal --client ./oauth-client.json
    node scripts/audit.mjs gsc properties --profile personal
    node scripts/audit.mjs audit https://example.com/ --gsc-profile personal --gsc-property sc-domain:example.com --start 2026-07-01 --end 2026-09-30 --inspect 10

Use dates relevant to the task. Search Console dates are Pacific Time. OAuth app configuration is separate from each user's authorisation. Distributed apps can serve multiple users; private installations can supply their own desktop client.

auth list shows profiles without secrets. auth disconnect --profile personal disconnects one profile. --no-open prints a sign-in URL for manual browser opening. Do not paste credentials into chat or commit them.

## Field data

Optional CRUX_API_KEY enables direct field lookup. Local Lighthouse needs no key. Reports distinguish page versus origin data and insufficient coverage. Keys are not saved into audit JSON.

## Artifacts

The audit command writes audit.json and returns report artifact paths for HTML, optional PDF, findings/page CSVs and the implementation action plan. Raw Lighthouse JSON is in evidence/lighthouse/. Each run declares scope, samples, exclusions and missing sources.
