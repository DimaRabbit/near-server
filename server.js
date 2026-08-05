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
let nextBulletinId = 1;
let nextReplyId = 1;
/** @type {{ id:string, kind:string, title:string, body:string, linkUrl:string, authorName:string, authorId:number, createdUnix:number }[]} */
let bulletinPosts = [];
/** @type {{ id:string, postId:string, fromName:string, fromId:number, text:string, createdUnix:number }[]} */
let bulletinReplies = [];

wss.on('connection', (ws) => {
    const player = {
        id: nextPlayerId++,
        name: `User_${(nextPlayerId - 1).toString().slice(-4)}`,
        roomId: "global",
        x: 0,
        y: 0,
        whoCanMessage: "everyone", // everyone | friends | nobody
        friendNames: []
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
                case "set_privacy":
                    handleSetPrivacy(player, data);
                    break;
                case "set_friends":
                    handleSetFriends(player, data);
                    break;
                case "dm_send":
                    handleDmSend(ws, player, data);
                    break;
                case "bulletin_list":
                    sendBulletinSnapshot(ws);
                    break;
                case "bulletin_post":
                    handleBulletinPost(ws, player, data);
                    break;
                case "bulletin_reply":
                    handleBulletinReply(ws, player, data);
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

function sendBulletinSnapshot(ws) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        type: "bulletin_snapshot",
        posts: bulletinPosts,
        replies: bulletinReplies
    }));
}

function broadcastBulletinSnapshot() {
    const msg = JSON.stringify({
        type: "bulletin_snapshot",
        posts: bulletinPosts,
        replies: bulletinReplies
    });
    clients.forEach(c => {
        if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
    });
}

function handleBulletinPost(ws, player, data) {
    const kind = (data.kind === "resume") ? "resume" : "vacancy";
    const title = (typeof data.title === "string" ? data.title : "").trim().slice(0, 80);
    const body = (typeof data.body === "string" ? data.body : "").trim().slice(0, 2000);
    const linkUrl = (typeof data.linkUrl === "string" ? data.linkUrl : "").trim().slice(0, 500);
    if (!title) {
        ws.send(JSON.stringify({ type: "bulletin_error", message: "Нужен заголовок" }));
        return;
    }
    const post = {
        id: "bp_" + (nextBulletinId++),
        kind,
        title,
        body,
        linkUrl,
        authorName: player.name,
        authorId: player.id,
        createdUnix: Math.floor(Date.now() / 1000)
    };
    bulletinPosts.unshift(post);
    if (bulletinPosts.length > 200) bulletinPosts.length = 200;
    console.log(`[bulletin] ${player.name} post ${post.kind}: ${post.title}`);
    broadcastBulletinSnapshot();
}

function handleBulletinReply(ws, player, data) {
    const postId = typeof data.postId === "string" ? data.postId : "";
    const text = (typeof data.text === "string" ? data.text : "").trim().slice(0, 500);
    if (!postId || !text) {
        ws.send(JSON.stringify({ type: "bulletin_error", message: "Пустой отклик" }));
        return;
    }
    const post = bulletinPosts.find(p => p.id === postId);
    if (!post) {
        ws.send(JSON.stringify({ type: "bulletin_error", message: "Объявление не найдено" }));
        return;
    }
    const reply = {
        id: "br_" + (nextReplyId++),
        postId,
        fromName: player.name,
        fromId: player.id,
        text,
        createdUnix: Math.floor(Date.now() / 1000)
    };
    bulletinReplies.push(reply);
    if (bulletinReplies.length > 500) bulletinReplies.splice(0, bulletinReplies.length - 500);

    broadcastBulletinSnapshot();

    const authorClient = clients.find(c => c.player.id === post.authorId);
    if (authorClient && authorClient.ws.readyState === WebSocket.OPEN) {
        authorClient.ws.send(JSON.stringify({
            type: "bulletin_reply_notify",
            postId,
            postTitle: post.title,
            fromName: player.name,
            fromId: player.id,
            text
        }));
        // Дублируем в чат автора (его текущая room), чтобы было видно в ленте.
        const roomId = authorClient.player.roomId || "global";
        const chatText = `[отклик] ${player.name} → «${post.title}»: ${text}`;
        clients.forEach(client => {
            if (client.player.roomId === roomId && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify({
                    type: "chat",
                    name: "Доска",
                    text: chatText,
                    roomId
                }));
            }
        });
    }
    console.log(`[bulletin] reply from ${player.name} on ${postId}`);
}

function handleSetPrivacy(player, data) {
    const raw = (typeof data.whoCanMessage === "string" ? data.whoCanMessage : "everyone").toLowerCase();
    if (raw === "friends" || raw === "nobody" || raw === "everyone") {
        player.whoCanMessage = raw;
    }
}

function handleSetFriends(player, data) {
    const names = Array.isArray(data.names) ? data.names : [];
    player.friendNames = names
        .filter(n => typeof n === "string" && n.trim())
        .map(n => n.trim().slice(0, 32))
        .slice(0, 200);
}

function findClientByIdOrName(toId, toName) {
    if (toId != null && toId !== "") {
        const idNum = parseInt(toId, 10);
        if (!Number.isNaN(idNum)) {
            const byId = clients.find(c => c.player.id === idNum);
            if (byId) return byId;
        }
    }
    if (typeof toName === "string" && toName.trim()) {
        const want = toName.trim().toLowerCase();
        return clients.find(c => (c.player.name || "").toLowerCase() === want) || null;
    }
    return null;
}

function isFriendOf(targetPlayer, senderName) {
    const want = (senderName || "").toLowerCase();
    return (targetPlayer.friendNames || []).some(n => (n || "").toLowerCase() === want);
}

function handleDmSend(ws, player, data) {
    const text = (typeof data.text === "string" ? data.text : "").trim().slice(0, 1000);
    if (!text) {
        ws.send(JSON.stringify({ type: "dm_error", message: "Пустое сообщение" }));
        return;
    }
    const target = findClientByIdOrName(data.toId, data.toName);
    if (!target) {
        ws.send(JSON.stringify({ type: "dm_error", message: "Игрок не в сети" }));
        return;
    }
    if (target.player.id === player.id) {
        ws.send(JSON.stringify({ type: "dm_error", message: "Нельзя писать себе" }));
        return;
    }

    const policy = target.player.whoCanMessage || "everyone";
    if (policy === "nobody") {
        ws.send(JSON.stringify({ type: "dm_error", message: "Личка закрыта" }));
        return;
    }
    if (policy === "friends" && !isFriendOf(target.player, player.name)) {
        ws.send(JSON.stringify({ type: "dm_error", message: "Писать могут только друзья" }));
        return;
    }

    const payload = {
        type: "dm_receive",
        fromId: player.id,
        fromName: player.name,
        toId: target.player.id,
        toName: target.player.name,
        text,
        createdUnix: Math.floor(Date.now() / 1000)
    };
    const msg = JSON.stringify(payload);
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    if (target.ws.readyState === WebSocket.OPEN) target.ws.send(msg);
    console.log(`[dm] ${player.name} → ${target.player.name}: ${text.slice(0, 40)}`);
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
