# Search Console and portable evidence imports

The public audit works without Google sign-in or a paid SEO data provider. Search Console adds evidence from the Google account that each auditor chooses. This skill contains no creator account, property ID, refresh token, or hosted account service.

## Connect your own account

Run commands from the skill directory. The same --data-dir must be used for connection and audit commands; the default is ./.search-audit in the current directory.

1. In your own Google Cloud project, enable the Search Console API, configure OAuth consent, and create an OAuth client of type **Desktop app**.
2. Download that client's JSON. Keep it outside the report output and source control. A client JSON identifies the application; it does not grant access to another user's properties.
3. Explicitly connect the profile you want:

~~~sh
node scripts/audit.mjs auth connect --profile client-a --client "/path/to/oauth-client.json"
node scripts/audit.mjs gsc properties --profile client-a
node scripts/audit.mjs auth list
~~~

The connect command opens the system browser. Use --no-open to print the authorization URL and open it manually. A listener bound to 127.0.0.1 on a random port accepts the callback. It checks the request host, callback path, unique state, and authorization code; PKCE S256 protects the code exchange. Authorization expires after three minutes. A declined sign-in does not prevent a public audit or file import.

Only the read-only scope is requested:

~~~text
https://www.googleapis.com/auth/webmasters.readonly
~~~

Sign in to the account that already has access to the website's Search Console property. If an OAuth application is in testing, configure its eligible test users in Google Cloud; consent and verification requirements depend on the app's distribution. Desktop clients cannot safely keep a client secret confidential: the user's refresh token is the sensitive credential.

## Bind each website to an accessible property

~~~sh
node scripts/audit.mjs audit https://www.example.com/ --gsc-profile client-a --gsc-property sc-domain:example.com --start 2026-01-01 --end 2026-03-31 --inspect 10
~~~

Use the exact ID returned by gsc properties. A Domain property such as sc-domain:example.com contains the domain's subdomains and protocols. A URL-prefix property such as https://www.example.com/shop/ is limited to its protocol, hostname, port, and URL prefix. Similar-looking domain strings do not match.

Access and target coverage are revalidated for every collection. Even if a broad Domain property is selected, Search Analytics is filtered to the audit target URL prefix and out-of-scope returned rows are excluded. The CLI saves the selected profile/property against the local website project. It selects a property automatically only when exactly one accessible property matches; otherwise pass --gsc-property.

A profile is a local connection label, not proof of ownership. The currently authorized Google account's property access determines what can be read. Give different Google accounts separate profile names.

## Credential storage and disconnect

- Windows: tokens are protected with DPAPI CurrentUser. Only ciphertext and non-secret profile metadata are written below the selected data directory.
- macOS: tokens are stored in the current user's Keychain using the security command.
- Linux: tokens are stored through secret-tool and the user's Secret Service. The command and an unlocked secret service must be available.
- Unsupported or locked stores fail closed. There is no plaintext token fallback. File imports remain available.

Tokens, client secrets, authorization codes, and PKCE verifiers are not included in auth list or returned audit evidence. Tokens are sent to credential subprocesses through standard input rather than process arguments. Profile identifiers are validated to prevent directory traversal. Credentials are bound to the data directory and OS user; reconnect after moving a profile to another directory or machine.

~~~sh
node scripts/audit.mjs auth disconnect --profile client-a
~~~

Disconnect attempts Google revocation and removes the local credential. If offline revocation cannot be confirmed, the result explains how to remove the application's Google Account access. On a shared computer, use separate OS accounts and filesystem permissions; project folders do not constitute a hosted multi-tenant security boundary.

## What the collected evidence means

The CLI collects Search Analytics before crawling so its in-scope page URLs can become discovery seeds, including URLs not found through navigation or sitemaps. After crawling it inspects a selected URL sample without refetching Analytics.

Search Analytics is requested with linked query and page dimensions, web search type, finalized data, and the stated inclusive date range. Dates follow Search Console's America/Los_Angeles time zone. Requests are paginated with a maximum 25,000 rows per request and a default 50,000 returned-row budget per collection. Reaching that budget is reported as a possible truncation.

Google does not guarantee all rows, and anonymized queries are not a complete query inventory. Query/page overlap is evidence for an investigation; it does not prove harmful cannibalization or justify automatic consolidation.

URL Inspection uses a bounded set of eligible URLs and records the indexed-version result, timestamp, and failures. It does not run Google's live URL test, request indexing, or establish the status of every URL. Quota or permission failures are reported as unavailable evidence.

## Import evidence without Google sign-in

~~~sh
node scripts/audit.mjs audit https://example.com/ --import "gsc=/path/to/search-performance.json"
node scripts/audit.mjs audit https://example.com/ --import "backlinks=/path/to/links.csv" --import "citations=/path/to/observations.json"
node scripts/audit.mjs audit https://example.com/ --import "logs=/path/to/server-requests.csv"
~~~

Imports accept UTF-8 CSV, TSV, and JSON arrays or objects containing rows. Quoted commas, escaped quotes, and embedded newlines are supported. The default input budget is 50 MiB and 200,000 rows per file. Malformed rows and out-of-scope destinations are counted and excluded. Provenance includes the filename, SHA-256, import timestamp, supplied range, dimensions, and explicit limitations. Source files are not modified.

Use JSON when you need source metadata or a date range:

~~~json
{
  "type": "gsc",
  "source": { "provider": "Search Console export" },
  "range": {
    "startDate": "2026-01-01",
    "endDate": "2026-03-31",
    "timezone": "America/Los_Angeles"
  },
  "rows": [
    {
      "query": "red running shoes",
      "page": "https://example.com/running/",
      "clicks": 12,
      "impressions": 300,
      "ctr": 0.04,
      "position": 6.2
    }
  ],
  "limitations": ["Filtered to the UAE market before export."]
}
~~~

Supported evidence:

| Type | Row fields |
| --- | --- |
| gsc | query, page, optional date, clicks, impressions, ctr, position |
| backlinks | sourceUrl, targetUrl, optional anchor and rel |
| citations | engine, prompt, observedAt, citedUrl; optional sourceUrl, locale, response, citationPresent |
| logs | url, status, observedAt; optional userAgent, ip, method |

Common headers such as Top queries, Top pages, Source URL, Target URL, Anchor Text, User Agent, and Status Code are normalized. CTR accepts fractions such as 0.04 or explicit percentages such as 4%. Separate Queries and Pages exports remain separate summaries: the importer never fabricates a relationship between them. Raw Search Analytics API keys require declared dimensions, for example "dimensions": ["query", "page"].

Citation observations require an engine, prompt, and parseable observation date. A positive citation also requires a URL. A negative observation may set citationPresent to false; it applies only to the recorded test, not all prompts or engines. Imported citations are not independently rechecked.

Server-log request URLs may be absolute or relative to the audit target. Status codes must be 100–599 and observation dates must parse. User-agent strings and IPs are retained as supplied evidence, but bot identity remains not_verified: no DNS or IP-range verification is implied. This importer accepts normalized CSV/JSON, not raw combined/access-log syntax.

Imported rows are retained in local audit evidence. Backlink datasets cannot establish a complete web-wide backlink profile, and do not justify automatic disavowal.

## Verification status

Automated tests cover forged and Unicode OAuth states, PKCE, consent denial, timeout, client endpoint validation, refresh behavior, property boundaries, scoped query/page collection, profile enumeration, CSV quoting, malformed imports, and evidence limits. Windows DPAPI has a real round-trip test using synthetic tokens in temporary directories. macOS and Linux backend paths require validation on their respective operating systems. No automated test signs in to a real Google account.

Official references:

- [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [List accessible Search Console properties](https://developers.google.com/webmaster-tools/v1/sites/list)
- [Domain and URL-prefix property scope](https://support.google.com/webmasters/answer/34592)
- [Search Analytics query and limits](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
- [URL Inspection indexed-version API](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect)
- [Search Console quotas](https://developers.google.com/webmaster-tools/limits)
