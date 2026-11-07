// Тест управления участниками в боте: /members, /find, блокировка.
// Запуск: node server/test-members.mjs
import assert from "node:assert/strict";
import worker from "./worker.js";

const store = new Map();
const KV = {
  async get(k) { return store.has(k) ? store.get(k) : null; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};
const env = { AVA_KV: KV, BOT_TOKEN: "T", WEBHOOK_SECRET: "sec", ADMIN_CHAT_ID: "111", CHANNEL_ID: "-100", ALLOWED_ORIGIN: "https://vip-club-ava.vercel.app" };
const calls = [];
globalThis.fetch = async (url, init) => {
  const method = url.split("/").pop();
  calls.push({ method, body: JSON.parse(init.body) });
  if (method === "getMe") return Response.json({ ok: true, result: { username: "ava_bot" } });
  if (method === "createChatInviteLink") return Response.json({ ok: true, result: { invite_link: "https://t.me/+X" + calls.length } });
  return Response.json({ ok: true, result: { message_id: 5 } });
};
const ORIGIN = "https://vip-club-ava.vercel.app";
const call = (path, opts = {}) => worker.fetch(new Request("https://srv.dev" + path, opts), env);
const hook = (u) => call("/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "sec" }, body: JSON.stringify(u) });
const admin = (text) => hook({ message: { chat: { id: 111, type: "private" }, from: { id: 111 }, text } });
const press = (data, from = 111) => hook({ callback_query: { id: "q", from: { id: from }, data, message: { chat: { id: 111 }, message_id: 5 } } });
const last = (method, chat) => calls.filter((c) => c.method === method && (chat === undefined || String(c.body.chat_id) === String(chat))).pop();
const auth = (t, path) => call(path, { headers: { Authorization: "Bearer " + t, Origin: ORIGIN } });

let ip = 1;
async function member(pid, tgId, name, username) {
  const r = await call("/api/submit", { method: "POST", headers: { Origin: ORIGIN, "CF-Connecting-IP": "7.7.7." + ip++ }, body: JSON.stringify({ pocketId: pid }) });
  const { token, telegramLink } = await r.json();
  await hook({ message: { chat: { id: tgId, type: "private" }, from: { id: tgId, first_name: name, username }, text: "/start " + telegramLink.split("start=")[1] } });
  await press(last("sendMessage", "111").body.reply_markup.inline_keyboard[0][0].callback_data);
  return token;
}

const tA = await member("30000001", 801, "Анна", "anna_fx");
const tB = await member("30000002", 802, "Борис", "boris");
for (let i = 3; i <= 11; i++) await member("300000" + String(i).padStart(2, "0"), 800 + i, "Игрок" + i);

// 1. /members — список с кнопками и пагинацией
await admin("/members");
let msg = last("sendMessage", "111").body;
assert.ok(msg.text.includes("Всего: 11") && msg.text.includes("заблокировано: 0"));
assert.equal(msg.reply_markup.inline_keyboard.length, 9, "8 участников + строка навигации");
assert.ok(calls.some((c) => c.method === "setMyCommands"), "меню команд для администратора");
await press("ml:1");
msg = last("editMessageText").body;
assert.ok(msg.text.includes("Страница 2 из 2"));

// 2. /find по ID и по @username
await admin("/find 30000002");
assert.equal(last("sendMessage", "111").body.reply_markup.inline_keyboard[0][0].callback_data, "m:30000002");
await admin("/find @anna");
assert.equal(last("sendMessage", "111").body.reply_markup.inline_keyboard[0][0].callback_data, "m:30000001");
await admin("/find несуществующий");
assert.ok(last("sendMessage", "111").body.text.includes("Никого не нашёл"));

// 3. Карточка участника
await press("m:30000001");
msg = last("editMessageText").body;
assert.ok(msg.text.includes("30000001") && msg.text.includes("@anna_fx") && msg.text.includes("активен"));
assert.equal(msg.reply_markup.inline_keyboard[0][0].callback_data, "b:30000001");

// 4. Посторонний не может управлять участниками
await press("b:30000001", 999);
assert.equal(store.get("blk:p:30000001"), undefined);

// 5. Блокировка: доступ к сайту закрыт, удалён из группы, ссылка отозвана
assert.equal((await auth(tA, "/api/academy")).status, 200);
await press("b:30000001");
assert.equal(last("banChatMember").body.user_id, 801);
assert.ok(last("revokeChatInviteLink"));
assert.ok(last("sendMessage", 801).body.text.includes("закрыт"));
assert.ok(last("editMessageText").body.text.includes("заблокирован"));
assert.equal((await (await auth(tA, "/api/status")).json()).status, "blocked");
assert.equal((await auth(tA, "/api/academy")).status, 403);
assert.equal((await auth(tA, "/api/club/tour")).status, 403);
assert.equal((await auth(tB, "/api/academy")).status, 200, "другие участники не затронуты");
// заново подать заявку с тем же ID нельзя
const again = await call("/api/submit", { method: "POST", headers: { Origin: ORIGIN, "CF-Connecting-IP": "6.6.6.6" }, body: JSON.stringify({ pocketId: "30000001" }) });
assert.equal(again.status, 403);
// и с тем же Telegram под другим ID — тоже
const r2 = await call("/api/submit", { method: "POST", headers: { Origin: ORIGIN, "CF-Connecting-IP": "6.6.6.7" }, body: JSON.stringify({ pocketId: "39999999" }) });
const sub2 = await r2.json();
await hook({ message: { chat: { id: 801, type: "private" }, from: { id: 801, first_name: "Анна" }, text: "/start " + sub2.telegramLink.split("start=")[1] } });
assert.ok(last("sendMessage", 801).body.text.includes("закрыт"));
await admin("/members");
assert.ok(last("sendMessage", "111").body.text.includes("заблокировано: 1"));

// 6. Разблокировка: доступ возвращается, новая ссылка выдаётся
await press("u:30000001");
assert.equal(last("unbanChatMember").body.user_id, 801);
const st = await (await auth(tA, "/api/status")).json();
assert.equal(st.status, "approved");
assert.ok(st.inviteLink && st.inviteLink !== "https://t.me/+X0", "выдана новая ссылка");
assert.equal((await auth(tA, "/api/academy")).status, 200);

// 7. Участники, одобренные до появления списка, подтягиваются автоматически
store.delete("idx:members");
store.delete("cfg:idx1");
await admin("/members");
assert.ok(last("sendMessage", "111").body.text.includes("Всего: 11"));

console.log("Участники: все проверки пройдены ✅");
