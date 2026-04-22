#!/usr/bin/env node

/**
 * get-chat-id.mjs — Resolve the user's Telegram chat_id from the bot's recent updates.
 *
 * Prereq: BOT_TOKEN set in .env, and you have sent at least one message to the bot.
 *
 * Usage:
 *   node get-chat-id.mjs           # prints chat_id, writes it back to .env
 *   node get-chat-id.mjs --print   # only prints, no .env write
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const ENV_PATH = '.env';

function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    console.error('Error: .env not found.');
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function writeChatId(chatId) {
  const text = readFileSync(ENV_PATH, 'utf-8');
  const updated = text.replace(
    /^TELEGRAM_CHAT_ID=.*/m,
    `TELEGRAM_CHAT_ID=${chatId}`
  );
  writeFileSync(ENV_PATH, updated, 'utf-8');
}

async function main() {
  const env = loadEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN is empty in .env');
    process.exit(1);
  }

  const url = `https://api.telegram.org/bot${token}/getUpdates`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Error: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = await res.json();
  if (!json.ok) {
    console.error('Error:', json.description);
    process.exit(1);
  }

  const updates = json.result || [];
  if (updates.length === 0) {
    console.error('No updates yet. Send any message to your bot in Telegram, then re-run this.');
    process.exit(1);
  }

  // Find the most recent chat where the user wrote to the bot
  const chats = new Map();
  for (const u of updates) {
    const msg = u.message || u.edited_message || u.channel_post;
    if (msg?.chat?.id) {
      chats.set(msg.chat.id, {
        id: msg.chat.id,
        title: msg.chat.title || msg.chat.username || msg.chat.first_name || '(unknown)',
      });
    }
  }

  if (chats.size === 0) {
    console.error('No chat found in updates. Send a text message to the bot, then re-run.');
    process.exit(1);
  }

  if (chats.size > 1) {
    console.log('Multiple chats found:');
    for (const c of chats.values()) console.log(`  ${c.id}  ${c.title}`);
    console.log('\nPick one and paste it manually into .env as TELEGRAM_CHAT_ID=<id>.');
    process.exit(0);
  }

  const chat = [...chats.values()][0];
  console.log(`Found chat: ${chat.title} (id=${chat.id})`);

  if (!process.argv.includes('--print')) {
    writeChatId(chat.id);
    console.log('✓ Written to .env');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
