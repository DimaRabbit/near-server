const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket server running');
});

const wss = new WebSocket.Server({ server });

let clients = [];

wss.on('connection', function connection(ws) {
    const player = {
        id: Date.now(),
        x: 0,
        y: 0,
        name: "User"
    };

    clients.push({ ws, player });

    ws.on('message', function incoming(message) {
        const data = JSON.parse(message);

        if (data.type === "move") {
            player.x = data.x;
            player.y = data.y;
        }

        if (data.type === "chat") {
            broadcast({
                type: "chat",
                id: player.id,
                text: data.text
            });
        }

        broadcast({
            type: "update",
            players: clients.map(c => c.player)
        });
    });

    ws.on('close', function () {
        clients = clients.filter(c => c.ws !== ws);
    });
});

function broadcast(data) {
    const msg = JSON.stringify(data);
    clients.forEach(c => c.ws.send(msg));
}

server.listen(PORT, () => {
    console.log("Server running on port", PORT);
});
console.log("Server running on port", PORT);
