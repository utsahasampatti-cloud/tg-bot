require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const http = require("http");

// --- ENV ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL;

if (!BOT_TOKEN || !API_BASE_URL) {
  console.error("Missing BOT_TOKEN or API_BASE_URL");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
bot.catch((err) => console.error("Telegraf error:", err));

// --- Railway keep-alive HTTP ---
const PORT = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
});
server.listen(PORT, () => console.log("HTTP server on", PORT));

// --- Session (MVP, in-memory) ---
const sessions = new Map();
function freshFilters() {
  return {
    city: "Kraków",
    districts: [],
    price_min: null,
    price_max: null,
    rooms: [],     // enum list
    pets: null,    // "Tak"|"Nie"|null
    parking: [],   // ["w garażu", "parking strzeżony"]
    elevator: null // true|null
  };
}
function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { step: "idle", filters: freshFilters(), queue: [] });
  }
  return sessions.get(userId);
}

// --- Options ---
const DISTRICTS = [
  "Stare Miasto",
  "Grzegórzki",
  "Krowodrza",
  "Podgórze",
  "Nowa Huta",
  "Bronowice",
  "Bieżanów-Prokocim",
  "Łagiewniki-Borek-Falecki",
];

const PARKING_OPTIONS = ["w garażu", "parking strzeżony"];

function roomsToEnumList(n) {
  if (n === 1) return ["one"];
  if (n === 2) return ["two"];
  if (n === 3) return ["three", "four", "five_more"]; // 3+
  return [];
}

// --- Keyboards ---
function districtsKeyboard(selected) {
  const rows = [];
  for (let i = 0; i < DISTRICTS.length; i += 2) {
    const a = DISTRICTS[i];
    const b = DISTRICTS[i + 1];
    rows.push([
      Markup.button.callback(`${selected.includes(a) ? "✅ " : ""}${a}`, `d:${a}`),
      ...(b ? [Markup.button.callback(`${selected.includes(b) ? "✅ " : ""}${b}`, `d:${b}`)] : []),
    ]);
  }
  rows.push([
    Markup.button.callback("Пропустити ➜", "d_skip"),
    Markup.button.callback("Готово ➜", "d_done"),
  ]);
  return Markup.inlineKeyboard(rows);
}

function roomsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("1", "r:1"),
      Markup.button.callback("2", "r:2"),
      Markup.button.callback("3+", "r:3"),
      Markup.button.callback("будь-які", "r:any"),
    ],
  ]);
}

function petsKeyboard(current) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`${current === "Tak" ? "✅ " : ""}Так`, "p:Tak"),
      Markup.button.callback(`${current === "Nie" ? "✅ " : ""}Ні`, "p:Nie"),
      Markup.button.callback(`${current === null ? "✅ " : ""}Все одно`, "p:any"),
    ],
  ]);
}

function parkingKeyboard(selected) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`${selected.includes(PARKING_OPTIONS[0]) ? "✅ " : ""}Гараж`, `park:${PARKING_OPTIONS[0]}`),
      Markup.button.callback(`${selected.includes(PARKING_OPTIONS[1]) ? "✅ " : ""}Охоронюваний`, `park:${PARKING_OPTIONS[1]}`),
    ],
    [
      Markup.button.callback("Не треба ➜", "park_skip"),
      Markup.button.callback("Готово ➜", "park_done"),
    ],
  ]);
}

function elevatorKeyboard(current) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`${current === true ? "✅ " : ""}Ліфт must-have`, "e:yes"),
      Markup.button.callback(`${current === null ? "✅ " : ""}Все одно`, "e:any"),
    ],
  ]);
}

function confirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔍 Шукати", "go")],
    [Markup.button.callback("♻️ Почати заново", "restart")],
  ]);
}

// --- Backend calls ---
async function callSearch(userId, filters, limit = 10) {
  const payload = {
    user_id: userId,
    filters: {
      city: filters.city || "Kraków",
      districts: Array.isArray(filters.districts) ? filters.districts : [],
      price_min: filters.price_min ?? null,
      price_max: filters.price_max ?? null,
      rooms: Array.isArray(filters.rooms) ? filters.rooms : [],
      pets: filters.pets ?? null,
      parking: Array.isArray(filters.parking) ? filters.parking : [],
      elevator: filters.elevator === true ? true : null,
    },
    limit,
  };

  const res = await axios.post(`${API_BASE_URL}/search`, payload, { timeout: 20000 });
  return res.data; // { job_id }
}

async function callFeed(userId, limit = 10) {
  const res = await axios.get(`${API_BASE_URL}/feed`, {
    params: { user_id: userId, limit },
    timeout: 20000,
  });
  return res.data;
}

async function callState(userId, listingId, state) {
  await axios.post(
    `${API_BASE_URL}/state`,
    { user_id: userId, listing_id: listingId, state },
    { timeout: 15000 }
  );
}

// --- Cards ---
function listingCard(listing) {
  const price = listing.price_value ? `${listing.price_value} zł` : "ціна не вказана";
  const loc = listing.location || "локація не вказана";
  const title = listing.title || "Оголошення";
  const text = `🏠 ${title}\n📍 ${loc}\n💰 ${price}\n🔗 ${listing.url}`;
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
    await ctx.reply("Поки все. Натисни /start — і я знову піду на полювання 🌙");
    s.step = "idle";
    return;
  }
  const l = s.queue.shift();
  const c = listingCard(l);
  await ctx.reply(c.text, c.kb);
}

function summaryText(f) {
  const d = f.districts.length ? f.districts.join(", ") : "будь-які";
  const price = f.price_max ? `до ${f.price_max} zł` : "без ліміту";
  const rooms = f.rooms.length ? f.rooms.join(", ") : "будь-які";
  const pets = f.pets ? f.pets : "все одно";
  const parking = f.parking.length ? f.parking.join(", ") : "неважливо";
  const elevator = f.elevator === true ? "Так" : "Все одно";

  return (
    `Окей, я зловила твій вайб ✨\n\n` +
    `📍 Райони: ${d}\n` +
    `💰 Бюджет: ${price}\n` +
    `🚪 Кімнати: ${rooms}\n` +
    `🐕 Тварини: ${pets}\n` +
    `🚗 Паркінг: ${parking}\n` +
    `🛗 Ліфт: ${elevator}\n\n` +
    `Запускаю пошук?`
  );
}

// --- Flow ---
bot.start(async (ctx) => {
  const s = getSession(ctx.from.id);
  s.step = "districts";
  s.filters = freshFilters();
  s.queue = [];

  await ctx.reply(
    "Привіт, я She 🌙\nЗнайду тобі вигідну оренду в Кракові — без зайвого шуму.\n\nОбери райони (можна кілька) або пропусти:",
    districtsKeyboard(s.filters.districts)
  );
});

// districts toggle
bot.action(/^d:(.+)$/, async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "districts") return ctx.answerCbQuery();

  const district = ctx.match[1];
  const idx = s.filters.districts.indexOf(district);
  if (idx >= 0) s.filters.districts.splice(idx, 1);
  else s.filters.districts.push(district);

  await ctx.editMessageReplyMarkup(districtsKeyboard(s.filters.districts).reply_markup);
  await ctx.answerCbQuery();
});

bot.action("d_skip", async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "districts") return ctx.answerCbQuery();

  s.filters.districts = [];
  s.step = "price";
  await ctx.reply("Ок. Який максимальний бюджет? (числом, напр. 3500)");
  await ctx.answerCbQuery();
});

bot.action("d_done", async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "districts") return ctx.answerCbQuery();

  s.step = "price";
  await ctx.reply("Супер. Який максимальний бюджет? (числом, напр. 3500)");
  await ctx.answerCbQuery();
});

// price input
bot.on("text", async (ctx) => {
  const s = getSession(ctx.from.id);

  if (s.step !== "price") {
    await ctx.reply("Якщо хочеш новий пошук — натисни /start 🌙");
    return;
  }

  const raw = ctx.message.text.trim().replace(/\s/g, "");
  const v = Number(raw);

  if (!Number.isFinite(v) || v <= 0) {
    await ctx.reply("Мені треба число типу 3500. Спробуй ще раз 🙂");
    return;
  }

  s.filters.price_max = Math.round(v);
  s.step = "rooms";
  await ctx.reply("Кімнати?", roomsKeyboard());
});

// rooms select
bot.action(/^r:(.+)$/, async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "rooms") return ctx.answerCbQuery();

  const v = ctx.match[1];
  s.filters.rooms = v === "any" ? [] : roomsToEnumList(Number(v));

  s.step = "pets";
  await ctx.reply("Тварини ок?", petsKeyboard(s.filters.pets));
  await ctx.answerCbQuery();
});

// pets select
bot.action(/^p:(.+)$/, async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "pets") return ctx.answerCbQuery();

  const v = ctx.match[1];
  s.filters.pets = v === "any" ? null : v; // "Tak"|"Nie"

  s.step = "parking";
  await ctx.reply("Паркінг?", parkingKeyboard(s.filters.parking));
  await ctx.answerCbQuery();
});

// parking toggle
bot.action(/^park:(.+)$/, async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "parking") return ctx.answerCbQuery();

  const p = ctx.match[1];
  const idx = s.filters.parking.indexOf(p);
  if (idx >= 0) s.filters.parking.splice(idx, 1);
  else s.filters.parking.push(p);

  await ctx.editMessageReplyMarkup(parkingKeyboard(s.filters.parking).reply_markup);
  await ctx.answerCbQuery();
});

bot.action("park_skip", async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "parking") return ctx.answerCbQuery();

  s.filters.parking = [];
  s.step = "elevator";
  await ctx.reply("Ліфт важливий?", elevatorKeyboard(s.filters.elevator));
  await ctx.answerCbQuery();
});

bot.action("park_done", async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "parking") return ctx.answerCbQuery();

  s.step = "elevator";
  await ctx.reply("Ліфт важливий?", elevatorKeyboard(s.filters.elevator));
  await ctx.answerCbQuery();
});

// elevator select
bot.action(/^e:(.+)$/, async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "elevator") return ctx.answerCbQuery();

  const v = ctx.match[1];
  s.filters.elevator = v === "yes" ? true : null;

  s.step = "confirm";
  await ctx.reply(summaryText(s.filters), confirmKeyboard());
  await ctx.answerCbQuery();
});

// restart
bot.action("restart", async (ctx) => {
  const s = getSession(ctx.from.id);
  s.step = "idle";
  await ctx.answerCbQuery();
  await ctx.reply("Рестарт. Натисни /start 🌙");
});

// go search
bot.action("go", async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "confirm") return ctx.answerCbQuery();

  await ctx.answerCbQuery();
  await ctx.reply("Ок, я пірнаю в OLX… 🫧");

  try {
    const { job_id } = await callSearch(ctx.from.id, s.filters, 10);
    await ctx.reply(`Я в роботі. Job: ${job_id}`);

    const list = await callFeed(ctx.from.id, 10);
    s.queue = Array.isArray(list) ? list : [];
    s.step = "showing";

    if (!s.queue.length) {
      await ctx.reply("Поки порожньо. Дай мені хвилинку і спробуй /start ще раз.");
      s.step = "idle";
      return;
    }

    await sendNext(ctx);
  } catch (e) {
    console.error("Backend error:", e?.response?.status, e?.response?.data || e?.message);
    await ctx.reply("Я зараз не дотягнулась до бекенда 😿 Перевір ще раз через хвилину.");
    s.step = "idle";
  }
});

// like/skip
bot.action(/^like:(.+)$/, async (ctx) => {
  try { await callState(ctx.from.id, ctx.match[1], "liked"); } catch {}
  await ctx.answerCbQuery("Лайк ✅");
  return sendNext(ctx);
});

bot.action(/^skip:(.+)$/, async (ctx) => {
  try { await callState(ctx.from.id, ctx.match[1], "skipped"); } catch {}
  await ctx.answerCbQuery("Скіп ❌");
  return sendNext(ctx);
});

// launch
bot.launch({ dropPendingUpdates: true });
console.log("Bot is running (polling)");

function shutdown(sig) {
  console.log("Shutdown", sig);
  try { bot.stop(sig); } catch {}
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
