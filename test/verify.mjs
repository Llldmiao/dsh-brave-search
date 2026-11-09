/**
 * Local verification harness for the Brave Search bundle.
 *
 * Loads the vendor copy of @deepseek-ai/dsh-tools extracted from the running
 * Harness, so the schema assertions are the real ones the registry applies at
 * register time and the value assertions are the real ones the execution
 * pipeline applies to a tool result. The Brave API itself is replaced by a
 * local HTTP server: the test asserts the outgoing request (path, query,
 * headers) and the parsed/rendered tool output.
 *
 * Run: node test/verify.mjs
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// The real schema validators live in the installed Harness. Resolution order:
//   1. $DSH_VENDOR_DIR        — explicit override (vendor copy extracted from app.asar)
//   2. the local scratch copy — how this bundle was developed
//   3. node resolution        — an installed @deepseek-ai/dsh-tools
const DSH_TOOLS = path.join('@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
const candidates = [
  process.env.DSH_VENDOR_DIR,
  path.join(here, '..', '..', '..', 'scratch', 'dsh-plugin', 'vendor', 'dsh', 'node_modules'),
  undefined,
]
  .filter((root) => root === undefined || root !== '')
  .map((root) => (root === undefined ? '@deepseek-ai/dsh-tools/lib/index.js' : path.join(root, DSH_TOOLS)));

let toolsModule;
const tried = [];
for (const candidate of candidates) {
  try {
    toolsModule = await import(candidate);
    break;
  } catch (error) {
    tried.push(`${candidate} (${error.code ?? error.message})`);
  }
}
if (toolsModule === undefined) {
  console.error(
    [
      'Cannot load the real @deepseek-ai/dsh-tools schema validators.',
      'Point DSH_VENDOR_DIR at a directory containing @deepseek-ai/dsh-tools, e.g.',
      '',
      '  node ../scratch/dsh-plugin/asar-extract.mjs \\',
      '    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" \\',
      '    ../scratch/dsh-plugin/vendor "dsh/node_modules/@deepseek-ai"',
      '  DSH_VENDOR_DIR=../scratch/dsh-plugin/vendor/dsh/node_modules node test/verify.mjs',
      '',
      'Tried:',
      ...tried.map((line) => `  - ${line}`),
    ].join('\n'),
  );
  process.exit(2);
}
const { assertSupportedJsonSchema, validateJsonSchemaValue } = toolsModule;

const plugin = await import(path.join(here, '..', 'index.js'));

let checks = 0;
function check(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.deepEqual(actual, expected, message);
}

/** Requests the mock server observed, in call order. */
const seen = [];

/** Recorded handler bodies per endpoint path. */
const routes = {
  '/res/v1/web/search': () => ({
    type: 'search',
    query: { original: 'rust async' },
    web: {
      results: [
        {
          title: 'Async Rust',
          url: 'https://example.com/async',
          description: 'Async programming in Rust.',
          age: '2 days ago',
          profile: { long_name: 'Example' },
          extra_snippets: ['extra one'],
        },
      ],
    },
  }),
  '/res/v1/news/search': () => ({
    type: 'news',
    results: [{ title: 'Launch', url: 'https://example.com/news', description: 'A launch happened.', age: '3 hours ago' }],
  }),
  '/res/v1/images/search': () => ({
    type: 'images',
    query: { original: 'rust logo', altered: 'rust logo' },
    results: [
      {
        title: 'Rust logo',
        url: 'https://example.com/page',
        source: 'example.com',
        thumbnail: { src: 'https://imgs.example.com/t.jpg' },
        properties: { url: 'https://imgs.example.com/full.png', width: 800, height: 600 },
      },
    ],
  }),
  '/res/v1/videos/search': () => ({
    type: 'videos',
    results: [
      {
        title: 'Rust in 10 minutes',
        url: 'https://video.example.com/v',
        description: 'A quick tour.',
        video: { creator: 'Example', duration: '10:00', views: 1234 },
        thumbnail: { src: 'https://imgs.example.com/v.jpg' },
      },
    ],
  }),
  '/res/v1/llm/context': () => ({
    grounding: {
      generic: [{ url: 'https://docs.example.com/a', title: 'Docs A', snippets: ['snippet alpha', 'snippet beta'] }],
    },
    sources: { 'https://docs.example.com/a': { title: 'Docs A', hostname: 'docs.example.com' } },
  }),
  '/res/v1/local/place_search': () => ({
    type: 'locations',
    results: [
      {
        type: 'location_result',
        id: 'loc-1',
        title: 'Coffee Bar',
        description: 'A cafe.',
        postal_address: { displayAddress: '1 Main St, Springfield' },
        contact: { telephone: '+1 555 0100' },
        rating: { ratingValue: 4.5, reviewCount: 120 },
        opening_hours: { current_day: [{ abbr_name: 'Mon', full_name: 'Monday', opens: '08:00', closes: '18:00' }] },
        price_range: '$$',
        distance: { value: 1.2, units: 'km' },
        coordinates: { latitude: 37.1, longitude: -122.2 },
        categories: ['cafe'],
        url: 'https://places.example.com/loc-1',
      },
    ],
  }),
  '/res/v1/local/pois': () => ({
    type: 'local_pois',
    results: [{ id: 'loc-1', title: 'Coffee Bar', description: 'A cafe.', postal_address: { displayAddress: '1 Main St' } }],
  }),
  '/res/v1/local/descriptions': () => ({
    type: 'local_descriptions',
    results: [{ type: 'local_description', id: 'loc-1', description: '### Coffee Bar\nA relaxed cafe.' }, null],
  }),
  '/res/v1/suggest/search': () => ({
    type: 'suggest',
    query: { original: 'rust ' },
    results: [{ query: 'rust async' }, { query: 'rust book' }],
  }),
  '/res/v1/spellcheck/search': () => ({
    type: 'spellcheck',
    query: { original: 'rust asynk' },
    results: [{ query: 'rust async' }],
  }),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    seen.push({
      path: url.pathname,
      params: [...url.searchParams.entries()],
      headers: req.headers,
      method: req.method,
      body: raw === '' ? undefined : JSON.parse(raw),
    });

    if (url.pathname === '/res/v1/chat/completions') {
      const body = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (body.enable_research === true) {
        res.write('data: {"choices":[{"delta":{"content":"<queries>a</queries>"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"<thinking>hmm</thinking>"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"<answer>Research answer.</answer>"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"<usage>{}</usage>"}}]}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"Plain "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"answer."},"citations":["https://a.example"]}]}\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (url.searchParams.get('q') === 'trigger-401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"code":"UNAUTHORIZED","message":"invalid token"}}');
      return;
    }
    if (url.searchParams.get('q') === 'trigger-422') {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end('{"error":{"code":"VALIDATION","message":"count must be <= 20"}}');
      return;
    }
    if (url.pathname === '/res/v1/error/unauthorized') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"code":"UNAUTHORIZED","message":"invalid token"}}');
      return;
    }
    if (url.pathname === '/res/v1/error/badrequest') {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end('{"error":{"code":"VALIDATION","message":"count must be <= 20"}}');
      return;
    }

    const handler = routes[url.pathname];
    if (handler === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"no route"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(handler()));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// 1. Load the plugin into a fake context and validate its definitions.
// ---------------------------------------------------------------------------
const registered = [];
const disposers = [];
const ctx = {
  effect(fn) {
    const disposer = fn();
    if (typeof disposer === 'function') disposers.push(disposer);
    return disposer;
  },
  tools: {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  },
};

process.env.BRAVE_SEARCH_API_KEY = 'test-subscription-token';
plugin.apply(ctx, { baseUrl, count: 5, timeoutMs: 5_000 });

equal(plugin.inject, ['tools'], 'plugin declares the tools dependency');
equal(registered.length, 5, 'plugin registers five tools');
equal(
  registered.map((tool) => tool.name),
  ['brave_search', 'brave_llm_context', 'brave_answers', 'brave_local', 'brave_query'],
  'tool names are stable',
);

for (const tool of registered) {
  check(typeof tool.description === 'string' && tool.description.length > 40, `${tool.name} has a description`);
  check(tool.parameters.type === 'object', `${tool.name} parameters are object-rooted`);
  assertSupportedJsonSchema(tool.parameters);
  assertSupportedJsonSchema(tool.output.schema);
  check(typeof tool.output.render === 'function', `${tool.name} declares output.render`);
  checks += 2;
  // `required` must name declared properties.
  for (const name of tool.parameters.required ?? []) {
    check(Object.hasOwn(tool.parameters.properties, name), `${tool.name} required "${name}" is declared`);
  }
}

const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]));

// The model-facing schema must describe the real contract, even though this
// bundle bypasses defineTool's argument pre-validation (it validates queries and
// coerces numbers itself, which the next section exercises).
equal(validateJsonSchemaValue(byName.brave_search.parameters, { q: 'x' }, 'args'), [], 'a minimal search call satisfies the schema');
check(validateJsonSchemaValue(byName.brave_search.parameters, {}, 'args').length > 0, 'the schema requires q');
check(
  validateJsonSchemaValue(byName.brave_search.parameters, { q: 'x', type: 'podcasts' }, 'args').length > 0,
  'the schema enumerates the search types',
);
check(
  validateJsonSchemaValue(byName.brave_local.parameters, { detail: 'pois', ids: ['a'] }, 'args').length === 0,
  'the local schema accepts an ids array',
);
check(
  validateJsonSchemaValue(byName.brave_query.parameters, { mode: 'spellcheck', q: 'x' }, 'args').length === 0,
  'the query-assist schema accepts spellcheck mode',
);
checks += 4;

/** Run one tool and assert its value against the declared output schema. */
async function run(name, args) {
  const tool = byName[name];
  const value = await tool.execute(args, { signal: AbortSignal.timeout(10_000) });
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'value');
  equal(violations, [], `${name} output matches its declared schema`);
  const content = tool.output.render(args, value);
  check(Array.isArray(content) && content[0].type === 'text' && content[0].text.length > 0, `${name} renders text content`);
  return { value, text: content[0].text };
}

// ---------------------------------------------------------------------------
// 2. Web search: request shape, output, and the auth header.
// ---------------------------------------------------------------------------
seen.length = 0;
const web = await run('brave_search', { q: 'rust async', type: 'web', count: 5, freshness: 'pw', extra_snippets: true });
const webRequest = seen.at(-1);
equal(webRequest.path, '/res/v1/web/search', 'web search hits the web endpoint');
equal(webRequest.method, 'GET', 'web search uses GET');
equal(webRequest.headers['x-subscription-token'], 'test-subscription-token', 'the subscription token header is sent');
const webParams = Object.fromEntries(webRequest.params);
equal(webParams.q, 'rust async', 'the query is forwarded');
equal(webParams.count, '5', 'count is forwarded');
equal(webParams.freshness, 'pw', 'freshness is forwarded for web');
equal(webParams.extra_snippets, 'true', 'extra_snippets is forwarded for web');
check(web.text.includes('Async Rust') && web.text.includes('https://example.com/async'), 'web text carries title and URL');
check(web.text.includes('extra one'), 'web text carries extra snippets');
equal(web.value.count, 1, 'web result count is reported');

// ---------------------------------------------------------------------------
// 3. Per-endpoint capability filtering.
// ---------------------------------------------------------------------------
seen.length = 0;
await run('brave_search', { q: 'rust logo', type: 'images', freshness: 'pw', goggles: '$discard', extra_snippets: true, offset: 3 });
const imageParams = Object.fromEntries(seen.at(-1).params);
check(!('freshness' in imageParams), 'images does not forward freshness');
check(!('goggles' in imageParams), 'images does not forward goggles');
check(!('offset' in imageParams), 'images does not forward offset');
check(!('extra_snippets' in imageParams), 'images does not forward extra_snippets');

seen.length = 0;
await run('brave_search', { q: 'rust video', type: 'videos', goggles: '$discard' });
const videoParams = Object.fromEntries(seen.at(-1).params);
check(!('goggles' in videoParams), 'videos does not forward goggles');

seen.length = 0;
await run('brave_search', { q: 'news', type: 'news', goggles: '$discard', extra_snippets: true, result_filter: 'news' });
const newsParams = Object.fromEntries(seen.at(-1).params);
equal(newsParams.goggles, '$discard', 'news forwards goggles');
equal(newsParams.extra_snippets, 'true', 'news forwards extra_snippets');
check(!('result_filter' in newsParams), 'news does not forward result_filter');

// Images must reject safesearch=moderate instead of silently sending it.
await assert.rejects(
  () => run('brave_search', { q: 'x', type: 'images', safesearch: 'moderate' }),
  /safesearch off \| strict/,
  'images rejects safesearch=moderate',
);
checks += 1;

// ---------------------------------------------------------------------------
// 4. LLM context uses the documented token-budget parameter names.
// ---------------------------------------------------------------------------
seen.length = 0;
const contextResult = await run('brave_llm_context', {
  q: 'retrieval augmented generation',
  max_tokens: 4096,
  max_tokens_per_url: 1024,
  threshold_mode: 'strict',
  enable_source_metadata: true,
});
const contextParams = Object.fromEntries(seen.at(-1).params);
equal(seen.at(-1).path, '/res/v1/llm/context', 'llm context hits the context endpoint');
equal(contextParams.maximum_number_of_tokens, '4096', 'the documented total-token parameter is sent');
equal(contextParams.maximum_number_of_tokens_per_url, '1024', 'the documented per-URL token parameter is sent');
equal(contextParams.context_threshold_mode, 'strict', 'threshold mode is sent');
equal(contextParams.enable_source_metadata, 'true', 'source metadata flag is sent');
check(!('max_tokens' in contextParams), 'the undocumented max_tokens name is never sent');
check(contextResult.text.includes('snippet alpha'), 'context text carries extracted snippets');

// Out-of-range values are clamped, not rejected.
seen.length = 0;
await run('brave_llm_context', { q: 'x', max_tokens: 5 });
equal(Object.fromEntries(seen.at(-1).params).maximum_number_of_tokens, '1024', 'the token budget is clamped to the documented minimum');

// ---------------------------------------------------------------------------
// 5. Answers: streaming, citations, research tag unwrapping.
// ---------------------------------------------------------------------------
seen.length = 0;
const plainAnswer = await run('brave_answers', { question: 'What is Brave Search?' });
const answerRequest = seen.at(-1);
equal(answerRequest.path, '/res/v1/chat/completions', 'answers hits the chat completions endpoint');
equal(answerRequest.method, 'POST', 'answers uses POST');
equal(answerRequest.body.stream, true, 'answers always streams');
equal(answerRequest.body.enable_research, undefined, 'research is off by default');
equal(answerRequest.body.messages[0].content, 'What is Brave Search?', 'the question becomes the user message');
check(plainAnswer.text.includes('Plain answer.'), 'streamed chunks are reassembled');
check(plainAnswer.text.includes('https://a.example'), 'citations are listed');
equal(plainAnswer.value.citations, ['https://a.example'], 'citations are returned as data');

seen.length = 0;
const researchAnswer = await run('brave_answers', { question: 'Deep question', research: true });
equal(seen.at(-1).body.enable_research, true, 'research mode sets enable_research');
check(!researchAnswer.text.includes('<queries>'), 'research control tags are stripped');
check(!researchAnswer.text.includes('<thinking>'), 'research thinking is stripped');
check(!researchAnswer.text.includes('<usage>'), 'research usage is stripped');
check(researchAnswer.text.includes('Research answer.'), 'the final answer is kept');

// A question is a chat message, not a search query: the 400-character search cap
// must not apply to it.
seen.length = 0;
await run('brave_answers', { question: 'Why '.repeat(150) + 'does this work?' });
equal(seen.at(-1).path, '/res/v1/chat/completions', 'a long question is still accepted');
checks += 1;

// ---------------------------------------------------------------------------
// 6. Local endpoints, including repeated ids parameters.
// ---------------------------------------------------------------------------
seen.length = 0;
const places = await run('brave_local', { detail: 'search', q: 'coffee shops', location: 'san francisco ca united states', count: 5 });
const placeParams = Object.fromEntries(seen.at(-1).params);
equal(seen.at(-1).path, '/res/v1/local/place_search', 'place search hits its endpoint');
equal(placeParams.q, 'coffee shops', 'place query is forwarded');
equal(placeParams.location, 'san francisco ca united states', 'location is forwarded');
check(places.text.includes('Coffee Bar') && places.text.includes('4.5 from 120 reviews'), 'place text carries rating and review count');
check(places.text.includes('loc-1'), 'place text exposes the reusable POI id');
check(places.text.includes('Monday 08:00-18:00'), 'opening hours are readable');

seen.length = 0;
await run('brave_local', { detail: 'search', q: 'x', coordinates: '37.7749,-122.4194' });
const coordParams = Object.fromEntries(seen.at(-1).params);
equal(coordParams.latitude, '37.7749', 'coordinates become latitude');
equal(coordParams.longitude, '-122.4194', 'coordinates become longitude');

seen.length = 0;
const pois = await run('brave_local', { detail: 'pois', ids: ['loc-1', 'loc=2'] });
const poiRequest = seen.at(-1);
equal(poiRequest.path, '/res/v1/local/pois', 'poi details hit their endpoint');
equal(
  poiRequest.params.filter(([key]) => key === 'ids').map(([, value]) => value),
  ['loc-1', 'loc=2'],
  'ids are repeated query parameters, not one comma-joined value',
);
check(pois.text.includes('Coffee Bar'), 'poi text carries the business');

seen.length = 0;
const descriptions = await run('brave_local', { detail: 'descriptions', ids: ['loc-1'] });
check(descriptions.text.includes('A relaxed cafe.'), 'descriptions carry the AI text');
check(descriptions.text.includes('no description available'), 'null description entries are handled');

await assert.rejects(() => run('brave_local', { detail: 'pois' }), /at least one POI id/, 'poi details require ids');
await assert.rejects(
  () => run('brave_local', { detail: 'pois', ids: Array.from({ length: 21 }, (_, i) => `id${i}`) }),
  /at most 20 POI ids/,
  'the POI id cap is enforced locally',
);
await assert.rejects(() => run('brave_local', { detail: 'search' }), /needs one of q, location or coordinates/, 'place search requires an anchor');
await assert.rejects(() => run('brave_local', { detail: 'search', q: 'x', coordinates: '200,10' }), /latitude must be between/, 'latitude range is validated');
checks += 4;

// ---------------------------------------------------------------------------
// 7. Suggest and spellcheck.
// ---------------------------------------------------------------------------
seen.length = 0;
const suggest = await run('brave_query', { q: 'rust ', rich: true });
const suggestParams = Object.fromEntries(seen.at(-1).params);
equal(seen.at(-1).path, '/res/v1/suggest/search', 'suggest hits its endpoint');
equal(suggestParams.rich, 'true', 'rich is forwarded');
check(suggest.text.includes('rust async') && suggest.text.includes('rust book'), 'suggestions are listed');

seen.length = 0;
const spell = await run('brave_query', { mode: 'spellcheck', q: 'rust asynk' });
equal(seen.at(-1).path, '/res/v1/spellcheck/search', 'spellcheck hits its endpoint');
check(spell.text.includes('rust asynk') && spell.text.includes('rust async'), 'the correction is reported from results[].query');

// ---------------------------------------------------------------------------
// 8. Input validation and environment handling.
// ---------------------------------------------------------------------------
await assert.rejects(() => run('brave_search', { q: '   ' }), /`q` is required/, 'blank queries are rejected');
await assert.rejects(() => run('brave_search', { q: 'x'.repeat(401) }), /at most 400/, 'over-long queries are rejected');
await assert.rejects(() => run('brave_search', { q: 'x', type: 'nope' }), /Unknown search type/, 'unknown search types are rejected');
checks += 3;

const savedKey = process.env.BRAVE_SEARCH_API_KEY;
delete process.env.BRAVE_SEARCH_API_KEY;
await assert.rejects(() => run('brave_search', { q: 'x' }), /API key is not configured/, 'a missing key produces an actionable error');
process.env.BRAVE_SEARCH_API_KEY = 'your-key';
await assert.rejects(() => run('brave_search', { q: 'x' }), /placeholder/, 'a placeholder key is rejected');
process.env.BRAVE_SEARCH_API_KEY = savedKey;
checks += 2;

// HTTP failures map to actionable messages.
await assert.rejects(() => run('brave_search', { q: 'trigger-401' }), /HTTP 401.*rejected/s, 'a 401 reports a rejected key');
await assert.rejects(() => run('brave_search', { q: 'trigger-422' }), /HTTP 422.*rejected a parameter/s, 'a 422 reports a rejected parameter');
await assert.rejects(() => run('brave_search', { q: 'trigger-422' }), /count must be <= 20/, 'the API detail is preserved in the error');
checks += 3;

// A base URL with a path prefix survives URL construction (gateway deployments).
{
  const prefixed = [];
  plugin.apply(
    {
      effect: (fn) => fn(),
      tools: { register: (definition) => (prefixed.push(definition), () => {}) },
    },
    { baseUrl: `${baseUrl}/gateway/`, timeoutMs: 3_000 },
  );
  seen.length = 0;
  await assert.rejects(() => prefixed[0].execute({ q: 'x' }, {}), /HTTP 404/, 'a prefixed base URL is preserved');
  equal(seen.at(-1).path, '/gateway/res/v1/web/search', 'the configured base path is kept in front of the route');
  checks += 1;
}

// Unreachable host produces a network diagnostic rather than a stack trace.
const unreachable = [];
const unreachableCtx = {
  effect(fn) {
    return fn();
  },
  tools: {
    register(definition) {
      unreachable.push(definition);
      return () => {};
    },
  },
};
plugin.apply(unreachableCtx, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 });
await assert.rejects(
  () => unreachable[0].execute({ q: 'x' }, {}),
  /could not reach/,
  'a network failure is reported as unreachable',
);
checks += 1;

// Disposal: every registration handed the context a disposer, so unloading the
// plugin unregisters all five tools.
equal(disposers.length, 5, 'each tool registration supplied a disposer to ctx.effect');
check(disposers.every((dispose) => typeof dispose === 'function'), 'every disposer is callable');

server.close();

console.log(`\nOK — ${checks} assertions passed across ${registered.length} tools.`);
