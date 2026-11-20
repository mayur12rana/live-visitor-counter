// Live Visitor Counter — WebSocket server for the Sprint Requirements Dashboard
// Clients connect to  wss://<your-service>.onrender.com/ws?vid=<browser id>
// and receive  {"activeVisitors": <unique browsers>, "activeConnections": <open tabs>}
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

// Only pages from these sites may connect (stops other websites inflating the count).
// Override on Render: Settings → Environment → ALLOWED_ORIGINS = comma-separated list,
// e.g. "https://mayur12rana.github.io,https://another.github.io". Use "*" to allow any site.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://mayur12rana.github.io")
    .split(",").map(s => s.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean);

function originAllowed(origin) {
    if (ALLOWED_ORIGINS.includes("*")) return true;
    if (!origin) return false;
    return ALLOWED_ORIGINS.includes(String(origin).replace(/\/+$/, "").toLowerCase());
}

const server = http.createServer((req, res) => {
    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(currentCounts()));
        return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Visitor Counter Running");
});

const wss = new WebSocket.Server({
    server,
    path: "/ws",
    maxPayload: 1024,                       // clients never need to send anything large
    verifyClient: (info, done) => {
        const ok = originAllowed(info.origin);
        if (!ok) console.warn("Rejected connection from origin:", info.origin || "(none)");
        done(ok, 403, "Forbidden");
    }
});

function currentCounts() {
    const open = [...wss.clients].filter(c => c.readyState === WebSocket.OPEN);
    // one browser with several tabs = one visitor (falls back to per-tab when no id was sent)
    const ids = new Set(open.map(c => c.visitorId || ("conn:" + c.connId)));
    return { activeVisitors: ids.size, activeConnections: open.length };
}

let broadcastTimer = null;
function broadcastCount() {
    // coalesce bursts (many tabs opening/closing at once) into one message
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
        broadcastTimer = null;
        const message = JSON.stringify(currentCounts());
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(message);
        });
    }, 250);
}

let nextConnId = 1;
wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.connId = nextConnId++;
    try {
        const vid = new URL(req.url, "http://localhost").searchParams.get("vid") || "";
        ws.visitorId = /^[A-Za-z0-9_-]{8,64}$/.test(vid) ? vid : null;
    } catch (e) {
        ws.visitorId = null;
    }

    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", () => { ws.isAlive = true; });   // client keep-alive pings
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
    console.log("Visitor Counter Started on port " + PORT + " | allowed origins: " + ALLOWED_ORIGINS.join(", "));
});
