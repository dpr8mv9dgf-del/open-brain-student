// supabase/functions/open-brain-mcp/index.ts
// Open Brain MCP server: lets an AI search, list, and add thoughts.
// Speaks JSON-RPC 2.0 (the message format MCP uses) over HTTP POST.

const ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? ""
// Provided automatically by Supabase to every Edge Function:
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, mcp-session-id, mcp-protocol-version",
}

const dbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
}

// ---------- The tools Claude can use ----------
const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search the user's Open Brain (their saved thoughts, notes, YouTube transcripts, PDFs, and past chats) by keyword. " +
      "Multiple words must all appear. Returns the newest matches first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for, e.g. 'junk removal margins'" },
        limit: { type: "number", description: "Max results (default 10, max 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description: "List the most recently saved thoughts from the user's Open Brain.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many to return (default 10, max 50)" },
      },
    },
  },
  {
    name: "add_thought",
    description: "Save a new thought or note into the user's Open Brain.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The text to save" },
      },
      required: ["content"],
    },
  },
]

// ---------- Small helpers ----------
type Thought = { id: string; content: string; created_at: string }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  })
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "..." : s)
const clamp = (v: unknown, def: number, max: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : def
}

function fmt(t: Thought, max: number) {
  return `[${t.created_at.slice(0, 10)}] (id: ${t.id})\n${clip(t.content, max)}`
}

// Compare two strings without leaking timing information.
function safeEqual(a: string, b: string) {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

function authorized(req: Request) {
  const header = req.headers.get("authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  return ACCESS_KEY.length > 0 && safeEqual(token, ACCESS_KEY)
}

async function dbGet(params: URLSearchParams): Promise<Thought[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/thoughts?${params}`, { headers: dbHeaders })
  if (!r.ok) throw new Error(`Database error (${r.status}): ${await r.text()}`)
  return await r.json()
}

// ---------- Tool implementations ----------
async function searchThoughts(args: any) {
  const words = String(args?.query ?? "")
    .replace(/[*%]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
  if (!words.length) return "Please give at least one word to search for."
  const p = new URLSearchParams()
  p.set("select", "id,content,created_at")
  for (const w of words) p.append("content", `ilike.*${w}*`) // every word must match
  p.set("order", "created_at.desc")
  p.set("limit", String(clamp(args?.limit, 10, 20)))
  const rows = await dbGet(p)
  if (!rows.length) return `No thoughts found matching: ${words.join(" ")}`
  return `Found ${rows.length} thought(s):\n\n` + rows.map((t) => fmt(t, 2500)).join("\n\n---\n\n")
}

async function listRecent(args: any) {
  const p = new URLSearchParams()
  p.set("select", "id,content,created_at")
  p.set("order", "created_at.desc")
  p.set("limit", String(clamp(args?.limit, 10, 50)))
  const rows = await dbGet(p)
  if (!rows.length) return "The brain is empty."
  return rows.map((t) => fmt(t, 1200)).join("\n\n---\n\n")
}

async function addThought(args: any) {
  const content = String(args?.content ?? "").trim()
  if (!content) return "Nothing to save: content was empty."
  if (content.length > 20000) return "That's too long to save in one thought (max 20,000 characters)."
  const r = await fetch(`${SUPABASE_URL}/rest/v1/thoughts?select=id,content,created_at`, {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ content: "🤖 Via Claude: " + content }),
  })
  if (!r.ok) throw new Error(`Save failed (${r.status}): ${await r.text()}`)
  const [saved] = await r.json()
  return `Saved.\n\n${fmt(saved, 500)}`
}

// ---------- JSON-RPC handling ----------
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]

// Returns a JSON-RPC response object, or null for notifications (which need no reply).
async function handle(msg: any) {
  const id = msg?.id
  const method = msg?.method
  const params = msg?.params
  if (id === undefined) return null // notification, e.g. "notifications/initialized"

  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result })
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } })

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "open-brain", version: "1.0.0" },
      })
    }
    case "ping":
      return ok({})
    case "tools/list":
      return ok({ tools: TOOLS })
    case "tools/call": {
      const name = params?.name
      const args = params?.arguments ?? {}
      try {
        let text: string
        if (name === "search_thoughts") text = await searchThoughts(args)
        else if (name === "list_recent") text = await listRecent(args)
        else if (name === "add_thought") text = await addThought(args)
        else return err(-32602, `Unknown tool: ${name}`)
        return ok({ content: [{ type: "text", text }] })
      } catch (e) {
        return ok({
          isError: true,
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        })
      }
    }
    default:
      return err(-32601, `Method not found: ${method}`)
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })

  // Everything else requires your MCP_ACCESS_KEY.
  if (!authorized(req)) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401)
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors })

  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400)
  }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map(handle))).filter((r) => r !== null)
    return replies.length ? json(replies) : new Response(null, { status: 202, headers: cors })
  }
  const reply = await handle(body)
  return reply ? json(reply) : new Response(null, { status: 202, headers: cors })
})
