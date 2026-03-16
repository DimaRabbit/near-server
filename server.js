const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const clients = new Map();      // id → ws
const rooms = {};               // roomId → {name, creatorId, members: [], pendingJoins: [], private: true}

let nextPlayerId = 1;

wss.on('connection', (ws) => {
    const id = nextPlayerId++;
    ws.id = id;
    ws.name = `User_${id.toString().slice(-4)}`;
    clients.set(id, ws);

    console.log(`[${ws.name}] Подключился (id: ${id})`);

    // Отправляем новому клиенту его данные
    ws.send(JSON.stringify({
        type: 'self_info',
        id: id,
        name: ws.name
    }));

    // Отправляем обновление игроков всем
    broadcastPlayersUpdate();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            switch (data.type) {
                case 'chat':
                    handleChat(ws, data);
                    break;

                case 'move':
                    handleMove(ws, data);
                    break;

                case 'create_room':
                    handleCreateRoom(ws, data);
                    break;

                case 'join_room':
                    handleJoinRoom(ws, data);
                    break;

                case 'approve_join':
                    handleApproveJoin(ws, data);
                    break;

                default:
                    console.log(`Неизвестный тип: ${data.type}`);
            }
        } catch (e) {
            console.error('Ошибка парсинга:', e);
        }
    });

    ws.on('close', () => {
        console.log(`[${ws.name}] Отключился`);
        clients.delete(id);

        // Удаляем из всех комнат
        for (const roomId in rooms) {
            const room = rooms[roomId];
            room.members = room.members.filter(m => m !== id);
            room.pendingJoins = room.pendingJoins.filter(m => m !== id);

            if (room.creatorId === id) {
                // Если создатель вышел — удаляем комнату или передаём права (здесь просто удаляем)
                delete rooms[roomId];
                console.log(`Комната ${roomId} удалена (создатель вышел)`);
            }

            broadcastRoomUpdate(roomId);
        }

        broadcastPlayersUpdate();
    });
});

// ────────────────────────────────────────────────
// Вспомогательные функции
// ────────────────────────────────────────────────

function broadcastPlayersUpdate() {
    const players = [];
    clients.forEach((ws, id) => {
        players.push({
            id,
            name: ws.name,
            x: ws.x || 0,
            y: ws.y || 0
        });
    });

    const msg = JSON.stringify({
        type: 'update',
        players
    });

    clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    });
}

function handleChat(ws, data) {
    const roomId = data.roomId || 'global';
    const msg = {
        type: 'chat',
        roomId,
        id: ws.id,
        name: ws.name,
        text: data.text,
        timestamp: Date.now()
    };

    if (roomId === 'global') {
        // глобальный чат — всем
        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(msg));
            }
        });
    } else {
        // приватная комната — только членам
        const room = rooms[roomId];
        if (room && room.members.includes(ws.id)) {
            room.members.forEach(memberId => {
                const client = clients.get(memberId);
                if (client && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(msg));
                }
            });
        }
    }

    console.log(`Чат [${roomId}]: ${ws.name} → ${data.text}`);
}

function handleMove(ws, data) {
    ws.x = data.x;
    ws.y = data.y;
    // Обновление позиций рассылается в broadcastPlayersUpdate каждые 100–200 мс (таймер ниже)
}

function handleCreateRoom(ws, data) {
    const roomId = 'room_' + Date.now();

    rooms[roomId] = {
        name: data.name || 'Без названия',
        creatorId: ws.id,
        members: [ws.id],
        pendingJoins: [],
        private: true
    };

    ws.send(JSON.stringify({
        type: 'room_created',
        roomId,
        name: rooms[roomId].name
    }));

    console.log(`Создана комната: ${rooms[roomId].name} (${roomId}) создателем ${ws.name}`);

    // Можно сразу отправить историю (пока пустая)
    ws.send(JSON.stringify({
        type: 'room_history',
        roomId,
        messages: []
    }));

    broadcastRoomUpdate(roomId);
}

function handleJoinRoom(ws, data) {
    const roomId = data.roomId;
    const room = rooms[roomId];

    if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' }));
        return;
    }

    if (room.members.includes(ws.id)) {
        ws.send(JSON.stringify({ type: 'join_success', roomId }));
        ws.send(JSON.stringify({
            type: 'room_history',
            roomId,
            messages: [] // здесь можно хранить историю сообщений комнаты
        }));
        return;
    }

    if (!room.private) {
        room.members.push(ws.id);
        ws.send(JSON.stringify({ type: 'join_success', roomId }));
        broadcastRoomUpdate(roomId);
        return;
    }

    // Приватная — запрос создателю
    const creator = clients.get(room.creatorId);
    if (creator && creator.readyState === WebSocket.OPEN) {
        creator.send(JSON.stringify({
            type: 'join_request',
            roomId,
            userId: ws.id,
            userName: ws.name
        }));
    }

    room.pendingJoins.push(ws.id);

    ws.send(JSON.stringify({
        type: 'join_pending',
        message: 'Запрос на вступление отправлен создателю'
    }));

    console.log(`[${ws.name}] запросил вступление в приватную комнату ${room.name} (${roomId})`);
}

function handleApproveJoin(ws, data) {
    const room = rooms[data.roomId];
    if (!room || room.creatorId !== ws.id) {
        ws.send(JSON.stringify({ type: 'error', message: 'Нет прав или комната не найдена' }));
        return;
    }

    const userId = data.userId;
    const approved = !!data.approved;

    if (approved) {
        if (room.pendingJoins.includes(userId)) {
            room.members.push(userId);
            room.pendingJoins = room.pendingJoins.filter(id => id !== userId);

            const target = clients.get(userId);
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify({
                    type: 'join_approved',
                    roomId: data.roomId,
                    roomName: room.name
                }));
                // Можно сразу отправить историю комнаты
                target.send(JSON.stringify({
                    type: 'room_history',
                    roomId: data.roomId,
                    messages: [] // если хранишь историю
                }));
            }

            broadcastRoomUpdate(data.roomId);
            console.log(`[${ws.name}] одобрил вступление ${clients.get(userId)?.name || userId} в ${room.name}`);
        }
    } else {
        const target = clients.get(userId);
        if (target && target.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify({
                type: 'join_denied',
                roomId: data.roomId,
                message: data.reason || 'Вступление отклонено создателем'
            }));
        }

        room.pendingJoins = room.pendingJoins.filter(id => id !== userId);
        console.log(`[${ws.name}] отклонил вступление ${clients.get(userId)?.name || userId} в ${room.name}`);
    }
}

function broadcastRoomUpdate(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const payload = {
        type: 'room_update',
        roomId,
        members: room.members.map(id => ({
            id,
            name: clients.get(id)?.name || '???'
        }))
    };

    room.members.forEach(memberId => {
        const ws = clients.get(memberId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    });
}

// Каждые 150 мс рассылаем позиции игроков
setInterval(broadcastPlayersUpdate, 150);

server.listen(8080, () => {
    console.log('WebSocket сервер запущен на ws://localhost:8080');
});
