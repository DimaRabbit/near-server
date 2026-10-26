'use strict';

/** Pure office whiteboard helpers — used by server.js and unit tests. */

function createEmptyBoard() {
    return { cards: [], reports: [], whiteboards: [], whiteboardStrokes: [] };
}

function ensureBoardArrays(board) {
    if (!board.cards) board.cards = [];
    if (!board.reports) board.reports = [];
    if (!board.whiteboards) board.whiteboards = [];
    if (!board.whiteboardStrokes) board.whiteboardStrokes = [];
    return board;
}

/** Pack UV points like UE NearOfficeMeta::PackStrokePoints (max 28). */
function packStrokePoints(pts) {
    const n = Math.min((pts || []).length, 28);
    let out = '';
    for (let i = 0; i < n; i++) {
        const x = Math.max(0, Math.min(99, Math.round((pts[i].x ?? pts[i].X ?? 0) * 99)));
        const y = Math.max(0, Math.min(99, Math.round((pts[i].y ?? pts[i].Y ?? 0) * 99)));
        out += String(x).padStart(2, '0') + String(y).padStart(2, '0');
    }
    return out;
}

function unpackStrokePoints(packed) {
    const s = String(packed || '').replace(/[^0-9]/g, '');
    const pts = [];
    for (let i = 0; i + 3 < s.length && pts.length < 28; i += 4) {
        const x = parseInt(s.slice(i, i + 2), 10);
        const y = parseInt(s.slice(i + 2, i + 4), 10);
        pts.push({ x: x / 99, y: y / 99 });
    }
    return pts;
}

function sanitizeStrokePacked(raw) {
    return String(raw || '').replace(/[^0-9]/g, '').slice(0, 112);
}

/**
 * Apply __near payload parts (already split) for wb|… ops onto board.
 * @returns {{ ok:boolean, op?:string, note?:object, stroke?:object, id?:string, author?:string }}
 */
function applyWbSignal(board, parts) {
    ensureBoardArrays(board);
    if (!parts || parts.length < 2 || (parts[0] || '').toLowerCase() !== 'wb') {
        return { ok: false };
    }
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
        return { ok: true, op: 'add', note };
    }
    if (op === 'del' && parts.length >= 3) {
        const id = parts[2];
        board.whiteboards = board.whiteboards.filter(n => n.id !== id);
        return { ok: true, op: 'del', id };
    }
    if (op === 'stroke' && parts.length >= 6) {
        const packed = sanitizeStrokePacked(parts[5]);
        if (packed.length < 8) return { ok: true, op: 'stroke', skipped: true };
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
        return { ok: true, op: 'stroke', stroke };
    }
    if (op === 'strokeclear' && parts.length >= 3) {
        const author = parts[2] || '';
        const authorLc = author.toLowerCase();
        board.whiteboardStrokes = board.whiteboardStrokes.filter(
            s => (s.author || '').toLowerCase() !== authorLc);
        return { ok: true, op: 'strokeclear', author };
    }
    if (op === 'hello') return { ok: true, op: 'hello' };
    return { ok: false };
}

function buildOfficeSnapshot(officeKey, roomId, board) {
    ensureBoardArrays(board);
    return {
        type: 'office_snapshot',
        officeKey: officeKey || '',
        roomId: roomId || '',
        cards: board.cards,
        reports: board.reports,
        whiteboards: {
            notes: board.whiteboards,
            strokes: board.whiteboardStrokes
        }
    };
}

/** Fingerprint players for dirty-check broadcasts. */
function playersUpdateFingerprint(players) {
    let h = players.length + ':';
    for (const p of players) {
        h += `${p.id},${Math.round(p.x)}|${Math.round(p.y)}|${Math.round((p.yaw || 0) * 10)}|${Math.round(p.speed || 0)}|${p.falling ? 1 : 0}|${p.skin || ''};`;
    }
    return h;
}

module.exports = {
    createEmptyBoard,
    ensureBoardArrays,
    packStrokePoints,
    unpackStrokePoints,
    sanitizeStrokePacked,
    applyWbSignal,
    buildOfficeSnapshot,
    playersUpdateFingerprint
};
