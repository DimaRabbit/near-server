const http = require('http');
const WebSocket = require('ws');
const {
    createEmptyBoard,
    ensureBoardArrays,
    applyWbSignal,
    buildOfficeSnapshot,
    playersUpdateFingerprint
} = require('./lib/officeBoard');

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_READY = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const serverStartedUnix = Math.floor(Date.now() / 1000);
let lastPlayersFingerprint = '';
let updateBroadcastsSkipped = 0;
let updateBroadcastsSent = 0;

const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/health' || url === '/ready') {
        let officeCount = 0;
        let noteCount = 0;
        let strokeCount = 0;
        for (const board of officeBoards.values()) {
            officeCount++;
            noteCount += (board.whiteboards || []).length;
            strokeCount += (board.whiteboardStrokes || []).length;
        }
        const body = JSON.stringify({
            ok: true,
            service: 'near-server',
            port: Number(PORT),
            uptimeSec: Math.floor(Date.now() / 1000) - serverStartedUnix,
            supabase: SUPABASE_READY,
            clients: clients.length,
            rooms: rooms.size,
            offices: officeCount,
            whiteboardNotes: noteCount,
            whiteboardStrokes: strokeCount,
            bulletinPosts: bulletinPosts.length,
            updateBroadcastsSent,
            updateBroadcastsSkipped,
            tickMs: 150
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
    }
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
        officeBoards.set(officeKey, createEmptyBoard());
    return ensureBoardArrays(officeBoards.get(officeKey));
}

function resolveOfficeKeyForPlayer(player) {
    const room = rooms.get(player.roomId);
    if (room && room.officeKey) return room.officeKey;
    return null;
}

async function hydrateOfficeBoardsFromSupabase() {
    if (!SUPABASE_READY) {
        console.log('[office] Supabase env missing — Kanban/whiteboard RAM only');
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
        const wbNotes = await sbFetch(
            'office_wb_notes?select=*&order=updated_unix.asc&limit=2000',
            { method: 'GET', headers: sbHeaders() }
        );
        const wbStrokes = await sbFetch(
            'office_wb_strokes?select=*&order=updated_unix.asc&limit=2000',
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
        if (Array.isArray(wbNotes)) {
            for (const row of wbNotes) {
                const key = row.office_key || 'default';
                const board = getOfficeBoard(key);
                board.whiteboards.push({
                    id: row.id,
                    author: row.author || '',
                    color: row.color || 0,
                    text: row.body || ''
                });
            }
        }
        if (Array.isArray(wbStrokes)) {
            for (const row of wbStrokes) {
                const key = row.office_key || 'default';
                const board = getOfficeBoard(key);
                board.whiteboardStrokes.push({
                    id: row.id,
                    author: row.author || '',
                    color: row.color || 0,
                    points: row.points || ''
                });
            }
        }
        let notes = 0;
        let strokes = 0;
        for (const b of officeBoards.values()) {
            notes += (b.whiteboards || []).length;
            strokes += (b.whiteboardStrokes || []).length;
        }
        console.log(`[office] hydrate: ${officeBoards.size} offices, wb notes=${notes} strokes=${strokes}`);
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

async function persistWbNote(officeKey, note) {
    if (!SUPABASE_READY || !note || !note.id) return;
    await sbFetch('office_wb_notes', {
        method: 'POST',
        headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({
            office_key: officeKey,
            id: note.id,
            author: note.author || '',
            color: note.color || 0,
            body: note.text || '',
            updated_unix: Math.floor(Date.now() / 1000)
        })
    });
}

async function deleteWbNote(officeKey, noteId) {
    if (!SUPABASE_READY || !noteId) return;
    const path = 'office_wb_notes?office_key=eq.' + encodeURIComponent(officeKey)
        + '&id=eq.' + encodeURIComponent(noteId);
    await sbFetch(path, { method: 'DELETE', headers: sbHeaders() });
}

async function persistWbStroke(officeKey, stroke) {
    if (!SUPABASE_READY || !stroke || !stroke.id) return;
    await sbFetch('office_wb_strokes', {
        method: 'POST',
        headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({
            office_key: officeKey,
            id: stroke.id,
            author: stroke.author || '',
            color: stroke.color || 0,
            points: stroke.points || '',
            updated_unix: Math.floor(Date.now() / 1000)
        })
    });
}

async function deleteWbStrokesByAuthor(officeKey, author) {
    if (!SUPABASE_READY || !author) return;
    const path = 'office_wb_strokes?office_key=eq.' + encodeURIComponent(officeKey)
        + '&author=eq.' + encodeURIComponent(author);
    await sbFetch(path, { method: 'DELETE', headers: sbHeaders() });
}

function sendOfficeSnapshot(ws, officeKey, roomId) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !officeKey) return;
    const board = getOfficeBoard(officeKey);
    ws.send(JSON.stringify(buildOfficeSnapshot(officeKey, roomId, board)));
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
        const op = (parts[1] || '').toLowerCase();
        if (op === 'hello') {
            sendOfficeSnapshot(player._ws || null, officeKey, player.roomId);
            return true;
        }
        const result = applyWbSignal(board, parts);
        if (!result.ok) return false;
        if (result.op === 'add' && result.note) {
            persistWbNote(officeKey, result.note).catch(e =>
                console.error('[office] persist wb note:', e.message || e));
        } else if (result.op === 'del' && result.id) {
            deleteWbNote(officeKey, result.id).catch(e =>
                console.error('[office] delete wb note:', e.message || e));
        } else if (result.op === 'stroke' && result.stroke) {
            persistWbStroke(officeKey, result.stroke).catch(e =>
                console.error('[office] persist wb stroke:', e.message || e));
        } else if (result.op === 'strokeclear' && result.author) {
            deleteWbStrokesByAuthor(officeKey, result.author).catch(e =>
                console.error('[office] delete wb strokes:', e.message || e));
        }
        return true;
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
                case "react":        handleReact(ws, player, data); break;
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

    const threadId = typeof data.threadId === 'string' ? data.threadId.slice(0, 96) : '';
    const msgId = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const msg = {
        type: "chat",
        name: player.name,
        text: text,
        roomId: roomId,
        msgId,
        threadId
    };
    clients.forEach(client => {
        if (client.player.roomId === roomId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(msg));
        }
    });
}

/** Places-as-Channels: emoji toast fan-out (same room only). */
function handleReact(ws, player, data) {
    const roomId = player.roomId || "global";
    const emoji = typeof data.emoji === 'string' ? data.emoji.slice(0, 8) : '+1';
    const targetName = typeof data.targetName === 'string' ? data.targetName.slice(0, 32) : '';
    const msg = JSON.stringify({
        type: "react",
        name: player.name,
        emoji,
        targetName,
        roomId
    });
    clients.forEach(client => {
        if (client.player.roomId === roomId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(msg);
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
        ws.send(JSON.stringify({ type: "dm_error", message: "Empty message" }));
        return;
    }
    const target = findClientByIdOrName(data.toId, data.toName);
    if (!target) {
        ws.send(JSON.stringify({ type: "dm_error", message: "Player is offline" }));
        return;
    }
    if (target.player.id === player.id) {
        ws.send(JSON.stringify({ type: "dm_error", message: "Cannot message yourself" }));
        return;
    }

    const policy = target.player.whoCanMessage || "everyone";
    if (policy === "nobody") {
        ws.send(JSON.stringify({ type: "dm_error", message: "DMs closed" }));
        return;
    }
    if (policy === "friends" && !isFriendOf(target.player, player.name)) {
        ws.send(JSON.stringify({ type: "dm_error", message: "Friends only" }));
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

function broadcastPlayersUpdate(force) {
    const playersData = clients.map(c => ({
        id: c.player.id,
        name: c.player.name,
        roomId: c.player.roomId || 'global',
        x: c.player.x || 0,
        y: c.player.y || 0,
        speed: typeof c.player.speed === "number" ? c.player.speed : 0,
        yaw: typeof c.player.yaw === "number" ? c.player.yaw : 0,
        falling: !!c.player.falling,
        skin: typeof c.player.skin === "string" && c.player.skin ? c.player.skin : "manny"
    }));
    const fp = playersUpdateFingerprint(playersData);
    if (!force && fp === lastPlayersFingerprint) {
        updateBroadcastsSkipped++;
        return;
    }
    lastPlayersFingerprint = fp;
    updateBroadcastsSent++;

    // Room-scoped fanout: each client gets global+own room peers (city/office split).
    const byRoom = new Map();
    for (const p of playersData) {
        const rid = p.roomId || 'global';
        if (!byRoom.has(rid)) byRoom.set(rid, []);
        byRoom.get(rid).push(p);
    }

    clients.forEach(client => {
        if (client.ws.readyState !== WebSocket.OPEN) return;
        const rid = client.player.roomId || 'global';
        // Always include global players when in office so city presence stays visible optionally —
        // for bandwidth: only same room.
        const list = byRoom.get(rid) || [];
        client.ws.send(JSON.stringify({ type: 'update', players: list }));
    });
}

setInterval(() => broadcastPlayersUpdate(false), 150);

Promise.all([
    hydrateBulletinFromSupabase(),
    hydrateOfficeBoardsFromSupabase()
]).finally(() => {
    server.listen(PORT, () => {
        console.log(`NEAR Server on :${PORT}` +
            (SUPABASE_READY ? ' (bulletin+office+wb→Supabase)' : ' (RAM only)') +
            ' | GET /health');
    });
});
