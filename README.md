# E-Commerce Order Status Bot

A Telegram bot for Shopify stores. Buyers **track their shipments**, get **push messages when the parcel moves**, and **start returns** themselves: they pick items, give a reason and send photos, and the return is auto-approved when it's within policy. No support agent is needed. The store's team approves the exceptions and answers handoffs from one Telegram group.

**Stack:** Node.js 20+, Telegram Bot API, Shopify Admin REST API (plain fetch, no SDKs), Express. Free-text messages are understood by Gemini through a multi-model fallback chain (Gemini → Groq → NVIDIA → OpenRouter → Ollama), with keyword rules and FAQ matching when every model is down.

```
Buyer (Telegram) ──► verify: order number + email or phone   (5 tries, then 30-min lock)
                 ──► 📦 order card: every shipment, carrier link, ETA, delay warning, unshipped items
                 ──► 🔔 notify me ◄── Shopify fulfillment webhooks / polling
                 ──► ↩️ return: items (qty) → reason → photo → note → confirm
                        policy in code: window, damaged window, final sale, already returned, approval limit
                        → approved (label / portal / address / RMA number) or pending staff review
                        → Shopify order tagged + note, staff group alert with photos, JSON webhook
                 ──► free text / FAQ (AI, grounded in the store profile) ──► 🙋 human handoff (staff group relay)
```

## Try it now (no accounts)

```bash
npm install
node bin/order-bot.js --no-ai demo     # scripted walkthrough of every feature
node bin/order-bot.js chat             # talk to the bot in your terminal (sample Shopify orders)
npm test                               # 39 tests, no network
```

In `chat`, type a number to press a button, `/photo` to send a photo, `staff: /pending` or `staff-reply: <text>` to act as the team, `scan 1001 delivered` to simulate a carrier scan, and `quit` to exit. Sample logins: `#1001` emma.wilson@example.com · `#1002` liam.chen@example.com · `#1003` +34 600 555 103 · `#1006` james.taylor@example.com · `#1008` lucas.dubois@example.com.

## Go live

1. **Telegram:** talk to @BotFather, send `/newbot`, and put the token in `TELEGRAM_BOT_TOKEN`. Create a team group, add the bot, send `/whoami` in it, and put that id in `STAFF_CHAT_ID`. In @BotFather → Bot Settings → Group Privacy, turn privacy **off** so the bot sees staff replies.
2. **Shopify:** go to Settings → Apps and sales channels → Develop apps → Create app. Admin API scopes: `read_orders`, `write_orders`. Install it and put the token (`shpat_...`) in `SHOPIFY_ACCESS_TOKEN` and the store handle in `SHOPIFY_SHOP`. Orders older than 60 days also need the `read_all_orders` scope (request it in the Partner dashboard).
3. Copy `examples/business.json`, fill in the store's details, policies and FAQs, then set `BUSINESS_FILE`.
4. Run `node bin/order-bot.js doctor`, then `node bin/order-bot.js start` (long polling, no public URL needed).

**Webhook mode** (servers, instant delivery updates):

```bash
PUBLIC_URL=https://bot.example.com TELEGRAM_WEBHOOK_SECRET=... SHOPIFY_WEBHOOK_SECRET=<app API secret>
node bin/order-bot.js serve               # Express on PORT
node bin/order-bot.js set-webhook         # Telegram -> /telegram/webhook
node bin/order-bot.js shopify-webhooks    # fulfillments/create|update, orders/cancelled, refunds/create -> /webhooks/shopify
```

Without Shopify webhooks, set `SHIPMENT_POLL_MINUTES=30` or run `check-shipments` from cron.

## Commands

| CLI | |
|---|---|
| `demo` / `chat` | Local simulation with sample orders |
| `start` | Long polling |
| `serve` | Webhook server: `/telegram/webhook`, `/webhooks/shopify`, `/health`, `/api/returns` |
| `set-webhook [url]` / `delete-webhook` | Telegram webhook |
| `shopify-webhooks` | Register Shopify webhooks |
| `order <number> [--demo] [--json]` | What a buyer would see for an order |
| `check-shipments` | Notify subscribers whose parcel moved |
| `returns [-s pending]`, `approve <id> [note]`, `reject <id> [note]` | Manage returns |
| `stats`, `doctor [--ping]` | Usage totals; config, Shopify, Telegram and AI model check |

**Buyer commands:** `/start`, `/track [number] [email]`, `/return [number] [email]`, `/orders`, `/returns`, `/human`, `/stop`, `/cancel`, `/help`. Deep links such as `https://t.me/<bot>?start=track_1001` or `?start=return_1001` can go in shipping emails or on the order status page.

**Staff group:** use the ✅ Approve / ❌ Reject buttons on return alerts, or `/approve R1006-AB12 [note]`, `/reject R1006-AB12 reason`, `/pending`. Reply to a customer message to answer that customer; `/close <chat id>` ends the chat.

**HTTP API** (`x-api-key: API_KEY`): `GET /api/returns?status=pending`, `POST /api/returns/:id/approve|reject {note}`, `POST /api/check-shipments`.

## Rules (in code, not left to the AI)

- **Privacy:** nothing about an order is shown until the buyer proves it's theirs, with the email or the last 6+ digits of the phone on the order. Failed attempts lock the chat (`VERIFY_MAX_ATTEMPTS`, `VERIFY_LOCK_MINUTES`). Every button checks that the order was verified in that chat.
- **Returns** (`business.json` → `returns`):
  - **Normal window:** `window_days` counted from the delivery scan.
  - **Damaged or wrong items:** a longer `damaged_window_days`.
  - **Final sale:** gift cards, `non_returnable_keywords`, `non_returnable_sku_prefixes`, `non_returnable_order_tags` and personalised items can be returned only if damaged or wrong.
  - **No double returns:** refunded quantities and quantities in open requests can't be returned again.
  - **Approval:** auto-approved under `auto_approve_max_value` unless damaged or wrong (staff checks the photos).
  - **Re-check:** everything is checked again at submit.
- **Shopify write-back:** tags `return-requested` + `return-approved|pending|rejected` (merged with existing tags) and a note line on the order. If that fails, the return is still saved and marked `shopifySynced: false`.
- **AI** only routes free text and answers general questions from the store profile. Its answers may contain only links from the profile, and an order number it "sees" must actually be in the message.
- **Delivery updates** are sent only when a shipment really changes. Subscriptions end at delivery or cancellation. Buyers who block the bot are unsubscribed.

## Project layout

```
bin/order-bot.js          CLI (incl. chat + demo simulators)
src/bot.js                conversation engine: verification, tracking, returns, staff actions, handoff
src/shopify/              REST client (retries, tag merge, webhook HMAC), order mapper, in-memory mock
src/telegram/             Bot API client (429 retry), mock
src/policy.js             ETA / delay, tracking links, return eligibility, approval, instructions
src/nlu.js                rules + AI routing and FAQ answers
src/messages.js           all buyer-facing text (rebrand / translate here)
src/tracker.js            delivery notifications
src/server.js             Express webhooks + API;  src/store.js JSON state;  src/ai/ fallback router
examples/                 store profile + 10 sample orders in Shopify's REST format
```

## Docker

```bash
docker build -t order-bot .
docker run -d -p 3000:3000 --env-file .env -v order-bot-data:/data order-bot
```

## License

MIT
