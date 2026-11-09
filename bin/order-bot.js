#!/usr/bin/env node
import readline from 'node:readline';
import { Command } from 'commander';
import { loadDotenv, problems } from '../src/config.js';
import { createApp, createServer, startPolling } from '../src/index.js';
import { createMockTelegram } from '../src/telegram/mock.js';
import { createSimulator, renderCall, htmlToTerminal } from '../src/simulator.js';
import { mapOrder } from '../src/shopify/map.js';
import { WEBHOOK_TOPICS } from '../src/shopify/client.js';
import { orderCard } from '../src/messages.js';
import { BOT_COMMANDS } from '../src/bot.js';
import { createLogger } from '../src/logger.js';

loadDotenv();

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const col = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const c = { green: col(32), red: col(31), yellow: col(33), gray: col(90), cyan: col(36), bold: col(1), magenta: col(35) };

const program = new Command();
program
  .name('order-bot')
  .description('E-Commerce Order Status Bot: Telegram + Shopify. Buyers track shipments and start returns without an agent.')
  .version('1.0.0')
  .option('--no-ai', 'keyword rules + FAQ matching only (no LLM calls)')
  .option('--simulate-outage <providers>', 'pretend these AI providers are down, e.g. "gemini"')
  .option('-v, --verbose', 'debug logging');

function build(cmd, extra = {}) {
  const o = cmd.optsWithGlobals();
  const logger = createLogger(o.verbose ? 'debug' : extra.quiet ? 'error' : process.env.LOG_LEVEL || 'info');
  delete extra.quiet;
  return { o, app: createApp({ noAi: o.ai === false, simulate: o.simulateOutage ? String(o.simulateOutage).split(',') : [], logger, ...extra }) };
}

function need(app, what) {
  const missing = problems(app.config).filter((p) => what.some((w) => p.includes(w)));
  if (!missing.length) return;
  console.error(c.red('Not configured:'));
  for (const p of missing) console.error(`  - ${p}`);
  console.error('Copy .env.example to .env and fill it in, or try `order-bot demo` / `order-bot chat` (no accounts needed).');
  process.exit(2);
}

program
  .command('start')
  .description('run the bot with long polling (no public URL needed)')
  .action(async (_x, cmd) => {
    const { app } = build(cmd);
    need(app, ['TELEGRAM', 'SHOPIFY']);
    await startPolling(app);
  });

program
  .command('serve')
  .description('webhook mode: POST /telegram/webhook, POST /webhooks/shopify, GET /health, /api/returns')
  .option('-p, --port <port>', 'port', (v) => Number(v))
  .action(async (_x, cmd) => {
    const { o, app } = build(cmd);
    need(app, ['TELEGRAM', 'SHOPIFY']);
    const port = o.port || app.config.server.port;
    createServer(app).listen(port, () => console.log(`order-bot listening on :${port}. Run \`order-bot set-webhook\` once (PUBLIC_URL=${app.config.server.publicUrl || 'not set'}).`));
    if (app.config.notify.pollMinutes > 0) setInterval(() => app.tracker.checkAll().catch((e) => app.logger.warn(e.message)), app.config.notify.pollMinutes * 60_000);
  });

program
  .command('set-webhook')
  .description('point Telegram at PUBLIC_URL/telegram/webhook (needs TELEGRAM_WEBHOOK_SECRET)')
  .argument('[url]', 'public base URL (default PUBLIC_URL)')
  .action(async (url, _x, cmd) => {
    const { app } = build(cmd);
    need(app, ['TELEGRAM']);
    const base = (url || app.config.server.publicUrl).replace(/\/$/, '');
    if (!base || !app.config.telegram.webhookSecret) {
      console.error('Set PUBLIC_URL (https://...) and TELEGRAM_WEBHOOK_SECRET first.');
      process.exit(2);
    }
    await app.tg.call('setWebhook', { url: `${base}/telegram/webhook`, secret_token: app.config.telegram.webhookSecret, allowed_updates: ['message', 'callback_query'] });
    await app.tg.call('setMyCommands', { commands: BOT_COMMANDS });
    console.log(c.green(`Telegram webhook set to ${base}/telegram/webhook`));
  });

program
  .command('delete-webhook')
  .description('remove the Telegram webhook (needed before `start` polling)')
  .action(async (_x, cmd) => {
    const { app } = build(cmd);
    need(app, ['TELEGRAM']);
    await app.tg.call('deleteWebhook', {});
    console.log(c.green('Webhook removed.'));
  });

program
  .command('shopify-webhooks')
  .description(`register Shopify webhooks (${WEBHOOK_TOPICS.join(', ')}) to PUBLIC_URL/webhooks/shopify`)
  .action(async (_x, cmd) => {
    const { app } = build(cmd);
    need(app, ['SHOPIFY']);
    const address = `${app.config.server.publicUrl}/webhooks/shopify`;
    if (!app.config.server.publicUrl) {
      console.error('Set PUBLIC_URL first.');
      process.exit(2);
    }
    const existing = await app.shopify.listWebhooks();
    for (const topic of WEBHOOK_TOPICS) {
      if (existing.some((w) => w.topic === topic && w.address === address)) console.log(`${c.gray('=')} ${topic}`);
      else console.log(`${c.green('+')} ${topic} -> ${(await app.shopify.createWebhook(topic, address)).address}`);
    }
    console.log(c.gray('Webhooks created through the API are signed with the app\'s API secret key: put it in SHOPIFY_WEBHOOK_SECRET.'));
  });

program
  .command('order')
  .description('look up one Shopify order and print what the buyer would see')
  .argument('<number>', 'order number, e.g. 1001')
  .option('--demo', 'use the sample orders')
  .option('--json', 'print the mapped order as JSON')
  .action(async (number, _x, cmd) => {
    const { o, app } = build(cmd, { demo: Boolean(cmd.opts().demo), quiet: true });
    if (!o.demo) need(app, ['SHOPIFY']);
    const order = mapOrder(await app.shopify.findOrderByNumber(number));
    if (!order) return console.error(c.red(`Order #${number} not found`)), process.exit(1);
    console.log(o.json ? JSON.stringify(order, null, 2) : htmlToTerminal(orderCard(order, app.profile)));
  });

program
  .command('check-shipments')
  .description('check subscribed orders now and message buyers whose parcel moved (cron alternative to webhooks)')
  .action(async (_x, cmd) => {
    const { app } = build(cmd);
    need(app, ['TELEGRAM', 'SHOPIFY']);
    const r = await app.tracker.checkAll();
    console.log(r.length ? r.map((x) => `#${x.number}: ${x.error ? c.red(x.error) : x.changed ? c.green(`${x.status}, ${x.notified} notified`) : 'no change'}`).join('\n') : 'No subscriptions.');
    app.store.flush();
  });

program
  .command('returns')
  .description('list return requests')
  .option('-s, --status <status>', 'pending | approved | rejected')
  .option('--json', 'JSON output')
  .action(async (_x, cmd) => {
    const { o, app } = build(cmd, { quiet: true });
    const list = app.store.returns({ status: o.status, limit: 100 });
    if (o.json) return console.log(JSON.stringify(list, null, 2));
    if (!list.length) return console.log('No returns.');
    for (const r of list) console.log(`${r.status === 'pending' ? c.yellow('pending ') : r.status === 'approved' ? c.green('approved') : c.red(r.status.padEnd(8))} ${r.id.padEnd(14)} #${r.orderNumber}  ${r.items.map((i) => `${i.quantity}x ${i.title}`).join(', ')}  ${c.gray(`${r.reason}, ${r.createdAt.slice(0, 16)}`)}`);
  });

for (const [name, status] of [
  ['approve', 'approved'],
  ['reject', 'rejected'],
]) {
  program
    .command(name)
    .description(`${name} a pending return and message the buyer`)
    .argument('<id>', 'return id, e.g. R1006-AB12')
    .argument('[note...]', 'note for the buyer')
    .action(async (id, note, _x, cmd) => {
      const { app } = build(cmd);
      need(app, ['TELEGRAM', 'SHOPIFY']);
      const r = await app.bot.decideReturn(id, status, { note: note.join(' '), by: 'cli' });
      console.log(r.error ? c.red(r.error) : c.green(`Return ${r.ret.id} ${r.ret.status}; buyer notified.`));
      app.store.flush();
    });
}

program
  .command('stats')
  .description('usage totals')
  .action(async (_x, cmd) => {
    const { app } = build(cmd, { quiet: true });
    const s = app.store.stats();
    console.log(`${c.bold('Since')} ${s.since.slice(0, 10)}   users ${s.users}   delivery subscriptions ${s.subscriptions}`);
    console.log(`${c.bold('Returns')} ${s.returns.total} (pending ${s.returns.pending}, approved ${s.returns.approved}, rejected ${s.returns.rejected})`);
    console.log(`${c.bold('Events')} ${Object.entries(s.events).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
    const solved = (s.events.track || 0) + (s.events.return_started || 0) + (s.events.faq_answered || 0);
    console.log(c.green(`~${solved} conversations handled without an agent (${s.events.handoff || 0} handed to a person)`));
  });

program
  .command('doctor')
  .description('check Telegram, Shopify, staff chat, store profile and AI models')
  .option('--ping', 'send a tiny prompt to every AI model')
  .action(async (_x, cmd) => {
    const { o, app } = build(cmd, { quiet: true });
    const ok = (b, label, detail = '') => console.log(`${b === true ? c.green('✓') : b === false ? c.red('✗') : c.yellow('!')} ${label}${detail ? c.gray(`  ${detail}`) : ''}`);
    ok(true, 'Store profile', `${app.profile.store_name}, ${app.profile.faqs?.length || 0} FAQs, ${app.profile.returns?.window_days}-day returns`);
    if (app.tg) {
      try {
        const me = await app.tg.call('getMe');
        const wh = await app.tg.call('getWebhookInfo');
        ok(true, 'Telegram', `@${me.username}, ${wh.url ? `webhook ${wh.url}${wh.last_error_message ? ` (last error: ${wh.last_error_message})` : ''}` : 'polling mode'}`);
      } catch (err) {
        ok(false, 'Telegram', err.message);
      }
    } else ok(false, 'Telegram', 'TELEGRAM_BOT_TOKEN missing');
    ok(app.config.telegram.staffChatId ? true : null, 'Staff chat', app.config.telegram.staffChatId || 'not set: handoffs show the support email; add the bot to a group, send /whoami, put the id in STAFF_CHAT_ID');
    if (app.shopify) {
      try {
        const shop = await app.shopify.getShop();
        ok(true, 'Shopify', `${shop.name} (${shop.domain})`);
      } catch (err) {
        ok(false, 'Shopify', err.message);
      }
    } else ok(false, 'Shopify', 'SHOPIFY_SHOP / SHOPIFY_ACCESS_TOKEN missing');
    ok(app.config.shopify.webhookSecret ? true : null, 'Shopify webhooks', app.config.shopify.webhookSecret ? 'secret set' : `no SHOPIFY_WEBHOOK_SECRET: use SHIPMENT_POLL_MINUTES or check-shipments for delivery updates`);
    if (!app.ai) return ok(null, 'AI', 'disabled: keyword rules + FAQ matching');
    for (const t of app.ai.status()) {
      if (!t.enabled) {
        console.log(`${c.gray('-')} ${t.id.padEnd(48)} ${c.gray(t.disabledReason || 'disabled')}`);
        continue;
      }
      if (!o.ping) {
        console.log(`${c.green('•')} ${t.id.padEnd(48)} ${c.gray('configured')}`);
        continue;
      }
      const t0 = Date.now();
      try {
        await app.ai.generate({ only: t.id, messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 1024, timeoutMs: 20_000 });
        console.log(`${c.green('✓')} ${t.id.padEnd(48)} ${Date.now() - t0} ms`);
      } catch (err) {
        console.log(`${c.red('✗')} ${t.id.padEnd(48)} ${c.gray(String(err.message).slice(0, 90))}`);
      }
    }
  });

// ---------- local simulation (no accounts)

function simApp(cmd, { print = true } = {}) {
  const staffChatId = process.env.STAFF_CHAT_ID || '-100777';
  const tg = createMockTelegram({
    onSend: print
      ? (call) => {
          const staff = String(call.params.chat_id) === staffChatId;
          const who = staff ? c.magenta('STAFF GROUP ◂ bot') : c.cyan(`bot ▸ ${call.params.chat_id}`);
          console.log(`\n${who}\n${renderCall(call).replace(/^/gm, '  ')}`);
        }
      : undefined,
  });
  const { o, app } = build(cmd, { demo: true, tg, env: { ...process.env, STAFF_CHAT_ID: staffChatId }, quiet: true });
  return { o, app, sim: createSimulator(app, { staffChatId }) };
}

program
  .command('chat')
  .description('talk to the bot in this terminal (sample Shopify orders, no accounts). Type a number to press a button.')
  .option('--chat-id <id>', 'your simulated chat id', '111')
  .action(async (_x, cmd) => {
    const { o, app, sim } = simApp(cmd);
    const me = o.chatId;
    console.log(c.bold(`\nSimulated Telegram chat with the ${app.profile.store_name} bot (AI: ${app.ai ? `${app.ai.enabledCount} model(s) with keys` : 'off'}).`));
    console.log(c.gray('Try: /start, "where is order 1001", email emma.wilson@example.com, /return 1002 (liam.chen@example.com)'));
    console.log(c.gray('Press a button: type its number. Other: /photo  ·  staff: <text>  ·  staff-reply: <text>  ·  scan <order> <status>  ·  quit\n'));
    await sim.say(me, '/start', 'You');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.gray('you> ') });
    const showButtons = () => {
      const b = sim.buttons(me).filter((x) => x.data);
      if (b.length) console.log(c.gray(b.map((x, i) => `  ${i + 1}) ${x.text}`).join('\n')));
    };
    showButtons();
    rl.prompt();
    for await (const line of rl) {
      const t = line.trim();
      try {
        if (t === 'quit' || t === 'exit') break;
        const btns = sim.buttons(me).filter((x) => x.data);
        if (/^\d+$/.test(t) && btns[Number(t) - 1] && t.length < 3) await sim.press(me, btns[Number(t) - 1].text);
        else if (t === '/photo') await sim.photo(me, 'damage');
        else if (t.startsWith('staff-reply:')) await sim.staffSay(t.slice(12).trim(), { reply: true });
        else if (t.startsWith('staff:')) await sim.staffSay(t.slice(6).trim());
        else if (t.startsWith('scan ')) {
          const [, num, status] = t.split(/\s+/);
          app.shopify.setShipmentStatus(num, status || 'delivered');
          console.log(c.gray(`(carrier scan: #${num} -> ${status || 'delivered'})`), (await app.tracker.checkAll()).map((r) => `#${r.number} ${r.changed ? 'changed' : 'no change'}`).join(', ') || 'no subscriptions');
        } else if (t) await sim.say(me, t);
      } catch (err) {
        console.log(c.red(err.message));
      }
      showButtons();
      rl.prompt();
    }
    rl.close();
  });

program
  .command('demo')
  .description('scripted walkthrough: tracking, verification, delivery update, returns, staff approval, FAQ and handoff')
  .action(async (_x, cmd) => {
    const { app, sim } = simApp(cmd);
    const step = async (title, fn) => {
      console.log(`\n${c.bold(c.yellow(`━━ ${title} ━━`))}`);
      await fn();
    };
    const NAMES = { 111: 'Emma', 222: 'Liam', 333: 'Stranger', 444: 'Sofía', 555: 'James', 666: 'Lucas', 777: 'Kai', 888: 'Nora' };
    for (const [id, n] of Object.entries(NAMES)) sim.user(id, n);
    const you = (chat, text) => {
      console.log(`\n${c.green(`${NAMES[chat]} (${chat}) ▸ bot`)}\n  ${text}`);
      return sim.say(chat, text);
    };
    const tap = (chat, label) => {
      console.log(`\n${c.green(`${chat} taps`)} [${label}]`);
      return sim.press(chat, label);
    };

    await step('1. Emma tracks her order (buttons + verification)', async () => {
      await you(111, '/start');
      await tap(111, 'Track my order');
      await you(111, '1001');
      await you(111, 'emma.wilson@example.com');
      await tap(111, 'Notify me');
    });
    await step('2. The carrier scans the parcel: Emma gets a push message', async () => {
      app.shopify.setShipmentStatus('1001', 'out_for_delivery');
      console.log(c.gray('  (Shopify fulfillment update: out_for_delivery)'));
      await app.tracker.checkAll();
    });
    await step('3. A stranger guesses an order number: no details leak', async () => {
      await you(333, 'where is order 1001? my email is someone@else.example');
    });
    await step('4. Sofía writes in Spanish, verifies by phone: split shipment, one late', async () => {
      await you(444, '¿Dónde está mi pedido 1003?');
      await you(444, '+34 600 555 103');
    });
    await step('5. Liam returns his jacket in free text: auto-approved, Shopify order tagged', async () => {
      await you(222, 'I want to return the jacket from order #1002, email liam.chen@example.com');
      await tap(222, 'Alpine Fleece Jacket');
      await tap(222, 'Continue');
      await tap(222, "Doesn't fit");
      await tap(222, 'Skip');
      await tap(222, 'Submit return');
      console.log(c.gray(`  (Shopify order #1002 tags now: "${app.shopify.orders.find((x) => x.name === '#1002').tags}")`));
    });
    await step('6. James: damaged $420 tent with photo -> staff approves in the team group', async () => {
      await you(555, '/return 1006');
      await you(555, 'james.taylor@example.com');
      await tap(555, 'Continue');
      await tap(555, 'damaged');
      console.log(`\n${c.green('James (555) ▸ bot')}\n  [photo of the broken pole]`);
      await sim.photo(555, 'broken pole');
      await tap(555, 'Done');
      await tap(555, 'Skip');
      await tap(555, 'Submit return');
      console.log(`\n${c.magenta('staff taps')} [✅ Approve]`);
      await sim.staffPress('Approve');
    });
    await step('7. Lucas: clearance item is final sale (only if damaged)', async () => {
      await you(666, '/return 1008 lucas.dubois@example.com');
    });
    await step('8. FAQ answered without an agent', async () => {
      await you(777, 'Do you ship internationally?');
    });
    await step('9. Handoff to a person, staff replies from the group', async () => {
      await you(888, 'I need to talk to a real person about a gift order');
      await you(888, 'Can you add a gift note to order 1005?');
      console.log(`\n${c.magenta('staff replies')} (to the ticket)`);
      await sim.staffSay("Hi! Sure, we've added the gift note. Anything else?", { reply: true });
    });
    const s = app.store.stats();
    console.log(`\n${c.bold('Summary')}: ${s.returns.total} returns (${s.returns.approved} approved), ${s.subscriptions} delivery subscription(s), events: ${Object.entries(s.events).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(c.gray('Try it yourself: order-bot chat'));
  });

program.parseAsync().catch((err) => {
  console.error(c.red(err.message));
  process.exit(1);
});
