'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 18089;
const ROOT = path.join(__dirname, '..');

function waitHealth() {
    return new Promise(async (resolve, reject) => {
        for (let i = 0; i < 40; i++) {
            try {
                await new Promise((res, rej) => {
                    http.get({ hostname: '127.0.0.1', port: PORT, path: '/health', timeout: 1000 }, (r) => {
                        r.resume();
                        if (r.statusCode === 200) res();
                        else rej(new Error('bad status'));
                    }).on('error', rej);
                });
                return resolve();
            } catch (_) { /* retry */ }
            await new Promise(r => setTimeout(r, 100));
        }
        reject(new Error('server not ready'));
    });
}

function connectWs() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const timer = setTimeout(() => reject(new Error('ws timeout')), 4000);
        ws.once('open', () => { clearTimeout(timer); resolve(ws); });
        ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

function onceJson(ws, type, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no ' + type)), timeoutMs);
        const onMsg = (raw) => {
            let data;
            try { data = JSON.parse(String(raw)); } catch { return; }
            if (data.type !== type) return;
            clearTimeout(timer);
            ws.off('message', onMsg);
            resolve(data);
        };
        ws.on('message', onMsg);
    });
}

describe('Places-as-Channels chat fanout', () => {
    let child;
    before(async () => {
        child = spawn(process.execPath, ['server.js'], {
            cwd: ROOT,
            env: { ...process.env, PORT: String(PORT) },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        await waitHealth();
    });
    after(() => {
        if (child && !child.killed) child.kill();
    });

    it('fans out chat with threadId + msgId in same room', async () => {
        const a = await connectWs();
        const b = await connectWs();
        a.send(JSON.stringify({ type: 'set_name', name: 'Alice' }));
        b.send(JSON.stringify({ type: 'set_name', name: 'Bob' }));
        await new Promise(r => setTimeout(r, 80));

        const waitChat = onceJson(b, 'chat');
        a.send(JSON.stringify({
            type: 'chat',
            text: 'card note',
            threadId: 'board:card1'
        }));
        const msg = await waitChat;
        assert.equal(msg.text, 'card note');
        assert.equal(msg.threadId, 'board:card1');
        assert.ok(typeof msg.msgId === 'string' && msg.msgId.length > 0);
        assert.equal(msg.name, 'Alice');
        a.close();
        b.close();
    });

    it('fans out react toasts in same room', async () => {
        const a = await connectWs();
        const b = await connectWs();
        a.send(JSON.stringify({ type: 'set_name', name: 'Alice' }));
        b.send(JSON.stringify({ type: 'set_name', name: 'Bob' }));
        await new Promise(r => setTimeout(r, 80));

        const waitReact = onceJson(b, 'react');
        a.send(JSON.stringify({ type: 'react', emoji: '+1', targetName: 'Bob' }));
        const msg = await waitReact;
        assert.equal(msg.emoji, '+1');
        assert.equal(msg.targetName, 'Bob');
        assert.equal(msg.name, 'Alice');
        a.close();
        b.close();
    });
});
