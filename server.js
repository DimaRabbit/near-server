const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket server running');
});

const wss = new WebSocket.Server({ server });

let clients = []; // { ws, player: {id, name, x, y} }
let rooms = new Map(); // roomId → { name, members: [playerId], messages: [] }

wss.on('connection', (ws) => {
    const player = {
        id: Date.now(),
        x: 0,
        y: 0,
        name: "User_" + Date.now().toString().slice(-4)
    };

    clients.push({ ws, player });

    console.log(`[${player.name}] подключился`);

    // Отправляем новому клиенту текущее состояние
    ws.send(JSON.stringify({
        type: "update",
        players: clients.map(c => ({ id: c.player.id, name: c.player.name, x: c.player.x, y: c.player.y }))
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            if (data.type === "move") {
                player.x = data.x;
                player.y = data.y;

                broadcastToRoom("global", {
                    type: "update",
                    players: clients.map(c => ({ id: c.player.id, name: c.player.name, x: c.player.x, y: c.player.y }))
                });
            }

            if (data.type === "chat") {
                const roomId = data.roomId || "global";
                const chatMsg = {
                    type: "chat",
                    roomId: roomId,
                    id: player.id,
                    name: player.name,
                    text: data.text,
                    timestamp: Date.now()
                };

                // Сохраняем в комнату
                if (!rooms.has(roomId)) {
                    rooms.set(roomId, { name: roomId, members: [player.id], messages: [] });
                }
                rooms.get(roomId).messages.push(chatMsg);

                // Отправляем только участникам комнаты
                broadcastToRoom(roomId, chatMsg);
            }

            // Создание/присоединение к комнате
            if (data.type === "create_room") {
                const roomId = "room_" + Date.now();
                rooms.set(roomId, { name: data.name || roomId, members: [player.id], messages: [] });

                ws.send(JSON.stringify({
                    type: "room_created",
                    roomId: roomId,
                    name: data.name || roomId
                }));
            }

            if (data.type === "join_room") {
                const roomId = data.roomId;
                if (rooms.has(roomId)) {
                    const room = rooms.get(roomId);
                    if (!room.members.includes(player.id)) {
                        room.members.push(player.id);
                    }

                    // Отправляем историю комнаты новому участнику
                    ws.send(JSON.stringify({
                        type: "room_history",
                        roomId: roomId,
                        messages: room.messages
                    }));

                    broadcastToRoom(roomId, {
                        type: "room_update",
                        roomId: roomId,
                        members: room.members
                    });
                }
            }

            // Приглашение в комнату
            if (data.type === "invite_to_room") {
                const targetId = data.targetId;
                const roomId = data.roomId;

                const targetClient = clients.find(c => c.player.id === targetId);
                if (targetClient) {
                    targetClient.ws.send(JSON.stringify({
                        type: "room_invite",
                        fromId: player.id,
                        fromName: player.name,
                        roomId: roomId
                    }));
                }
            }

        } catch (e) {
            console.log(`Ошибка от ${player.name}:`, e.message);
        }
    });

    ws.on('close', () => {
        console.log(`[${player.name}] отключился`);
        clients = clients.filter(c => c.ws !== ws);

        // Удаляем из всех комнат
        for (const [roomId, room] of rooms) {
            room.members = room.members.filter(id => id !== player.id);
            if (room.members.length === 0) rooms.delete(roomId);
        }

        broadcastToRoom("global", {
            type: "update",
            players: clients.map(c => ({ id: c.player.id, name: c.player.name, x: c.player.x, y: c.player.y }))
        });
    });
});

function broadcastToRoom(roomId, data) {
    const msg = JSON.stringify(data);
    const room = rooms.get(roomId);
    if (room) {
        clients.forEach(client => {
            if (room.members.includes(client.player.id) && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(msg);
            }
        });
    } else if (roomId === "global") {
        clients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(msg);
            }
        });
    }
}

server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
