import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBot, verify, fakeProvider, STAFF } from './helpers.js';

test('track via buttons: number, then email, then order card with tracking link', async () => {
  const { sim } = makeBot();
  await sim.say(1, '/start');
  assert.match(sim.last(1), /order assistant/);
  await sim.press(1, 'Track my order');
  await sim.say(1, '#1001');
  assert.match(sim.last(1), /email address/);
  await sim.say(1, 'emma.wilson@example.com');
  assert.match(sim.last(1), /Order #1001.*On its way/);
  assert.match(sim.last(1), /1Z999AA10123456784/);
  assert.ok(sim.buttons(1).some((b) => b.url === 'https://www.ups.com/track?tracknum=1Z999AA10123456784'));
});

test('one message with order number + email goes straight to the order', async () => {
  const { sim } = makeBot();
  await sim.say(2, 'where is order 1007? emma? no: amira.haddad@example.com');
  assert.match(sim.last(2), /Out for delivery today/);
});

test('wrong contact never reveals the order, and locks after 5 failures', async () => {
  const { sim } = makeBot();
  await sim.say(3, 'where is order 1001? my email is attacker@evil.example');
  assert.match(sim.last(3), /doesn't match/);
  assert.ok(!sim.texts(3).join().includes('1Z999'));
  for (let i = 0; i < 4; i++) await sim.say(3, 'attacker@evil.example');
  assert.match(sim.last(3), /Too many attempts/);
  await sim.say(3, '/track 1001 emma.wilson@example.com'); // even the right email is refused while locked
  assert.match(sim.last(3), /Too many attempts/);
});

test('unknown order number is reported', async () => {
  const { sim } = makeBot();
  await sim.say(4, '/track 4242 x@y.com');
  assert.match(sim.last(4), /couldn't find order <b>#4242/);
});

test('buttons for an order this chat did not verify ask for verification', async () => {
  const { app, sim } = makeBot();
  await app.bot.enqueue({ update_id: 1, callback_query: { id: 'c', from: { id: 5 }, data: 'ref:1001', message: { message_id: 1, chat: { id: 5, type: 'private' } } } });
  await app.bot.idle();
  assert.match(sim.last(5), /email address/);
});

test('deep link /start track_1001 and phone verification', async () => {
  const { sim } = makeBot();
  await sim.say(6, '/start track_1003');
  await sim.say(6, '+34 600 555 103');
  assert.match(sim.last(6), /Partly delivered/);
  assert.match(sim.last(6), /taking longer than expected/);
});

test('return: choose item, reason, auto-approved, Shopify tagged, staff informed', async () => {
  const { sim, shopify, app } = makeBot();
  await sim.say(7, 'I want to return my jacket, order #1002 liam.chen@example.com');
  assert.match(sim.last(7), /Return from order #1002/);
  await sim.press(7, 'Merino Beanie');
  await sim.press(7, 'Merino Beanie'); // second tap = 2 units
  assert.match(sim.last(7), /Merino Beanie.*×2/);
  await sim.press(7, 'Continue');
  await sim.press(7, 'Changed my mind');
  await sim.say(7, 'Wrong colour for me');
  assert.match(sim.last(7), /Note: Wrong colour for me/);
  await sim.press(7, 'Submit return');
  assert.match(sim.last(7), /approved/);
  assert.match(sim.last(7), /returns portal|portal/i);
  const ret = app.store.returns()[0];
  assert.equal(ret.status, 'approved');
  assert.equal(ret.items[0].quantity, 2);
  assert.equal(ret.shopifySynced, true);
  assert.match(shopify.orders.find((o) => o.name === '#1002').tags, /return-requested, return-approved/);
  assert.match(shopify.orders.find((o) => o.name === '#1002').note, /Return R1002-/);
  assert.match(sim.last(STAFF), /auto-approved/);
  // The same units can't be returned twice.
  await sim.say(7, '/return 1002');
  assert.match(sim.last(7), /Merino Beanie.*return already requested/);
});

test('damaged item: photo, pending, staff approves with the button', async () => {
  const { sim, app } = makeBot();
  await sim.say(8, '/return 1006 james.taylor@example.com');
  await sim.press(8, 'Continue'); // only item pre-selected
  await sim.press(8, 'damaged');
  await sim.photo(8);
  await sim.press(8, 'Done');
  await sim.press(8, 'Skip');
  await sim.press(8, 'Submit');
  assert.match(sim.last(8), /received/);
  const ret = app.store.returns()[0];
  assert.equal(ret.status, 'pending');
  assert.equal(ret.photos.length, 1);
  assert.ok(app.tg.calls.some((c) => c.method === 'sendPhoto' && String(c.params.chat_id) === STAFF));
  await sim.staffPress('Approve');
  assert.equal(app.store.findReturn(ret.id).status, 'approved');
  assert.match(sim.last(8), /free prepaid return label/);
  await sim.staffSay(`/approve ${ret.id}`);
  assert.match(sim.last(STAFF), /already approved/);
});

test('staff /reject with a reason; non-admins cannot decide', async () => {
  const { sim, app } = makeBot({ env: { ADMIN_USER_IDS: '42' } });
  await sim.say(9, '/return 1006 james.taylor@example.com');
  await sim.press(9, 'Continue');
  await sim.press(9, 'Wrong item');
  await sim.press(9, 'Skip');
  await sim.press(9, 'Skip');
  await sim.press(9, 'Submit');
  const id = app.store.returns()[0].id;
  await sim.staffSay(`/reject ${id} photos show normal use`); // staff user id 999, not admin
  assert.match(sim.last(STAFF), /Only admins/);
  const r = await app.bot.decideReturn(id, 'rejected', { note: 'photos show normal use' });
  assert.equal(r.ret.status, 'rejected');
  assert.match(sim.last(9), /unable to accept[\s\S]*photos show normal use/);
});

test('final-sale item only allows damaged / wrong reasons', async () => {
  const { sim } = makeBot();
  await sim.say(10, '/return 1008 lucas.dubois@example.com');
  await sim.press(10, 'Clearance Rain Poncho');
  await sim.press(10, 'Continue');
  const reasons = sim.buttons(10).map((b) => b.text);
  assert.deepEqual(reasons.filter((t) => t !== '✖️ Cancel'), ['Arrived damaged / faulty', 'Wrong item sent']);
});

test('nothing returnable: cancelled or not delivered', async () => {
  const { sim } = makeBot();
  await sim.say(11, '/return 1009 mia.johnson@example.com');
  assert.match(sim.last(11), /can be returned right now[\s\S]*cancelled/);
  await sim.say(12, '/return 1001 emma.wilson@example.com');
  assert.match(sim.last(12), /not delivered yet/);
});

test('human handoff: ticket in staff group, relay both ways, /close', async () => {
  const { sim } = makeBot();
  await sim.say(13, 'can I talk to a real person?', 'Nora');
  assert.match(sim.last(STAFF), /Customer wants a person/);
  await sim.say(13, 'Please add a gift note');
  assert.match(sim.last(STAFF), /Nora[\s\S]*gift note/);
  await sim.staffSay('Done, gift note added!', { reply: true });
  assert.match(sim.last(13), /Done, gift note added!/);
  await sim.staffSay('/close 13');
  assert.match(sim.last(13), /closed this chat/);
  await sim.say(13, 'Do you ship internationally?');
  assert.match(sim.last(13), /Canada/); // back to the bot
});

test('without a staff chat, handoff gives the support email', async () => {
  const { sim } = makeBot({ env: { STAFF_CHAT_ID: '' } });
  await sim.say(14, '/human');
  assert.match(sim.last(14), /support@northwind-outfitters.example/);
});

test('Shopify outage: buyer gets a friendly error', async () => {
  const { sim } = makeBot({ shopifyOpts: { failOn: { findOrderByNumber: true } } });
  await sim.say(15, '/track 1001 emma.wilson@example.com');
  assert.match(sim.last(15), /couldn't reach the store system/);
});

test('Shopify write-back failure does not lose the return', async () => {
  const { sim, app } = makeBot({ shopifyOpts: { failOn: { annotateOrder: true } } });
  await sim.say(16, '/return 1002 liam.chen@example.com');
  await sim.press(16, 'Alpine');
  await sim.press(16, 'Continue');
  await sim.press(16, 'fit');
  await sim.press(16, 'Skip');
  await sim.press(16, 'Submit');
  const r = app.store.returns()[0];
  assert.equal(r.status, 'approved');
  assert.equal(r.shopifySynced, false);
});

test('AI: free-text intent and grounded FAQ answer', async () => {
  const provider = fakeProvider((req) => {
    const msg = req.messages[0].content;
    if (/gift wrap/.test(msg)) return { intent: 'faq', order_number: null, email: null, language: 'en', answer: 'Sorry, we do not offer gift wrapping yet.' };
    return { intent: 'track', order_number: '1001', email: 'emma.wilson@example.com', language: 'en', answer: null };
  });
  const { sim } = makeBot({ provider });
  await sim.say(17, 'do you gift wrap?');
  assert.equal(sim.last(17), 'Sorry, we do not offer gift wrapping yet.');
  await sim.say(18, 'yo whats up with 1001, im emma.wilson@example.com');
  assert.match(sim.last(18), /Order #1001/);
});

test('/orders lists verified orders, /returns lists requests, /cancel resets', async () => {
  const { sim } = makeBot();
  await verify(sim, 19, '1001', 'emma.wilson@example.com');
  await sim.say(19, '/orders');
  assert.match(sim.last(19), /Order #1001/);
  await sim.say(19, '/returns');
  assert.match(sim.last(19), /no return requests/);
  await sim.say(19, '/track');
  await sim.say(19, '/cancel');
  assert.match(sim.last(19), /Cancelled/);
});
