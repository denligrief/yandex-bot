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

const SUBGRAM_API_KEY = process.env.SUBGRAM_API_KEY;
const SUBGRAM_API_BASE = process.env.SUBGRAM_API_BASE || "https://api.subgram.org";
const SUBGRAM_ACTION = process.env.SUBGRAM_ACTION || "task";
const SUBGRAM_MAX_SPONSORS = Number(process.env.SUBGRAM_MAX_SPONSORS || 5);
const SUBGRAM_REWARD = Number(process.env.SUBGRAM_REWARD || 0.25);

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

function toTelegramId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function buildSubgramUserPayload(source) {
  const userId = toTelegramId(source.user_id);
  const chatId = toTelegramId(source.chat_id) || userId;

  if (!userId || !chatId) {
    return null;
  }

  return {
    user_id: userId,
    chat_id: chatId,
    first_name: source.first_name || undefined,
    username: source.username || undefined,
    language_code: source.language_code || "ru",
    is_premium: source.is_premium === "true" || source.is_premium === true,
    action: SUBGRAM_ACTION,
    max_sponsors: SUBGRAM_MAX_SPONSORS,
    get_links: 1
  };
}

async function requestSubgram(endpoint, payload) {
  if (!SUBGRAM_API_KEY) {
    return {
      status: "error",
      code: "missing_key",
      message: "SUBGRAM_API_KEY не указан в .env"
    };
  }

  const response = await fetch(`${SUBGRAM_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Auth: SUBGRAM_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      status: "error",
      code: response.status,
      message: data.message || "SubGram API вернул ошибку",
      raw: data
    };
  }

  return data;
}

function getSponsorsFromResponse(data) {
  return data?.additional?.sponsors
    || data?.result?.sponsors
    || data?.response?.sponsors
    || data?.sponsors
    || [];
}

function normalizeSponsorTask(sponsor, index) {
  const link = sponsor.link || sponsor.url;
  const id = String(sponsor.ads_id || sponsor.resource_id || link || `subgram_${index}`);
  const title = sponsor.button_text || sponsor.title || "Подпишись на канал партнёра";
  const status = sponsor.status || "unsubscribed";

  return {
    id,
    title,
    reward: SUBGRAM_REWARD,
    type: sponsor.type || "subscribe",
    url: link,
    status,
    source: "subgram",
    available: sponsor.available_now !== false && status !== "subscribed"
  };
}

function makeDemoTasks() {
  return [
    {
      id: "demo_1",
      title: "Подпишись на Telegram-канал",
      reward: SUBGRAM_REWARD,
      type: "subscribe",
      url: "https://t.me/telegram",
      status: "available",
      source: "demo",
      available: true
    },
    {
      id: "demo_2",
      title: "Вступи в канал партнёра",
      reward: SUBGRAM_REWARD,
      type: "subscribe",
      url: "https://t.me/durov",
      status: "available",
      source: "demo",
      available: true
    }
  ];
}

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
  res.json({ ok: true, subgram: Boolean(SUBGRAM_API_KEY) });
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
  const payload = buildSubgramUserPayload(req.query);

  if (!payload) {
    return res.status(400).json({ error: "valid user_id required" });
  }

  if (!SUBGRAM_API_KEY) {
    return res.json({
      source: "demo",
      warning: "SUBGRAM_API_KEY не указан в .env",
      tasks: makeDemoTasks()
    });
  }

  try {
    const data = await requestSubgram("/get-sponsors", payload);

    if (data.status === "error") {
      return res.status(data.code === 401 ? 401 : 502).json({
        error: data.message || "SubGram API error",
        tasks: []
      });
    }

    const tasks = getSponsorsFromResponse(data)
      .map(normalizeSponsorTask)
      .filter((task) => task.url && task.available);

    res.json({
      source: "subgram",
      status: data.status,
      message: data.message,
      tasks
    });
  } catch (error) {
    res.status(502).json({
      error: "Не удалось получить задания SubGram",
      details: error.message,
      tasks: []
    });
  }
});

app.post("/api/check-task", async (req, res) => {
  const { user_id, chat_id, task_url } = req.body;
  const userId = toTelegramId(user_id);

  if (!userId || !task_url) {
    return res.status(400).json({ error: "valid user_id and task_url required" });
  }

  if (!SUBGRAM_API_KEY) {
    return res.json({
      ok: true,
      message: "Демо-проверка выполнена. Для реальной проверки укажи SUBGRAM_API_KEY.",
      reward: SUBGRAM_REWARD
    });
  }

  try {
    const data = await requestSubgram("/get-user-subscriptions", {
      user_id: userId,
      chat_id: toTelegramId(chat_id) || userId,
      links: [task_url]
    });

    if (data.status === "error") {
      if (Number(data.code) === 404) {
        return res.json({
          ok: false,
          status: "unsubscribed",
          message: "Подписка пока не найдена",
          reward: 0
        });
      }

      return res.status(data.code === 401 ? 401 : 502).json({
        ok: false,
        message: data.message || "SubGram API error"
      });
    }

    const subscriptions = data.result || data.response || data.subscriptions || data.data || [];
    const checks = Array.isArray(subscriptions) ? subscriptions : [subscriptions];
    const match = checks.find((item) => item?.link === task_url) || checks[0] || data;
    const status = match.status || data.status;
    const subscribed = status === "subscribed" || status === "notgetted";

    res.json({
      ok: subscribed,
      status,
      message: subscribed ? "Подписка подтверждена" : "Подписка пока не найдена",
      reward: subscribed ? SUBGRAM_REWARD : 0
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      message: "Не удалось проверить подписку SubGram",
      details: error.message
    });
  }
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
