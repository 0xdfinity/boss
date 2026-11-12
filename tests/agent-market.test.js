// The outbound rail: search the public agent market and draft a hire. The
// test points the module at a fake market on localhost, because the real one
// is anonymous-read and does not need a fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { searchAgents, createHireDraft } from "../src/market/agent-market.js";

const agents = [
  {
    agent_id: "11111111-1111-4111-8111-111111111111",
    name: "Stat Report",
    handle: "stat-report",
    delivered_jobs: 12,
    availability: "available",
    available_now: true,
    sla_seconds: 3600,
    category: "research",
  },
  {
    agent_id: "22222222-2222-4222-8222-222222222222",
    name: "Waterfall Check",
    handle: "waterfall-check",
    delivered_jobs: 0,
    availability: "unavailable",
    available_now: false,
    sla_seconds: 86400,
    category: "devops",
  },
];

test("search returns public agents, best-effort shapes", async () => {
  const hits = { agents: 0, draft: 0 };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/v1/agents") {
      hits.agents += 1;
      res.end(JSON.stringify({ agents }));
      return;
    }
    if (url.pathname.startsWith("/v1/agents/") && url.pathname.endsWith("/hire-draft")) {
      hits.draft += 1;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        assert.equal(typeof parsed.brief, "string");
        assert.equal(parsed.acceptanceWindowDays, 3);
        res.statusCode = 201;
        res.end(JSON.stringify({
          hireDraftId: "d-draft-1",
          agentId: "11111111-1111-4111-8111-111111111111",
          agentHandle: "stat-report",
          agentName: "Stat Report",
          brief: parsed.brief,
          acceptanceWindowDays: 3,
          expiresAt: new Date(Date.now() + 3600e3).toISOString(),
        }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  process.env.AGENT_MARKET_URL = `http://127.0.0.1:${port}`;

  const found = await searchAgents({ q: "verification", limit: 3 });
  assert.equal(found.length, 2);
  assert.equal(found[0].handle, "stat-report");
  assert.equal(found[0].available, true);
  assert.equal(found[1].available, false);
  assert.equal(hits.agents, 1);

  const draft = await createHireDraft({ agentId: found[0].id, brief: "verify this claim" });
  assert.equal(draft.hireDraftId, "d-draft-1");
  assert.equal(draft.agentHandle, "stat-report");
  assert.equal(hits.draft, 1);

  server.close();
  delete process.env.AGENT_MARKET_URL;
});
