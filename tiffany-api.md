# Tiffany API — akses Tiffany ke Tiffany Phone

**Kenapa endpoint khusus, bukan pakai login cookie HP:**
Login HP (`/login` → cookie `tpsess`) dirancang buat browser. Buat akses machine-to-machine
(Tiffany di VPS → PC Davin via Tailscale), yang tepat adalah Bearer token statis:
tidak ada session yang bisa kedaluwarsa, gampang dipakai dari curl/script, dan bisa
di-rotate/di-revoke tanpa ganti password HP.

## Kontrak endpoint

Base: `http://100.81.74.82:3001` (via Tailscale). Semua butuh header:
`Authorization: Bearer <TIFFANY_TOKEN>`. Tanpa token yang benar → `401`.

| Method | Path | Fungsi |
|---|---|---|
| GET | `/tiffany/status` | Sehat tidaknya server + CDP: `{ok, cdp, uptime_sec, time}` |
| GET | `/tiffany/messages?limit=50&after=<id>` | Pesan sebagai teks struktur, `id` naik monoton; `after` = hanya yang lebih baru (buat polling pantauan) |
| POST | `/tiffany/send` | `{text, client_msg_id?}` → kirim ke Antigravity via CDP. `client_msg_id` bikin idempoten (retry aman, tidak double-kirim) |
| GET | `/tiffany/models` | Daftar model + yang aktif (sama kayak `/api/models`) |
| POST | `/tiffany/model` | `{model}` → ganti model |

Setiap `POST /tiffany/send` dan `/tiffany/model` dicatat di console server
(`[tiffany-api] ...`) — jadi bisa diaudit kapan Tiffany kirim apa.

**Catatan keamanan:**
- Kalau `TIFFANY_TOKEN` kosong, semua `/tiffany/*` balas `401` (fitur nonaktif by default).
- Token JANGAN taruh di chat — kirim sekali via jalur aman, lalu simpan di `.env`/start.bat di PC.
- Server sekarang listen `0.0.0.0` — artinya satu LAN juga bisa mencapai halaman login.
  Itu masih aman (diproteksi password), tapi kalau mau ketat: bind ke IP Tailscale saja.

## Kode: 3 tempelan ke server.js

### Tempelan 1 — di bagian CONFIG, tepat di bawah `const CDP_PORT = 9000;`

```js
const TIFFANY_TOKEN = process.env.TIFFANY_TOKEN || '';
```

### Tempelan 2 — tepat di bawah fungsi `checkAuth` (di bawah baris penutup `}`-nya)

```js
// ============ TIFFANY API (akses Tiffany via Tailscale, auth: Bearer token) ============
function checkTiffany(req) {
    if (!TIFFANY_TOKEN) return false;
    const h = req.headers['authorization'] || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) return false;
    const a = Buffer.from(m[1], 'utf8');
    const b = Buffer.from(TIFFANY_TOKEN, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const tiffanySentIds = new Map();
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
        req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}
async function handleTiffany(req, res, url) {
    res.setHeader('Content-Type', 'application/json');
    if (!checkTiffany(req)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const bootTime = handleTiffany.bootTime || (handleTiffany.bootTime = Date.now());
    try {
        if (url.pathname === '/tiffany/status') {
            res.end(JSON.stringify({ ok: true, cdp: !!(cdpWs && cdpWs.readyState === 1), uptime_sec: Math.floor((Date.now() - bootTime) / 1000), time: new Date().toISOString() }));
        } else if (url.pathname === '/tiffany/messages') {
            const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100);
            const after = parseInt(url.searchParams.get('after') || '-1', 10);
            const d = await getMessages();
            if (d.error) { res.end(JSON.stringify({ error: d.error })); return; }
            const all = (d.messages || []).map((m, i) => ({ id: i, text: m.text }));
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
```

### Tempelan 3 — di dalam `http.createServer`, tepat di bawah `const url = new URL(req.url, 'http://x');`

```js
    if (url.pathname.startsWith('/tiffany/')) { await handleTiffany(req, res, url); return; }
```

(Penting: taruh SEBELUM blok `/login` dan SEBELUM `checkAuth(req)` — endpoint ini pakai
auth sendiri, bukan cookie.)

## Tempelan ke start.bat

Taruh di bawah blok `APP_PASSWORD`, sebelum `echo.`:

```bat
if "%TIFFANY_TOKEN%"=="" (
    set /p TIFFANY_TOKEN=Masukkan token Tiffany (kosongkan = API Tiffany nonaktif): 
)
```

## Setup di PC (sekali saja)

1. Tempel 3 blok kode ke `server.js`, 1 blok ke `start.bat` (di atas).
2. Bikin token acak yang panjang, misal di PowerShell:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. Double-click `start.bat` → masukkan password HP seperti biasa → masukkan token tadi
   di prompt baru.
4. Kirim tokennya ke Tiffany **via jalur aman** (jangan di chat). Sekali saja;
   Tiffany simpan di sisi VPS.

## Cara Tiffany pakai (nanti, via Tailscale)

```bash
# cek sehat + CDP nyambung tidak
curl -s -H "Authorization: Bearer <TOKEN>" http://100.81.74.82:3001/tiffany/status

# pantau pesan baru (polling; simpan id terakhir)
curl -s -H "Authorization: Bearer <TOKEN>" "http://100.81.74.82:3001/tiffany/messages?after=41&limit=20"

# kirim chat ke Antigravity
curl -s -X POST -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"text":"lanjutkan refactoringnya","client_msg_id":"t1-20261019-001"}' \
  http://100.81.74.82:3001/tiffany/send
```

## Keputusan buat Davin (2 hal)

1. **Identitas pengirim:** pesan dari Tiffany API masuk sebagai kamu (chat-nya sesi kamu,
   jadi agent Antigravity menganggapnya instruksi kamu) — dengan catatan audit
   `[tiffany-api]` di console server. Alternatif: prefix otomatis `[Tiffany]` di tiap
   pesan. Rekomendasi: sebagai kamu (lebih natural buat remote control).
2. **Cara share token:** via jalur aman sekali saja (bukan chat), lalu Tiffany simpan.
