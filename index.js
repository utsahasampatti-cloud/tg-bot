require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const http = require("http");

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL;

if (!BOT_TOKEN || !API_BASE_URL) {
  console.error("Missing BOT_TOKEN or API_BASE_URL");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------- SESSION (in-memory MVP) ----------
const sessions = new Map();
function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      step: "idle",
      filters: {
        city: "Kraków",
        districts: [],
        price_min: null,
        price_max: null,
        rooms: [],
        pets: null,
        parking: [],
        elevator: null,
      },
      queue: [],
    });
  }
  return sessions.get(userId);
}

// ---------- HELPERS ----------
function roomsToEnumList(n) {
  if (n === 1) return ["one"];
  if (n === 2) return ["two"];
  if (n === 3) return ["three", "four", "five_more"];
  return [];
}

// ---------- BACKEND ----------
async function callSearch(userId, filters, limit = 10) {
  const payload = {
    user_id: userId,
    filters: {
      city: "Kraków",
      districts: filters.districts || [],
      price_min: filters.price_min ?? null,
      price_max: filters.price_max ?? null,
      rooms: Array.isArray(filters.rooms) ? filters.rooms : roomsToEnumList(filters.rooms),
      pets: filters.pets ?? null,
      parking: filters.parking || [],
      elevator: filters.elevator === true ? true : null,
    },
    limit,
  };

  const res = await axios.post(`${API_BASE_URL}/search`, payload, { timeout: 15000 });
  return res.data;
}

async function callFeed(userId, limit = 10) {
  const res = await axios.get(`${API_BASE_URL}/feed`, {
    params: { user_id: userId, limit },
    timeout: 15000,
  });
  return res.data;
}

async function callState(userId, listingId, state) {
  await axios.post(`${API_BASE_URL}/state`, {
    user_id: userId,
    listing_id: listingId,
    state,
  });
}

// ---------- UI ----------
function listingCard(listing) {
  const price = listing.price_value ? `${listing.price_value} zł` : "ціна не вказана";
  const text = `🏠 ${listing.title}\n💰 ${price}\n🔗 ${listing.url}`;
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback("❤️ Like", `like:${listing.id}`),
      Markup.button.callback("❌ Skip", `skip:${listing.id}`),
    ],
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

// ---------- FLOW ----------
bot.start(async (ctx) => {
  const s = getSession(ctx.from.id);
  s.step = "price";
  s.filters = { city: "Kraków", districts: [], price_min: null, price_max: null, rooms: [], pets: null, parking: [], elevator: null };
  s.queue = [];
  await ctx.reply("Привіт 🌙\nЯ знайду тобі квартиру в Кракові.\n\nЯкий максимальний бюджет? (напр. 3500)");
});

bot.on("text", async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "price") return;

  const v = Number(ctx.message.text.trim());
  if (!Number.isFinite(v)) {
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
  s.step = "search";
  await ctx.answerCbQuery();
  await ctx.reply("Шукаю… ⏳");

  try {
    await callSearch(ctx.from.id, s.filters, 10);
    const list = await callFeed(ctx.from.id, 10);
    s.queue = list || [];
    s.step = "show";
    await sendNext(ctx);
  } catch {
    await ctx.reply("Помилка бекенда 😿");
    s.step = "idle";
  }
});

bot.action(/^like:(.+)$/, async (ctx) => {
  await callState(ctx.from.id, ctx.match[1], "liked");
  await ctx.answerCbQuery("❤️");
  await sendNext(ctx);
});

bot.action(/^skip:(.+)$/, async (ctx) => {
  await callState(ctx.from.id, ctx.match[1], "skipped");
  await ctx.answerCbQuery("❌");
  await sendNext(ctx);
});

// ---------- RAILWAY KEEP-ALIVE ----------
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200);
    res.end("ok");
  })
  .listen(PORT, () => console.log("HTTP server on", PORT));

bot.launch();
console.log("Bot is running");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
