# Tiffany Phone v2

Remote control Antigravity dari HP — custom build untuk versi Antigravity Davin.
UI: Option A Minimal (Telegram-dark chat + Antigravity-dark input).

## Cara pakai (urutan penting!)

1. **Tutup total Antigravity** (cek system tray juga).
2. **Jalankan Antigravity dengan debug port DULU** — buka PowerShell:
   ```
   & "C:\Users\Alucard\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe" "D:\GAG MARKET" --remote-debugging-port=9000
   ```
3. Buka/siapkan satu chat di Antigravity.
4. Double-click **`start.bat`** di folder ini.
5. Masukkan **password HP** waktu diminta (kamu yang tentuin sendiri — jangan share ke siapa pun).
6. Masukkan **token Tiffany** waktu diminta (bikin acak yang panjang, misal via
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   Kosongkan = API Tiffany nonaktif. Token ini JANGAN dikirim via chat —
   kasih ke Tiffany via jalur aman sekali saja.
7. Di HP (Tailscale connect): buka `http://100.81.74.82:3001`, login pakai password tadi.

## Fitur

- 💬 Chat Antigravity asli dari HP (auto-refresh 3 detik, auto-scroll)
- ✏️ Kirim pesan dari HP (Enter = kirim, Shift+Enter = baris baru)
- ⏹ Tombol kirim berubah jadi **stop merah** saat AI memproses — tap untuk batalkan
- 🤖 Ganti model — daftar diambil **live** dari Antigravity (bukan hardcoded)
- 🔒 Password protect (cookie session)
- ⚠️ Banner "Antigravity not connected" kalau debug port belum dibuka
- 🔌 **Tiffany API** (`/tiffany/*`, Bearer token terpisah): status, baca pesan,
  kirim pesan (idempoten via `client_msg_id`), daftar/ganti model — buat pantauan
  Tiffany via Tailscale. Detail kontrak: `tiffany-api.md`.

## Catatan

- Server jalan di **port 3001** (HTTP biasa — bukan HTTPS — supaya bisa diakses via Tailscale).
- Butuh Node.js terinstall. `npm install` otomatis via start.bat (butuh `ws`).
- Password & token **hanya dari env var** — tidak pernah ditulis ke file.
- Kalau daftar model kosong / chat tidak terbaca, pastikan Antigravity dibuka
  dengan `--remote-debugging-port=9000` (langkah 2 di atas).
