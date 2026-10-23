// 둘이서 분식집 중계 서버 (Cloudflare Workers + Durable Objects, 무료 플랜)
// 방 코드마다 방(Durable Object) 하나: 방장 소켓 하나 + 친구·관전 소켓 여럿. 내용은 열어 보지 않고 그대로 넘겨요.
//   방장 → 중계: "s" + 받을 id들(쉼표로) + "\n" + 내용 / "d" + id (내보내기)
//   중계 → 방장: "j" + id (들어옴) / "l" + id (나감) / "m" + id + "\n" + 내용
//   친구 ↔ 중계: 내용 그대로 (방장하고만 주고받아요)
//   중계 → 친구: "bye" (방장이 나갔어요) / "drop" (내보냈어요) — 소켓 닫힘이 늦게 알려질 수 있어서 먼저 말해 줘요
//   "ping"은 방을 깨우지 않고 중계가 바로 "pong"으로 답해요 (연결 유지용)
const ORIGIN = /^(https:\/\/ocean-test\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i; // 게임 화면에서만 붙어요

export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/room\/([\w-]{1,64})$/);
    if (!m) return new Response("bunsik relay");
    if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
    if (!ORIGIN.test(req.headers.get("Origin") || "")) return new Response("forbidden", { status: 403 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  }
};

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  host() { return this.ctx.getWebSockets("host").find((w) => w.readyState === 1); }
  async fetch(req) {
    const asHost = new URL(req.url).searchParams.get("role") === "host", host = this.host();
    if (asHost && host) return new Response("taken", { status: 409 }); // 같은 코드 방이 이미 있어요
    if (!asHost && !host) return new Response("no room", { status: 404 }); // 방장이 없어요 (PeerJS 쪽 방일 수도)
    const [client, server] = Object.values(new WebSocketPair());
    if (asHost) this.ctx.acceptWebSocket(server, ["host"]);
    else {
      const id = "r" + crypto.randomUUID().slice(0, 8);
      this.ctx.acceptWebSocket(server, ["g", "g:" + id]);
      server.serializeAttachment(id);
      host.send("j" + id);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, msg) {
    if (typeof msg !== "string") return;
    if (!this.ctx.getTags(ws).includes("host")) { const host = this.host(); if (host) host.send("m" + ws.deserializeAttachment() + "\n" + msg); return; }
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
    if (this.ctx.getTags(ws).includes("host")) { for (const g of this.ctx.getWebSockets("g")) this.end(g, "bye", 4001); return; }
    const host = this.host();
    if (host) host.send("l" + ws.deserializeAttachment());
  }
}
