// supabase/functions/telegram-bot/index.ts
// Open Brain Telegram bot: save thoughts, search them, list recent ones.

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? ""
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? ""
const ALLOWED_CHAT_ID = Deno.env.get("TELEGRAM_ALLOWED_CHAT_ID") ?? ""
// These two are provided to every Edge Function automatically by Supabase:
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token",
}

const dbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
}

type Thought = { content: string; created_at: string }

function ok() {
  // Always answer 200 so Telegram never retries the same message.
  return new Response("ok", { status: 200, headers: cors })
}

async function reply(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  })
}

async function saveThought(content: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/thoughts`, {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ content }),
  })
  if (!r.ok) throw new Error(`Save failed (${r.status}): ${await r.text()}`)
}

async function queryThoughts(qs: string): Promise<Thought[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/thoughts?${qs}`, { headers: dbHeaders })
  if (!r.ok) throw new Error(`Query failed (${r.status}): ${await r.text()}`)
  return await r.json()
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "..." : s
}

function formatResults(rows: Thought[], title: string) {
  if (!rows.length) return "Nothing found."
  const lines = rows.map((r, i) => {
    // Change the timeZone below if you move.
    const d = new Date(r.created_at).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "America/Phoenix",
    })
    return `${i + 1}. ${clip(r.content, 350)}\n   (${d})`
  })
  return `${title}\n\n${lines.join("\n\n")}`
}

async function doSearch(chatId: number, term: string) {
  if (!term) {
    await reply(chatId, "What should I search for? Example: /search hello")
    return
  }
  const safe = term.replace(/[*%]/g, "")
  const rows = await queryThoughts(
    `select=content,created_at&content=ilike.*${encodeURIComponent(safe)}*&order=created_at.desc&limit=5`,
  )
  await reply(chatId, formatResults(rows, `Top ${rows.length} result(s) for "${safe}":`))
}

async function doRecent(chatId: number) {
  const rows = await queryThoughts("select=content,created_at&order=created_at.desc&limit=5")
  await reply(chatId, formatResults(rows, "Your 5 most recent thoughts:"))
}

const HELP =
  "Open Brain bot\n\n" +
  "Send any text to save it as a thought.\n" +
  "/search word  (or ?word) finds saved thoughts\n" +
  "/recent  shows your last 5 thoughts\n" +
  "/help  shows this message"

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (req.method !== "POST") return new Response("Open Brain bot is running", { headers: cors })

  // Only Telegram (which knows your secret) may call this function.
  if (!WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401, headers: cors })
  }

  let chatId: number | undefined
  try {
    const update = await req.json()
    const message = update?.message
    if (!message) return ok()
    chatId = message.chat.id
    const text: string = (message.text ?? "").trim()

    // First-time setup: tell the owner their chat ID so they can lock the bot to themselves.
    if (!ALLOWED_CHAT_ID) {
      await reply(
        chatId!,
        `Almost done! Your chat ID is ${chatId}.\n\nAdd it in Supabase as a secret named TELEGRAM_ALLOWED_CHAT_ID (value: ${chatId}), then message me again. Until then I won't save anything.`,
      )
      return ok()
    }
    // Ignore everyone except the owner.
    if (String(chatId) !== ALLOWED_CHAT_ID) return ok()

    if (!text) {
      await reply(chatId!, "I can only save text messages for now.")
      return ok()
    }

    const cmd = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/)
    if (cmd) {
      const name = cmd[1].toLowerCase()
      const arg = cmd[2].trim()
      if (name === "start" || name === "help") await reply(chatId!, HELP)
      else if (name === "recent") await doRecent(chatId!)
      else if (name === "search") await doSearch(chatId!, arg)
      else await reply(chatId!, "Unknown command. Send /help to see what I can do.")
    } else if (text.startsWith("?")) {
      await doSearch(chatId!, text.slice(1).trim())
    } else {
      await saveThought("💬 Telegram: " + text)
      await reply(chatId!, "✅ Saved to your brain")
    }
  } catch (e) {
    console.error(e)
    if (chatId) {
      await reply(chatId, "Something went wrong: " + (e instanceof Error ? e.message : String(e))).catch(() => {})
    }
  }
  return ok()
})
