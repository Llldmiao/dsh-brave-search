# Brave Search — DeepSeek Harness plugin

A Host-side bundle that turns the official [Brave Search API skills](https://github.com/brave/brave-search-skills) (`curl` + `SKILL.md` instructions) into first-class Harness tools. Instead of asking an agent to read a skill and shell out to `curl`, the agent calls typed tools and gets compact, token-budgeted text back.

Converted from `brave-search-skills` v1.5.0 (`skills/` directory: 11 HTTP endpoints plus the `bx` CLI skill).

## Tools

| Tool | Brave endpoints | Use it for |
|---|---|---|
| `brave_search` | `/res/v1/web/search`, `/res/v1/news/search`, `/res/v1/images/search`, `/res/v1/videos/search` | Ranked results with title, URL and snippet; pick the index with `type` |
| `brave_llm_context` | `/res/v1/llm/context` | Pre-extracted page content sized to a token budget — the grounding endpoint |
| `brave_answers` | `/res/v1/chat/completions` | AI-grounded answer with citations; `research: true` for the slower multi-search mode |
| `brave_local` | `/res/v1/local/place_search`, `/res/v1/local/pois`, `/res/v1/local/descriptions` | Businesses and places by query/location/coordinates, POI details, AI-written POI text |
| `brave_query` | `/res/v1/suggest/search`, `/res/v1/spellcheck/search` | Autocomplete candidates and "did you mean" correction |

It also registers a `brave` search provider with `ctx.web` (`/res/v1/web/search`), so the built-in `web_search` tool can use Brave — see [Use Brave as the default `web_search` provider](#use-brave-as-the-default-web_search-provider).

Every tool returns `{ endpoint, query, count, text, … }`; `text` is the rendered block the model reads, and the other fields stay available to programmatic callers (PTC mode).

Endpoint capabilities are enforced per route, following the documented API: `offset` is only sent for web/news/videos, `goggles` is not sent to images/videos, `freshness` is not sent to images, `extra_snippets` only to web/news, `result_filter` only to web, and `safesearch=moderate` is rejected for images instead of being sent and failing with a 422.

## Requirements

- DeepSeek Harness Desktop (verified against `0.2.1-rc.3`).
- A Brave Search API subscription. Create the key at <https://api.search.brave.com>. Endpoints sit on different plans: web/news/images/videos/llm-context/pois/descriptions need the **Search** plan, `place_search` needs Search with the locations option, `suggest` needs the **Suggest** plan, `spellcheck` the **Spellcheck** plan, and answers the **Answers** plan. A tool whose plan is missing returns HTTP 401/403 with an explanatory message.

## Install

There are two ways to get the bundle into a Harness profile. Both end in the same place: a `brave-search` row in the profile, switched on in the **Plugins** page.

### Step 1 — the API key (both ways)

The Harness loads `$DSH_HOME/.env` (by default `~/.dsh/.env`) at launch and materializes those values into `process.env`:

```bash
printf 'BRAVE_SEARCH_API_KEY=%s\n' 'your-key' >> ~/.dsh/.env
```

This is the same layer the Harness already uses for other gateway keys, and it does not travel with a repository. A key exported in the launching shell also works and takes precedence. The key is never read from this package or from the plugin patch.

Restart the Harness once so the new environment value is loaded.

### Option A — install from a local checkout (recommended for development)

Clone the repository anywhere, then install it as a linked package so edits to `index.js` are picked up on the next Harness restart:

```bash
git clone https://github.com/Llldmiao/dsh-brave-search.git ~/development/github/dsh-brave-search

"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "link:$HOME/development/github/dsh-brave-search"
```

Then open **Plugins** in the Harness sidebar and switch the `brave-search` row on. Selecting the bundle is what adds it to the profile's `dsh.profile.bundles`; the CLI command alone only installs the package.

Prefer the GUI when you can — in the **Plugins** page, choose *add plugin* and point it at the checkout directory.

### Option B — install from npm

Once published, any machine can install the bundle by name:

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add dsh-plugin-brave-search
```

then switch the `brave-search` row on in the **Plugins** page. An npm install is a normal (non-linked) package: upgrading means installing the new version with the same command and restarting.

### Verify the install

After the restart, a search through the Harness should come back from Brave. With the provider enabled, `web_search` returns sources with no answer text; `brave_search` returns the rendered result list. If the row shows 异常, the **Plugins** page detail view prints the reason under 原因 (see [Troubleshooting](#troubleshooting)).

## Configuration

The patch row accepts these optional fields (defaults shown):

```yaml
- id: brave-search
  config:
    apiKeyEnv: BRAVE_SEARCH_API_KEY   # environment variable holding the token
    baseUrl: https://api.search.brave.com
    timeoutMs: 30000                  # per-call budget; research answers allow up to 330000
    count: 10                         # default result count per call
```

Brave's own per-endpoint defaults are 20 results for web/news/videos, 50 for images and 20 for place search. The bundle defaults to 10 to keep tool results affordable, and each tool exposes `count` so the model can ask for more.

`baseUrl` may carry a path prefix (for example `https://gateway.example/brave`); the prefix is preserved when the route is appended.

## Use Brave as the default `web_search` provider

Besides its own tools, the bundle registers a search provider with the Harness web seam (`ctx.web`), so the shipped `web_search` tool can run on Brave instead of another provider. The provider id is `brave` (override with `config.id`).

The web seam picks exactly one provider per call: a pinned id wins when registered and usable, otherwise a single usable provider auto-selects and several usable providers raise `WEB_PROVIDER_AMBIGUOUS`. To make Brave the default, pin it in the profile patch (a bundle cannot set another package's config from its own patch):

```yaml
- id: web
  config:
    searchProvider: brave
# Unmount the provider you are replacing; two usable providers without a pin is an error.
- id: web-search-deepseek
  config:
    enabled: false
```

`web_search` (no answer text, sources only) and `web_fetch` (unchanged, still the local HTTP provider) then route through Brave. The provider's `available()` only checks that the token variable is set; it never makes a network call.

The provider attaches lazily through `ctx.inject(['web'], ...)` rather than being listed in the bundle's top-level `inject`. A top-level entry is *required*: on a deployment without a web seam cordis throws `cannot get property "web" without inject` when `apply` touches `ctx.web`, which marks the whole bundle as 异常 in the Plugins page instead of just skipping the provider. Keep `web` out of the top-level list.

To keep both providers mounted, leave the DeepSeek row enabled and switch by editing `searchProvider` (or `DSH_WEB_SEARCH_PROVIDER`) between `brave` and `deepseek-official`; the two ids coexist.

## Security notes

- Tool descriptions tell the model that Brave results are external, untrusted data and must not be followed as instructions. The same rule is what the shipped `web_search` tool applies.
- The subscription token is sent only to the configured base URL, in the `X-Subscription-Token` header, and never appears in tool output.
- No credential is stored in this directory.

## Verification

`test/verify.mjs` is a self-contained harness that loads the real `@deepseek-ai/dsh-tools` schema validators extracted from the installed Harness, registers the bundle into a fake context, and runs every tool against a local mock of the Brave API. It asserts the outgoing request (route, query parameters, headers, method, body), the parsed and rendered output, the declared output schema, and the error paths.

```bash
node test/verify.mjs   # OK — 148 assertions passed across 5 tools
```

It depends on a vendor copy of the Harness packages, extracted from the installed app:

```bash
node ../scratch/dsh-plugin/asar-extract.mjs \
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" \
  ../scratch/dsh-plugin/vendor "dsh/node_modules/@deepseek-ai"
```

What the harness does **not** cover: the bundle is not installed into a live profile by it, so activation, slot-free Host registration order, the Plugins-page inventory entry, and the icon rendering are verified only after installing. Live Brave responses were not exercised because no API key was available at build time; the request shapes follow the documented API and the skills this bundle was converted from.

The seam provider is verified live with a throwaway context, which exercises the real Brave API without installing into a profile:

```bash
set -a; . ~/.dsh/.env; set +a
node --input-type=module -e "
const mod = await import('$PWD/index.js')
const providers = []
mod.apply({ web: { registerSearchProvider: (p) => providers.push(p) }, tools: { register: () => () => {} }, effect: (fn) => fn() }, {})
const [provider] = providers
console.log(provider.id, provider.available())
console.log(await provider.search({ query: '今天北京天气', maxResults: 3 }))
"
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Row shows 异常, 原因 reads `cannot get property "web" without inject` | The bundle read `ctx.web` directly in `apply`. cordis only allows property access on services listed in the plugin's `inject`. | Don't list `web` in the top-level `inject` — it would make the whole bundle *require* a web seam and fail on deployments without one. Register the provider through `ctx.inject(['web'], cb)` instead, which is what `registerAsWebSearchProvider` does. |
| `web_search` fails with `WEB_PROVIDER_CONFIGURED_MISSING: brave` | The profile pins `searchProvider: brave` but the bundle is disabled or not loaded. | Enable the row in **Plugins**, or remove the pin to fall back to auto-selection. |
| `web_search` fails with `WEB_PROVIDER_AMBIGUOUS` | Two usable providers are registered and none is pinned. | Pin one: `searchProvider: brave` on the `web` row, or disable the other provider. |
| `brave_search` returns HTTP 401/403 | The key lacks the plan that endpoint needs (suggest/spellcheck/answers are separate plans). | See [Requirements](#requirements). |

## Publishing to npm

The package is publish-ready: `package.json` carries `name`, `license`, `repository`, `files` and `publishConfig.access: public`, and `files` ships only the runtime pieces (`index.js`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`) — the test harness and README are not in the tarball.

```bash
npm publish --registry=https://registry.npmjs.org --dry-run   # inspect the tarball first
npm publish --registry=https://registry.npmjs.org
```

Notes:

- The package is unscoped, `dsh-plugin-brave-search`, so it publishes straight to the public registry under that name with no scope setup. A scoped name (`@name/...`) only works when an organization with exactly that name exists; npm usernames are lowercase and the account is `llldmiao`, so `@lldmiao/...` does not resolve and fails with `E404 Scope not found`.
- Unscoped names are first-come-first-served on the public registry, so the name must still be free at publish time.
- Release only reaches npm after the repository is pushed and tagged, e.g. `git tag v1.0.0 && git push --tags`. Keep `package.json` `version` and the tag in step.
- `index.js` has no dependencies, so there is nothing to bundle and no `node_modules` in the tarball.

## Layout

```text
dsh-brave-search/
├── index.js            # Host half: tool definitions, Brave client, web-seam provider
├── package.json        # bundle manifest (dsh.bundle.patch) + npm metadata
├── cordis.patch.yml    # inserts the `brave-search` row
├── locale/en.json      # Plugin Manager title/description
├── locale/zh.json
├── icon.svg            # original artwork for the plugin row
├── LICENSE
└── test/verify.mjs     # local verification harness
```

`index.js` imports nothing. The tool definitions are plain registry objects (the same shape `defineTool` produces), so a linked install needs no dependency tree and keeps loading across Harness upgrades. If a future Harness changes the tool-definition contract, this file is the only one that needs updating.
