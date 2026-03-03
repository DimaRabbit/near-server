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
        name: "User_" + Date.now().toString().slice(-4)  // ← вот здесь имя, типа User_4567
    };

    clients.push({ ws, player });

    console.log(player.name + ' connected');

    ws.on('message', function incoming(message) {
        try {
            const data = JSON.parse(message);

            if (data.type === "move") {
                player.x = data.x;
                player.y = data.y;
            }

            if (data.type === "chat") {
                // Отправляем всем с именем отправителя
                const chatMsg = {
                    type: "chat",
                    id: player.id,
                    name: player.name,          // ← имя здесь
                    text: data.text
                };
                broadcast(chatMsg);
            }

            // Отправляем обновление всех игроков (пока можно оставить, потом уберём если не нужно)
            broadcast({
                type: "update",
                players: clients.map(c => ({ id: c.player.id, name: c.player.name, x: c.player.x, y: c.player.y }))
            });

        } catch (e) {
            console.log('Invalid JSON:', message);
        }
    });

    ws.on('close', function () {
        console.log(player.name + ' disconnected');
        clients = clients.filter(c => c.ws !== ws);
    });
});

function broadcast(data) {
    const msg = JSON.stringify(data);
    clients.forEach(c => {
        if (c.ws.readyState === WebSocket.OPEN) {
            c.ws.send(msg);
        }
    });
}

server.listen(PORT, () => {
    console.log("Server running on port", PORT);
});
