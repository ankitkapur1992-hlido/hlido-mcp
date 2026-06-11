// Hlido MCP — Cloudflare Workers edition.
// Replaces netlify/functions/mcp.mjs. Reads review-registry.json from CF Pages
// (or fallback URL), caches via KV namespace MCP_CACHE for 5 minutes.
// Public, no auth. Public-data only — never returns scoring weights, opinion
// fields, or attestation internals.

const VERSION = "3.2.0-workers";
// Bumped 2026-05-03 from 300s to 1800s. With 329 reviews and rising MCP
// traffic, 5-min TTL was driving us into the 1000-puts/day KV free-tier
// limit. 30-min TTL gives 48 puts/day max — plenty of headroom — and the
// edge cf.cacheTtl=300 still keeps responses fast within the 30-min window.
const REGISTRY_TTL = 1800;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
  "Content-Type": "application/json; charset=utf-8",
  // Wave 4 Item #2 — let MCP clients identify the server they're talking to
  // without parsing the body. Pairs with the per-tool /v1/telemetry/event
  // self-emit so rollup can correlate edge logs to surface attribution.
  "Server": `hlido-mcp/${VERSION}`,
};

const jsonRpc = (id, result, error) =>
  new Response(
    JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }),
    { status: 200, headers: cors }
  );

// Tier classification — must match what the public site renders so MCP
// clients filtering by tier see the same labels as users browsing /reviews/.
// Cutoffs aligned 2026-05-03 with public renderer (was 75/55/35 SIGNAL/STEADY
// /WATCH/SKIP — Codex audit caught the divergence). Public scheme:
//   VITAL  ≥ 90  (top tier, our highest endorsement)
//   STEADY ≥ 70  (solid, recommend with caveats)
//   FADING ≥ 40  (works but with significant gaps)
//   FLATLINE < 40 (do not rely on)
const scoreToTier = (s) => (s == null ? "UNSCORED" : s >= 90 ? "VITAL" : s >= 70 ? "STEADY" : s >= 40 ? "FADING" : "FLATLINE");
const reviewUrl = (siteRoot, slug) => `${siteRoot}/reviews/${slug}/`;
const embedUrl = (siteRoot, slug) => `${siteRoot}/embed/${slug}/`;

async function loadRegistry(env) {
  const siteRoot = env.SITE_URL || "https://hlido.eu";
  // Fetch source — keep separate from siteRoot. Workers fetching their own
  // zone (hlido.eu) can hit a recursion guard or pages-fallback HTML; the
  // CF Pages preview alias avoids that loop.
  const fetchSource = env.REGISTRY_FETCH_URL || "https://hlido.pages.dev";
  // KV read is cheap, KV write is daily-rate-limited (1000 puts/day on free
  // tier). 2026-05-03: limit-exceeded was poisoning trust_check + find_trusted
  // because the put error bubbled up and the outer catch returned an empty
  // registry. Now puts are best-effort and isolated.
  if (env.MCP_CACHE) {
    try {
      const cached = await env.MCP_CACHE.get("registry", "json");
      if (cached && Array.isArray(cached?.items) && cached.items.length > 0) {
        return { siteRoot, registry: cached };
      }
    } catch (err) {
      console.log(`[loadRegistry] KV get failed (non-fatal): ${err?.message || err}`);
    }
  }
  const fetchUrl = `${fetchSource}/data/review-registry.json`;
  try {
    const res = await fetch(fetchUrl, { cf: { cacheTtl: 300 } });
    if (!res.ok) {
      console.log(`[loadRegistry] HTTP ${res.status} from ${fetchUrl}`);
      throw new Error(`registry HTTP ${res.status}`);
    }
    const registry = await res.json();
    const itemCount = Array.isArray(registry?.items) ? registry.items.length : -1;
    console.log(`[loadRegistry] fetched ${fetchUrl} — ${itemCount} items`);
    // Best-effort KV cache write — never let a put failure (rate limit,
    // size cap, anything) take down the response.
    if (env.MCP_CACHE) {
      try {
        await env.MCP_CACHE.put("registry", JSON.stringify(registry), { expirationTtl: REGISTRY_TTL });
      } catch (err) {
        console.log(`[loadRegistry] KV put failed (non-fatal): ${err?.message || err}`);
      }
    }
    return { siteRoot, registry };
  } catch (err) {
    console.log(`[loadRegistry] FAILED ${fetchUrl}: ${err?.message || err}`);
    return { siteRoot, registry: { items: [], asOf: "unknown" } };
  }
}

const tokenize = (t) =>
  new Set(
    (t || "")
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((w) => w.length > 1 && !["a","an","and","for","from","in","is","of","on","or","the","to","with"].includes(w)) || []
  );

function similarity(q, c) {
  const qt = (q || "").toLowerCase().trim();
  const ct = (c || "").toLowerCase().trim();
  if (!qt || !ct) return 0;
  if (ct.includes(qt)) return 10;
  const qs = tokenize(qt);
  const cs = tokenize(ct);
  const overlap = [...qs].filter((t) => cs.has(t));
  if (!overlap.length) return 0;
  return overlap.length + overlap.length / Math.max(qs.size, 1);
}

function formatItem(item, siteRoot) {
  const slug = item.slug || "";
  return {
    id: item.id || "",
    slug,
    name: item.name || "",
    category: item.category || "",
    score: item.score ?? null,
    tier: scoreToTier(item.score),
    summary: item.summary || "",
    verdict: item.summary || "",
    published_at: item.publishedAt ?? null,
    updated_at: item.updatedAt ?? null,
    proof_depth: item.proofDepth ?? null,
    evidence_count: item.evidenceCount ?? null,
    c2pa_proof_note: item.proofNote || "",
    review_url: reviewUrl(siteRoot, slug),
    embed_url: embedUrl(siteRoot, slug),
    watch_url: item.watchUrl || null,
    blocker: item.blockerLabel || null,
  };
}

function findBySlugOrUrl(items, ref) {
  if (!ref) return null;
  const r = ref.toLowerCase().trim();
  let hit = items.find((i) => (i.slug || "").toLowerCase() === r);
  if (hit) return hit;
  if (r.includes("://")) {
    try {
      const segs = new URL(ref).pathname.split("/").filter(Boolean);
      const last = segs[segs.length - 1]?.toLowerCase();
      hit = items.find((i) => (i.slug || "").toLowerCase() === last);
      if (hit) return hit;
    } catch {}
  }
  return null;
}

const TOOL_SPECS = [
  { name: "trust_check", description: "Hlido trust answer for one agent (slug or URL).", inputSchema: { type: "object", properties: { agent_or_url: { type: "string" }, use_case: { type: "string" } }, required: ["agent_or_url"] } },
  { name: "find_trusted", description: "Find Hlido-reviewed agents matching a free-text need.", inputSchema: { type: "object", properties: { need: { type: "string" }, min_tier: { type: "string", enum: ["VITAL","STEADY","FADING","FLATLINE"], default: "STEADY" }, limit: { type: "integer", default: 10 } }, required: ["need"] } },
  { name: "verify_claim", description: "Check whether Hlido's review references a specific claim. Honest nulls when not tested.", inputSchema: { type: "object", properties: { agent: { type: "string" }, claim: { type: "string" } }, required: ["agent", "claim"] } },
  { name: "compare_agents", description: "Side-by-side comparison of up to 5 Hlido-reviewed agents.", inputSchema: { type: "object", properties: { slugs: { type: "array", items: { type: "string" } } }, required: ["slugs"] } },
  { name: "submit_agent", description: "Submit an AI agent for Hlido review consideration.", inputSchema: { type: "object", properties: { url: { type: "string" }, name: { type: "string" }, note: { type: "string" } }, required: ["url","name"] } },
  // Public-surface pivot 2026-04-26: get_scorecard returns the full sanitized
  // claim-vs-evidence scorecard for one slug. This is the agent-to-agent thesis
  // artifact — agents calling this tool get every claim, every verdict, every
  // captured command/source-surface, with stable schema_version=1.0. Backed
  // by site/data/scorecards/{slug}.json on hlido.pages.dev (auto-deployed
  // from the repo on every publish).
  { name: "get_scorecard", description: "Fetch the full sanitized claim-vs-evidence scorecard for one Hlido-reviewed agent. Returns every claim, verdict, evidence quote, source surface, and (for CLI/API tests) the captured command + exit_code + duration. Schema v1.0. Use this for agent-to-agent pre-flight evaluation.", inputSchema: { type: "object", properties: { slug: { type: "string", description: "The agent's Hlido slug (e.g. 'aider', 'gumloop')" } }, required: ["slug"] } },
  // Feedback intake 2026-04-26: agents and humans can report issues with a
  // review (stale, wrong, missing claim). Writes to KV under feedback:* keys
  // which scripts/drain-mcp-feedback.mjs pulls into the routine queue.
  { name: "report_review_issue", description: "Report an issue with a Hlido review (stale info, wrong verdict, missing claim, broken link). Use when calling get_scorecard or trust_check returns data you can prove is incorrect. Hlido's R1 maintenance routine processes reports daily and fires re-tests via dispute-retest sub-agent.", inputSchema: { type: "object", properties: { slug: { type: "string", description: "The slug whose review has the issue" }, issue_type: { type: "string", enum: ["stale", "wrong_verdict", "missing_claim", "broken_link", "other"], description: "Category of the report" }, detail: { type: "string", description: "What's wrong, with a concrete reference (URL, claim id, etc) if possible" }, reporter: { type: "string", description: "Optional self-identifier — agent name or email — purely informational" } }, required: ["slug", "issue_type", "detail"] } },
  // Live audit-on-demand 2026-04-26: agent encountered an unknown agent and
  // wants Hlido to audit it now. We queue the request to KV, return a tracking
  // URL + ETA, then R1 drains the queue and fires the standard public-surface
  // run on next cycle (or sooner if the founder triggers manually). Rate-
  // limited to 5/day per anonymous IP, 50/day per identified caller.
  { name: "request_quick_audit", description: "Request that Hlido audit a NEW AI agent that has no review yet. Use this when trust_check or get_scorecard returns no_review_found and you need a verdict before delegating to the unknown agent. Returns a future scorecard URL + ETA. Free-tier rate-limited (5/day per anonymous, 50/day per identified). The audit produces signed evidence + claim verification within ~24h (sooner if founder triggers manually).", inputSchema: { type: "object", properties: { url: { type: "string", description: "Homepage or product URL of the agent to audit" }, name: { type: "string", description: "Optional human-readable name (we'll derive from URL if missing)" }, why: { type: "string", description: "Optional one-liner: why are you considering this agent? helps us prioritize" }, requester: { type: "string", description: "Optional self-identifier — agent name, email, or session id — for rate-limiting + follow-up" } }, required: ["url"] } },
  // Vectorize 2026-04-26: semantic search across Hlido's review corpus. Given
  // a free-text need, returns top-N reviews ranked by embedding similarity.
  // The reviews are embedded on every publish via scripts/embed-review.mjs.
  { name: "find_similar_agents", description: "Semantic search over Hlido's review corpus. Given a task description (e.g. 'I need an agent that can refactor TypeScript and edit multiple files at once'), returns the top-N reviewed agents ranked by embedding similarity, each with their Laddoo score, evidence_tier, and review URL. Use this when you have a task in mind and want Hlido's recommendation — much better than substring matching via find_trusted.", inputSchema: { type: "object", properties: { description: { type: "string", description: "Free-text description of the task or capability you need" }, top_k: { type: "integer", description: "Number of matches to return (default 5, max 20)", default: 5 }, min_score: { type: "integer", description: "Minimum Laddoo score filter (default 0)", default: 0 } }, required: ["description"] } },
  // MCP v2 — in-runtime workflow tools 2026-05-09. Additive only; no existing
  // tool signatures changed. subscribe is advisory until Wave 3 ships persistent
  // watchlists (KV writes are 1k/day on free tier — can't persist webhooks yet).
  // explain pulls structured claim-by-claim evidence from the published
  // scorecard. recommend filters + ranks via existing similarity logic.
  { name: "subscribe", description: "Preview — Wave 3 will add persistent webhook + RSS subscriptions. For now this returns the agent's current state plus advisory polling instructions (RSS at /changelog/feed.xml or polling /data/attestations/{slug}.json). Use this to register interest in being notified when a slug's verdict changes.", inputSchema: { type: "object", properties: { slug: { type: "string", description: "The Hlido slug to subscribe to (e.g. 'cursor', 'aider')" }, channel: { type: "string", enum: ["rss", "json", "webhook"], description: "Preferred notification channel. webhook is advisory only until Wave 3 ships." } }, required: ["slug"] } },
  { name: "explain", description: "Structured natural-language explanation of why a Hlido-reviewed agent has its current score. Pulls claim-by-claim evidence from the published scorecard. Pass an optional dimension (one of: reliability, transparency, integration, security, evidence) to filter; omit for the full picture. Returns each claim with verdict (PASS|FAIL|PARTIAL|UNKNOWN), a quoted evidence snippet, plus a top-line synthesis.", inputSchema: { type: "object", properties: { slug: { type: "string", description: "The agent's Hlido slug" }, dimension: { type: "string", description: "Optional dimension filter. Run without and check supported_dimensions in response if unsure." } }, required: ["slug"] } },
  { name: "recommend", description: "Constraint-driven recommendation across Hlido's reviewed agents. Pass any combination of: category, min_score, tier, use_case, max_results. Returns ranked candidates each with a why_match line. Use this when you have buyer constraints (budget, category, capability) and want Hlido's filtered shortlist instead of one-by-one trust_check calls.", inputSchema: { type: "object", properties: { constraints: { type: "object", properties: { category: { type: "string", description: "Filter by category (e.g. 'Coding', 'Voice', 'Productivity')" }, min_score: { type: "integer", description: "Minimum Laddoo score (0-100)", default: 0 }, tier: { type: "string", enum: ["VITAL", "STEADY", "FADING", "FLATLINE"], description: "Minimum tier filter (VITAL strictest, FLATLINE allows all)" }, use_case: { type: "string", description: "Free-text capability description for ranking (e.g. 'multi-file refactor in TypeScript')" }, max_results: { type: "integer", description: "Cap on results (default 5, max 25)", default: 5 } }, additionalProperties: false } }, required: ["constraints"] } },
  // Phase C 2026-05-18 — behavioral trace tool. Fetches the behavioral
  // evaluation trace for a slug — per-task pass/fail, adapter used, score.
  // Data lives at site/data/behavioral/{slug}.json (CF Pages private deploy).
  // Returns 404-equivalent if the slug hasn't been bench-tested yet.
  // Public fields only: task IDs + outcomes, adapter, score, tier,
  // verdict_summary. Methodology weights and grader assertions are never exposed.
  { name: "get_behavioral_trace", description: "Fetch the behavioral evaluation trace for a Hlido-reviewed agent — per-task pass/fail, adapter used, behavioral tier, and signed trace link. Returns status 'not_yet_bench_tested' if the slug hasn't been evaluated yet, or 'not_testable' if the agent's interface doesn't support automated bench runs. Use this when you need evidence that an agent's coding/task behaviour has been independently verified beyond marketing claims.", inputSchema: { type: "object", properties: { slug: { type: "string", description: "The Hlido slug to fetch behavioral trace for (e.g. 'aider', 'opencode')" }, spec_version: { type: "string", description: "Behavioral spec version (default 'v0.1'). Omit to get the latest available.", default: "v0.1" } }, required: ["slug"] } },
  // FEATURE_INSERT:mcp-tools
  // /FEATURE_INSERT:mcp-tools
];

// Tier ordering for min_tier filters — aligned with public taxonomy 2026-05-03.
const TIER_ORDER = { UNSCORED: 0, FLATLINE: 1, FADING: 2, STEADY: 3, VITAL: 4 };

// ─────────────────────────────────────────────────────────────────────────────
// Wave 2.5 (2026-05-10) — Per-call MCP telemetry to R2.
//
// Why R2 not KV: KV free tier is 1000 writes/day (would burn in hours under
// any real traffic). R2 is 10M class-A ops/month free; daily NDJSON append
// keeps puts to ~48/day per source even under heavy load. See
// reference_cloudflare_free_tier_limits.md.
//
// Pipeline:
//   1. classifyUa(ua) → "agent" | "browser" | "cli" | "unknown"
//   2. logToolCall() pushes {ts, tool_name, slug, ua_class, region} to the
//      module-scope circular buffer (size 64).
//   3. Flush triggers: buffer hits MAX_BUFFER (size 64) OR 30s elapsed since
//      last flush. Both go through event.waitUntil() so the user response
//      isn't blocked.
//   4. flushTelemetry() does a single R2 GET (existing-day NDJSON or empty)
//      + concatenated PUT. Object size stays small — at 1 req/sec that's
//      ~86k rows/day, ~10 MB NDJSON; well within R2 single-object limits.
//
// No PII — UA is classified into 4 buckets and discarded; we never persist
// the raw User-Agent header. Region is from request.cf.colo (CF datacenter
// code), not user IP.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_BUFFER = 64;
const FLUSH_INTERVAL_MS = 30_000;
const TELEMETRY_PREFIX = "telemetry/mcp-calls/";

// Module-scope buffer. Workers reuse isolates across requests within the
// same warm container, so this state survives between calls. On cold start
// or isolate eviction, the buffer is empty — that's fine; we lose at most
// 64 events on a redeploy.
const telemetryBuffer = [];
let lastFlushAt = 0;

function classifyUa(ua) {
  if (!ua) return "unknown";
  const u = ua.toLowerCase();
  // Order matters: agent identifiers (anthropic-claude, openai, ...) are
  // most specific; CLI tools next (curl, httpie, node-fetch); browsers last.
  if (/anthropic|claude|openai|gpt|cohere|gemini|copilot|cursor|aider|crew|autogen|llamaindex|langchain|continue\.dev|codeium|tabby|sweep|devin|smol|babyagi|metagpt|agent\b/.test(u)) return "agent";
  if (/curl|wget|httpie|node-fetch|axios|undici|python-requests|aiohttp|go-http|okhttp|reqwest|cli\b/.test(u)) return "cli";
  if (/mozilla|chrome|safari|firefox|edge|opera|webkit|gecko/.test(u)) return "browser";
  return "unknown";
}

function logToolCall(env, ctx, request, toolName, slugArg) {
  // No-op when the binding is missing — keeps local dev / older deployments
  // working without crashes. Likewise no-op if ctx is unavailable (we need
  // event.waitUntil to not block the response).
  if (!env?.TELEMETRY || !ctx?.waitUntil) return;
  const cf = request?.cf || {};
  const ua = request?.headers?.get?.("user-agent") || "";
  telemetryBuffer.push({
    ts: new Date().toISOString(),
    tool_name: toolName,
    slug: slugArg || null,
    ua_class: classifyUa(ua),
    region: cf.colo || cf.country || null,
  });
  const now = Date.now();
  const shouldFlush =
    telemetryBuffer.length >= MAX_BUFFER ||
    (lastFlushAt > 0 && now - lastFlushAt >= FLUSH_INTERVAL_MS) ||
    lastFlushAt === 0;
  if (shouldFlush) {
    lastFlushAt = now;
    ctx.waitUntil(flushTelemetry(env).catch((err) => {
      // Restore buffer on flush failure so we don't drop events.
      console.log(`[telemetry] flush failed (non-fatal): ${err?.message || err}`);
    }));
  }
}

async function flushTelemetry(env) {
  if (!env.TELEMETRY) return;
  // Snapshot + clear so concurrent calls don't write the same rows twice.
  if (telemetryBuffer.length === 0) return;
  const rows = telemetryBuffer.splice(0, telemetryBuffer.length);
  const day = new Date().toISOString().slice(0, 10);
  const key = `${TELEMETRY_PREFIX}${day}.ndjson`;
  let existing = "";
  try {
    const obj = await env.TELEMETRY.get(key);
    if (obj) existing = await obj.text();
  } catch (err) {
    console.log(`[telemetry] R2 get ${key} failed (non-fatal): ${err?.message || err}`);
  }
  const newLines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const body = existing ? existing + newLines : newLines;
  try {
    await env.TELEMETRY.put(key, body, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  } catch (err) {
    // Re-append to buffer on failure so next flush retries.
    telemetryBuffer.unshift(...rows);
    console.log(`[telemetry] R2 put ${key} failed (non-fatal): ${err?.message || err}`);
  }
}

// Wave 4 Item #2 (2026-05-10) — distribution-surface self-emit.
//
// Sends a fire-and-forget POST to /v1/telemetry/event for every MCP tool
// call so MCP usage flows into the same R2 NDJSON / rollup as the CLI,
// extension, GHA, and skill. The /v1/recommend worker rate-limits at
// 60/min per IP-hash; that's fine for organic MCP traffic. Surface = "mcp",
// event = the tool name (so the rollup's by_surface block shows tool mix).
//
// Why a separate POST instead of just reading the existing R2 NDJSON in
// telemetry/mcp-calls/? Because the recommend-api rollup is the ONE place
// that produces top_callers across all surfaces; centralising the feed is
// simpler than teaching the rollup to read two NDJSON paths. Cost is one
// edge-internal HTTP call per tool, all under waitUntil.
const MCP_VERSION = VERSION;
function selfEmitTelemetryEvent(env, ctx, request, toolName, slugArg, ok, durationMs) {
  if (!ctx?.waitUntil) return;
  // Origin defaults to hlido.eu — overridable via env for staging.
  const target = (env?.SITE_URL || "https://hlido.eu").replace(/\/+$/, "") + "/v1/telemetry/event";
  const ua = request?.headers?.get?.("user-agent") || "";
  const cfIp = request?.headers?.get?.("cf-connecting-ip") || "";
  const body = JSON.stringify({
    surface: "mcp",
    version: MCP_VERSION,
    event: "tool-call",
    slug: slugArg || undefined,
    ok: !!ok,
    duration_ms: typeof durationMs === "number" ? Math.max(0, Math.floor(durationMs)) : undefined,
    // Tool-name in a side channel so the rollup can break MCP traffic down
    // by tool. Validator on the recommend side ignores unknown keys.
    tool_name: toolName,
  });
  const headers = {
    "content-type": "application/json",
    "user-agent": `hlido-mcp/${MCP_VERSION} (cf-worker)`,
  };
  // Forward the original caller's IP so the recommend worker can hash it
  // for the per-caller leaderboard (same hashing salt = same hash).
  if (cfIp) headers["cf-connecting-ip"] = cfIp;
  if (ua) headers["x-original-ua"] = ua.slice(0, 256);
  ctx.waitUntil(
    fetch(target, { method: "POST", headers, body }).catch(() => { /* never break */ })
  );
}

// Lightweight usage telemetry (introduced 2026-04-26). Bumps a daily +
// per-tool counter in KV. Public, no PII — only tool name + slug-arg if
// present + day. scripts/drain-mcp-usage.mjs pulls it for the daily pulse.
async function bumpUsage(env, toolName, slugArg = null) {
  if (!env.MCP_CACHE) return;
  const day = new Date().toISOString().slice(0, 10);
  try {
    const dayKey = `usage:${day}:${toolName}`;
    const cur = await env.MCP_CACHE.get(dayKey);
    const next = (cur ? parseInt(cur, 10) : 0) + 1;
    // No TTL — counters persist until daily drain rotates them.
    await env.MCP_CACHE.put(dayKey, String(next));
    if (slugArg) {
      const slugKey = `usage:${day}:${toolName}:${slugArg.toLowerCase()}`;
      const c2 = await env.MCP_CACHE.get(slugKey);
      await env.MCP_CACHE.put(slugKey, String((c2 ? parseInt(c2, 10) : 0) + 1));
    }
  } catch { /* never break the request */ }
}

async function callTool(name, args, env, request = null, ctx = null) {
  // Bump usage BEFORE the call so we count even on errors.
  const slugArg = (args?.slug || args?.agent_or_url || args?.agent || null) ? String(args.slug || args.agent_or_url || args.agent).toLowerCase() : null;
  await bumpUsage(env, name, slugArg);
  // Wave 2.5 (2026-05-10) — fire-and-forget per-call telemetry to R2. Never
  // blocks the response (uses ctx.waitUntil internally). No-op when the
  // TELEMETRY binding or ctx is missing (older deployments, local dev).
  logToolCall(env, ctx, request, name, slugArg);

  const { siteRoot, registry } = await loadRegistry(env);
  const items = registry.items || [];

  if (name === "trust_check") {
    const hit = findBySlugOrUrl(items, args.agent_or_url);
    if (!hit) return { ok: false, error: `No Hlido review found for '${args.agent_or_url}'.` };
    return { ok: true, ...formatItem(hit, siteRoot) };
  }

  if (name === "find_trusted") {
    const need = args.need || "";
    const minTier = TIER_ORDER[args.min_tier || "STEADY"] ?? 3;
    const limit = Math.min(Math.max(args.limit || 10, 1), 25);
    const ranked = items
      .map((i) => ({ item: i, score: similarity(need, [i.category, i.summary, i.name, i.slug].join(" ")) + (i.score || 0) / 100 }))
      .filter((x) => x.score > 0 && (TIER_ORDER[scoreToTier(x.item.score)] ?? 0) >= minTier)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => formatItem(x.item, siteRoot));
    return { ok: true, results: ranked, count: ranked.length };
  }

  if (name === "verify_claim") {
    const hit = findBySlugOrUrl(items, args.agent);
    if (!hit) return { ok: false, error: `No Hlido review found for '${args.agent}'.`, tested: false };
    const claim = (args.claim || "").toLowerCase();
    const haystack = [hit.summary, hit.proofNote, hit.blockerLabel, hit.nextStep].filter(Boolean).join(" ").toLowerCase();
    const mentioned = claim.length > 2 && haystack.includes(claim.split(" ").filter((w) => w.length > 3)[0] || claim);
    return {
      ok: true,
      agent: hit.slug,
      claim: args.claim,
      mentioned_in_review: mentioned,
      tested: hit.score != null,
      verdict: mentioned ? "claim referenced in review — read full verdict at review_url" : "claim not specifically addressed in current review",
      review_url: reviewUrl(siteRoot, hit.slug),
      honest_null: !mentioned ? "Hlido has not specifically tested this claim. Do not assume verified." : null,
    };
  }

  if (name === "compare_agents") {
    const slugs = (args.slugs || []).slice(0, 5);
    const rows = slugs.map((s) => {
      const hit = findBySlugOrUrl(items, s);
      return hit ? formatItem(hit, siteRoot) : { slug: s, error: "not_found" };
    });
    return { ok: true, comparison: rows };
  }

  if (name === "get_scorecard") {
    const slug = String(args.slug || "").trim().toLowerCase();
    if (!slug) return { ok: false, error: "slug required" };
    const cacheKey = `scorecard:${slug}`;
    // Best-effort KV read — never fail the request because cache lookup errored.
    if (env.MCP_CACHE) {
      try {
        const cached = await env.MCP_CACHE.get(cacheKey, "json");
        if (cached) return { ok: true, ...cached };
      } catch (err) {
        console.log(`[get_scorecard] KV get failed (non-fatal) for ${slug}: ${err?.message || err}`);
      }
    }
    // Always fetch from the same source as registry to avoid same-zone loop.
    const fetchSource = env.REGISTRY_FETCH_URL || "https://hlido.pages.dev";
    try {
      const res = await fetch(`${fetchSource}/data/scorecards/${slug}.json`, { cf: { cacheTtl: 300 } });
      if (!res.ok) {
        return {
          ok: false,
          error: `No scorecard published for '${slug}'. The review may exist as a summary only — try trust_check for the high-level verdict.`,
          slug,
          tried_url: `${fetchSource}/data/scorecards/${slug}.json`,
          honest_null: "Hlido has not published a structured claim-vs-evidence scorecard for this slug yet.",
        };
      }
      const scorecard = await res.json();
      // Best-effort KV write — KV put can throw on rate-limit. Never poison the response.
      if (env.MCP_CACHE) {
        try {
          await env.MCP_CACHE.put(cacheKey, JSON.stringify(scorecard), { expirationTtl: REGISTRY_TTL });
        } catch (err) {
          console.log(`[get_scorecard] KV put failed (non-fatal) for ${slug}: ${err?.message || err}`);
        }
      }
      return { ok: true, ...scorecard };
    } catch (err) {
      return { ok: false, error: `Scorecard fetch failed: ${err.message}`, slug };
    }
  }

  if (name === "report_review_issue") {
    const slug = String(args.slug || "").trim().toLowerCase();
    const issueType = String(args.issue_type || "other").trim();
    const detail = String(args.detail || "").trim();
    if (!slug || !detail) return { ok: false, error: "slug and detail are required" };
    const ts = new Date().toISOString();
    const ticketId = `feedback-${ts.replace(/[:.]/g, "-")}-${slug}`;
    const record = { ticket_id: ticketId, ts, slug, issue_type: issueType, detail: detail.slice(0, 2000), reporter: String(args.reporter || "anonymous").slice(0, 100), processed: false };
    if (env.MCP_CACHE) {
      // No TTL — feedback persists until R4 drains it into the queue file.
      await env.MCP_CACHE.put(`feedback:${ticketId}`, JSON.stringify(record));
    }
    // Bump per-tool usage counter as well (this tool is a feedback channel).
    await bumpUsage(env, "report_review_issue");
    return {
      ok: true,
      ticket_id: ticketId,
      received_at: ts,
      message: `Thanks. Hlido's R4 maintenance routine drains MCP feedback daily into the dispute-retest queue. If your report is reproducible, R1 fires a sub-agent retest and the review updates within the next cycle.`,
      next_steps: ["R4 maintenance drains daily", "Reproducible disputes trigger R1 sub-agent retest", "Updated verdicts auto-deploy to hlido.eu/reviews/{slug}/"],
    };
  }

  if (name === "request_quick_audit") {
    const url = String(args.url || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: "valid http(s) url required" };
    const requester = String(args.requester || "anonymous").slice(0, 100);
    const day = new Date().toISOString().slice(0, 10);
    const rateKey = `quickaudit-rate:${day}:${requester}`;
    if (env.MCP_CACHE) {
      const used = parseInt((await env.MCP_CACHE.get(rateKey)) || "0", 10);
      const cap = requester === "anonymous" ? 5 : 50;
      if (used >= cap) return { ok: false, error: `daily rate-limit hit (${cap}/day for ${requester}). Try again tomorrow or set 'requester' to identify your agent.`, used, cap };
      await env.MCP_CACHE.put(rateKey, String(used + 1), { expirationTtl: 86400 * 2 });
    }
    // Derive a slug from the URL host
    let slug;
    try {
      const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      slug = host.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
    } catch { return { ok: false, error: "could not parse URL" }; }
    const ts = new Date().toISOString();
    const ticketId = `quickaudit-${ts.replace(/[:.]/g, "-")}-${slug}`;
    const record = { ticket_id: ticketId, ts, url, slug, name: String(args.name || slug), why: String(args.why || "").slice(0, 400), requester, processed: false };
    if (env.MCP_CACHE) await env.MCP_CACHE.put(`live-request:${ticketId}`, JSON.stringify(record));
    await bumpUsage(env, "request_quick_audit", slug);
    const eta = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    return {
      ok: true,
      ticket_id: ticketId,
      slug,
      future_scorecard_url: `https://hlido.eu/data/scorecards/${slug}.json`,
      future_review_url: `https://hlido.eu/reviews/${slug}/`,
      eta_iso: eta,
      eta_human: "within 24 hours (often faster)",
      message: `Hlido has queued the audit. Poll the future_scorecard_url; when it returns 200 you have the verdict. Honest null until then. The audit will be a public-surface scrape + claim verification — no logged-in product testing without manual setup.`,
    };
  }

  if (name === "find_similar_agents") {
    const description = String(args.description || "").trim();
    if (!description) return { ok: false, error: "description required" };
    const top_k = Math.min(Math.max(parseInt(args.top_k || 5, 10), 1), 20);
    const min_score = parseInt(args.min_score || 0, 10);
    if (!env.OPENAI_API_KEY) return { ok: false, error: "OPENAI_API_KEY secret not set on worker. Provision via: cd workers/mcp && npx wrangler secret put OPENAI_API_KEY. Fallback: use find_trusted (substring search) for now." };
    if (!env.VECTORIZE) return { ok: false, error: "Vectorize binding not present on worker. Re-deploy the worker after wrangler.toml gets the [[vectorize]] block. Fallback: use find_trusted." };
    try {
      // 1. Embed the query via OpenAI
      const embRes = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: description.slice(0, 4000) }),
      });
      if (!embRes.ok) return { ok: false, error: `embedding HTTP ${embRes.status}` };
      const emb = (await embRes.json()).data?.[0]?.embedding;
      if (!Array.isArray(emb)) return { ok: false, error: "no embedding returned" };
      // 2. Query Vectorize via NATIVE BINDING (no REST round-trip, runs at edge,
      //    no auth needed — env.VECTORIZE is the bound index from wrangler.toml).
      const vResp = await env.VECTORIZE.query(emb, { topK: top_k, returnMetadata: "all" });
      const matches = vResp?.matches || [];
      // 3. Hydrate matches with current registry data + filter by min_score
      const results = [];
      for (const m of matches) {
        const meta = m.metadata || {};
        const slug = meta.slug || m.id;
        const hit = items.find(it => (it.slug || "").toLowerCase() === String(slug).toLowerCase());
        if (!hit) continue;
        if ((hit.score ?? 0) < min_score) continue;
        results.push({
          ...formatItem(hit, siteRoot),
          similarity: m.score,
          why_match: meta.summary_excerpt || (hit.summary || "").slice(0, 160),
        });
      }
      return { ok: true, query: description, count: results.length, results };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (name === "submit_agent") {
    return {
      ok: true,
      queued: true,
      message: `Thanks — '${args.name}' queued for Hlido intake review. Independent evaluation begins on next daily cycle (08:00 UTC).`,
      next_steps: ["Intake triages within 24h", "T1 surface review within 7 days", "Full published review with C2PA video typically 10–14 days"],
      contact: "ankit@hlido.eu",
      submission_echo: { url: args.url, name: args.name, note: args.note || null },
    };
  }

  // MCP v2 — subscribe (advisory). Persistent webhook/RSS subscription support
  // is queued for Wave 3 once we have a server-side watchlist store that
  // doesn't blow the 1k/day KV write cap. For now the tool is honest about
  // being preview and returns current state + a polling/RSS suggestion.
  if (name === "subscribe") {
    const slug = String(args.slug || "").trim().toLowerCase();
    if (!slug) return { ok: false, error: "slug required" };
    const channel = String(args.channel || "rss").trim().toLowerCase();
    const hit = findBySlugOrUrl(items, slug);
    if (!hit) {
      return {
        ok: false,
        error: `No Hlido review found for '${slug}'.`,
        suggestion: "Use request_quick_audit to commission a review of an unknown agent.",
      };
    }
    const channelAdvised =
      channel === "json"
        ? `${siteRoot}/changelog/feed.json`
        : channel === "webhook"
          ? `${siteRoot}/data/attestations/${slug}.json`
          : `${siteRoot}/changelog/feed.xml`;
    return {
      ok: true,
      status: "advisory",
      slug,
      current_state: {
        score: hit.score ?? null,
        tier: scoreToTier(hit.score),
        last_tested: hit.updatedAt || hit.publishedAt || null,
      },
      suggestion:
        "Persistent subscriptions ship in Wave 3. For now poll /data/attestations/{slug}.json or RSS at /changelog/feed.xml.",
      channel_advised: channelAdvised,
      preview_note:
        "preview — Wave 3 will add persistent webhook + RSS with stable subscription IDs.",
    };
  }

  // MCP v2 — explain. Pulls the published scorecard and converts it into a
  // structured natural-language payload. dimension is an optional filter
  // matched case-insensitively against the claim id, claim text, and
  // source_surface. Verdicts are normalized to PASS/FAIL/PARTIAL/UNKNOWN
  // (the scorecard uses pass/fail/partial_pass/unknown). Evidence quotes
  // are truncated to 240 chars per spec.
  if (name === "explain") {
    const slug = String(args.slug || "").trim().toLowerCase();
    if (!slug) return { ok: false, error: "slug required" };
    const dimension = args.dimension ? String(args.dimension).trim().toLowerCase() : null;
    const hit = findBySlugOrUrl(items, slug);
    if (!hit) {
      return {
        ok: false,
        error: `No Hlido review found for '${slug}'.`,
        suggestion: "Use request_quick_audit if this agent has no review yet.",
      };
    }
    // Fetch the full scorecard from the same source we use for registry to
    // avoid same-zone recursion. Best-effort cache via KV.
    const fetchSource = env.REGISTRY_FETCH_URL || "https://hlido.pages.dev";
    let scorecard = null;
    if (env.MCP_CACHE) {
      try {
        scorecard = await env.MCP_CACHE.get(`scorecard:${slug}`, "json");
      } catch (err) {
        console.log(`[explain] KV get failed (non-fatal) for ${slug}: ${err?.message || err}`);
      }
    }
    if (!scorecard) {
      try {
        const res = await fetch(`${fetchSource}/data/scorecards/${slug}.json`, { cf: { cacheTtl: 300 } });
        if (res.ok) {
          scorecard = await res.json();
          if (env.MCP_CACHE) {
            try {
              await env.MCP_CACHE.put(`scorecard:${slug}`, JSON.stringify(scorecard), { expirationTtl: REGISTRY_TTL });
            } catch (err) {
              console.log(`[explain] KV put failed (non-fatal) for ${slug}: ${err?.message || err}`);
            }
          }
        }
      } catch (err) {
        console.log(`[explain] scorecard fetch failed for ${slug}: ${err?.message || err}`);
      }
    }
    const allClaims = Array.isArray(scorecard?.claims) ? scorecard.claims : [];
    // Build a list of claim-attached "dimensions" we can filter on. We
    // surface source_surface values + claim-id prefix as the filterable
    // vocabulary because the live scorecard schema doesn't carry an
    // explicit dimension key. This makes the dimension hint concrete.
    const supportedDimensions = Array.from(
      new Set(
        allClaims.map((c) => String(c.source_surface || "").toLowerCase()).filter(Boolean)
      )
    );
    const verdictMap = { pass: "PASS", fail: "FAIL", partial_pass: "PARTIAL", partial: "PARTIAL", unknown: "UNKNOWN" };
    const filtered = dimension
      ? allClaims.filter((c) => {
          const haystack = `${c.id || ""} ${c.claim || ""} ${c.source_surface || ""}`.toLowerCase();
          return haystack.includes(dimension);
        })
      : allClaims;
    const evidence = filtered.map((c) => ({
      claim: String(c.claim || "").trim(),
      verdict: verdictMap[String(c.verdict || "").toLowerCase()] || "UNKNOWN",
      evidence_quote: String(c.evidence || "").trim().slice(0, 240),
      source_surface: c.source_surface || null,
    }));
    // Synthesis: short prose summary derived from verdicts + score.
    const counts = evidence.reduce((acc, e) => ((acc[e.verdict] = (acc[e.verdict] || 0) + 1), acc), {});
    const passN = counts.PASS || 0;
    const failN = counts.FAIL || 0;
    const partialN = counts.PARTIAL || 0;
    const unknownN = counts.UNKNOWN || 0;
    const totalN = evidence.length;
    const verdictSummary = totalN
      ? `${passN}/${totalN} claims passed${failN ? `, ${failN} failed` : ""}${partialN ? `, ${partialN} partial` : ""}${unknownN ? `, ${unknownN} unverifiable` : ""}.`
      : "No claims available for this scope.";
    const summary = `${hit.name || slug} scored ${hit.score ?? "n/a"} (${scoreToTier(hit.score)}). ${verdictSummary} ${hit.summary ? "Headline: " + String(hit.summary).slice(0, 200) : ""}`.trim();
    const response = {
      ok: true,
      slug,
      dimension: dimension || null,
      score: hit.score ?? null,
      tier: scoreToTier(hit.score),
      evidence,
      summary,
      review_url: reviewUrl(siteRoot, slug),
    };
    if (dimension && evidence.length === 0 && supportedDimensions.length) {
      response.supported_dimensions = supportedDimensions;
      response.note = `dimension '${dimension}' did not match any claim. Use one of supported_dimensions or omit dimension for the full picture.`;
    }
    if (!scorecard) {
      response.note = "No structured scorecard published for this slug yet — only top-line score and tier are available.";
    }
    return response;
  }

  // MCP v2 — recommend. Constraint-driven shortlist. Reuses the same
  // similarity scoring as find_trusted when use_case is set; falls back to
  // pure score-desc ordering otherwise.
  if (name === "recommend") {
    const c = args.constraints || {};
    const category = c.category ? String(c.category).trim().toLowerCase() : null;
    const minScore = Math.max(parseInt(c.min_score ?? 0, 10) || 0, 0);
    const tierFilter = c.tier ? String(c.tier).trim().toUpperCase() : null;
    const tierFloor = tierFilter ? (TIER_ORDER[tierFilter] ?? 0) : 0;
    const useCase = c.use_case ? String(c.use_case).trim() : "";
    const maxResults = Math.min(Math.max(parseInt(c.max_results ?? 5, 10) || 5, 1), 25);
    const filtered = items.filter((it) => {
      if (it.score == null || it.score < minScore) return false;
      if (category && String(it.category || "").toLowerCase() !== category) return false;
      if (tierFloor && (TIER_ORDER[scoreToTier(it.score)] ?? 0) < tierFloor) return false;
      return true;
    });
    const ranked = filtered
      .map((it) => {
        const matchHaystack = [it.category, it.summary, it.name, it.slug].filter(Boolean).join(" ");
        const sim = useCase ? similarity(useCase, matchHaystack) : 0;
        // Composite rank: similarity weight + score/100 so well-scored items
        // beat token-only matches when use_case is generic.
        const rank = sim + (it.score || 0) / 100;
        return { item: it, sim, rank };
      })
      .sort((a, b) => b.rank - a.rank)
      .slice(0, maxResults)
      .map(({ item, sim }) => {
        const why = useCase
          ? sim > 0
            ? `Matches '${useCase}' on category/summary tokens; Laddoo ${item.score} keeps it ranked.`
            : `No direct '${useCase}' token match — ranked by Laddoo score (${item.score}).`
          : `Top-ranked by Laddoo score (${item.score}) within your filters.`;
        return {
          slug: item.slug,
          name: item.name,
          score: item.score,
          tier: scoreToTier(item.score),
          summary: item.summary || "",
          review_url: reviewUrl(siteRoot, item.slug || ""),
          why_match: why,
        };
      });
    return {
      ok: true,
      constraints: {
        category: category || null,
        min_score: minScore,
        tier: tierFilter || null,
        use_case: useCase || null,
        max_results: maxResults,
      },
      count: ranked.length,
      results: ranked,
    };
  }

  // Phase C 2026-05-18 — get_behavioral_trace handler.
  // Mirrors get_scorecard: same KV cache wrapper, same fallback to live fetch,
  // same auth (none — public read from CF Pages private deploy).
  // Data served at site/data/behavioral/{slug}.json via CF Pages.
  if (name === "get_behavioral_trace") {
    const slug = String(args.slug || "").trim().toLowerCase();
    if (!slug) return { ok: false, error: "slug required" };
    const specVersion = String(args.spec_version || "v0.1").trim();
    const cacheKey = `behavioral:${slug}:${specVersion}`;
    // Best-effort KV read — never fail the request because cache lookup errored.
    if (env.MCP_CACHE) {
      try {
        const cached = await env.MCP_CACHE.get(cacheKey, "json");
        if (cached) return { ok: true, ...cached };
      } catch (err) {
        console.log(`[get_behavioral_trace] KV get failed (non-fatal) for ${slug}: ${err?.message || err}`);
      }
    }
    // Fetch from same source as scorecard — CF Pages private deploy avoids zone loop.
    const fetchSource = env.REGISTRY_FETCH_URL || "https://hlido.pages.dev";
    const fetchUrl = `${fetchSource}/data/behavioral/${slug}.json`;
    try {
      const res = await fetch(fetchUrl, { cf: { cacheTtl: 300 } });
      if (!res.ok) {
        return {
          ok: true,
          slug,
          status: "not_yet_bench_tested",
          spec_version: specVersion,
          message: `${slug} has not been bench-tested under spec ${specVersion} yet. It may be in the behavioral-bench queue — check back after the next bench run.`,
          review_url: `${siteRoot}/reviews/${slug}/`,
        };
      }
      const trace = await res.json();
      // Propagate not_testable status with a clear agent-readable message
      if (trace.status === "not_testable") {
        const result = {
          ok: true,
          slug,
          status: "not_testable",
          spec_version: trace.spec_version || specVersion,
          reason: trace.reason || "adapter_probe_failed",
          probed_at: trace.probed_at || null,
          message: `${slug} could not be bench-tested under the cli-headless adapter. The probe detected: ${(trace.reason || "unknown").split(":").slice(0, 2).join(":")}. Future adapter versions may support this agent.`,
          review_url: `${siteRoot}/reviews/${slug}/`,
        };
        return result;
      }
      // Full result — return public fields only
      const result = {
        ok: true,
        slug: trace.slug || slug,
        category: trace.category || null,
        spec_version: trace.spec_version || specVersion,
        run_id: trace.run_id || null,
        aggregate_score: trace.aggregate_score ?? null,
        behavioral_tier: trace.behavioral_tier || null,
        passed: trace.passed ?? null,
        failed: trace.failed ?? null,
        errored: trace.errored ?? 0,
        adapter: trace.adapter || null,
        model_used: trace.model_used || null,
        started_at: trace.started_at || null,
        completed_at: trace.completed_at || null,
        verdict_summary: trace.verdict_summary || null,
        // tasks: only id + outcome — grader_details and stdout are never exposed.
        tasks: Array.isArray(trace.tasks) ? trace.tasks.map(t => ({ id: t.id, outcome: t.outcome })) : [],
        signed_trace_url: trace.signed_trace_url || null,
        review_url: `${siteRoot}/reviews/${slug}/`,
      };
      // Best-effort KV write
      if (env.MCP_CACHE) {
        try {
          await env.MCP_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: REGISTRY_TTL });
        } catch (err) {
          console.log(`[get_behavioral_trace] KV put failed (non-fatal) for ${slug}: ${err?.message || err}`);
        }
      }
      return result;
    } catch (err) {
      return { ok: false, error: `Behavioral trace fetch failed: ${err.message}`, slug };
    }
  }

  return { ok: false, error: `Unknown tool: ${name}` };
}

async function handleRpc(body, env, request = null, ctx = null) {
  const { id = null, method, params = {} } = body || {};
  if (method === "initialize") {
    return jsonRpc(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "hlido-agent-reviews", version: VERSION },
    });
  }
  if (method === "tools/list") return jsonRpc(id, { tools: TOOL_SPECS });
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const t0 = Date.now();
    const slugArg = (args?.slug || args?.agent_or_url || args?.agent || null)
      ? String(args.slug || args.agent_or_url || args.agent).toLowerCase()
      : null;
    try {
      const result = await callTool(name, args || {}, env, request, ctx);
      // Wave 4 Item #2 — fire-and-forget POST to /v1/telemetry/event so MCP
      // usage flows into the unified by_surface / top_callers rollup. Uses
      // ctx.waitUntil internally; never blocks the response.
      selfEmitTelemetryEvent(env, ctx, request, name, slugArg, !!result?.ok, Date.now() - t0);
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: !result.ok });
    } catch (err) {
      selfEmitTelemetryEvent(env, ctx, request, name, slugArg, false, Date.now() - t0);
      return jsonRpc(id, null, { code: -32603, message: err?.message || "tool execution failed" });
    }
  }
  if (method === "ping") return jsonRpc(id, {});
  return jsonRpc(id, null, { code: -32601, message: `Method not found: ${method}` });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response("", { status: 204, headers: cors });

    if (request.method === "GET") {
      const siteRoot = env.SITE_URL || "https://hlido.eu";
      return new Response(
        JSON.stringify({
          name: "hlido-agent-reviews",
          version: VERSION,
          description: "The trust layer for AI agents — C2PA-verified reviews, Laddoo Scores, queryable over MCP.",
          transport: ["http", "streamable-http"],
          endpoint: `${siteRoot}/mcp`,
          protocolVersion: "2024-11-05",
          tools: TOOL_SPECS.map((t) => ({ name: t.name, description: t.description })),
          docs: `${siteRoot}/mcp-docs/`,
          playground: `${siteRoot}/mcp-docs/playground/`,
          server_card: `${siteRoot}/.well-known/mcp-server-card/server.json`,
          // Wave 4.0 — REST surface advertisement. The /v1/* endpoints are a
          // paid recommendation API consumed by buyer agents that don't speak
          // JSON-RPC. MCP and REST share the same ranker (workers/recommend
          // mirrors workers/mcp's recommend tool body — model_version
          // wave4-v1 is bumped on any divergence). Full docs at /api/.
          rest_api: {
            endpoint: `${siteRoot}/v1`,
            docs: `${siteRoot}/api/`,
            openapi: `${siteRoot}/v1/openapi.json`,
          },
          // Wave 4 Item C.1 — Incident registry advertisement. Independent
          // public registry of reported AI agent failures, mirroring the
          // shape of the rest_api block. RSS feed + JSON detail endpoints
          // documented at /api/. Submit form is private-beta until media
          // liability cover binds (see brain/wave4/insurance-research-*.md).
          incidents_endpoint: {
            base_url: `${siteRoot}/v1/incidents`,
            feed_url: `${siteRoot}/v1/incidents/feed.xml`,
            submit_url: `${siteRoot}/incidents/submit`,
            description: "Independent registry of reported AI agent failures. Searchable by slug, severity, date.",
          },
          edge: "cloudflare-workers",
        }, null, 2),
        { status: 200, headers: cors }
      );
    }

    if (request.method !== "POST") {
      return jsonRpc(null, null, { code: -32600, message: "Only POST JSON-RPC accepted" });
    }

    let body;
    try { body = await request.json(); } catch { return jsonRpc(null, null, { code: -32700, message: "Parse error" }); }

    if (Array.isArray(body)) {
      const results = await Promise.all(body.map((b) => handleRpc(b, env, request, ctx).then((r) => r.json())));
      return new Response(JSON.stringify(results), { status: 200, headers: cors });
    }
    return handleRpc(body, env, request, ctx);
  },
};
