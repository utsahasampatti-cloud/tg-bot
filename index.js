require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const http = require("http");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL;

if (!BOT_TOKEN || !API_BASE_URL) {
  console.error("Missing BOT_TOKEN or API_BASE_URL");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
bot.catch((err) => console.error("Telegraf error:", err));

const sessions = new Map();
function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { step: "idle", filters: { price_max: null, rooms: [] }, queue: [] });
  }
  return sessions.get(userId);
}

function roomsToEnumList(n) {
  if (n === 1) return ["one"];
  if (n === 2) return ["two"];
  if (n === 3) return ["three", "four", "five_more"];
  return [];
}

async function callSearch(userId, filters, limit = 10) {
  const payload = {
    user_id: userId,
    filters: {
      city: "Kraków",
      districts: [],
      price_min: null,
      price_max: filters.price_max ?? null,
      rooms: Array.isArray(filters.rooms) ? filters.rooms : roomsToEnumList(filters.rooms),
      pets: null,
      parking: [],
      elevator: null,
    },
    limit,
  };
  const res = await axios.post(`${API_BASE_URL}/search`, payload, { timeout: 20000 });
  return res.data;
}

async function callFeed(userId, limit = 10) {
  const res = await axios.get(`${API_BASE_URL}/feed`, {
    params: { user_id: userId, limit },
    timeout: 20000,
  });
  return res.data;
}

async function callState(userId, listingId, state) {
  await axios.post(`${API_BASE_URL}/state`, { user_id: userId, listing_id: listingId, state }, { timeout: 15000 });
}

function listingCard(listing) {
  const price = listing.price_value ? `${listing.price_value} zł` : "ціна не вказана";
  const loc = listing.location || "локація не вказана";
  const title = listing.title || "Оголошення";
  const text = `🏠 ${title}\n📍 ${loc}\n💰 ${price}\n🔗 ${listing.url}`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("❤️ Like", `like:${listing.id}`), Markup.button.callback("❌ Skip", `skip:${listing.id}`)],
  ]);
  return { text, kb };
}

async function sendNext(ctx) {
  const s = getSession(ctx.from.id);
  if (!s.queue.length) {
    await ctx.reply("Поки все. Натисни /start для нового пошуку.");
    s.step = "idle";
    return;
  }
  const l = s.queue.shift();
  const c = listingCard(l);
  await ctx.reply(c.text, c.kb);
}

// --- Telegram flow
bot.start(async (ctx) => {
  const s = getSession(ctx.from.id);
  s.step = "price";
  s.filters = { price_max: null, rooms: [] };
  s.queue = [];
  await ctx.reply("She online 🌙\n\nЯкий максимальний бюджет? (напр. 3500)");
});

bot.on("text", async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "price") return;

  const v = Number(ctx.message.text.trim());
  if (!Number.isFinite(v) || v <= 0) {
    await ctx.reply("Введи число, напр. 3500");
    return;
  }

  s.filters.price_max = Math.round(v);
  s.step = "rooms";
  await ctx.reply(
    "Скільки кімнат?",
    Markup.inlineKeyboard([
      [Markup.button.callback("1", "r:1"), Markup.button.callback("2", "r:2"), Markup.button.callback("3+", "r:3"), Markup.button.callback("будь-які", "r:any")],
    ])
  );
});

bot.action(/^r:(.+)$/, async (ctx) => {
  const s = getSession(ctx.from.id);
  const v = ctx.match[1];
  s.filters.rooms = v === "any" ? [] : roomsToEnumList(Number(v));
  await ctx.answerCbQuery();
  await ctx.reply("Шукаю… ⏳");

  try {
    await callSearch(ctx.from.id, s.filters, 10);
    const list = await callFeed(ctx.from.id, 10);
    s.queue = Array.isArray(list) ? list : [];
    s.step = "show";
    await sendNext(ctx);
  } catch (e) {
    console.error("Backend error:", e?.response?.status, e?.response?.data || e?.message);
    await ctx.reply("Помилка бекенда 😿");
    s.step = "idle";
  }
});

bot.action(/^like:(.+)$/, async (ctx) => {
  try { await callState(ctx.from.id, ctx.match[1], "liked"); } catch (e) { console.error("State error:", e?.message); }
  await ctx.answerCbQuery("❤️");
  return sendNext(ctx);
});

bot.action(/^skip:(.+)$/, async (ctx) => {
  try { await callState(ctx.from.id, ctx.match[1], "skipped"); } catch (e) { console.error("State error:", e?.message); }
  await ctx.answerCbQuery("❌");
  return sendNext(ctx);
});

// --- HTTP server for Railway health
const PORT = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  // log pings so we see if Railway checks it
  console.log("HTTP", req.method, req.url);

  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
});

server.listen(PORT, () => console.log("HTTP server on", PORT));

// launch bot
bot.launch({ dropPendingUpdates: true });
console.log("Bot is running (polling)");

// graceful shutdown
function shutdown(sig) {
  console.log("Shutdown", sig);
  try { bot.stop(sig); } catch {}
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
