# Search Audit

A portable local Agent Skill for **Codex and Claude Code**. Audit a website with free tools, review the evidence with your coding assistant, and generate a report using the audited website’s branding with a prioritised implementation plan.

Technical SEO · performance · indexing signals · on-page content · search intent · AEO · GEO

No Semrush API, paid SEO database, or separate model API key is required. Your existing assistant performs the business and content interpretation; the Node.js engine gathers evidence and builds the deliverables.

## Install

Requirements: **Node.js 22.19 or newer**, npm and Git. Chrome/Chromium is needed for rendering, Lighthouse and PDF; an installed supported browser is detected automatically.

```sh
git clone https://github.com/nadeem615/search-audit.git
cd search-audit
node scripts/install.mjs --agent both
```

Choose one agent with `--agent codex` or `--agent claude`. The installer copies the skill and installs its npm dependencies. It leaves existing installations alone unless `--force` is supplied; forced replacements retain a backup. It does not install the Codex or Claude Code application.

| Agent | Personal installation | Project installation | Invoke |
| --- | --- | --- | --- |
| Codex | `~/.agents/skills/search-audit/` | `.agents/skills/search-audit/` | `$search-audit` |
| Claude Code | `~/.claude/skills/search-audit/` | `.claude/skills/search-audit/` | `/search-audit` |

For installation in a specific project:

```sh
node scripts/install.mjs --agent both --scope project --project-dir /path/to/project
```

On PowerShell, quote paths containing spaces. Installation commands work on Windows, macOS and Linux. Use `--dry-run` to preview destinations, `--skip-deps` to copy without npm downloads, and `--help` for the full options. Updates use `git pull --ff-only` followed by the same installer command with `--force`.

Restart your agent session if the skill is not discovered immediately. These are local agent installations; they do not upload a skill to a web chat account. Skill locations follow the [Codex documentation](https://learn.chatgpt.com/docs/build-skills) and [Claude Code documentation](https://code.claude.com/docs/en/skills).

If no supported browser is present, run `npx playwright install chromium` from the installed skill directory, or ask the agent to set `--browser`/`CHROME_PATH` to your browser executable. Linux may also require the system libraries listed by Playwright.

## Use it

In **Codex**:

```text
Use $search-audit to audit https://example.com/ and generate a branded report,
PDF, and prioritised action plan. Review technical issues, performance,
indexing signals, content intent, AEO and GEO. Explain coverage gaps.
```

In **Claude Code**:

```text
/search-audit audit https://example.com/ and generate a branded report,
PDF, and prioritised action plan. Review the evidence and key page types.
```

The assistant discovers the site, runs the engine, reviews representative templates and conversion journeys, validates important anomalies, and adds site-specific analysis before regenerating the report. A mechanical crawl alone leaves semantic areas unassessed. Larger sites and delayed JavaScript content need adjusted budgets and additional browser review.

Network, shell and local-file permissions must be available in the agent environment. The installed skill works from its own path; audit reports and project state belong in your working project, outside the installed skill.

## What makes the audit useful

- **Evidence-backed tickets:** affected URLs, observations, recommendations, owner, effort, dependencies and acceptance checks.
- **Business context:** evaluate actual offers, audiences, application/contact journeys and page purposes rather than treating every site identically.
- **Response versus rendered HTML:** compare content, canonicals and headings; inspect fresh navigation and client-side transitions where metadata is stateful.
- **Performance diagnostics:** Lighthouse mobile/desktop measurements, optional repetitions and medians, with raw evidence. Field data is separate.
- **AEO/GEO review:** retrieval accessibility, useful answers, factual support, entity consistency and freshness. Search crawlers and training crawlers are distinct.
- **Website branding:** use the site’s verified name, logo and palette while keeping the report legible.
- **Follow-up:** compare later audits against the same scope; disappearing findings are not automatically marked resolved.

## Outputs

| File | Purpose |
| --- | --- |
| `report.html` | Self-contained branded report with finding filters and print support |
| `report.pdf` | Optional printable report |
| `action-plan.md` | Prioritised developer/editor tickets and verification criteria |
| `findings.csv` | Findings, affected URLs, evidence and acceptance criteria |
| `pages.csv` | Inventory with separately labelled response and rendered observations |
| `audit.json` | Structured evidence, capability coverage and measurement conditions |
| `analysis.json` | Assistant’s business, content and strategy interpretation when supplied |
| `evidence/lighthouse/` | Raw Lighthouse measurements |

The assistant can prepare implementation changes when source/CMS access is supplied and authorised. An audit request itself does not deploy changes.

## Optional: connect your own Search Console

Public audits work without sign-in. Each person uses their own Google OAuth desktop client, named account profile and accessible matching website property. No creator account or shared property is embedded.

Run from your audit project, replacing `<skill-dir>` with the installed directory printed by the installer:

```sh
node "<skill-dir>/scripts/audit.mjs" auth connect --profile my-account --client /path/to/oauth-client.json --data-dir ./.search-audit
node "<skill-dir>/scripts/audit.mjs" gsc properties --profile my-account --data-dir ./.search-audit
node "<skill-dir>/scripts/audit.mjs" audit https://example.com/ --gsc-profile my-account --gsc-property sc-domain:example.com --data-dir ./.search-audit --output ./audit-output/example
```

Keep the same working directory/`--data-dir` across connection and collection commands. Read-only access is used. Tokens are stored with Windows DPAPI, macOS Keychain, or Linux Secret Service; Linux requires `secret-tool` and an unlocked secret service. Imports remain available without an account connection. See [Search Console and imports](references/search-console.md).

Optional CSV/JSON imports support linked query/page evidence, backlink samples, AI citation observations and logs. `CRUX_API_KEY` enables optional CrUX field lookups. No optional connection is required for public crawling or Lighthouse.

## Run the engine directly

From a repository checkout, install dependencies first:

```sh
npm ci
node scripts/audit.mjs doctor
node scripts/audit.mjs audit https://example.com/ --output ./audit-output/example --render 10 --lighthouse 4 --devices mobile,desktop --lighthouse-runs 3 --pdf
```

PowerShell users can use `npm.cmd ci` if script execution policy blocks `npm`. The example performs up to 24 Lighthouse runs and can take several minutes. Defaults are a 200-page crawl, three rendered-page samples and three mobile Lighthouse samples, one run per URL/device.

For an HTTP-only audit with reduced coverage:

```sh
node scripts/audit.mjs audit https://example.com/ --no-performance --render 0
```

After completing the [semantic review](references/analysis-and-execution.md), regenerate with its analysis:

```sh
node scripts/audit.mjs report ./audit-output/example/audit.json --analysis ./audit-output/example/analysis.json --pdf
```

See [all commands](references/commands.md), [methodology](references/methodology.md), and [SKILL.md](SKILL.md).

## Scope and limits

This is a local evidence engine plus an agent workflow, not a full web backlink index. It cannot guarantee every issue, rankings, Google indexation or AI citations. Public technical checks establish observed behaviour and indexability signals; actual indexed versions require owner data. Similar content or multiple URLs ranking for a query do not alone prove harmful cannibalisation.

The report states missing sources, crawl budgets, rendering samples, failures and performance conditions. Missing data is not a pass. There is no invented SEO health score, compulsory `llms.txt`, bulk-disavow recommendation or special schema that guarantees AI inclusion.

The tools and source are free. Your coding assistant, hosting, optional services or API providers may have their own usage costs. Real customer reports, OAuth files and credentials are not included in this repository.

## Development

```sh
npm ci
npm test
```

Tests use synthetic websites, credentials and data; they do not sign in to Google. A [GitHub Actions template](ci/github-actions.yml) runs the suite and project-install checks on Ubuntu/Windows with Node 22.19 and 24. It is not enabled automatically: maintainers can place it at `.github/workflows/ci.yml` using credentials with workflow permission. A local synthetic demo is available with `npm run demo -- --no-performance --no-pdf` (browser rendering still needs a browser).

Contributions should preserve evidence provenance, per-user account isolation and the distinction between measured issues, hypotheses and opportunities.

## License

[MIT](LICENSE).