# Subzon Telegram Mini App

Telegram-бот и Mini App для заданий на подписки. Интерфейс оставлен в темном стиле с желтыми акцентами.

## Стек

- Node.js
- Express
- Telegraf
- Telegram Mini App
- SubGram API
- PostgreSQL через `DATABASE_URL`

## Запуск

```bash
npm install
npm start
```

## Переменные окружения

Смотри `.env.example`. Для Render обязательно укажи:

```env
BOT_TOKEN=...
WEBAPP_URL=https://your-render-url.onrender.com
SUBGRAM_API_KEY=...
SUBGRAM_MAX_SPONSORS=10
SUBGRAM_REWARD=0.25
DATABASE_URL=...
DATABASE_SSL=true
```

## Проверка

```text
/health
```

Должно вернуть `subgram: true`, а при подключенной базе еще и `database: true`.
