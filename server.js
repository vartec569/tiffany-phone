// Tiffany Phone v2 — custom Antigravity remote control (Option A: Minimal UI)
// Davin-approved final build. Plain HTTP :3001. Real CDP backend only — no fake replies.
const http = require('http');
const crypto = require('crypto');
const { WebSocket, WebSocketServer } = require('ws');

// Never die on a stray async error — log it and keep serving.
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e && e.message); });
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e && e.message); });

// ============ CONFIG (secrets ONLY from env — never hardcode, never log) ============
const PORT = process.env.PORT || 3001;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const TIFFANY_TOKEN = process.env.TIFFANY_TOKEN || ''; // separate from APP_PASSWORD; empty = Tiffany API disabled
const CDP_PORT = 9000;
// =====================================================================================

if (!APP_PASSWORD) {
    console.error('ERROR: Set APP_PASSWORD env var first!');
    process.exit(1);
}

// ============ CDP CLIENT ============
let cdpWs = null;
let cdpId = 1;
const cdpPending = new Map();
let cdpContexts = [];

function cdpCall(method, params = {}) {
    return new Promise((resolve, reject) => {
        if (!cdpWs || cdpWs.readyState !== 1) return reject(new Error('CDP not connected'));
        const id = cdpId++;
        const timer = setTimeout(() => { cdpPending.delete(id); reject(new Error('CDP timeout')); }, 15000);
        cdpPending.set(id, { resolve, reject, timer });
        cdpWs.send(JSON.stringify({ id, method, params }));
    });
}

async function cdpEval(js) {
    // Try all execution contexts, return first success
    for (const ctx of cdpContexts) {
        try {
            const res = await cdpCall('Runtime.evaluate', {
                expression: js, returnByValue: true, awaitPromise: true, contextId: ctx.id
            });
            if (res.result && res.result.value !== undefined) return res.result.value;
            if (res.result && res.result.type !== 'undefined') return res.result.value;
        } catch (e) { /* try next context */ }
    }
    throw new Error('CDP eval failed in all contexts');
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

async function connectCDP() {
    const list = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const workbench = list.find(t => (t.url && t.url.includes('workbench.html')) || (t.title && t.title.includes('workbench')));
    if (!workbench || !workbench.webSocketDebuggerUrl) throw new Error('Workbench target not found. Is Antigravity running with --remote-debugging-port=9000?');

    console.log('CDP target:', workbench.title);
    cdpWs = new WebSocket(workbench.webSocketDebuggerUrl);

    await new Promise((res, rej) => {
        cdpWs.on('open', res);
        cdpWs.on('error', rej);
    });

    cdpWs.on('message', msg => {
        try {
            const data = JSON.parse(msg);
            if (data.id !== undefined && cdpPending.has(data.id)) {
                const { resolve, reject, timer } = cdpPending.get(data.id);
                clearTimeout(timer); cdpPending.delete(data.id);
                if (data.error) reject(new Error(JSON.stringify(data.error)));
                else resolve(data.result);
            }
            if (data.method === 'Runtime.executionContextCreated') cdpContexts.push(data.params.context);
            if (data.method === 'Runtime.executionContextDestroyed') {
                cdpContexts = cdpContexts.filter(c => c.id !== data.params.executionContextId);
            }
        } catch (e) {}
    });

    cdpWs.on('close', () => { console.log('CDP disconnected, retrying in 3s...'); cdpWs = null; cdpContexts = []; setTimeout(connectCDP, 3000); });

    await cdpCall('Runtime.enable');
    console.log('CDP connected!');
}

function cdpConnected() { return !!(cdpWs && cdpWs.readyState === 1); }

// ============ CHAT OPERATIONS ============

// Read messages as structured data with best-effort role detection.
// NOTE: role heuristic is tuned blind — verify against Davin's real DOM on first live test.
async function getMessages() {
    const js = `(() => {
        const container = document.getElementById('conversation');
        if (!container) return { error: 'no conversation element' };
        function detectRole(el) {
            let node = el, su = 0, sa = 0;
            for (let d = 0; d < 6 && node; d++) {
                const cn = (node.className && typeof node.className === 'string') ? node.className.toLowerCase() : '';
                if (/(^|[^a-z])(user|human|sender)([^a-z]|$)/.test(cn)) su += 2;
                if (/(^|[^a-z])(assistant|agent|model|bot)([^a-z]|$)/.test(cn)) sa += 2;
                const dr = node.getAttribute ? (node.getAttribute('data-role') || '') : '';
                if (/user/i.test(dr)) su += 3;
                if (/assistant|model/i.test(dr)) sa += 3;
                node = node.parentElement;
            }
            try {
                const p = el.parentElement;
                if (p) { const pcs = getComputedStyle(p); if (pcs.justifyContent === 'flex-end' || pcs.alignItems === 'flex-end') su += 1; }
                if (getComputedStyle(el).marginLeft === 'auto') su += 1;
            } catch (e) {}
            return su > sa ? 'user' : 'ai';
        }
        function isStatus(t) {
            // Agent working status: show separately (not in bubble, not hidden)
            var sl = t.trim().toLowerCase();
            var NL = String.fromCharCode(10);
            function startsWord(s, w) {
                if (s.indexOf(w) !== 0) return false;
                var c = s.charAt(w.length);
                return c === '' || c === ' ' || c === NL || c === String.fromCharCode(9);
            }
            if (startsWord(sl, 'analyzed')) return true;
            if (startsWord(sl, 'searched')) return true;
            if (startsWord(sl, 'thought for')) return true;
            if (startsWord(sl, 'exploring')) return true;
            if (startsWord(sl, 'working')) return true;
            if (startsWord(sl, 'thinking')) return true;
            if (sl === 'mcp error') return true;
            if (sl.indexOf('mcp tool:') === 0) return true;
            if (sl.indexOf('tool arguments') !== -1) return true;
            var hl2 = sl.indexOf('#l');
            if (hl2 >= 0 && sl.indexOf(' ') === -1) {
                if (hl2 === 0) return true;
                var fp2 = sl.slice(0, hl2);
                var lp2 = sl.slice(hl2 + 2);
                if (fp2.indexOf('.') > 0 && lp2.length > 0) {
                    var ok2 = true;
                    for (var qi = 0; qi < lp2.length; qi++) {
                        var qc = lp2.charAt(qi);
                        if (qc !== '-' && (qc < '0' || qc > '9')) { ok2 = false; break; }
                    }
                    if (ok2) return true;
                }
            }
            var hasSearched = sl.indexOf('searched') !== -1;
            var hasAnalyzed = sl.indexOf('analyzed') !== -1;
            var hasThought = sl.indexOf('thought for') !== -1;
            var hasExploring = sl.indexOf('exploring ') !== -1;
            var activityCount = (hasSearched ? 1 : 0) + (hasAnalyzed ? 1 : 0) + (hasThought ? 1 : 0) + (hasExploring ? 1 : 0);
            if (activityCount >= 2) return true;
            return false;
        }
        function isChrome(t) {
            // UI chrome: hide completely
            var sl = t.trim().toLowerCase();
            if (sl.indexOf('review changes') !== -1) return true;
            if (sl.indexOf('files with changes') !== -1) return true;
            if (sl.indexOf('queued messages') !== -1) return true;
            if (sl.indexOf('ask anything, @ to mention') !== -1) return true;
            if (sl.indexOf('sends after agent finishes working') !== -1) return true;
            if (sl.indexOf('allow using this mcp tool') !== -1) return true;
            if (sl.indexOf('gemini ') === 0 && sl.length < 60) return true;
            if (sl.indexOf('claude ') === 0 && sl.length < 60) return true;
            if (sl.indexOf('worked for ') === 0) return true;
            return false;
        }
        function cleanText(t) {
            // Strip Antigravity's inline timestamps like "9:58 PM" and "Worked for 2m"
            var NL = String.fromCharCode(10);
            var lines = t.split(NL);
            var out = [];
            for (var i = 0; i < lines.length; i++) {
                var ln = lines[i].trim();
                var ll = ln.toLowerCase();
                // skip "9:58 PM" style timestamps: [digits]:[digits] am/pm
                var isTime = false;
                if (ll.length >= 7 && ll.length <= 8) {
                    var ap = ll.slice(-2);
                    if (ap === 'am' || ap === 'pm') {
                        var hm = ll.slice(0, -2).trim().split(':');
                        if (hm.length === 2) {
                            var hOk = true, mOk = true;
                            for (var hi = 0; hi < hm[0].length; hi++) { var hc = hm[0].charAt(hi); if (hc < '0' || hc > '9') hOk = false; }
                            for (var mi = 0; mi < hm[1].length; mi++) { var mc = hm[1].charAt(mi); if (mc < '0' || mc > '9') mOk = false; }
                            if (hOk && mOk && hm[0].length > 0 && hm[1].length === 2) isTime = true;
                        }
                    }
                }
                if (isTime) continue;
                // skip "Worked for 2m"
                if (ll.indexOf('worked for ') === 0) continue;
                out.push(lines[i]);
            }
            return out.join(NL).trim();
        }
        const messages = [];
        const statusItems = [];
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
        const seen = new Set();
        let el;
        while (el = walker.nextNode()) {
            if (el.querySelector && el.querySelector('[contenteditable="true"]')) continue;
            if (el.hasAttribute && el.hasAttribute('contenteditable')) continue;
            var rawText = (el.innerText || '').trim();
            var text = cleanText(rawText);
            if (text.length > 10 && text.length < 5000 && el.children.length <= 3) {
                if (isChrome(text)) continue;
                let p = el.parentElement, dup = false;
                while (p && p !== container) { if (seen.has(p)) { dup = true; break; } p = p.parentElement; }
                if (!dup) {
                    seen.add(el);
                    // Split merged user+AI: short first line + long rest
                    var NL2 = String.fromCharCode(10);
                    var parts = text.split(NL2 + NL2);
                    if (parts.length >= 2) {
                        var first = parts[0].trim();
                        var rest = parts.slice(1).join(NL2 + NL2).trim();
                        if (first.length > 0 && first.length < 80 && rest.length > 100 && first.indexOf(' ') !== -1) {
                            // likely user message + AI answer merged
                            if (!isChrome(first) && !isStatus(first)) {
                                messages.push({ role: 'user', text: first.substring(0, 2000) });
                            }
                            if (!isChrome(rest) && !isStatus(rest)) {
                                messages.push({ role: 'ai', text: rest.substring(0, 2000) });
                            } else if (isStatus(rest)) {
                                statusItems.push({ role: 'ai', text: rest.substring(0, 2000) });
                            }
                            continue;
                        }
                    }
                    var item = { role: detectRole(el), text: text.substring(0, 2000) };
                    if (isStatus(text)) statusItems.push(item);
                    else messages.push(item);
                }
            }
            if (messages.length > 100) break;
        }
        return { messages: messages.slice(-50), status: statusItems.slice(-30) };
    })()`;
    return await cdpEval(js);
}

// Debug: dump DOM structure of the conversation (to understand Antigravity's layout)
async function getDomStructure() {
    const js = `(() => {
        const container = document.getElementById('conversation');
        if (!container) return { error: 'no conversation element' };
        // Find the message list: #conversation .mx-auto.w-full > div
        const listDiv = container.querySelector('.mx-auto.w-full > div');
        if (!listDiv) return { error: 'message list not found' };
        function nodeInfo(el, depth, maxDepth) {
            if (depth > maxDepth) return null;
            const info = {
                tag: el.tagName ? el.tagName.toLowerCase() : '?',
                cls: (el.className && typeof el.className === 'string') ? el.className.split(' ').slice(0, 4).join(' ') : '',
                textLen: (el.innerText || '').length,
                textStart: (el.innerText || '').substring(0, 80).replace(/\\n/g, ' | '),
                childCount: el.children ? el.children.length : 0
            };
            if (depth < maxDepth && el.children && el.children.length > 0) {
                info.children = [];
                const max = Math.min(el.children.length, 6);
                for (let i = 0; i < max; i++) {
                    const c = nodeInfo(el.children[i], depth + 1, maxDepth);
                    if (c) info.children.push(c);
                }
            }
            return info;
        }
        // Dump each of the 5 messages (depth 2)
        const result = { messageCount: listDiv.children.length, messages: [] };
        for (let i = 0; i < listDiv.children.length; i++) {
            result.messages.push(nodeInfo(listDiv.children[i], 0, 2));
        }
        return result;
    })()`;
    return await cdpEval(js);
}

// Send a message via the input box
async function sendMessage(text) {
    const safeText = JSON.stringify(text);
    const js = `(async () => {
        const container = document.getElementById('conversation') || document;
        const editor = container.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
                    || container.querySelector('[contenteditable="true"]');
        if (!editor) return { error: 'input not found' };
        editor.focus();
        document.execCommand('insertText', false, ${safeText});
        await new Promise(r => setTimeout(r, 300));
        const inputArea = editor.closest('div');
        let btn = null;
        if (inputArea && inputArea.parentElement) {
            const buttons = inputArea.parentElement.querySelectorAll('button');
            for (const b of buttons) {
                if (b.innerHTML.includes('svg') || b.getAttribute('aria-label')) { btn = b; break; }
            }
            if (!btn && buttons.length > 0) btn = buttons[buttons.length - 1];
        }
        if (btn) { btn.click(); return { success: true, method: 'button' }; }
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        return { success: true, method: 'enter' };
    })()`;
    return await cdpEval(js);
}

// Stop an in-progress generation by clicking Antigravity's stop button (best effort).
async function stopGeneration() {
    const js = `(() => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
        const stop = btns.find(b => {
            const label = (b.getAttribute('aria-label') || '').toLowerCase();
            const title = (b.getAttribute('title') || '').toLowerCase();
            const txt = (b.innerText || '').trim();
            return label.includes('stop') || title.includes('stop') || txt === '■' || txt === '⏹';
        });
        if (stop) { stop.click(); return { success: true }; }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { success: false, error: 'stop button not found, sent Escape instead' };
    })()`;
    return await cdpEval(js);
}

// Get available models from the picker (live list)
async function getModels() {
    const js = `(async () => {
        const keywords = ['Gemini', 'Claude', 'GPT'];
        let modelBtn = document.querySelector('[data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
        if (!modelBtn) {
            const cands = Array.from(document.querySelectorAll('button')).filter(b => {
                const t = b.innerText || '';
                return keywords.some(k => t.includes(k)) && b.offsetParent;
            });
            modelBtn = cands[0];
        }
        if (!modelBtn) return { error: 'model button not found' };
        modelBtn.click();
        await new Promise(r => setTimeout(r, 800));
        const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
            .filter(e => e.offsetParent && (e.innerText || '').trim().length > 0 && (e.innerText || '').trim().length < 80)
            .map(e => (e.innerText || '').trim());
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { models: [...new Set(items)] };
    })()`;
    return await cdpEval(js);
}

// Set model by exact name
async function setModel(name) {
    const safeName = JSON.stringify(name);
    const js = `(async () => {
        let modelBtn = document.querySelector('[data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
        if (!modelBtn) {
            const cands = Array.from(document.querySelectorAll('button')).filter(b => {
                const t = b.innerText || '';
                return ['Gemini','Claude','GPT'].some(k => t.includes(k)) && b.offsetParent;
            });
            modelBtn = cands[0];
        }
        if (!modelBtn) return { error: 'model button not found' };
        modelBtn.click();
        await new Promise(r => setTimeout(r, 800));
        const target = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
            .find(e => e.offsetParent && (e.innerText || '').trim() === ${safeName});
        if (target) { target.click(); return { success: true }; }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { error: 'model not found: ' + ${safeName} };
    })()`;
    return await cdpEval(js);
}

// Get current model
async function getCurrentModel() {
    const js = `(() => {
        const cands = Array.from(document.querySelectorAll('button')).filter(b => {
            const t = (b.innerText || '').trim();
            return ['Gemini','Claude','GPT'].some(k => t.includes(k)) && t.length < 60 && b.offsetParent;
        });
        return { model: cands.length ? cands[0].innerText.trim() : 'unknown' };
    })()`;
    return await cdpEval(js);
}

// ============ AUTH (phone UI): stateless signed tokens ============
// Token = <random64hex>.<hmac-sha256(random, APP_PASSWORD)>. The server never
// stores sessions, so restarts and crashes can't log anyone out.
function makeToken() {
    const r = crypto.randomBytes(32).toString('hex');
    const sig = crypto.createHmac('sha256', APP_PASSWORD).update(r).digest('hex');
    return r + '.' + sig;
}
function verifyToken(tok) {
    const m = /^([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(tok || '');
    if (!m) return false;
    const expected = crypto.createHmac('sha256', APP_PASSWORD).update(m[1]).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(expected, 'hex'));
    } catch (e) { return false; }
}
function checkAuth(req) {
    const cookie = req.headers.cookie || '';
    const m = /tpsess=([a-f0-9]{64}\.[a-f0-9]{64})/.exec(cookie);
    if (m && verifyToken(m[1])) return true;
    // Fallback for browsers that won't persist cookies: session token via
    // Authorization header (phone UI keeps it in page memory / URL).
    const ah = req.headers['authorization'] || '';
    const b = /^Bearer ([a-f0-9]{64}\.[a-f0-9]{64})$/.exec(ah);
    if (b && verifyToken(b[1])) return true;
    return false;
}

// ============ TIFFANY API (machine access via Tailscale, Bearer token) ============
function checkTiffany(req) {
    if (!TIFFANY_TOKEN) return false;
    const h = req.headers['authorization'] || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) return false;
    const a = Buffer.from(m[1], 'utf8');
    const b = Buffer.from(TIFFANY_TOKEN, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const tiffanySentIds = new Map(); // client_msg_id -> timestamp (idempotency)
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
        req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}
function readTextBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}
async function handleTiffany(req, res, url) {
    res.setHeader('Content-Type', 'application/json');
    if (!checkTiffany(req)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const bootTime = handleTiffany.bootTime || (handleTiffany.bootTime = Date.now());
    try {
        if (url.pathname === '/tiffany/status') {
            res.end(JSON.stringify({ ok: true, cdp: cdpConnected(), uptime_sec: Math.floor((Date.now() - bootTime) / 1000), time: new Date().toISOString() }));
        } else if (url.pathname === '/tiffany/messages') {
            const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100);
            const after = parseInt(url.searchParams.get('after') || '-1', 10);
            const d = await getMessages();
            if (d.error) { res.end(JSON.stringify({ error: d.error })); return; }
            const all = (d.messages || []).map((m, i) => ({ id: i, role: m.role, text: m.text }));
            const msgs = all.filter(m => m.id > after).slice(-limit);
            res.end(JSON.stringify({ messages: msgs, total: all.length }));
        } else if (url.pathname === '/tiffany/send' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const text = String(body.text || '').trim();
            if (!text) { res.writeHead(400); res.end('{"error":"empty text"}'); return; }
            if (body.client_msg_id) {
                if (tiffanySentIds.has(body.client_msg_id)) { res.end(JSON.stringify({ ok: true, duplicate: true })); return; }
                tiffanySentIds.set(body.client_msg_id, Date.now());
                if (tiffanySentIds.size > 500) tiffanySentIds.delete(tiffanySentIds.keys().next().value);
            }
            const r = await sendMessage(text);
            console.log('[tiffany-api] send (' + new Date().toISOString() + '): ' + ((r && r.success) ? 'OK via ' + (r.method || '?') : 'FAIL ' + ((r && r.error) || 'unknown')) + ' | ' + text.slice(0, 80));
            res.end(JSON.stringify({ ok: !(r && r.error), result: r }));
        } else if (url.pathname === '/tiffany/models') {
            const [models, current] = await Promise.all([getModels().catch(e => ({ error: e.message })), getCurrentModel().catch(e => ({ model: '?' }))]);
            res.end(JSON.stringify({ models: models.models || [], current: current.model || '' }));
        } else if (url.pathname === '/tiffany/model' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const r = await setModel(String(body.model || ''));
            console.log('[tiffany-api] model -> ' + body.model + ' (' + new Date().toISOString() + ')');
            res.end(JSON.stringify({ ok: !(r && r.error), result: r }));
        } else {
            res.writeHead(404); res.end('{}');
        }
    } catch (e) {
        res.end(JSON.stringify({ error: e.message }));
    }
}

// ============ HTML UI — Option A Minimal (locked spec) ============
const HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Tiffany Phone</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0e1621;color:#e8edf3;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
#banner{display:none;background:#7c2d12;color:#ffd9a8;font-size:13px;text-align:center;padding:9px 12px}
#banner.show{display:block}
#msgs{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:10px;-webkit-overflow-scrolling:touch}
.bubble{max-width:82%;padding:9px 12px 20px;border-radius:14px;font-size:15px;line-height:1.5;position:relative;word-wrap:break-word;overflow-wrap:break-word}
.bubble.ai{background:#182533;align-self:flex-start;border-bottom-left-radius:4px}
.bubble.user{background:#2b5278;align-self:flex-end;border-bottom-right-radius:4px}
.bubble .ts{position:absolute;bottom:5px;right:10px;font-size:10px;color:rgba(255,255,255,.55)}
.bubble pre{background:rgba(0,0,0,.35);border-radius:8px;padding:8px;margin:8px 0 4px;overflow-x:auto;font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre}
.bubble code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;background:rgba(0,0,0,.3);padding:1px 5px;border-radius:4px}
.bubble pre code{background:none;padding:0}
.bubble.typing{padding:13px 16px}
.bubble.typing span{display:inline-block;width:7px;height:7px;border-radius:50%;background:#8fa3b8;margin:0 2px;animation:blink 1.2s infinite}
.bubble.typing span:nth-child(2){animation-delay:.2s}
.bubble.typing span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,60%,100%{opacity:.25}30%{opacity:1}}
.status-block{align-self:flex-start;max-width:82%;margin:2px 0}
.status-line{font-size:12px;color:#6b7a8d;line-height:1.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#jumpNew{position:fixed;left:50%;transform:translateX(-50%);bottom:118px;background:#1c1c1e;border:1px solid #3a3a3c;color:#eee;font-size:12px;padding:8px 16px;border-radius:18px;display:none;z-index:30}
#jumpNew.show{display:block}
#inputWrap{padding:8px 10px calc(10px + env(safe-area-inset-bottom));background:#0e1621}
#inputBox{background:#2a2a2a;border-radius:20px;padding:10px 12px 8px;position:relative}
#txt{width:100%;background:transparent;border:none;outline:none;resize:none;color:#f0f0f0;font-size:15px;font-family:inherit;line-height:1.45;max-height:120px;display:block}
#txt::placeholder{color:#8a8a8a}
#inputRow{display:flex;align-items:center;margin-top:4px;min-height:40px}
#plusBtn{width:30px;height:30px;border-radius:50%;background:#3a3a3a;color:#ddd;border:none;font-size:18px;line-height:1;flex-shrink:0}
#modelLabel{flex:1;background:none;border:none;color:#cfcfcf;font-size:13px;text-align:left;padding:8px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#modelLabel .chev{color:#8a8a8a;font-size:11px}
#sendBtn{width:40px;height:40px;border-radius:50%;background:#0e639c;color:#fff;border:none;font-size:19px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:background-color .3s ease,transform .3s ease}
#sendBtn.stop{background:#e5484d;font-size:13px;transform:rotate(90deg)}
#modelDrop{position:absolute;bottom:calc(100% + 8px);left:0;right:0;background:#1c1c1e;border:1px solid #3a3a3c;border-radius:14px;display:none;z-index:20;max-height:280px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.5)}
#modelDrop.show{display:block}
#modelDrop button{display:flex;width:100%;background:none;border:none;color:#eee;font-size:14px;padding:13px 14px;text-align:left;justify-content:space-between;align-items:center}
#modelDrop button:active{background:#2c2c2e}
#modelDrop .chk{color:#4ade80;font-size:14px}
#toast{position:fixed;left:50%;transform:translateX(-50%);bottom:120px;background:#1c1c1e;border:1px solid #3a3a3c;color:#eee;font-size:13px;padding:10px 18px;border-radius:20px;display:none;z-index:200;white-space:nowrap}
#login form{margin:0}
#toast.show{display:block}
#login{position:fixed;inset:0;background:#0e1621;display:flex;align-items:center;justify-content:center;z-index:99;padding:20px}
#login .card{background:#182533;padding:32px 28px;border-radius:18px;text-align:center;width:100%;max-width:300px}
#login h2{font-size:18px;margin-bottom:6px}
#login p{font-size:13px;color:#8fa3b8;margin-bottom:6px}
#login input{background:#0e1621;border:1px solid #2b3a4d;border-radius:10px;padding:12px;color:#fff;font-size:16px;margin:12px 0;width:100%;text-align:center;outline:none}
#login input:focus{border-color:#0e639c}
#login button{background:#0e639c;border:none;color:#fff;padding:12px 0;border-radius:10px;font-size:16px;cursor:pointer;width:100%}
</style></head><body>
<div id="login"><div class="card"><h2>Tiffany Phone</h2><p>Masukkan password</p>__LOGIN_ERR__<form method="POST" action="/login"><input type="password" id="pw" name="pw" placeholder="Password" autocomplete="off"><button type="submit">Masuk</button></form></div></div>
<div id="banner">Antigravity not connected &mdash; buka Antigravity dengan --remote-debugging-port=9000</div>
<div id="msgs"></div>
<button id="jumpNew" onclick="jumpBottom()">Pesan baru &darr;</button>
<div id="inputWrap"><div id="inputBox">
<textarea id="txt" rows="1" placeholder="Ask anything, @ to mention, / for actions"></textarea>
<div id="inputRow">
<button id="plusBtn" onclick="plusToast()">+</button>
<button id="modelLabel" onclick="toggleModels()"><span id="modelName">Loading...</span> <span class="chev">^</span></button>
<button id="sendBtn" onclick="sendOrStop()">&rarr;</button>
</div>
<div id="modelDrop"></div>
</div></div>
<div id="toast"></div>
<script>
var FALLBACK_MODELS = ['Gemini 3.8 Flash High','Gemini 3.8 Pro','Claude Sonnet 4.6','Gemini 3.8 Flash Lite'];
var seenTs = {};
var lastKey = '';
var lastSKey = '';
var processing = false;
var pendingOwn = [];
var stopTimer = null;
var toastTimer = null;
var aiCountAtSend = 0;
var firstLoad = true;
var lastItems = [];

function $(id){ return document.getElementById(id); }
function esc(s){ var d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function fmtT(ts){ var d=new Date(ts); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
function renderText(t){
  var BT = String.fromCharCode(96);
  var e = esc(t);
  var fenceRe = new RegExp(BT+BT+BT+'(\\w*)\\n?([\\s\\S]*?)'+BT+BT+BT, 'g');
  var NL = String.fromCharCode(10);
  e = e.replace(fenceRe, function(m0,lang,code){
    while (code.charAt(0) === NL) code = code.slice(1);
    while (code.slice(-1) === NL) code = code.slice(0,-1);
    return '<pre><code>'+code+'</code></pre>';
  });
  var inlineRe = new RegExp(BT+'([^'+BT+'\\n]+)'+BT, 'g');
  e = e.replace(inlineRe,'<code>$1</code>');
  e = e.split(NL).join('<br>');
  return e;
}
function toast(msg){
  var t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(function(){ t.classList.remove('show'); }, 2500);
}
function showLogin(){ $('login').style.display = 'flex'; }
function hideLogin(){ $('login').style.display = 'none'; }

// Session token lives in page memory (primary) + localStorage (backup).
// The ?s= token stays in the URL so even a refresh works with cookies AND
// localStorage both blocked.
var PHONE_TOKEN = null;
function phoneToken(){ return PHONE_TOKEN; }
async function api(p, o){
  o = o || {};
  if (PHONE_TOKEN) { o.headers = o.headers || {}; o.headers['Authorization'] = 'Bearer ' + PHONE_TOKEN; }
  var r = await fetch(p, o);
  if (r.status === 401){ showLogin(); throw new Error('unauth'); }
  return r.json();
}
async function doLogin(){
  try {
    var pw = $('pw').value;
    var r = await fetch('/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pw:pw})});
    if (r.ok){ hideLogin(); init(); }
    else toast('Password salah');
  } catch(e){ toast('Koneksi gagal, coba lagi'); }
}

function setBanner(show){ $('banner').classList.toggle('show', !!show); }
async function loadStatus(){
  try { var s = await api('/api/status'); setBanner(!s.cdp); }
  catch(e){ setBanner(true); }
}

function countAi(items){ var n=0; items.forEach(function(x){ if(x.role==='ai') n++; }); return n; }

function renderMsgs(items, statusItems){
  lastItems = items;
  var box = $('msgs');
  var html = '';
  items.forEach(function(x){
    html += '<div class="bubble '+x.role+'">'+renderText(x.text)+'<span class="ts">'+fmtT(x.ts)+'</span></div>';
  });
  if (statusItems && statusItems.length > 0) {
    html += '<div class="status-block">';
    statusItems.forEach(function(s){
      html += '<div class="status-line">'+esc(s.text)+'</div>';
    });
    html += '</div>';
  }
  if (processing) html += '<div class="bubble ai typing"><span></span><span></span><span></span></div>';
  box.innerHTML = html;
}
function nearBottom(){ var b=$('msgs'); return b.scrollHeight - b.scrollTop - b.clientHeight < 140; }
function jumpBottom(){ var b=$('msgs'); b.scrollTop = b.scrollHeight; $('jumpNew').classList.remove('show'); }
function maybeAutoScroll(){
  if (nearBottom()){ jumpBottom(); }
  else { $('jumpNew').classList.add('show'); }
}

async function loadMsgs(){
  var d;
  try { d = await api('/api/messages'); } catch(e){ return; }
  if (!d || d.error || !d.messages) return;
  var now = Date.now();
  var serverUserTexts = {};
  d.messages.forEach(function(m){ if (m.role === 'user') serverUserTexts[m.text] = 1; });
  pendingOwn = pendingOwn.filter(function(p){ return !serverUserTexts[p.text] && (now - p.ts < 30000); });
  var items = d.messages.map(function(m){
    var k = m.role + '|' + m.text;
    if (!seenTs[k]) seenTs[k] = now;
    return { role: m.role, text: m.text, ts: seenTs[k] };
  });
  pendingOwn.forEach(function(p){ items.push({ role:'user', text:p.text, ts:p.ts }); });
  var statusItems = (d.status || []).map(function(s){ return { text: s.text }; });
  var key = items.map(function(x){ return x.role + ':' + x.text; }).join('\\n');
  var skey = statusItems.map(function(s){ return s.text; }).join('\\n');
  var changed = (lastKey !== key) || (lastSKey !== skey);
  var wasFirst = firstLoad;
  lastKey = key; lastSKey = skey; firstLoad = false;
  if (!changed && !wasFirst) return; // skip re-render -> no scroll jitter
  renderMsgs(items, statusItems);
  if (wasFirst){ jumpBottom(); return; }
  maybeAutoScroll();
  if (processing && countAi(items) > aiCountAtSend){ onDone(); }
}

function morphStop(on){
  var b = $('sendBtn');
  b.classList.toggle('stop', !!on);
  b.innerHTML = on ? '&#9632;' : '&rarr;';
}
function onSendStart(aiCount){
  aiCountAtSend = aiCount;
  processing = true;
  morphStop(true);
  renderMsgs(lastItems); maybeAutoScroll();
  clearTimeout(stopTimer);
  stopTimer = setTimeout(function(){ if (processing){ onDone(); toast('Response timed out'); } }, 180000);
}
function onDone(){
  processing = false;
  clearTimeout(stopTimer);
  morphStop(false);
  renderMsgs(lastItems);
}

async function doSend(){
  var ta = $('txt');
  var t = ta.value.trim();
  if (!t || processing) return;
  ta.value = ''; autogrow();
  var aiCount = 0;
  try { var d = await api('/api/messages'); if (d && d.messages) aiCount = d.messages.filter(function(m){ return m.role==='ai'; }).length; } catch(e){}
  var r;
  try { r = await api('/api/send', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:t})}); }
  catch(e){ toast('Send failed'); return; }
  if (r.error){ toast('Error: ' + r.error); return; }
  pendingOwn.push({ text:t, ts:Date.now() });
  onSendStart(aiCount);
  loadMsgs();
}
async function doStop(){
  try { await api('/api/stop', {method:'POST'}); } catch(e){}
  onDone();
  toast('Response stopped');
}
function sendOrStop(){ if (processing) doStop(); else doSend(); }
function plusToast(){ toast('@ mention / / actions'); }

function setModelLabel(name){ $('modelName').textContent = name || 'Unknown model'; }
function renderModelDrop(list, current){
  var dd = $('modelDrop');
  var html = '';
  list.forEach(function(m){
    html += '<button data-m="'+esc(m)+'">'+esc(m)+(m===current?'<span class="chk">&#10003;</span>':'<span></span>')+'</button>';
  });
  dd.innerHTML = html || '<button disabled>No models</button>';
  var btns = dd.querySelectorAll('button[data-m]');
  btns.forEach(function(b){
    b.onclick = function(){ pickModel(b.getAttribute('data-m')); };
  });
}
function toggleModels(){ $('modelDrop').classList.toggle('show'); }
async function pickModel(name){
  $('modelDrop').classList.remove('show');
  try {
    var r = await api('/api/model', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({model:name})});
    if (r.error){ toast('Error: ' + r.error); return; }
    setModelLabel(name);
    loadModels();
  } catch(e){ toast('Failed to set model'); }
}
async function loadModels(){
  var list = FALLBACK_MODELS.slice(), current = '';
  try {
    var m = await api('/api/models');
    if (m.models && m.models.length) list = m.models;
    current = m.current || '';
  } catch(e){}
  renderModelDrop(list, current);
  setModelLabel(current || list[0] || '');
}

function autogrow(){
  var ta = $('txt');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

function init(){
  setBanner(false);
  loadStatus(); loadModels(); loadMsgs();
  setInterval(loadMsgs, 2000);
  setInterval(loadStatus, 8000);
  var ta = $('txt');
  ta.addEventListener('input', autogrow);
  ta.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); doSend(); }
  });
  document.addEventListener('click', function(e){
    var dd = $('modelDrop');
    if (dd.classList.contains('show') && !e.target.closest('#inputBox')) dd.classList.remove('show');
  });
}

var wsConn = null;
function onWsMessages(messages){
  var now = Date.now();
  var serverUserTexts = {};
  messages.forEach(function(m){ if (m.role === 'user') serverUserTexts[m.text] = 1; });
  pendingOwn = pendingOwn.filter(function(p){ return !serverUserTexts[p.text] && (now - p.ts < 30000); });
  var items = messages.map(function(m){
    var k = m.role + '|' + m.text;
    if (!seenTs[k]) seenTs[k] = now;
    return { role: m.role, text: m.text, ts: seenTs[k] };
  });
  pendingOwn.forEach(function(p){ items.push({ role:'user', text:p.text, ts:p.ts }); });
  var key = items.map(function(x){ return x.role + ':' + x.text; }).join('\\n');
  var changed = (lastKey !== key);
  var wasFirst = firstLoad;
  lastKey = key; firstLoad = false;
  if (!changed && !wasFirst) return;
  renderMsgs(items);
  if (wasFirst){ jumpBottom(); return; }
  maybeAutoScroll();
  if (processing && countAi(items) > aiCountAtSend){ onDone(); }
}
function connectWS(){
  try {
    if (wsConn) { try { wsConn.close(); } catch(e){} wsConn = null; }
    if (!PHONE_TOKEN) { setTimeout(connectWS, 2000); return; }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsConn = new WebSocket(proto + '//' + location.host + '/ws?token=' + encodeURIComponent(PHONE_TOKEN));
    wsConn.onmessage = function(ev){
      try {
        var d = JSON.parse(ev.data);
        if (d && d.type === 'messages' && d.messages) onWsMessages(d.messages);
      } catch(e){}
    };
    wsConn.onclose = function(){ wsConn = null; setTimeout(connectWS, 2000); };
    wsConn.onerror = function(){ try { wsConn.close(); } catch(e){} };
  } catch(e){ setTimeout(connectWS, 2000); }
}

// boot: pick up the session token from the login redirect (?s=...) or from
// localStorage. The token is kept in page memory and left in the URL, so the
// chat works even when the browser blocks both cookies and localStorage.
(function(){
  try {
    var m = /[?&]s=([a-f0-9]{64}[.][a-f0-9]{64})/.exec(location.search);
    if (m) {
      PHONE_TOKEN = m[1];
      try { localStorage.setItem('tpsess', m[1]); } catch(e){}
    } else {
      try { PHONE_TOKEN = localStorage.getItem('tpsess'); } catch(e){}
    }
  } catch(e){}
  if (PHONE_TOKEN) { hideLogin(); init(); }
  else { fetch('/api/status').then(function(r){ if (r.ok){ hideLogin(); init(); } }).catch(function(){}); }
})();

</script></body></html>`;

// ============ HTTP SERVER ============
async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://x');

    // Tiffany machine API first — own Bearer auth, before cookie auth
    if (url.pathname.startsWith('/tiffany/')) { await handleTiffany(req, res, url); return; }

    if (url.pathname === '/login' && req.method === 'POST') {
        try {
            const ctype = String(req.headers['content-type'] || '');
            const isForm = ctype.includes('application/x-www-form-urlencoded');
            let pw;
            if (isForm) {
                pw = new URLSearchParams(await readTextBody(req)).get('pw');
            } else {
                ({ pw } = await readJsonBody(req));
            }
            const pwNorm = String(pw || '').trim();
            const appPwNorm = String(APP_PASSWORD || '').trim();
            if (pwNorm !== '' && pwNorm === appPwNorm) {
                const t = makeToken();
                const cookie = `tpsess=${t}; HttpOnly; Path=/; Max-Age=86400`;
                if (isForm) {
                    // Pass the token in the URL too — some mobile browsers won't
                    // persist the cookie, and the page picks it up from there.
                    res.writeHead(302, { 'Set-Cookie': cookie, 'Location': '/?s=' + t });
                    res.end();
                } else {
                    res.writeHead(200, { 'Set-Cookie': cookie, 'Content-Type': 'application/json' });
                    res.end('{"ok":true}');
                }
            } else {
                if (isForm) {
                    res.writeHead(302, { 'Location': '/?err=wrong' });
                    res.end();
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end('{"error":"wrong password"}');
                }
            }
        } catch (e) { res.writeHead(400); res.end('{}'); }
        return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
        const errHtml = url.searchParams.get('err') === 'wrong'
            ? '<p style="color:#ff8a8a;font-size:13px;margin:0 0 8px">Password salah, coba lagi</p>' : '';
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(HTML.replace('__LOGIN_ERR__', errHtml));
        return;
    }

    if (!checkAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }

    res.setHeader('Content-Type', 'application/json');
    try {
        if (url.pathname === '/api/status') {
            res.end(JSON.stringify({ cdp: cdpConnected() }));
        } else if (url.pathname === '/api/messages') {
            res.end(JSON.stringify(await getMessages()));
        } else if (url.pathname === '/api/dom-debug') {
            res.end(JSON.stringify(await getDomStructure().catch(e => ({ error: e.message }))));
        } else if (url.pathname === '/api/send' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const text = String(body.text || '').trim();
            if (!text) { res.writeHead(400); res.end('{"error":"empty text"}'); return; }
            res.end(JSON.stringify(await sendMessage(text)));
        } else if (url.pathname === '/api/stop' && req.method === 'POST') {
            res.end(JSON.stringify(await stopGeneration()));
        } else if (url.pathname === '/api/models') {
            const [models, current] = await Promise.all([getModels().catch(e => ({ error: e.message })), getCurrentModel().catch(e => ({ model: '?' }))]);
            res.end(JSON.stringify({ models: models.models || [], current: current.model || '' }));
        } else if (url.pathname === '/api/model' && req.method === 'POST') {
            const body = await readJsonBody(req);
            res.end(JSON.stringify(await setModel(String(body.model || ''))));
        } else {
            res.writeHead(404); res.end('{}');
        }
    } catch (e) {
        res.end(JSON.stringify({ error: e.message }));
    }
}

const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(e => {
        console.error('[request-error]', e && e.message);
        if (!res.headersSent) { try { res.writeHead(500); res.end('{}'); } catch (_) {} }
    });
});

// Need 'ws' module
try { require.resolve('ws'); }
catch (e) { console.error('Run: npm install ws'); process.exit(1); }

// ============ WEBSOCKET PUSH (real-time message updates) ============
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set();

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const tok = url.searchParams.get('token') || '';
    if (!verifyToken(tok)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
        wsClients.add(ws);
        ws.on('close', () => wsClients.delete(ws));
        ws.on('error', () => wsClients.delete(ws));
        // send current messages immediately on connect
        pushMessagesTo(ws).catch(() => {});
    });
});

async function pushMessagesTo(ws) {
    try {
        const d = await getMessages();
        if (d && !d.error && d.messages && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'messages', messages: d.messages }));
        }
    } catch (e) {}
}

function broadcastMessages(messages) {
    const payload = JSON.stringify({ type: 'messages', messages });
    for (const ws of wsClients) {
        if (ws.readyState === 1) { try { ws.send(payload); } catch (e) {} }
    }
}

let lastPushedKey = '';
async function watchMessages() {
    if (!cdpConnected() || wsClients.size === 0) return;
    try {
        const d = await getMessages();
        if (!d || d.error || !d.messages) return;
        const key = d.messages.map(m => m.role + '|' + (m.text || '').slice(0, 100)).join('\n');
        if (key !== lastPushedKey) {
            lastPushedKey = key;
            broadcastMessages(d.messages);
        }
    } catch (e) {}
}
setInterval(watchMessages, 800);

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`Tiffany Phone v2 running on http://0.0.0.0:${PORT}`);
    console.log('Tiffany API: ' + (TIFFANY_TOKEN ? 'ENABLED (/tiffany/*)' : 'DISABLED (no TIFFANY_TOKEN)'));
    try { await connectCDP(); }
    catch (e) { console.error('CDP failed:', e.message); console.log('Make sure Antigravity is running with --remote-debugging-port=9000'); }
});
