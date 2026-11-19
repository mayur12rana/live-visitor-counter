const http = require("http");
const WebSocket = require("ws");

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Visitor Counter Running");
});

const wss = new WebSocket.Server({
    server,
    path: "/ws"
});

function broadcastCount() {
    const count = [...wss.clients].filter(
        client => client.readyState === WebSocket.OPEN
    ).length;

    const message = JSON.stringify({
        activeVisitors: count
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

wss.on("connection", ws => {
    ws.isAlive = true;

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("error", () => {});

    broadcastCount();

    ws.on("close", broadcastCount);
});

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) {
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
    console.log("Visitor Counter Started");
});
  
