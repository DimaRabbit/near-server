'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    createEmptyBoard,
    packStrokePoints,
    unpackStrokePoints,
    applyWbSignal,
    buildOfficeSnapshot,
    playersUpdateFingerprint
} = require('../lib/officeBoard');

describe('stroke pack/unpack (UE wire)', () => {
    it('round-trips UV points', () => {
        const pts = [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.5 },
            { x: 1, y: 1 }
        ];
        const packed = packStrokePoints(pts);
        assert.equal(packed.length, 12);
        const back = unpackStrokePoints(packed);
        assert.equal(back.length, 3);
        assert.ok(Math.abs(back[0].x) < 0.02);
        assert.ok(Math.abs(back[1].x - 0.5) < 0.02);
        assert.ok(Math.abs(back[2].x - 1) < 0.02);
    });

    it('clamps and caps at 28 points', () => {
        const pts = Array.from({ length: 40 }, (_, i) => ({ x: i / 40, y: 0 }));
        const packed = packStrokePoints(pts);
        assert.equal(packed.length, 28 * 4);
        assert.equal(unpackStrokePoints(packed).length, 28);
    });
});

describe('wb signals', () => {
    it('adds note and stroke, clears by author', () => {
        const board = createEmptyBoard();
        const add = applyWbSignal(board, ['wb', 'add', 'n1', 'Alice', '2', 'hello']);
        assert.equal(add.ok, true);
        assert.equal(add.op, 'add');
        assert.equal(board.whiteboards.length, 1);
        assert.equal(board.whiteboards[0].text, 'hello');

        const packed = packStrokePoints([{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }]);
        assert.equal(applyWbSignal(board, ['wb', 'stroke', 'sk1', 'Alice', '1', packed]).ok, true);
        assert.equal(applyWbSignal(board, ['wb', 'stroke', 'sk2', 'Bob', '0', packed]).ok, true);
        assert.equal(board.whiteboardStrokes.length, 2);

        const clear = applyWbSignal(board, ['wb', 'strokeclear', 'Alice']);
        assert.equal(clear.ok, true);
        assert.equal(clear.op, 'strokeclear');
        assert.equal(board.whiteboardStrokes.length, 1);
        assert.equal(board.whiteboardStrokes[0].author, 'Bob');

        assert.equal(applyWbSignal(board, ['wb', 'del', 'n1']).ok, true);
        assert.equal(board.whiteboards.length, 0);
    });

    it('rejects too-short stroke packed data without adding', () => {
        const board = createEmptyBoard();
        const r = applyWbSignal(board, ['wb', 'stroke', 'sk', 'Me', '0', '12']);
        assert.equal(r.ok, true);
        assert.equal(r.skipped, true);
        assert.equal(board.whiteboardStrokes.length, 0);
    });

    it('caps strokes at 80', () => {
        const board = createEmptyBoard();
        const packed = packStrokePoints([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
        for (let i = 0; i < 85; i++) {
            applyWbSignal(board, ['wb', 'stroke', `sk${i}`, 'Me', '0', packed]);
        }
        assert.equal(board.whiteboardStrokes.length, 80);
        assert.equal(board.whiteboardStrokes[0].id, 'sk5');
    });
});

describe('office_snapshot shape', () => {
    it('nests notes and strokes under whiteboards', () => {
        const board = createEmptyBoard();
        applyWbSignal(board, ['wb', 'add', 'n1', 'Me', '0', 'note']);
        const packed = packStrokePoints([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
        applyWbSignal(board, ['wb', 'stroke', 'sk1', 'Me', '3', packed]);

        const snap = buildOfficeSnapshot('acme', 'room1', board);
        assert.equal(snap.type, 'office_snapshot');
        assert.ok(Array.isArray(snap.whiteboards.notes));
        assert.ok(Array.isArray(snap.whiteboards.strokes));
        assert.equal(snap.whiteboards.notes.length, 1);
        assert.equal(snap.whiteboards.strokes.length, 1);
        assert.equal(snap.whiteboards.strokes[0].color, 3);
        assert.match(snap.whiteboards.strokes[0].points, /^[0-9]+$/);
    });
});

describe('presence fingerprint (replication skip)', () => {
    it('stable when pose unchanged, changes on move', () => {
        const a = [
            { id: 1, x: 10, y: 20, yaw: 1.5, speed: 0, falling: false, skin: 'manny' }
        ];
        const b = [
            { id: 1, x: 10, y: 20, yaw: 1.5, speed: 0, falling: false, skin: 'manny' }
        ];
        const c = [
            { id: 1, x: 11, y: 20, yaw: 1.5, speed: 0, falling: false, skin: 'manny' }
        ];
        assert.equal(playersUpdateFingerprint(a), playersUpdateFingerprint(b));
        assert.notEqual(playersUpdateFingerprint(a), playersUpdateFingerprint(c));
    });
});
