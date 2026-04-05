const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('NEAR Server Running');
});

const wss = new WebSocket.Server({ server });

let clients = [];
let rooms = new Map();
let nextPlayerId = 1;

wss.on('connection', (ws) => {
    const player = {
        id: nextPlayerId++,
        name: `User_${(nextPlayerId - 1).toString().slice(-4)}`,
        roomId: "global",
        x: 0,
        y: 0
    };

    clients.push({ ws, player });

    console.log(`[${player.name}] (id=${player.id}) подключился`);

    // Отправляем информацию о себе
    ws.send(JSON.stringify({
        type: "self_info",
        id: player.id,
        name: player.name
    }));

    broadcastPlayersUpdate();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`[${player.name}] получил: ${data.type}`);

            switch (data.type) {
                case "create_room":
                    handleCreateRoom(ws, player, data);
                    break;
                case "request_join":
                    handleRequestJoin(ws, player, data);
                    break;
                case "approve_join":
                    handleApproveJoin(ws, player, data);
                    break;
                case "chat":
                    handleChat(ws, player, data);
                    break;
                case "move":
                    player.x = data.x || 0;
                    player.y = data.y || 0;
                    break;
            }
        } catch (e) {
            console.error("Ошибка парсинга:", e);
        }
    });

    ws.on('close', () => {
        console.log(`[${player.name}] отключился`);
        clients = clients.filter(c => c.ws !== ws);

        rooms.forEach((room, roomId) => {
            room.members = room.members.filter(id => id !== player.id);
            if (room.creatorId === player.id) rooms.delete(roomId);
        });

        broadcastPlayersUpdate();
    });
});

// ====================== ОБРАБОТЧИКИ ======================

function handleCreateRoom(ws, player, data) {
    const roomId = "room_" + Date.now();

    rooms.set(roomId, {
        name: data.name || "Private Room",
        creatorId: player.id,
        members: [player.id]
    });

    player.roomId = roomId;

    ws.send(JSON.stringify({
        type: "room_created",
        roomId: roomId,
        name: rooms.get(roomId).name
    }));

    console.log(`[${player.name}] создал комнату ${roomId} (creator = ${player.id})`);
}

function handleRequestJoin(ws, player, data) {
    const room = rooms.get(data.roomId);
    if (!room) {
        console.log(`Комната ${data.roomId} не найдена`);
        return;
    }

    // Ищем клиента-создателя по ID
    const creatorClient = clients.find(c => c.player.id === room.creatorId);

    if (creatorClient && creatorClient.ws.readyState === WebSocket.OPEN) {
        creatorClient.ws.send(JSON.stringify({
            type: "room_invite",
            fromId: player.id,
            fromName: player.name,
            roomId: data.roomId
        }));
        console.log(`[${player.name}] запросил вход → invite отправлен СОЗДАТЕЛЮ (id=${room.creatorId})`);
    } else {
        console.log(`Не удалось найти создателя комнаты ${data.roomId}`);
    }
}

function handleApproveJoin(ws, player, data) {
    const room = rooms.get(data.roomId);
    if (!room || room.creatorId !== player.id) return;

    const targetId = parseInt(data.userId);
    const approved = !!data.approved;

    if (approved) {
        if (!room.members.includes(targetId)) room.members.push(targetId);

        const targetClient = clients.find(c => c.player.id === targetId);
        if (targetClient) {
            targetClient.player.roomId = data.roomId;
            targetClient.ws.send(JSON.stringify({
                type: "join_approved",
                roomId: data.roomId
            }));
        }
        console.log(`[${player.name}] одобрил вход игрока ${targetId}`);
    }
}

function handleChat(ws, player, data) {
    const roomId = player.roomId || "global";

    const msg = {
        type: "chat",
        name: player.name,
        text: data.text,
        roomId: roomId
    };

    clients.forEach(client => {
        if (client.player.roomId === roomId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(msg));
        }
    });
}

function broadcastPlayersUpdate() {
    const playersData = clients.map(c => ({
        id: c.player.id,
        name: c.player.name,
        x: c.player.x || 0,
        y: c.player.y || 0
    }));

    const msg = JSON.stringify({ type: "update", players: playersData });

    clients.forEach(client => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(msg);
        }
    });
}

setInterval(broadcastPlayersUpdate, 150);

server.listen(PORT, () => {
    console.log(`NEAR Server запущен на порту ${PORT}`);
});
