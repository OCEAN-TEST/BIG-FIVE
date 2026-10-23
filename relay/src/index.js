// 둘이서 분식집 중계 서버 (Cloudflare Workers + Durable Objects, 무료 플랜)
// 방 코드마다 방(Durable Object) 하나: 방장 소켓 하나 + 친구·관전 소켓 여럿. 내용은 열어 보지 않고 그대로 넘겨요.
//   방장 → 중계: "s" + 받을 id들(쉼표로) + "\n" + 내용 / "d" + id (내보내기)
//   중계 → 방장: "j" + id (들어옴) / "l" + id (나감) / "m" + id + "\n" + 내용
//   친구 ↔ 중계: 내용 그대로 (방장하고만 주고받아요)
//   중계 → 친구: "bye" (방장이 나갔어요) / "drop" (내보냈어요) — 소켓 닫힘이 늦게 알려질 수 있어서 먼저 말해 줘요
//   "ping"은 방을 깨우지 않고 중계가 바로 "pong"으로 답해요 (연결 유지용)
// 운영자 페이지(/stats?k=열쇠): 지금 열린 방·인원 숫자만 모아서 보여 줘요 (이름·채팅은 안 모아요)
const ORIGIN = /^(https:\/\/ocean-test\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i; // 게임 화면에서만 붙어요
const KEY_HASH = "b2e2e39d4e9a4509061e14583b27738741a78579d6b1aac8d86bf0ec869ec235"; // 운영자 페이지 열쇠의 SHA-256 (열쇠 자체는 저장소에 없어요)
const TXT = { "content-type": "text/plain; charset=utf-8" };

async function keyOk(k, env) {
  if (!k) return false;
  if (env.STATS_KEY && k === env.STATS_KEY) return true; // 대시보드에서 비밀 값(STATS_KEY)으로 바꿔 쓸 수도 있어요
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return h === KEY_HASH;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/stats" || url.pathname === "/stats.json") {
      if (!(await keyOk(url.searchParams.get("k"), env))) return new Response("열쇠가 틀렸어요", { status: 403, headers: TXT });
      if (url.pathname === "/stats") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      return env.STATS.get(env.STATS.idFromName("all")).fetch("https://stats/");
    }
    const m = url.pathname.match(/^\/room\/([\w-]{1,64})$/);
    if (!m) return new Response("bunsik relay");
    if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
    if (!ORIGIN.test(req.headers.get("Origin") || "")) return new Response("forbidden", { status: 403 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  }
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  host() { return this.ctx.getWebSockets("host").find((w) => w.readyState === 1); }
  async fetch(req) {
    const u = new URL(req.url), asHost = u.searchParams.get("role") === "host", host = this.host();
    if (asHost && host) return new Response("taken", { status: 409 }); // 같은 코드 방이 이미 있어요
    if (!asHost && !host) return new Response("no room", { status: 404 }); // 방장이 없어요 (PeerJS 쪽 방일 수도)
    const [client, server] = Object.values(new WebSocketPair());
    if (asHost) {
      const code = u.pathname.split("-").pop();
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({ code });
      this.tell("open", code);
    } else {
      const id = "r" + crypto.randomUUID().slice(0, 8);
      this.ctx.acceptWebSocket(server, ["g", "g:" + id]);
      server.serializeAttachment({ id, spec: u.searchParams.get("w") === "spec" });
      host.send("j" + id);
      this.tell("join", host.deserializeAttachment().code);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, msg) {
    if (typeof msg !== "string") return;
    if (!this.ctx.getTags(ws).includes("host")) { const host = this.host(); if (host) host.send("m" + ws.deserializeAttachment().id + "\n" + msg); return; }
    if (msg[0] === "s") {
      const nl = msg.indexOf("\n"), body = msg.slice(nl + 1);
      for (const id of msg.slice(1, nl).split(",")) for (const g of this.ctx.getWebSockets("g:" + id)) g.send(body);
    } else if (msg[0] === "d") for (const g of this.ctx.getWebSockets("g:" + msg.slice(1))) this.end(g, "drop", 4002);
  }
  end(g, why, code) { try { g.send(why); g.close(code, why); } catch (e) {} }
  webSocketClose(ws) { this.gone(ws); }
  webSocketError(ws) { this.gone(ws); }
  gone(ws) {
    try { ws.close(); } catch (e) {}
    if (this.ctx.getTags(ws).includes("host")) {
      for (const g of this.ctx.getWebSockets("g")) this.end(g, "bye", 4001);
      this.tell("close", ws.deserializeAttachment().code);
      return;
    }
    const host = this.host();
    if (host) { host.send("l" + ws.deserializeAttachment().id); this.tell("leave", host.deserializeAttachment().code, ws); }
  }
  tell(op, code, skip) { // 운영자 페이지에 방 소식 (방장 포함 인원·관전 인원 숫자만). 순서대로 보내요
    if (!this.env.STATS || !code) return;
    const gs = this.ctx.getWebSockets("g").filter((g) => g !== skip && g.readyState === 1);
    const w = gs.filter((g) => g.deserializeAttachment().spec).length;
    const body = JSON.stringify({ op, code, n: 1 + gs.length - w, w });
    const stub = this.env.STATS.get(this.env.STATS.idFromName("all"));
    this.q = (this.q || Promise.resolve()).then(() => stub.fetch("https://stats/", { method: "POST", body })).catch(() => {});
  }
}

// 모든 방 소식을 모아 두는 곳 (하나만 있어요). 한국 날짜로 하루치 숫자도 세요
export class Stats {
  constructor(ctx) {
    this.ctx = ctx;
    ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get("s")) || { rooms: {}, day: "", opened: 0, joins: 0, peak: 0 }; });
  }
  async fetch(req) {
    const now = Date.now(), s = this.s, day = new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
    if (s.day !== day) Object.assign(s, { day, opened: 0, joins: 0, peak: 0 });
    for (const c in s.rooms) if (now - s.rooms[c].t > 12 * 3600e3) delete s.rooms[c]; // 소식이 12시간 없는 방은 지워요 (서버가 다시 켜진 경우 등)
    if (req.method !== "POST") return Response.json({ now, ...s });
    const m = await req.json();
    if (!/^\w{1,12}$/.test(m.code || "")) return new Response("bad", { status: 400 });
    const r = s.rooms[m.code];
    if (m.op === "open") { s.rooms[m.code] = { n: 1, w: 0, t0: now, t: now }; s.opened++; }
    else if (m.op === "close") delete s.rooms[m.code];
    else if (r) { if (m.op === "join") s.joins++; r.n = m.n; r.w = m.w; r.t = now; }
    s.peak = Math.max(s.peak, Object.values(s.rooms).reduce((a, q) => a + q.n + q.w, 0));
    await this.ctx.storage.put("s", s);
    return new Response("ok");
  }
}

const PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>분식집 운영자</title>
<style>
:root { --bg: #fff7e6; --card: #fff; --ink: #3a2a1c; --sub: #8a7563; --line: #ead9bf; --acc: #d7372b; }
@media (prefers-color-scheme: dark) { :root { --bg: #1d1915; --card: #2a241e; --ink: #f4e9d8; --sub: #b6a48f; --line: #43392f; --acc: #ff6a5c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 18px 16px 40px; }
h1 { font-size: 22px; margin: 0 0 12px; }
.big { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.box { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
.box b { display: block; font-size: 30px; line-height: 1.1; }
.box span, .sub { color: var(--sub); font-size: 14px; }
.today { margin: 10px 0 18px; }
h2 { font-size: 17px; margin: 18px 0 8px; }
.room { display: flex; align-items: center; gap: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 10px 12px; margin-bottom: 8px; }
.code { font-size: 24px; font-weight: 700; letter-spacing: 2px; min-width: 70px; }
.room div { flex: 1; font-size: 14px; }
.room a { color: #fff; background: var(--acc); text-decoration: none; border-radius: 999px; padding: 7px 12px; font-size: 14px; white-space: nowrap; }
.empty { color: var(--sub); }
</style></head>
<body><main>
<h1>분식집 지금</h1>
<div class="big"><div class="box"><b id="rooms">-</b><span>열린 방</span></div><div class="box"><b id="people">-</b><span>접속한 사람</span></div></div>
<p class="sub today" id="today"></p>
<h2>방 목록</h2>
<div id="list"></div>
<p class="sub" id="upd"></p>
</main>
<script>
const K = new URLSearchParams(location.search).get("k") || "", GAME = "https://ocean-test.github.io/BIG-FIVE/duo/";
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function draw(s) {
  const rooms = Object.entries(s.rooms).sort((a, b) => a[1].t0 - b[1].t0);
  $("rooms").textContent = rooms.length;
  $("people").textContent = rooms.reduce((a, r) => a + r[1].n + r[1].w, 0);
  $("today").textContent = "오늘(" + s.day + ") 연 방 " + s.opened + "개 · 들어온 사람 " + s.joins + "명 · 최고 동시 접속 " + s.peak + "명";
  const list = $("list"); list.textContent = "";
  if (!rooms.length) list.append(el("p", "empty", "지금 열린 방이 없어요."));
  rooms.forEach(([code, r]) => {
    const row = el("div", "room"), mins = Math.max(0, Math.round((s.now - r.t0) / 60000));
    row.append(el("span", "code", code), el("div", "", "방장 포함 " + r.n + "명" + (r.w ? " · 관전 " + r.w + "명" : "") + " · " + (mins < 1 ? "방금" : mins + "분째") + " 열림"));
    const a = el("a", "", "관전"); a.href = GAME + "?watch=" + encodeURIComponent(code) + "&mod"; a.target = "_blank"; a.rel = "noopener";
    row.append(a); list.append(row);
  });
  $("upd").textContent = "마지막으로 불러온 때 " + new Date(s.now).toLocaleTimeString("ko-KR");
}
async function load() {
  if (document.hidden) return;
  try { const r = await fetch("/stats.json?k=" + encodeURIComponent(K), { cache: "no-store" }); if (!r.ok) throw 0; draw(await r.json()); }
  catch (e) { $("upd").textContent = "불러오지 못했어요. 잠시 뒤 다시 해볼게요."; }
}
load(); setInterval(load, 10000); document.addEventListener("visibilitychange", load);
</script>
</body></html>`;
