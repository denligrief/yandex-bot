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
const BOT_POLLING = process.env.BOT_POLLING !== "false";

if (BOT_POLLING && !BOT_TOKEN) {
  console.error("BOT_TOKEN не указан в .env");
  process.exit(1);
}

if (BOT_POLLING && !WEBAPP_URL) {
  console.error("WEBAPP_URL не указан в .env");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const bot = BOT_POLLING ? new Telegraf(BOT_TOKEN) : null;

bot?.start(async (ctx) => {
  const name = ctx.from?.first_name || "друг";

  await ctx.reply(
`Привет, ${name}!

Здесь можно зарабатывать на простых заданиях:
- подписки на Telegram-каналы
- быстрые проверки
- бонусы за друзей

Нажми кнопку ниже, чтобы открыть приложение.`,
    Markup.inlineKeyboard([
      Markup.button.webApp("Заработать", WEBAPP_URL)
    ])
  );
});

bot?.command("app", async (ctx) => {
  await ctx.reply(
    "Открыть приложение",
    Markup.inlineKeyboard([
      Markup.button.webApp("Открыть Mini App", WEBAPP_URL)
    ])
  );
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/profile", async (req, res) => {
  const userId = req.query.user_id || "unknown";

  res.json({
    user_id: userId,
    balance: 0,
    completed: 0,
    referral_earned: 0
  });
});

app.get("/api/tasks", async (req, res) => {
  const userId = req.query.user_id;

  if (!userId) {
    return res.status(400).json({ error: "user_id required" });
  }

  // Здесь можно подключить Subgram API, когда будут точные URL и формат ответа.
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
      },
      {
        id: "demo_3",
        title: "Проверь новое задание дня",
        reward: 1.25,
        type: "action",
        url: "https://t.me/telegram",
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

  res.json({
    ok: true,
    message: "Задание отправлено на проверку",
    reward: 0.5
  });
});

app.listen(PORT, () => {
  console.log(`Web server started on port ${PORT}`);
});

if (bot) {
  bot.launch(() => {
    console.log("Telegram bot started");
  });
} else {
  console.log("Telegram bot polling disabled");
}

process.once("SIGINT", () => bot?.stop("SIGINT"));
process.once("SIGTERM", () => bot?.stop("SIGTERM"));
