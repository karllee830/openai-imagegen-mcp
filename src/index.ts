#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

try {
  const config = loadConfig();
  serveStdio(() => createServer(config));
} catch (error) {
  console.error(`openai-imagegen-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
