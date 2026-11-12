// NEAR Agent Market (market.near.ai) — hire agents that already exist.
//
// The public market is anonymous for browsing and for preparing a hire. The
// checkout — the point where money actually moves — happens in the buyer's
// own session on the market site. BOSS never sees a card, never holds funds,
// and never pretends the hire is complete before the visitor confirms it.
//
// Everything here is also covered by tests/agent-market.test.js, which points
// this module at a fake market on localhost.

const BASE = () => process.env.AGENT_MARKET_URL ?? "https://market.near.ai";

const json = async (res) => {
  if (!res.ok) throw new Error(`agent market answered ${res.status}`);
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("agent market returned invalid JSON");
  }
};

export async function searchAgents({ q = "", limit = 6 } = {}) {
  const url = new URL(`${BASE()}/v1/agents`);
  if (q) url.searchParams.set("q", q);
  url.searchParams.set("limit", String(Math.min(Math.max(Number(limit) || 6, 1), 20)));
  const body = await json(await fetch(url, { signal: AbortSignal.timeout(20_000) }));
  const agents = Array.isArray(body.agents) ? body.agents : [];
  return agents.map((a) => ({
    id: a.agent_id,
    name: a.name,
    handle: a.handle,
    bio: a.bio_markdown ?? a.description ?? "",
    delivered: a.delivered_jobs ?? 0,
    category: a.category ?? null,
    available: a.available_now === true,
    slaSeconds: a.sla_seconds ?? null,
  }));
}

export async function getAgent(handle) {
  const body = await json(await fetch(`${BASE()}/v1/agents/${encodeURIComponent(handle)}`, {
    signal: AbortSignal.timeout(20_000),
  }));
  const a = body.agent ?? body;
  return {
    id: a.agent_id,
    name: a.name,
    handle: a.handle,
    bio: a.bio_markdown ?? a.description ?? "",
    delivered: a.delivered_jobs ?? 0,
    enabled: a.listing_status === "live" || a.availability === "available",
    price: a.price ?? a.price_usd ?? null,
  };
}

export async function createHireDraft({ agentId, brief, acceptanceWindowDays = 3 } = {}) {
  const body = await json(
    await fetch(`${BASE()}/v1/agents/${encodeURIComponent(agentId)}/hire-draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief, acceptanceWindowDays }),
      signal: AbortSignal.timeout(20_000),
    }),
  );
  return {
    hireDraftId: body.hireDraftId,
    agentHandle: body.agentHandle,
    agentName: body.agentName,
    checkoutUrl: `https://market.near.ai`,
    expiresAt: body.expiresAt,
  };
}
