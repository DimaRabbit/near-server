const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

const wss = new WebSocket.Server({ port: PORT });

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

console.log("Server running on port", PORT);
