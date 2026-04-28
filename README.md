# Telegram bot + Mini App в стиле Яндекса

Стек:
- Node.js
- Express
- Telegraf
- Telegram Mini App
- дизайн в стиле Яндекс: чёрный/тёмный фон, жёлтые акценты, карточки, кнопки

## 1. Установка

```bash
npm install
```

## 2. Настрой `.env`

Скопируй файл:

```bash
cp .env.example .env
```

Заполни:

```env
BOT_TOKEN=токен_бота_из_BotFather
WEBAPP_URL=https://твой-домен.ru
SUBGRAM_API_KEY=новый_api_ключ
PORT=3000
```

Важно: API-ключ Subgram держи только на сервере. Старый ключ лучше перевыпусти.

## 3. Запуск

```bash
npm start
```

## 4. В BotFather

`/mybots` → твой бот → Bot Settings → Menu Button → Configure menu button  
URL: `https://твой-домен.ru`

## 5. Что уже готово

- `/start` в боте
- кнопка «💸 Заработать»
- Mini App с дизайном
- главная, задания, баланс, рефералка
- backend endpoint `/api/tasks`
- место для подключения Subgram API

Файл, где подключать Subgram:
`server.js`, функция `/api/tasks`.
