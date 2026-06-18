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

    ws.send(JSON.stringify({ type: "self_info", id: player.id, name: player.name }));
    broadcastPlayersUpdate();
    sendExistingRooms(ws);

    ws.on('message', (message, isBinary) => {
        // --- ГОЛОС: бинарный кадр [int32 sampleRate][int16 PCM...] ---
        if (isBinary) {
            const header = Buffer.alloc(4);
            header.writeInt32LE(player.id, 0);
            const out = Buffer.concat([header, message]);
            const roomId = player.roomId || "global";
            clients.forEach(client => {
                if (client.ws !== ws &&
                    client.player.roomId === roomId &&
                    client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(out, { binary: true });
                }
            });
            return;
        }

        try {
            const data = JSON.parse(message);
            switch (data.type) {
                case "create_room":  handleCreateRoom(ws, player, data); break;
                case "request_join": handleRequestJoin(ws, player, data); break;
                case "approve_join": handleApproveJoin(ws, player, data); break;
                case "chat":         handleChat(ws, player, data); break;
                case "move":
                    player.x = data.x || 0;
                    player.y = data.y || 0;
                    break;
                case "set_name":
                    if (typeof data.name === "string" && data.name.trim()) {
                        player.name = data.name.trim().slice(0, 32);
                        broadcastPlayersUpdate();
                    }
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
            if (room.creatorId === player.id) {
                rooms.delete(roomId);
                const closeMsg = JSON.stringify({ type: "room_closed", roomId });
                clients.forEach(c => {
                    if (c.ws !== ws && c.ws.readyState === WebSocket.OPEN) c.ws.send(closeMsg);
                });
            }
        });

        broadcastPlayersUpdate();
    });
});

// ====================== ОБРАБОТЧИКИ ======================

function handleCreateRoom(ws, player, data) {
    const roomId = "room_" + Date.now();
    rooms.set(roomId, { name: data.name || "Private Room", creatorId: player.id, members: [player.id] });
    player.roomId = roomId;
    ws.send(JSON.stringify({ type: "room_created", roomId: roomId, name: rooms.get(roomId).name }));
    console.log(`[${player.name}] создал комнату ${roomId}`);
    broadcastRoomAvailable(roomId);
}

function handleRequestJoin(ws, player, data) {
    const room = rooms.get(data.roomId);
    if (!room) return;
    const creatorClient = clients.find(c => c.player.id === room.creatorId);
    if (creatorClient && creatorClient.ws.readyState === WebSocket.OPEN) {
        creatorClient.ws.send(JSON.stringify({
            type: "room_invite", fromId: player.id, fromName: player.name, roomId: data.roomId
        }));
    }
}

function handleApproveJoin(ws, player, data) {
    const room = rooms.get(data.roomId);
    if (!room || room.creatorId !== player.id) return;
    const targetId = parseInt(data.userId);
    if (!!data.approved) {
        if (!room.members.includes(targetId)) room.members.push(targetId);
        const targetClient = clients.find(c => c.player.id === targetId);
        if (targetClient) {
            targetClient.player.roomId = data.roomId;
            targetClient.ws.send(JSON.stringify({ type: "join_approved", roomId: data.roomId }));
        }
    }
}

function handleChat(ws, player, data) {
    const roomId = player.roomId || "global";
    const msg = { type: "chat", name: player.name, text: data.text, roomId: roomId };
    clients.forEach(client => {
        if (client.player.roomId === roomId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(msg));
        }
    });
}

function broadcastRoomAvailable(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const creator = clients.find(c => c.player.id === room.creatorId);
    const msg = JSON.stringify({
        type: "room_available", roomId, name: room.name,
        creatorId: room.creatorId, creatorName: creator ? creator.player.name : ""
    });
    clients.forEach(c => { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg); });
}

function sendExistingRooms(ws) {
    rooms.forEach((room, roomId) => {
        const creator = clients.find(c => c.player.id === room.creatorId);
        ws.send(JSON.stringify({
            type: "room_available", roomId, name: room.name,
            creatorId: room.creatorId, creatorName: creator ? creator.player.name : ""
        }));
    });
}

function broadcastPlayersUpdate() {
    const playersData = clients.map(c => ({ id: c.player.id, name: c.player.name, x: c.player.x || 0, y: c.player.y || 0 }));
    const msg = JSON.stringify({ type: "update", players: playersData });
    clients.forEach(client => {
        if (client.ws.readyState === WebSocket.OPEN) client.ws.send(msg);
    });
}

setInterval(broadcastPlayersUpdate, 150);

server.listen(PORT, () => console.log(`NEAR Server запущен на порту ${PORT}`));
