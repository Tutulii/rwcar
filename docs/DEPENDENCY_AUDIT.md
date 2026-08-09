# Production dependency audit

Review date: 2026-08-09 UTC

`npm audit --omit=dev` reports zero critical and zero high-severity findings. It reports two moderate instances of [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) through `@modelcontextprotocol/node -> @hono/node-server@1.19.17`; npm currently offers no compatible fix.

## Reviewed disposition

The advisory affects Hono's Windows `serve-static` implementation when processing encoded backslashes. RWCAR's API image is Linux (`node:22-bookworm-slim`), does not import or expose `serveStatic`, and uses only `getRequestListener` from the transitive package to bridge the official MCP web-standard handler to Node HTTP. Static files and uploaded evidence do not pass through this package.

This is an explicit, bounded risk acceptance—not a blanket waiver:

- production and CI remain Linux-only for the affected service;
- the API must not import `serveStatic` from `@hono/node-server`;
- CI continues to fail on high or critical production findings;
- upgrade `@modelcontextprotocol/node` as soon as it accepts a patched Hono adapter;
- reopen the review if the runtime becomes Windows, the MCP adapter changes, or any static-serving path is added.

Do not force a major transitive override: replacing the MCP SDK's tested adapter beneath it would create a larger protocol and streaming risk. The deployment owner must re-run `npm audit --omit=dev` before every release and record any changed advisory graph.
