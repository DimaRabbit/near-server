const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_READY = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

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

// ====================== SUPABASE ======================

function sbHeaders(extra) {
    return Object.assign({
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json'
    }, extra || {});
}

async function sbFetch(path, options) {
    if (!SUPABASE_READY) return null;
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, options);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Supabase ${res.status}: ${body.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
}

function rowToPost(row) {
    return {
        id: row.id,
        kind: row.kind,
        title: row.title || '',
        body: row.body || '',
        linkUrl: row.link_url || '',
        authorName: row.author_name || '',
        authorId: row.author_session_id || 0,
        createdUnix: Number(row.created_unix) || 0
    };
}

function rowToReply(row) {
    return {
        id: row.id,
        postId: row.post_id,
        fromName: row.from_name || '',
        fromId: row.from_session_id || 0,
        text: row.text || '',
        createdUnix: Number(row.created_unix) || 0
    };
}

function bumpIdsFromLoaded() {
    let maxBp = 0;
    let maxBr = 0;
    for (const p of bulletinPosts) {
        const m = /^bp_(\d+)$/.exec(p.id);
        if (m) maxBp = Math.max(maxBp, parseInt(m[1], 10));
    }
    for (const r of bulletinReplies) {
        const m = /^br_(\d+)$/.exec(r.id);
        if (m) maxBr = Math.max(maxBr, parseInt(m[1], 10));
    }
    nextBulletinId = Math.max(nextBulletinId, maxBp + 1);
    nextReplyId = Math.max(nextReplyId, maxBr + 1);
}

async function hydrateBulletinFromSupabase() {
    if (!SUPABASE_READY) {
        console.log('[bulletin] Supabase env не задан — только RAM');
        return;
    }
    try {
        const posts = await sbFetch(
            'bulletin_posts?select=*&order=created_unix.desc&limit=200',
            { method: 'GET', headers: sbHeaders() }
        );
        const replies = await sbFetch(
            'bulletin_replies?select=*&order=created_unix.asc&limit=500',
            { method: 'GET', headers: sbHeaders() }
        );
        bulletinPosts = Array.isArray(posts) ? posts.map(rowToPost) : [];
        bulletinReplies = Array.isArray(replies) ? replies.map(rowToReply) : [];
        bumpIdsFromLoaded();
        console.log(`[bulletin] hydrate: ${bulletinPosts.length} posts, ${bulletinReplies.length} replies`);
    } catch (e) {
        console.error('[bulletin] hydrate failed:', e.message || e);
    }
}

async function persistBulletinPost(post) {
    if (!SUPABASE_READY) return;
    await sbFetch('bulletin_posts', {
        method: 'POST',
        headers: sbHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({
            id: post.id,
            kind: post.kind,
            title: post.title,
            body: post.body,
            link_url: post.linkUrl,
            author_name: post.authorName,
            author_session_id: post.authorId,
            author_user_id: null,
            created_unix: post.createdUnix
        })
    });
}

async function persistBulletinReply(reply) {
    if (!SUPABASE_READY) return;
    await sbFetch('bulletin_replies', {
        method: 'POST',
        headers: sbHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({
            id: reply.id,
            post_id: reply.postId,
            from_name: reply.fromName,
            from_session_id: reply.fromId,
            from_user_id: null,
            text: reply.text,
            created_unix: reply.createdUnix
        })
    });
}

function normalizeLinkUrl(raw) {
    let url = (typeof raw === 'string' ? raw : '').trim().slice(0, 500);
    if (!url) return '';
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url))
        url = 'https://' + url;
    return url;
}

function parseBulletinKind(raw) {
    const k = (typeof raw === 'string' ? raw : '').toLowerCase().trim();
    if (k === 'resume') return 'resume';
    if (k === 'portfolio') return 'portfolio';
    return 'vacancy';
}

// ====================== OFFICE BOARD ======================
/** @type {Map<string, { cards: object[], reports: object[] }>} */
const officeBoards = new Map();

function officeKeyFromRoomName(name) {
    const display = String(name || '').split('~')[0].trim().toLowerCase().slice(0, 64);
    return display || 'default';
}

function getOfficeBoard(officeKey) {
    if (!officeBoards.has(officeKey))
        officeBoards.set(officeKey, { cards: [], reports: [], whiteboards: [], whiteboardStrokes: [] });
    const board = officeBoards.get(officeKey);
    if (!board.whiteboards) board.whiteboards = [];
    if (!board.whiteboardStrokes) board.whiteboardStrokes = [];
    return board;
}

function resolveOfficeKeyForPlayer(player) {
    const room = rooms.get(player.roomId);
    if (room && room.officeKey) return room.officeKey;
    return null;
}

async function hydrateOfficeBoardsFromSupabase() {
    if (!SUPABASE_READY) {
        console.log('[office] Supabase env не задан — Kanban только RAM');
        return;
    }
    try {
        const cards = await sbFetch(
            'office_board_cards?select=*&order=updated_unix.asc&limit=2000',
            { method: 'GET', headers: sbHeaders() }
        );
        const reports = await sbFetch(
            'office_day_reports?select=*&order=updated_unix.asc&limit=2000',
            { method: 'GET', headers: sbHeaders() }
        );
        officeBoards.clear();
        if (Array.isArray(cards)) {
            for (const row of cards) {
                const key = row.office_key || 'default';
                const board = getOfficeBoard(key);
                board.cards.push({
                    id: row.id,
                    column: row.column_id || 'todo',
                    author: row.author || '',
                    dueDate: row.due_date || '',
                    text: row.body || ''
                });
            }
        }
        if (Array.isArray(reports)) {
            for (const row of reports) {
                const key = row.office_key || 'default';
                const board = getOfficeBoard(key);
                board.reports.push({
                    author: row.author || '',
                    dateYmd: row.date_ymd || '',
                    text: row.body || ''
                });
            }
        }
        console.log(`[office] hydrate: ${officeBoards.size} offices`);
    } catch (e) {
        console.error('[office] hydrate failed:', e.message || e);
    }
}

async function persistOfficeCard(officeKey, card) {
    if (!SUPABASE_READY) return;
    await sbFetch('office_board_cards', {
        method: 'POST',
        headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({
            office_key: officeKey,
            id: card.id,
            column_id: card.column,
            author: card.author,
            due_date: card.dueDate || '',
            body: card.text || '',
            updated_unix: Math.floor(Date.now() / 1000)
        })
    });
}

async function deleteOfficeCard(officeKey, cardId) {
    if (!SUPABASE_READY) return;
    const path = 'office_board_cards?office_key=eq.' + encodeURIComponent(officeKey)
        + '&id=eq.' + encodeURIComponent(cardId);
    await sbFetch(path, { method: 'DELETE', headers: sbHeaders() });
}

async function persistOfficeReport(officeKey, rep) {
    if (!SUPABASE_READY) return;
    await sbFetch('office_day_reports', {
        method: 'POST',
        headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({
            office_key: officeKey,
            author: rep.author,
            date_ymd: rep.dateYmd,
            body: rep.text || '',
            updated_unix: Math.floor(Date.now() / 1000)
        })
    });
}

function sendOfficeSnapshot(ws, officeKey, roomId) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !officeKey) return;
    const board = getOfficeBoard(officeKey);
    ws.send(JSON.stringify({
        type: 'office_snapshot',
        officeKey,
        roomId: roomId || '',
        cards: board.cards,
        reports: board.reports,
        whiteboards: {
            notes: board.whiteboards || [],
            strokes: board.whiteboardStrokes || []
        }
    }));
}

function applyOfficeSignal(player, text) {
    if (typeof text !== 'string' || !text.startsWith('__near|')) return false;
    const officeKey = resolveOfficeKeyForPlayer(player);
    if (!officeKey) return false;

    const payload = text.slice('__near|'.length);
    const parts = payload.split('|');
    if (parts.length < 2) return false;
    const board = getOfficeBoard(officeKey);
    const now = Math.floor(Date.now() / 1000);

    if (parts[0] === 'board') {
        const op = (parts[1] || '').toLowerCase();
        if ((op === 'add' || op === 'edit') && parts.length >= 7) {
            const id = parts[2];
            const column = ['todo', 'doing', 'done'].includes((parts[3] || '').toLowerCase())
                ? parts[3].toLowerCase() : 'todo';
            const author = parts[4] || '';
            let dueDate = '';
            let textIdx = 5;
            const maybeDue = parts[5] || '';
            if (maybeDue === '-' || /^\d{4}-\d{2}-\d{2}$/.test(maybeDue)) {
                dueDate = maybeDue === '-' ? '' : maybeDue;
                textIdx = 6;
            }
            const cardText = parts.slice(textIdx).join('|').slice(0, 180);
            const card = { id, column, author, dueDate, text: cardText };
            const idx = board.cards.findIndex(c => c.id === id);
            if (idx >= 0) board.cards[idx] = card;
            else board.cards.push(card);
            if (board.cards.length > 200) board.cards = board.cards.slice(-200);
            persistOfficeCard(officeKey, card).catch(e =>
                console.error('[office] persist card:', e.message || e));
            return true;
        }
        if (op === 'move' && parts.length >= 4) {
            const id = parts[2];
            const column = ['todo', 'doing', 'done'].includes((parts[3] || '').toLowerCase())
                ? parts[3].toLowerCase() : 'todo';
            const card = board.cards.find(c => c.id === id);
            if (card) {
                card.column = column;
                persistOfficeCard(officeKey, card).catch(e =>
                    console.error('[office] persist move:', e.message || e));
            }
            return true;
        }
        if (op === 'del' && parts.length >= 3) {
            const id = parts[2];
            board.cards = board.cards.filter(c => c.id !== id);
            deleteOfficeCard(officeKey, id).catch(e =>
                console.error('[office] delete card:', e.message || e));
            return true;
        }
        if (op === 'hello') {
            sendOfficeSnapshot(player._ws || null, officeKey, player.roomId);
            return true;
        }
    }

    if (parts[0] === 'report') {
        const op = (parts[1] || '').toLowerCase();
        if (op === 'set' && parts.length >= 5) {
            const dateYmd = parts[2] || '';
            const author = parts[3] || '';
            const repText = parts.slice(4).join('|').slice(0, 180);
            const rep = { author, dateYmd, text: repText };
            const idx = board.reports.findIndex(r =>
                r.dateYmd === dateYmd && (r.author || '').toLowerCase() === author.toLowerCase());
            if (idx >= 0) board.reports[idx] = rep;
            else board.reports.push(rep);
            if (board.reports.length > 500) board.reports = board.reports.slice(-500);
            persistOfficeReport(officeKey, rep).catch(e =>
                console.error('[office] persist report:', e.message || e));
            return true;
        }
        if (op === 'hello') {
            sendOfficeSnapshot(player._ws || null, officeKey, player.roomId);
            return true;
        }
    }

    if (parts[0] === 'wb') {
        if (!board.whiteboards) board.whiteboards = [];
        if (!board.whiteboardStrokes) board.whiteboardStrokes = [];
        const op = (parts[1] || '').toLowerCase();
        if (op === 'add' && parts.length >= 6) {
            const note = {
                id: parts[2],
                author: parts[3] || '',
                color: parseInt(parts[4], 10) || 0,
                text: parts.slice(5).join('|').slice(0, 180)
            };
            const idx = board.whiteboards.findIndex(n => n.id === note.id);
            if (idx >= 0) board.whiteboards[idx] = note;
            else board.whiteboards.push(note);
            if (board.whiteboards.length > 100) board.whiteboards = board.whiteboards.slice(-100);
            return true;
        }
        if (op === 'del' && parts.length >= 3) {
            const id = parts[2];
            board.whiteboards = board.whiteboards.filter(n => n.id !== id);
            return true;
        }
        if (op === 'stroke' && parts.length >= 6) {
            const packed = String(parts[5] || '').replace(/[^0-9]/g, '').slice(0, 112);
            if (packed.length < 8) return true;
            const stroke = {
                id: parts[2],
                author: parts[3] || '',
                color: Math.max(0, Math.min(5, parseInt(parts[4], 10) || 0)),
                points: packed
            };
            const idx = board.whiteboardStrokes.findIndex(s => s.id === stroke.id);
            if (idx >= 0) board.whiteboardStrokes[idx] = stroke;
            else board.whiteboardStrokes.push(stroke);
            if (board.whiteboardStrokes.length > 80)
                board.whiteboardStrokes = board.whiteboardStrokes.slice(-80);
            return true;
        }
        if (op === 'strokeclear' && parts.length >= 3) {
            const author = (parts[2] || '').toLowerCase();
            board.whiteboardStrokes = board.whiteboardStrokes.filter(
                s => (s.author || '').toLowerCase() !== author);
            return true;
        }
        if (op === 'hello') {
            sendOfficeSnapshot(player._ws || null, officeKey, player.roomId);
            return true;
        }
    }
    return false;
}

// ====================== WS ======================

wss.on('connection', (ws) => {
    const player = {
        id: nextPlayerId++,
        name: `User_${(nextPlayerId - 1).toString().slice(-4)}`,
        roomId: "global",
        x: 0,
        y: 0,
        speed: 0,
        yaw: 0,
        falling: false,
        skin: "manny",
        whoCanMessage: "everyone", // everyone | friends | nobody
        friendNames: []
    };

    player._ws = ws;
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
                    player.x = typeof data.x === "number" ? data.x : (data.x || 0);
                    player.y = typeof data.y === "number" ? data.y : (data.y || 0);
                    if (typeof data.speed === "number" && Number.isFinite(data.speed))
                        player.speed = Math.max(0, Math.min(1200, data.speed));
                    if (typeof data.yaw === "number" && Number.isFinite(data.yaw))
                        player.yaw = data.yaw;
                    if (typeof data.falling === "boolean")
                        player.falling = data.falling;
                    break;
                case "set_name":
                    if (typeof data.name === "string" && data.name.trim()) {
                        player.name = data.name.trim().slice(0, 32);
                        broadcastPlayersUpdate();
                    }
                    break;
                case "set_skin":
                    if (typeof data.skin === "string" && data.skin.trim()) {
                        player.skin = data.skin.trim().slice(0, 48).toLowerCase();
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
    const roomName = data.name || "Private Room";
    const officeKey = officeKeyFromRoomName(roomName);
    rooms.set(roomId, {
        name: roomName,
        creatorId: player.id,
        members: [player.id],
        officeKey
    });
    player.roomId = roomId;
    getOfficeBoard(officeKey); // ensure RAM entry
    ws.send(JSON.stringify({ type: "room_created", roomId: roomId, name: roomName }));
    sendOfficeSnapshot(ws, officeKey, roomId);
    console.log(`[${player.name}] создал комнату ${roomId} (office=${officeKey})`);
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
            if (room.officeKey)
                sendOfficeSnapshot(targetClient.ws, room.officeKey, data.roomId);
        }
    }
}

function handleChat(ws, player, data) {
    const roomId = player.roomId || "global";
    const text = typeof data.text === 'string' ? data.text : '';
    // Kanban / day report: обновить server+Supabase до fan-out (hello → snapshot).
    if (text.startsWith('__near|'))
        applyOfficeSignal(player, text);

    const msg = { type: "chat", name: player.name, text: text, roomId: roomId };
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
    const kind = parseBulletinKind(data.kind);
    const title = (typeof data.title === "string" ? data.title : "").trim().slice(0, 80);
    const body = (typeof data.body === "string" ? data.body : "").trim().slice(0, 2000);
    const linkUrl = normalizeLinkUrl(data.linkUrl);
    if (!title) {
        ws.send(JSON.stringify({ type: "bulletin_error", message: "Нужен заголовок" }));
        return;
    }
    if (kind === "portfolio" && !linkUrl) {
        ws.send(JSON.stringify({ type: "bulletin_error", message: "Для портфолио нужна ссылка" }));
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

    persistBulletinPost(post).catch(e => {
        console.error('[bulletin] persist post failed:', e.message || e);
    });
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

    persistBulletinReply(reply).catch(e => {
        console.error('[bulletin] persist reply failed:', e.message || e);
    });

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
    const playersData = clients.map(c => ({
        id: c.player.id,
        name: c.player.name,
        x: c.player.x || 0,
        y: c.player.y || 0,
        speed: typeof c.player.speed === "number" ? c.player.speed : 0,
        yaw: typeof c.player.yaw === "number" ? c.player.yaw : 0,
        falling: !!c.player.falling,
        skin: typeof c.player.skin === "string" && c.player.skin ? c.player.skin : "manny"
    }));
    const msg = JSON.stringify({ type: "update", players: playersData });
    clients.forEach(client => {
        if (client.ws.readyState === WebSocket.OPEN) client.ws.send(msg);
    });
}

setInterval(broadcastPlayersUpdate, 150);

Promise.all([
    hydrateBulletinFromSupabase(),
    hydrateOfficeBoardsFromSupabase()
]).finally(() => {
    server.listen(PORT, () => {
        console.log(`NEAR Server запущен на порту ${PORT}` +
            (SUPABASE_READY ? ' (bulletin+office→Supabase)' : ' (RAM only)'));
    });
});
