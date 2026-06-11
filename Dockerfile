# Runs the Hlido MCP server locally via the Cloudflare workerd runtime.
# All Cloudflare bindings (KV cache, Vectorize, R2 telemetry) are optional —
# the worker falls back to fetching the public JSON at hlido.eu/data/* directly.
FROM node:22-slim

WORKDIR /app
COPY package.json ./
RUN npm install

COPY src ./src

# Minimal config for local execution: no account-bound bindings.
RUN printf '%s\n' \
  'name = "hlido-mcp"' \
  'main = "src/index.mjs"' \
  'compatibility_date = "2024-12-01"' \
  '' \
  '[vars]' \
  'SITE_URL = "https://hlido.eu"' \
  > wrangler.toml

EXPOSE 8080
CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8080"]
