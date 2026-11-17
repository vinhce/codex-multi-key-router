/**
 * Codex Multi-API Key Router & Subagent Load Balancer
 * Open-source MCP Server & HTTP Proxy for OpenAI Codex
 * License: MIT
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PORT = parseInt(process.env.PORT || '5050', 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'api.xingchiapi.com';
const KEYS_FILE = path.join(__dirname, 'keys.json');
const LOG_FILE = path.join(__dirname, 'router.log');

function logRouter(msg) {
  const timeStr = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  const logLine = `[${timeStr}] ${msg}\n`;
  console.error(msg);
  try {
    fs.appendFileSync(LOG_FILE, logLine);
  } catch (e) {}
}

// --- Key Management ---
function loadKeys() {
  try {
    const data = fs.readFileSync(KEYS_FILE, 'utf-8');
    const keys = JSON.parse(data);
    if (Array.isArray(keys) && keys.length > 0) {
      return keys.filter(k => typeof k === 'string' && k.startsWith('sk-'));
    }
  } catch (err) {
    console.error('[Router] Error reading keys.json:', err.message);
  }
  return [];
}

let keys = loadKeys();
logRouter(`[Router] Initialized with ${keys.length} API keys.`);

// In-flight concurrency tracking per key index
const inFlightCount = new Map();

function incrementInFlight(index) {
  const current = inFlightCount.get(index) || 0;
  inFlightCount.set(index, current + 1);
}

function decrementInFlight(index) {
  const current = inFlightCount.get(index) || 0;
  inFlightCount.set(index, Math.max(0, current - 1));
}

// Conversation tracking
const conversationLeadKeyMap = new Map();
let nextLeadKeyIndex = 0;

function getConversationId(req, bodyBuffer) {
  if (req.headers['x-thread-id']) return req.headers['x-thread-id'];
  if (req.headers['x-conversation-id']) return req.headers['x-conversation-id'];
  if (req.headers['x-session-id']) return req.headers['x-session-id'];
  const turnMeta = req.headers['x-codex-turn-metadata'];
  if (turnMeta) {
    const m = turnMeta.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m) return m[1].toLowerCase();
  }

  if (bodyBuffer && bodyBuffer.length > 0) {
    try {
      const bodyStr = bodyBuffer.toString('utf-8');
      const sessionMatch = bodyStr.match(/"(?:session_id|thread_id|conversation_id)":\s*"([^"]+)"/i);
      if (sessionMatch) return sessionMatch[1].toLowerCase();

      const uuidMatch = bodyStr.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (uuidMatch) return uuidMatch[1].toLowerCase();
    } catch (e) {}
  }

  return 'default-session';
}

function detectSubagent(req, bodyBuffer) {
  const agentRoleHeader = req.headers['x-codex-agent-role'] || req.headers['x-agent-role'] || req.headers['x-subagent'];
  if (agentRoleHeader) {
    return { isSubagent: true, label: `Header:${agentRoleHeader}` };
  }

  if (bodyBuffer && bodyBuffer.length > 0) {
    try {
      const bodyStr = bodyBuffer.toString('utf-8');

      if (bodyStr.includes('"collaboration_mode_kind":"subagent"') ||
          bodyStr.includes('"collaboration_mode_kind":"review"') ||
          bodyStr.includes('"initiating_agent_path"') ||
          bodyStr.includes('"collaboration_mode_kind":"collaborator"')) {
        return { isSubagent: true, label: 'Codex-Collaboration-Subagent' };
      }

      const subagentMatches = bodyStr.match(/(?:subagent|sub-agent|code-reviewer|code review|analyzer|specialist|investigator)/i);
      if (subagentMatches && (bodyStr.includes('"role":"developer"') || bodyStr.includes('"role":"system"'))) {
        return { isSubagent: true, label: `Prompt:${subagentMatches[0]}` };
      }
    } catch (e) {}
  }

  return { isSubagent: false, label: 'Lead-Agent' };
}

function getLeadKeyIndex(convId) {
  keys = loadKeys();
  if (keys.length === 0) return 0;

  if (!conversationLeadKeyMap.has(convId)) {
    const assigned = nextLeadKeyIndex % keys.length;
    conversationLeadKeyMap.set(convId, assigned);
    nextLeadKeyIndex = (nextLeadKeyIndex + 1) % keys.length;
    logRouter(`[Router] NEW CONVERSATION: [${convId.slice(0, 16)}] -> Primary Lead Key #${assigned + 1}`);
  }
  return conversationLeadKeyMap.get(convId);
}

function selectKeyForRequest(convId, isSubagent, subagentLabel) {
  keys = loadKeys();
  if (keys.length === 0) return { keyIndex: 0, role: 'Fallback', isParallel: false };

  const leadKey = getLeadKeyIndex(convId);
  const leadBusy = (inFlightCount.get(leadKey) || 0) > 0;

  if (!isSubagent && !leadBusy) {
    incrementInFlight(leadKey);
    return { keyIndex: leadKey, role: 'Lead-Agent', isParallel: false };
  }

  const isParallel = !isSubagent && leadBusy;
  const roleName = isSubagent ? `⚡ Subagent [${subagentLabel}]` : `⚡ Parallel-Turn [Lead Busy]`;

  let candidates = [];
  for (let i = 0; i < keys.length; i++) {
    if (i !== leadKey) candidates.push(i);
  }
  if (candidates.length === 0) candidates = [leadKey];

  candidates.sort((a, b) => {
    const countA = inFlightCount.get(a) || 0;
    const countB = inFlightCount.get(b) || 0;
    return countA - countB;
  });

  const chosenKey = candidates[0];
  incrementInFlight(chosenKey);
  logRouter(`[Router] [${roleName}] Conv [${convId.slice(0, 8)}] -> Assigned Dedicated Key #${chosenKey + 1} (In-flight: ${inFlightCount.get(chosenKey)})`);
  return { keyIndex: chosenKey, role: roleName, isParallel: true };
}

function sendUpstreamRequest(options, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      resolve(res);
    });
    req.on('error', reject);
    if (bodyBuffer && bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

// --- HTTP Proxy Server ---
const server = http.createServer((clientReq, clientRes) => {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', async () => {
    let bodyBuffer = Buffer.concat(chunks);
    const urlPath = clientReq.url;

    // Auto-map model & reasoning, and sanitize tools
    if (bodyBuffer && bodyBuffer.length > 0) {
      try {
        const bodyStr = bodyBuffer.toString('utf-8');
        let bodyObj = null;
        let modified = false;

        if (bodyStr.startsWith('{')) {
          bodyObj = JSON.parse(bodyStr);
        }

        if (bodyObj) {
          if (bodyObj.model === 'gpt-6-astra') {
            bodyObj.model = 'gpt-6.1-sol';
            modified = true;
          }

          if (bodyObj.reasoning && bodyObj.reasoning.effort === 'ultra') {
            bodyObj.reasoning.effort = 'max';
            modified = true;
          }

          if (Array.isArray(bodyObj.tools)) {
            const beforeCount = bodyObj.tools.length;
            bodyObj.tools = bodyObj.tools.filter(t => {
              const name = (t && t.function && t.function.name) || (t && t.name) || '';
              return !name.startsWith('collaboration.') && !name.includes('create_channel');
            });
            if (bodyObj.tools.length !== beforeCount) {
              modified = true;
            }
          }

          if (modified) {
            bodyBuffer = Buffer.from(JSON.stringify(bodyObj), 'utf-8');
          }
        }
      } catch (e) {
        logRouter(`[Router] Error transforming body: ${e.message}`);
      }
    }

    keys = loadKeys();
    if (keys.length === 0) {
      clientRes.writeHead(500, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { message: 'No API keys configured in keys.json' } }));
      return;
    }

    const convId = getConversationId(clientReq, bodyBuffer);

    // Pass-through for /v1/models
    if (urlPath.includes('/models') && clientReq.method === 'GET') {
      const activeKey = keys[0];
      const headers = { ...clientReq.headers };
      delete headers.host;
      headers['authorization'] = `Bearer ${activeKey}`;
      headers['user-agent'] = 'Codex Desktop';

      const options = {
        hostname: UPSTREAM_HOST,
        port: 443,
        path: urlPath,
        method: 'GET',
        headers: headers
      };

      try {
        const upstreamRes = await sendUpstreamRequest(options);
        clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      } catch (err) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { message: err.message } }));
      }
      return;
    }

    // Inspect request: Lead Agent vs Subagent vs Parallel
    const subagentInfo = detectSubagent(clientReq, bodyBuffer);
    const selection = selectKeyForRequest(convId, subagentInfo.isSubagent, subagentInfo.label);

    // Differentiate reasoning effort: Lead Agent -> 'max', Subagent/Parallel -> 'xhigh'
    const targetEffort = (subagentInfo.isSubagent || selection.isParallel) ? 'xhigh' : 'max';
    try {
      if (bodyBuffer && bodyBuffer.length > 0) {
        const bodyStr = bodyBuffer.toString('utf-8');
        if (bodyStr.startsWith('{')) {
          const bodyObj = JSON.parse(bodyStr);
          if (!bodyObj.reasoning) {
            bodyObj.reasoning = { effort: targetEffort };
          } else {
            bodyObj.reasoning.effort = targetEffort;
          }
          bodyBuffer = Buffer.from(JSON.stringify(bodyObj), 'utf-8');
          logRouter(`[Router] [${selection.role}] Reasoning effort calibrated to '${targetEffort}'`);
        }
      }
    } catch (e) {
      logRouter(`[Router] Error updating reasoning effort: ${e.message}`);
    }

    let currentKeyIndex = selection.keyIndex;
    let attempts = 0;
    const maxAttempts = keys.length;

    while (attempts < maxAttempts) {
      const selectedKey = keys[currentKeyIndex];
      const keyLabel = `Key #${currentKeyIndex + 1}`;

      const headers = { ...clientReq.headers };
      delete headers.host;
      headers['authorization'] = `Bearer ${selectedKey}`;
      headers['user-agent'] = 'Codex Desktop';
      headers['x-openai-actor-authorization'] = 'local-image-extension';
      if (bodyBuffer.length > 0) {
        headers['content-length'] = bodyBuffer.length;
      }

      const options = {
        hostname: UPSTREAM_HOST,
        port: 443,
        path: urlPath,
        method: clientReq.method,
        headers: headers
      };

      try {
        const upstreamRes = await sendUpstreamRequest(options, bodyBuffer);

        if (upstreamRes.statusCode === 429 || upstreamRes.statusCode === 503 || upstreamRes.statusCode === 502) {
          logRouter(`[Router] [${selection.role}] ${keyLabel} returned HTTP ${upstreamRes.statusCode}. Auto failover to next key...`);
          
          await new Promise(r => {
            upstreamRes.on('data', () => {});
            upstreamRes.on('end', r);
          });

          decrementInFlight(currentKeyIndex);
          currentKeyIndex = (currentKeyIndex + 1) % keys.length;
          incrementInFlight(currentKeyIndex);
          attempts++;
          continue;
        }

        logRouter(`[Router] [${selection.role}] -> ${keyLabel} | HTTP ${upstreamRes.statusCode} Streaming... (Active on Key: ${inFlightCount.get(currentKeyIndex)})`);

        let finished = false;
        const cleanup = () => {
          if (!finished) {
            finished = true;
            decrementInFlight(currentKeyIndex);
            logRouter(`[Router] [${selection.role}] -> Finished stream on Key #${currentKeyIndex + 1} (Remaining: ${inFlightCount.get(currentKeyIndex) || 0})`);
          }
        };

        clientRes.on('finish', cleanup);
        clientRes.on('close', cleanup);
        clientRes.on('error', cleanup);

        clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
        return;

      } catch (err) {
        logRouter(`[Router] Error with ${keyLabel}: ${err.message}`);
        decrementInFlight(currentKeyIndex);
        currentKeyIndex = (currentKeyIndex + 1) % keys.length;
        incrementInFlight(currentKeyIndex);
        attempts++;
      }
    }

    logRouter(`[Router] [${convId}] ALL ${keys.length} KEYS FAILED.`);
    clientRes.writeHead(503, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      error: {
        message: 'All API keys returned 429/503. Upstream rate limit reached on all keys. Please wait 1 minute.',
        type: 'router_exhausted'
      }
    }));
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logRouter(`[Router] Port ${PORT} already in use. Existing router process will handle traffic.`);
  } else {
    logRouter(`[Router] Server error: ${err.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  logRouter(`============================================================`);
  logRouter(` Codex Multi-API Key Router is ACTIVE on http://127.0.0.1:${PORT}`);
  logRouter(` Upstream: ${UPSTREAM_HOST}`);
  logRouter(` Loaded ${keys.length} API keys in pool.`);
  logRouter(` Auto Failover on 429/503 enabled.`);
  logRouter(`============================================================`);
});

// --- MCP Protocol Handler (over stdio) ---
function sendMcpResponse(response) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    console.error('[Router MCP] Invalid JSON:', trimmed);
    return;
  }

  if (msg.method === 'notifications/initialized') {
    logRouter('[Router MCP] Client connection initialized.');
    return;
  }

  if (typeof msg.id === 'undefined') {
    return;
  }

  if (msg.method === 'initialize') {
    sendMcpResponse({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'codex-api-router',
          version: '1.2.0'
        }
      }
    });
  } else if (msg.method === 'ping') {
    sendMcpResponse({
      jsonrpc: '2.0',
      id: msg.id,
      result: {}
    });
  } else if (msg.method === 'tools/list') {
    sendMcpResponse({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'get_router_status',
            description: 'Returns health, key pool size, active in-flight requests per key, and subagent routing statistics.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ]
      }
    });
  } else if (msg.method === 'tools/call') {
    const toolName = msg.params && msg.params.name;
    if (toolName === 'get_router_status') {
      keys = loadKeys();
      const inFlightReport = keys.map((k, i) => `Key #${i + 1} (${k.slice(0, 8)}...): ${inFlightCount.get(i) || 0} active`).join('\n  ');
      sendMcpResponse({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            {
              type: 'text',
              text: `Codex Key Router Mode A (Lead + Subagent Splitting)\nHTTP: http://127.0.0.1:${PORT}\nTotal Keys in Pool: ${keys.length}\nActive Conversations: ${conversationLeadKeyMap.size}\nIn-flight Requests:\n  ${inFlightReport}`
            }
          ]
        }
      });
    } else {
      sendMcpResponse({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32601,
          message: `Tool '${toolName}' not found`
        }
      });
    }
  } else {
    sendMcpResponse({
      jsonrpc: '2.0',
      id: msg.id,
      error: {
        code: -32601,
        message: `Method '${msg.method}' not found`
      }
    });
  }
});

rl.on('close', () => {
  logRouter('[Router MCP] Codex closed connection. Exiting...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
