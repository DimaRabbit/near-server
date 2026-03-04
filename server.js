const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket server running');
});

const wss = new WebSocket.Server({ server });

let clients = [];

wss.on('connection', (ws) => {
    const player = {
        id: Date.now(),
        x: 0,
        y: 0,
        name: "User_" + Date.now().toString().slice(-4)
    };

    clients.push({ ws, player });

    console.log(`[${player.name}] подключился (ID: ${player.id})`);

    // Отправляем новому клиенту текущее состояние всех игроков
    ws.send(JSON.stringify({
        type: "update",
        players: clients.map(c => ({
            id: c.player.id,
            name: c.player.name,
            x: c.player.x,
            y: c.player.y
        }))
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            // Обработка движения
            if (data.type === "move") {
                player.x = data.x;
                player.y = data.y;

                // Рассылаем обновление всем (кроме отправителя, чтобы не дублировать)
                broadcast({
                    type: "update",
                    players: clients.map(c => ({
                        id: c.player.id,
                        name: c.player.name,
                        x: c.player.x,
                        y: c.player.y
                    }))
                }, ws);
            }

            // Обработка чата
            if (data.type === "chat") {
                const chatMsg = {
                    type: "chat",
                    id: player.id,
                    name: player.name,
                    text: data.text
                };
                broadcast(chatMsg);
            }

            // Обработка WebRTC signaling (offer, answer, ICE candidates)
            if (data.type.startsWith("webrtc_")) {
                const targetId = data.targetId;
                const fromId = player.id;
                const payload = data.payload;

                const targetClient = clients.find(c => c.player.id === targetId);
                if (targetClient) {
                    targetClient.ws.send(JSON.stringify({
                        type: data.type,
                        fromId: fromId,
                        payload: payload
                    }));
                    console.log(`WebRTC ${data.type} от ${fromId} → ${targetId}`);
                } else {
                    console.log(`Целевой клиент ${targetId} не найден`);
                }
            }

        } catch (e) {
            console.log(`Ошибка парсинга от ${player.name}:`, e.message);
        }
    });

    ws.on('close', () => {
        console.log(`[${player.name}] отключился`);
        clients = clients.filter(c => c.ws !== ws);

        // Рассылаем обновление всем после отключения
        broadcast({
            type: "update",
            players: clients.map(c => ({
                id: c.player.id,
                name: c.player.name,
                x: c.player.x,
                y: c.player.y
            }))
        });
    });
});

function broadcast(data, excludeWs = null) {
    const msg = JSON.stringify(data);
    clients.forEach(client => {
        if (client.ws.readyState === WebSocket.OPEN && client.ws !== excludeWs) {
            client.ws.send(msg);
        }
    });
}

server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
