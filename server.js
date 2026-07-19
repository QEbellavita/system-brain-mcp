#!/usr/bin/env node
'use strict';

// Standalone MCP server exposing the system-brain tools over stdio.
//
// Every tool is READ-ONLY. Nothing here writes to your database, your repos, or
// your deploy targets — it reads and reports.
//
// Configuration is entirely by environment variable; see README.md. With
// nothing configured the server still starts, and each tool reports what it
// would need rather than failing.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const domain = require('./src/tools.js');

const tools = domain.tools();
const byName = new Map(tools.map((t) => [t.def.name, t]));

const server = new Server(
  { name: 'system-brain', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => t.def),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = byName.get(request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
    };
  }
  try {
    const result = await tool.handler(request.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `${request.params.name}: ${err.message}` }],
    };
  }
});

async function main() {
  // stdout is the MCP transport — diagnostics must go to stderr.
  await server.connect(new StdioServerTransport());
  process.stderr.write(`system-brain ready — ${tools.length} tools\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
