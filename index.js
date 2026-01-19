require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const http = require("http");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL;

console.log("ENV CHECK:", {
  hasBOT_TOKEN: !!BOT_TOKEN,
  hasAPI_BASE_URL: !!API_BASE_URL,
  RAILWAY_CHECK: process.env.RAILWAY_CHECK || null,
});

if (!BOT_TOKEN || !API_BASE_URL) {
  console.error("Missing BOT_TOKEN or API_BASE_URL");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  await ctx.reply("She online 🌙");
});

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

bot.launch({ dropPendingUpdates: true });
console.log("Bot is running");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
