# Hlido MCP Server

**Independent trust scores, claim audits, and comparisons for AI agents — queryable by your agent over [MCP](https://modelcontextprotocol.io).**

[Hlido](https://hlido.eu) is an independent AI-agent review platform ("Rotten Tomatoes for AI agents"). We test agents hands-on and publish evidence-backed scorecards: a 0–100 score, tier verdict, per-claim PASS/FAIL audit, and signed screenshots. This repository contains the source of the MCP server that exposes that registry to other agents.

## Use the hosted server (no install)

The server runs as a Cloudflare Worker at:

```
https://hlido.eu/mcp
```

**Claude Code:**
```bash
claude mcp add --transport http hlido https://hlido.eu/mcp
```

**Claude Desktop / Cursor / any MCP client** (`mcpServers` config):
```json
{
  "mcpServers": {
    "hlido": { "url": "https://hlido.eu/mcp" }
  }
}
```

Also listed on [Smithery](https://smithery.ai/server/ankitkapur1992/hlido) and mcp.so.

## Tools

| Tool | What it answers |
|---|---|
| `trust_check` | "Is agent X trustworthy?" — score, tier, verdict for a slug |
| `find_trusted` | "Find me a trusted agent for <need>" — filtered registry search |
| `verify_claim` | "Does X really do Y?" — per-claim PASS/FAIL evidence |
| `compare_agents` | Side-by-side scorecard comparison |
| `get_scorecard` | Full sanitized scorecard JSON for a slug |
| `find_similar_agents` | Semantic nearest neighbours to a given agent |
| `submit_agent` | Nominate an agent for review |
| `report_review_issue` | Flag a problem with a published review |
| `request_quick_audit` | Ask for a fast re-check of a stale review |

(plus discovery/metadata tools — see `src/index.mjs` for the live tool table)

## Design principles

- **Public data only.** The server reads the same JSON published at `hlido.eu/data/*` (registry, scorecards, attestations). It never exposes scoring weights, grader assertions, or editorial drafts — the methodology stays private; the outcomes and evidence are public.
- **No auth, no tracking.** Anonymous JSON-RPC. Lightweight daily per-tool counters are the only telemetry.
- **Thin by intent.** This is an adapter over open data. The review pipeline, testing engine, and scoring model live elsewhere and are not part of this repository.

## Self-hosting

It's a standard Cloudflare Worker. Copy `wrangler.toml.example` to `wrangler.toml`, set your account id, and `npx wrangler deploy`. Optional bindings (KV cache, Vectorize similarity index) degrade gracefully when absent — the worker falls back to fetching the public JSON directly.

## Data & licensing

- Code: [Apache-2.0](LICENSE)
- Review data: [CC-BY](https://github.com/ankitkapur1992-hlido/hlido-public) via the public data mirror and the [HF dataset](https://huggingface.co/datasets/hlido-eu/agent-benchmark)

## Links

- Website: https://hlido.eu
- Agent manifest: https://hlido.eu/agent-manifest.json
- llms.txt: https://hlido.eu/llms.txt
- Public data mirror: https://github.com/ankitkapur1992-hlido/hlido-public

## Run with Docker

```bash
docker build -t hlido-mcp .
docker run -p 8080:8080 hlido-mcp
```

The container runs the worker on the local [workerd](https://github.com/cloudflare/workerd) runtime via `wrangler dev` — no Cloudflare account needed. The MCP endpoint is `http://localhost:8080/` (GET for server info, POST for JSON-RPC).
