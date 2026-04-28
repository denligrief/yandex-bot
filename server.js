import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { Telegraf, Markup } from "telegraf";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN не указан в .env");
  process.exit(1);
}

if (!WEBAPP_URL) {
  console.error("❌ WEBAPP_URL не указан в .env");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const name = ctx.from?.first_name || "друг";

  await ctx.reply(
`👋 Привет, ${name}!

Здесь можно зарабатывать на простых заданиях:
• подписки на Telegram-каналы
• быстрые проверки
• бонусы за друзей

Нажми кнопку ниже, чтобы открыть приложение 👇`,
    Markup.inlineKeyboard([
      Markup.button.webApp("💸 Заработать", WEBAPP_URL)
    ])
  );
});

bot.command("app", async (ctx) => {
  await ctx.reply(
    "Открыть приложение 👇",
    Markup.inlineKeyboard([
      Markup.button.webApp("💸 Открыть Mini App", WEBAPP_URL)
    ])
  );
});

// Проверка живости сервера
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Заглушка профиля
app.get("/api/profile", async (req, res) => {
  const userId = req.query.user_id || "unknown";

  res.json({
    user_id: userId,
    balance: 0,
    completed: 0,
    referral_earned: 0
  });
});

// Тут подключается Subgram API.
// Я оставил безопасную заглушку, чтобы приложение сразу запускалось.
// Когда у тебя будет точный URL/док API Subgram, сюда вставляется реальный fetch.
app.get("/api/tasks", async (req, res) => {
  const userId = req.query.user_id;

  if (!userId) {
    return res.status(400).json({ error: "user_id required" });
  }

  // Пример будущего подключения:
  //
  // const response = await fetch("https://api.subgram.ru/...", {
  //   method: "POST",
  //   headers: {
  //     "Authorization": `Bearer ${process.env.SUBGRAM_API_KEY}`,
  //     "Content-Type": "application/json"
  //   },
  //   body: JSON.stringify({ user_id: userId })
  // });
  //
  // const data = await response.json();
  // return res.json(data);

  res.json({
    tasks: [
      {
        id: "demo_1",
        title: "Подпишись на Telegram-канал",
        reward: 0.5,
        type: "subscribe",
        url: "https://t.me/telegram",
        status: "available"
      },
      {
        id: "demo_2",
        title: "Вступи в канал партнёра",
        reward: 0.75,
        type: "subscribe",
        url: "https://t.me/durov",
        status: "available"
      }
    ]
  });
});

app.post("/api/check-task", async (req, res) => {
  const { user_id, task_id } = req.body;

  if (!user_id || !task_id) {
    return res.status(400).json({ error: "user_id and task_id required" });
  }

  // Здесь потом будет проверка через Subgram или Telegram API.
  res.json({
    ok: true,
    message: "Задание отправлено на проверку",
    reward: 0.5
  });
});

app.listen(PORT, () => {
  console.log(`✅ Web server started on port ${PORT}`);
});

bot.launch(() => {
  console.log("✅ Telegram bot started");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
