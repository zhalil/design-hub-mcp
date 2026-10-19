// Design Hub MCP server proper (loaded by server.js once dependencies are present).
// OpenDesign + huashu-design + UI UX Pro Max behind one MCP, with a Superdesign-style canvas
// served locally. Canvas requests are handled by Claude Code itself: either the interactive
// session (canvas_wait_feedback) or a background `claude -p` run under the user's subscription.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { log } from './config.js';
import { buildServer, startHub, VERSION } from './tools.js';
import { startPreview, setMcpFactory } from './preview/http.js';

startHub();
setMcpFactory(() => buildServer({ worker: true }));
await startPreview();
await buildServer().connect(new StdioServerTransport());
log(`MCP server ready (v${VERSION})`);
