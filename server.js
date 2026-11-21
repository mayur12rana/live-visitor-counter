// Live Visitor Counter — WebSocket server for the Sprint Requirements Dashboard
//
// Every client:   wss://<service>.onrender.com/ws?vid=<browser id>
//   receives      {"type":"count","activeVisitors":N,"activeConnections":M}
//   may send      {"type":"hello","name":"<TFS display name>","status":"ok"|"denied"}   (after login)
//                 {"type":"admin","key":"<ADMIN_KEY>"} / {"type":"adminOff"}               (super_admin only)
//                 "ping"                                                                   (keep-alive)
// Admin clients (correct ADMIN_KEY) additionally receive the visitor list in every update:
//                 {"type":"count", ..., "visitors":[{"name":..,"status":..,"tabs":..,"since":..,"self":..}]}
//
// Names are kept in memory only for open connections — nothing is stored or logged.
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

// Render → Settings → Environment
//   ALLOWED_ORIGINS : comma-separated sites allowed to connect ("*" = any). Default: your GitHub Pages site.
//   ADMIN_KEY       : secret that unlocks the visitor-name list. If not set, names are never sent to anyone.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://mayur12rana.github.io")
    .split(",").map(s => s.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean);
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const MAX_KEY_ATTEMPTS = 5;      // wrong admin-key tries per connection before it is ignored

function originAllowed(origin) {
    if (ALLOWED_ORIGINS.includes("*")) return true;
    if (!origin) return false;
    return ALLOWED_ORIGINS.includes(String(origin).replace(/\/+$/, "").toLowerCase());
}

function keyMatches(given) {
    if (!ADMIN_KEY || typeof given !== "string" || !given) return false;
    const a = crypto.createHash("sha256").update(given).digest();
    const b = crypto.createHash("sha256").update(ADMIN_KEY).digest();
    return crypto.timingSafeEqual(a, b);
}

// Visible text only, max 80 chars
function cleanName(v) {
    if (typeof v !== "string") return null;
    const s = v.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    return s && s !== "-" ? s : null;
}

const server = http.createServer((req, res) => {
    if (req.url === "/health") {
        const c = summarize();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ activeVisitors: c.activeVisitors, activeConnections: c.activeConnections }));   // never names
        return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Visitor Counter Running");
});

const wss = new WebSocket.Server({
    server,
    path: "/ws",
    maxPayload: 2048,
    verifyClient: (info, done) => {
        const ok = originAllowed(info.origin);
        if (!ok) console.warn("Rejected connection from origin:", info.origin || "(none)");
        done(ok, 403, "Forbidden");
    }
});

// Group open connections by browser id → one entry per visitor
function summarize() {
    const open = [...wss.clients].filter(c => c.readyState === WebSocket.OPEN);
    const groups = new Map();
    for (const c of open) {
        const key = c.visitorId || ("conn:" + c.connId);
        let g = groups.get(key);
        if (!g) { g = { key, name: null, status: null, tabs: 0, since: c.since, nameAt: 0 }; groups.set(key, g); }
        g.tabs++;
        g.since = Math.min(g.since, c.since);
        if (c.visitorName && c.nameAt >= g.nameAt) { g.name = c.visitorName; g.nameAt = c.nameAt; }
        if (c.status === "ok") g.status = "ok";
        else if (c.status === "denied" && g.status !== "ok") g.status = "denied";
    }
    return { activeVisitors: groups.size, activeConnections: open.length, groups: [...groups.values()] };
}

let broadcastTimer = null;
function broadcastCount() {
    if (broadcastTimer) return;              // coalesce bursts into one update
    broadcastTimer = setTimeout(() => {
        broadcastTimer = null;
        const s = summarize();
        const base = { type: "count", activeVisitors: s.activeVisitors, activeConnections: s.activeConnections };
        const plain = JSON.stringify(base);
        wss.clients.forEach(client => {
            if (client.readyState !== WebSocket.OPEN) return;
            if (!client.isAdmin) { client.send(plain); return; }
            const myKey = client.visitorId || ("conn:" + client.connId);
            const visitors = s.groups.map(g => ({
                name: g.status ? g.name : null,          // only logged-in (PAT) users have a name
                status: g.status || "unknown",           // ok | denied | unknown
                tabs: g.tabs,
                since: g.since,
                self: g.key === myKey
            }));
            client.send(JSON.stringify({ ...base, visitors }));
        });
    }, 250);
}

function reply(ws, obj) { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch (e) {} }

let nextConnId = 1;
wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.connId = nextConnId++;
    ws.since = Date.now();
    ws.visitorName = null; ws.status = null; ws.nameAt = 0;
    ws.isAdmin = false; ws.keyTries = 0;
    try {
        const vid = new URL(req.url, "http://localhost").searchParams.get("vid") || "";
        ws.visitorId = /^[A-Za-z0-9_-]{8,64}$/.test(vid) ? vid : null;
    } catch (e) { ws.visitorId = null; }

    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", raw => {
        ws.isAlive = true;
        const text = String(raw);
        if (text === "ping") return;
        let msg; try { msg = JSON.parse(text); } catch (e) { return; }
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "hello") {
            const name = cleanName(msg.name);
            const status = msg.status === "ok" ? "ok" : msg.status === "denied" ? "denied" : null;
            ws.visitorName = status ? name : null;
            ws.status = name ? status : null;
            ws.nameAt = Date.now();
            broadcastCount();
        } else if (msg.type === "admin") {
            if (!ADMIN_KEY) { reply(ws, { type: "admin", ok: false, reason: "not-configured" }); return; }
            if (ws.keyTries >= MAX_KEY_ATTEMPTS) { reply(ws, { type: "admin", ok: false, reason: "locked" }); return; }
            if (keyMatches(msg.key)) {
                ws.isAdmin = true; ws.keyTries = 0;
                reply(ws, { type: "admin", ok: true });
                broadcastCount();
            } else {
                ws.keyTries++;
                ws.isAdmin = false;
                setTimeout(() => reply(ws, { type: "admin", ok: false, reason: ws.keyTries >= MAX_KEY_ATTEMPTS ? "locked" : "wrong-key" }), 800);
            }
        } else if (msg.type === "adminOff") {
            ws.isAdmin = false;
        }
    });
    ws.on("error", () => {});
    ws.on("close", broadcastCount);

    broadcastCount();
});

// Drop connections that stopped answering (closed laptops, lost networks)
const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch (e) {}
    });
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, "0.0.0.0", () => {
    console.log("Visitor Counter Started on port " + PORT +
        " | allowed origins: " + ALLOWED_ORIGINS.join(", ") +
        " | visitor names: " + (ADMIN_KEY ? "enabled (ADMIN_KEY set)" : "disabled (set ADMIN_KEY to enable)"));
});
