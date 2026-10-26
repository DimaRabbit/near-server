'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18088;
const ROOT = path.join(__dirname, '..');

function getJson(urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: PORT, path: urlPath, timeout: 3000 }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

describe('server /health', () => {
    let child;
    before(async () => {
        child = spawn(process.execPath, ['server.js'], {
            cwd: ROOT,
            env: { ...process.env, PORT: String(PORT) },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        // Wait until listening
        for (let i = 0; i < 40; i++) {
            try {
                const r = await getJson('/health');
                if (r.status === 200) return;
            } catch (_) { /* retry */ }
            await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('server did not become ready');
    });
    after(() => {
        if (child && !child.killed) child.kill();
    });

    it('returns ok JSON with replication counters', async () => {
        const { status, body } = await getJson('/health');
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.service, 'near-server');
        assert.equal(typeof body.clients, 'number');
        assert.equal(typeof body.updateBroadcastsSent, 'number');
        assert.equal(typeof body.updateBroadcastsSkipped, 'number');
        assert.equal(body.tickMs, 150);
    });
});
