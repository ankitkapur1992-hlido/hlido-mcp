#!/usr/bin/env node
/**
 * Hlido MCP — stdio ↔ HTTP bridge.
 *
 * Exposes the hosted Hlido MCP server (https://hlido.eu/mcp, Streamable-HTTP
 * JSON-RPC, no auth) over the MCP *stdio* transport so stdio-only clients can
 * use it: Glama's build-check (mcp-proxy), Claude Desktop, Cursor, etc.
 *
 * The hosted server is stateless (no session id required), so this is a
 * transparent JSON-RPC forwarder: read newline-delimited JSON messages from
 * stdin, POST each to the endpoint, write the response to stdout. Only requests
 * (with an `id`) get a response written back; notifications do not.
 *
 * Zero dependencies (Node 18+: global fetch + node:readline). All diagnostics
 * go to stderr — stdout MUST carry only protocol messages.
 *
 * Usage:  node bin/stdio.mjs        (or `npx hlido-mcp`)
 * Env:    HLIDO_MCP_URL  override the endpoint (default https://hlido.eu/mcp)
 */
import readline from "node:readline";

const ENDPOINT = process.env.HLIDO_MCP_URL || "https://hlido.eu/mcp";

async function forward(message) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "hlido-mcp-stdio/1.0",
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const isRequest = (m) => m && m.id !== undefined && m.id !== null;

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; } // ignore non-JSON noise
  try {
    const reply = await forward(msg);
    if (reply && isRequest(msg)) process.stdout.write(JSON.stringify(reply) + "\n");
  } catch (e) {
    if (isRequest(msg)) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: `hlido stdio bridge: ${String(e?.message || e)}` },
      }) + "\n");
    }
  }
});

process.stderr.write(`[hlido-mcp] stdio bridge → ${ENDPOINT}\n`);
