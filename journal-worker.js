const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Suivi-Key, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function cleanTime(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return "";
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return "";
  return `${match[1]}:${match[2]}`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/event") return saveEvent(request, env);
    if (request.method === "GET" && url.pathname === "/events") return listEvents(request, env);
    return json({ error: "Introuvable." }, 404);
  },
};

async function saveEvent(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, 400);
  }
  const name = cleanName(body.name);
  if (!name) return json({ ok: false }, 400);

  const key = `p:${name.toLocaleLowerCase("fr")}`;
  const current = JSON.parse((await env.JOURNAL.get(key)) || "null") || {};
  const next = {
    name,
    last: typeof body.at === "string" ? body.at.slice(0, 40) : new Date().toISOString(),
    start: current.start || "",
    end: current.end || "",
  };
  const start = cleanTime(body.start);
  const end = cleanTime(body.end);
  if (start && end) {
    next.start = start;
    next.end = end;
  }
  await env.JOURNAL.put(key, JSON.stringify(next));
  return json({ ok: true });
}

async function allowedCaller(request, env) {
  const key = request.headers.get("X-Suivi-Key");
  if (env.SUIVI_KEY && key && key === env.SUIVI_KEY) return true;
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token || !env.SUIVI_EMAIL) return false;
  const response = await fetch("https://sts-mobilite.stsweb.fr/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: "query { me { email } }" }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  const email = String(body?.data?.me?.email || "").trim().toLowerCase();
  return email !== "" && email === String(env.SUIVI_EMAIL).trim().toLowerCase();
}

async function listEvents(request, env) {
  if (!(await allowedCaller(request, env))) return json({ error: "Interdit." }, 401);
  const listed = await env.JOURNAL.list({ prefix: "p:" });
  const rows = [];
  for (const entry of listed.keys) {
    const value = await env.JOURNAL.get(entry.name);
    if (!value) continue;
    try {
      rows.push(JSON.parse(value));
    } catch {}
  }
  rows.sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")));
  return json(rows);
}
