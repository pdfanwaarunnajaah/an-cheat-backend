/**
 * ====================================================
 * AN CHEAT - Multi-Session WhatsApp Backend Server
 * Powered by @whiskeysockets/baileys & Gemini AI
 * 
 * Features:
 * - Multi-Number WhatsApp Management (banyak nomor WA)
 * - Setiap nomor WA memiliki Gemini AI & System Prompt sendiri
 * - Setiap nomor WA memiliki Google Spreadsheet & Tab Sheet sendiri
 * - Mode Privasi Fleksibel:
 *     * 'self' (Default/Aman): Hanya balas chat ke nomor sendiri (Message yourself)
 *     * 'all_private': Balas semua chat pribadi (Cocok untuk CS Toko/Bisnis)
 *     * Selalu tolak/abaikan pesan Grup & Broadcast untuk keamanan total
 * - Dukungan Scan QR & Kode Tautan OTP 8-digit per sesi
 * - Otomatis fallback model Gemini jika model lama deprecated
 * - Penanganan error & auto-reconnect stabil 24/7
 * ====================================================
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
  Browsers
} = require('@whiskeysockets/baileys');

// ─── Global Uncaught Exception Protection (Anti Crash) ───────
process.on('uncaughtException', (err) => {
  console.error('⚠️ [Uncaught Exception Ditangkap]:', err.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [Unhandled Rejection Ditangkap]:', reason?.message || reason);
});

const PORT = process.env.PORT || 8080;
const SESSIONS_DIR = path.join(__dirname, 'auth_sessions');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const LEGACY_AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const LEGACY_CONFIG_FILE = path.join(__dirname, 'config.json');

// Pastikan direktori sesi ada
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ─── Default System Prompt ────────────────────────────────────
const DEFAULT_SYSTEM_PROMPT = `Anda adalah AN Cheat AI — asisten pribadi serbabisa yang cerdas, kreatif, asyik, dan solutif.

Peran & Kemampuan:
1. Teman Ngobrol & Brainstorming: Sangat terbuka untuk diajak mengobrol santai, bertukar pikiran, menggali ide bisnis/konten/proyek, berdiskusi solusi, maupun membahas topik menarik apa pun.
2. Ahli Google Spreadsheet: Mahir membuat format tabel yang rapi, menyusun template kolom, serta mencatat atau merangkum data ketika diminta.
3. Gaya Bahasa: Ramah, luwes, komunikatif, dan alami. Menyesuaikan dengan nada pengguna (akrab & santai jika diajak santai; terstruktur & solutif jika membahas topik serius atau data).
4. Privasi & Keamanan: Asisten khusus untuk pemilik nomor WhatsApp ini.`;

// ─── Session Store Management ─────────────────────────────────
function loadSessionsData() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) {
        return data;
      }
    }
  } catch (e) {
    console.error('Error reading sessions.json:', e.message);
  }

  // Migrasi dari single-session lama jika ada
  let legacyApiKey = '';
  let legacySpreadsheet = '';
  let legacySheet = 'Sheet1';
  let legacyPrompt = DEFAULT_SYSTEM_PROMPT;

  try {
    if (fs.existsSync(LEGACY_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, 'utf-8'));
      legacyApiKey = cfg.geminiApiKey || '';
      legacySpreadsheet = cfg.spreadsheetUrl || '';
      legacySheet = cfg.sheetName || 'Sheet1';
      if (cfg.systemPrompt && !cfg.systemPrompt.includes('Tugas Anda adalah membantu memasukkan data, membuat tabel')) {
        legacyPrompt = cfg.systemPrompt;
      }
    }
  } catch (e) {}

  // Migrasi auth folder lama ke auth_sessions/session_1 jika ada
  const session1Auth = path.join(SESSIONS_DIR, 'session_1');
  if (fs.existsSync(LEGACY_AUTH_DIR) && !fs.existsSync(session1Auth)) {
    try {
      fs.cpSync(LEGACY_AUTH_DIR, session1Auth, { recursive: true });
      console.log('📦 [Migrasi Berhasil] Memindahkan sesi WhatsApp lama ke session_1.');
    } catch (e) {
      console.warn('Gagal migrasi auth folder:', e.message);
    }
  }

  const initialSessions = [
    {
      id: 'session_1',
      name: 'Nomor Utama',
      phone: null,
      geminiApiKey: legacyApiKey,
      geminiModel: 'gemini-3.5-flash-lite',
      systemPrompt: legacyPrompt,
      spreadsheetUrl: legacySpreadsheet,
      sheetName: legacySheet,
      respondMode: 'self',
      createdAt: Date.now()
    }
  ];

  saveSessionsData(initialSessions);
  return initialSessions;
}

function saveSessionsData(sessions) {
  try {
    const cleanData = sessions.map(s => ({
      id: s.id,
      name: s.name,
      phone: s.phone || null,
      geminiApiKey: s.geminiApiKey || '',
      geminiModel: s.geminiModel || 'gemini-3.5-flash-lite',
      systemPrompt: s.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      spreadsheetUrl: s.spreadsheetUrl || '',
      sheetName: s.sheetName || 'Sheet1',
      respondMode: s.respondMode || 'self',
      createdAt: s.createdAt || Date.now()
    }));
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(cleanData, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error writing sessions.json:', e.message);
  }
}

// ─── Message Text Unwrapper Helper ──────────────────────────
function extractMessageText(message) {
  if (!message) return '';
  const m = message.ephemeralMessage?.message ||
            message.viewOnceMessage?.message ||
            message.viewOnceMessageV2?.message ||
            message.documentWithCaptionMessage?.message ||
            message.extendedTextMessage ||
            message;

  if (typeof m.conversation === 'string' && m.conversation.trim()) {
    return m.conversation.trim();
  }
  if (typeof m.text === 'string' && m.text.trim()) {
    return m.text.trim();
  }
  if (typeof m.caption === 'string' && m.caption.trim()) {
    return m.caption.trim();
  }
  if (m.extendedTextMessage?.text) {
    return m.extendedTextMessage.text.trim();
  }
  if (m.imageMessage?.caption) {
    return m.imageMessage.caption.trim();
  }
  if (m.videoMessage?.caption) {
    return m.videoMessage.caption.trim();
  }
  return '';
}

// ─── Active Sockets Manager in Memory ─────────────────────────
const activeSessions = new Map();

class SessionInstance {
  constructor(meta) {
    this.id = meta.id;
    this.name = meta.name;
    this.phone = meta.phone || null;
    this.lid = meta.lid || null;
    this.geminiApiKey = meta.geminiApiKey || '';
    this.geminiModel = meta.geminiModel || 'gemini-3.5-flash-lite';
    this.systemPrompt = meta.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.spreadsheetUrl = meta.spreadsheetUrl || '';
    this.sheetName = meta.sheetName || 'Sheet1';
    this.knownSheetDetails = Array.isArray(meta.knownSheetDetails) ? meta.knownSheetDetails : [
      { name: this.sheetName || 'Sheet1', headers: [], totalRows: 0 }
    ];
    this.respondMode = meta.respondMode || 'all_private'; // 'self' | 'all_private'
    this.createdAt = meta.createdAt || Date.now();

    this.sock = null;
    this.currentQR = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectTimer = null;
    this.pairingCodeRequested = null;
    this.sentBotMessageIds = new Set();
    this.recentBotReplies = [];
    this.startupTimestampSec = Math.floor(Date.now() / 1000);
    this.chatHistory = [];
    this.loadChatHistory();
  }

  getMyLid() {
    if (this.lid) return this.lid;
    const rawLid = this.sock?.user?.lid || this.sock?.authState?.creds?.me?.lid;
    if (rawLid) {
      this.lid = rawLid.split(':')[0].split('@')[0].replace(/\D/g, '');
      return this.lid;
    }
    try {
      const credsPath = path.join(SESSIONS_DIR, this.id, 'creds.json');
      if (fs.existsSync(credsPath)) {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        const meLid = creds.me?.lid;
        if (meLid) {
          this.lid = meLid.split(':')[0].split('@')[0].replace(/\D/g, '');
          return this.lid;
        }
      }
    } catch (e) {}
    return null;
  }

  resolvePhoneFromJid(jid) {
    if (!jid) return '';
    const id = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (jid.endsWith('@s.whatsapp.net')) {
      return id;
    }
    if (jid.endsWith('@lid')) {
      const myLid = this.getMyLid();
      if (myLid && id === myLid) {
        return this.phone || id;
      }
      try {
        const sessionAuthDir = path.join(SESSIONS_DIR, this.id);
        if (fs.existsSync(sessionAuthDir)) {
          const files = fs.readdirSync(sessionAuthDir);
          for (const f of files) {
            if (f.startsWith('lid-mapping-') && f.endsWith('.json')) {
              const mappedLid = JSON.parse(fs.readFileSync(path.join(sessionAuthDir, f), 'utf8'));
              if (String(mappedLid).trim() === id) {
                return f.replace('lid-mapping-', '').replace('.json', '');
              }
            }
          }
        }
      } catch (e) {}
      return id;
    }
    return id;
  }

  addKnownSheet(sheetName, headers = []) {
    if (!sheetName) return;
    if (!this.knownSheetDetails) this.knownSheetDetails = [];
    const lower = sheetName.toLowerCase().trim();
    const existing = this.knownSheetDetails.find(s => (s.name || '').toLowerCase().trim() === lower);
    if (existing) {
      existing.name = sheetName.trim();
      if (Array.isArray(headers) && headers.length > 0) existing.headers = headers;
    } else {
      this.knownSheetDetails.push({
        name: sheetName.trim(),
        headers: Array.isArray(headers) ? headers : [],
        totalRows: 0
      });
    }
  }

  async getSpreadsheetContext() {
    if (!this.spreadsheetUrl || !this.spreadsheetUrl.startsWith('http')) {
      return {
        promptContext: 'Google Spreadsheet belum dikonfigurasi untuk nomor ini.',
        sheets: []
      };
    }

    try {
      const fetched = await fetchSpreadsheetSheets(this.spreadsheetUrl, this.knownSheetDetails);
      if (Array.isArray(fetched.sheets) && fetched.sheets.length > 0) {
        const map = new Map();
        for (const s of (this.knownSheetDetails || [])) {
          if (s && s.name) map.set(s.name.toLowerCase().trim(), s);
        }
        for (const s of (fetched.sheetDetails || [])) {
          if (s && s.name) map.set(s.name.toLowerCase().trim(), s);
        }
        for (const name of fetched.sheets) {
          const lower = name.toLowerCase().trim();
          if (!map.has(lower)) {
            map.set(lower, { name: name.trim(), headers: [], totalRows: 0 });
          }
        }
        this.knownSheetDetails = Array.from(map.values());
      }
    } catch (e) {}

    if (!this.knownSheetDetails || this.knownSheetDetails.length === 0) {
      this.knownSheetDetails = [
        { name: this.sheetName || 'Sheet1', headers: [], totalRows: 0 }
      ];
    }

    const currentSheet = this.sheetName || 'Sheet1';
    const sheetListDesc = this.knownSheetDetails.map((s, idx) => {
      const headerStr = (Array.isArray(s.headers) && s.headers.length > 0)
        ? ` (Kolom: ${s.headers.join(', ')})`
        : '';
      return `${idx + 1}. "${s.name}"${headerStr}`;
    }).join('\n    ');

    const promptContext = `[STATUS GOOGLE SPREADSHEET TERHUBUNG]:
- Spreadsheet Web App URL: ${this.spreadsheetUrl}
- Sheet Aktif Saat Ini: "${currentSheet}"
- Daftar Sheet yang Ada di Spreadsheet:
    ${sheetListDesc}

[PANDUAN & KEMAMPUAN GOOGLE SPREADSHEET]:
Anda memiliki integrasi langsung dan otomatis ke Google Spreadsheet pengguna.
Patuhi aturan berikut dengan cermat:

1. DAFTAR SHEET:
   - Jika pengguna bertanya tentang daftar/list sheet (misal "ada sheet apa saja?", "list sheet", "tampilkan sheet", "lihat daftar sheet"), sebutkan SEMUA nama sheet di atas beserta rincian kolomnya secara rapi dan bersahabat. Tanyakan sheet mana yang ingin dibuka atau diisi data.

2. MEMBUAT SHEET BARU:
   - Pengguna bebas membuat sheet baru di spreadsheet sebanyak-banyaknya kapan saja (misal "buat sheet Jadwal Ngopi", "bikin sheet baru Pengeluaran", "tambahkan di sheet baru", dll).
   - Tentukan nama sheet yang spesifik dan jelas sesuai topik.
   - Rancang kolom tabel (headers) yang rapi, profesional, dan relevan dengan topik (misal: ["No", "Hari/Tanggal", "Waktu", "Kegiatan/Menu", "Lokasi", "Catatan"]).
   - Jawab pengguna bahwa sheet baru telah dibuat, sebutkan rincian kolom yang dibuat, dan berikan contoh cara menginputkan data ke sheet tersebut.
   - Sertakan tag perintah:
<<<SPREADSHEET_ACTION
{
  "action": "create_sheet",
  "sheet": "Nama Sheet Baru",
  "headers": ["Kolom1", "Kolom2", "Kolom3", ...]
}
>>>

3. MEMANDU INPUT DATA KE SHEET TERTENTU:
   - Jika pengguna menyatakan ingin mengisi data pada sheet tertentu (misal "saya mau isi data di sheet Jadwal Ngopi" atau "mau input pengeluaran"), sebutkan rincian kolom data yang dibutuhkan untuk sheet tersebut serta berikan contoh format pengisian yang mudah agar pengguna tinggal mengetik datanya.

4. MENYUSUN & MENGINPUT DATA TABEL:
   - Ketika pengguna mengirimkan data (baik sesuai contoh maupun dalam kalimat santai/sehari-hari), ekstrak data tersebut menjadi baris tabel terstruktur yang rapi sesuai kolom-kolom sheet yang dituju.
   - Jawab pengguna dengan konfirmasi ramah beserta ringkasan data yang baru tersimpan.
   - Sertakan tag perintah:
<<<SPREADSHEET_ACTION
{
  "action": "append_rows",
  "sheet": "Nama Sheet",
  "rows": [
    ["NilaiKolom1", "NilaiKolom2", "NilaiKolom3", ...]
  ]
}
>>>

5. MEMBERSIHKAN / MENGOSONGKAN / MERESET SHEET:
   - Jika pengguna meminta untuk membersihkan, mengosongkan, menghapus isi, atau mereset data pada sheet tertentu (misal: "bersihkan Sheet1", "kosongkan sheet Jadwal Ngopi", "hapus data di sheet...", "reset isi tabel"), Anda MEMILIKI KEMAMPUAN LENGKAP untuk melakukannya secara otomatis!
   - JANGAN PERNAH menolak dengan mengatakan fitur belum tersedia atau menyuruh pengguna menghapus manual di spreadsheet!
   - Jawab pengguna dengan ramah bahwa seluruh data pada sheet tersebut telah berhasil dibersihkan/dikosongkan.
   - Sertakan tag perintah:
<<<SPREADSHEET_ACTION
{
  "action": "clear",
  "sheet": "Nama Sheet Yang Dikosongkan"
}
>>>

6. ATURAN PENTING:
   - JANGAN PERNAH menyimpan obrolan biasa atau riwayat percakapan chat ke dalam spreadsheet!
   - Tag <<<SPREADSHEET_ACTION ... >>> HANYA disertakan jika ada aksi spreadsheet nyata (membuat sheet, memasukkan baris data tabel, atau membersihkan sheet). Tag ini akan otomatis diproses dan disembunyikan dari WhatsApp pengguna.`;

    return { promptContext, sheets: this.knownSheetDetails.map(s => s.name) };
  }

  loadChatHistory() {
    try {
      const file = path.join(SESSIONS_DIR, `${this.id}_history.json`);
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        this.chatHistory = JSON.parse(raw);
        if (!Array.isArray(this.chatHistory)) this.chatHistory = [];
      }
    } catch (e) {
      console.warn(`[${this.name}] Gagal membaca file chat history:`, e.message);
      this.chatHistory = [];
    }
  }

  saveChatHistory() {
    try {
      const file = path.join(SESSIONS_DIR, `${this.id}_history.json`);
      fs.writeFileSync(file, JSON.stringify(this.chatHistory, null, 2), 'utf8');
    } catch (e) {
      console.warn(`[${this.name}] Gagal menyimpan file chat history:`, e.message);
    }
  }

  addChatMessage(entry) {
    if (!this.chatHistory) this.chatHistory = [];
    this.chatHistory.push(entry);
    if (this.chatHistory.length > 120) {
      this.chatHistory = this.chatHistory.slice(-120);
    }
    this.saveChatHistory();
  }

  clearChatHistory() {
    this.chatHistory = [];
    this.saveChatHistory();
  }

  updateConfig(updates) {
    if (updates.name !== undefined) this.name = updates.name.trim();
    if (updates.geminiApiKey !== undefined) {
      const trimmed = updates.geminiApiKey.trim();
      // Jangan timpa jika user mengirimkan string yang disamarkan (...)
      if (!trimmed.includes('...')) {
        this.geminiApiKey = trimmed;
      }
    }
    if (updates.geminiModel !== undefined) this.geminiModel = updates.geminiModel;
    if (updates.systemPrompt !== undefined) this.systemPrompt = updates.systemPrompt;
    if (updates.spreadsheetUrl !== undefined) this.spreadsheetUrl = updates.spreadsheetUrl.trim();
    if (updates.sheetName !== undefined) this.sheetName = updates.sheetName.trim() || 'Sheet1';
    if (updates.respondMode !== undefined) this.respondMode = updates.respondMode;
  }

  getPublicStatus() {
    return {
      id: this.id,
      name: this.name,
      phone: this.phone,
      lid: this.getMyLid(),
      connected: this.isConnected,
      hasQR: !this.isConnected && !!this.currentQR,
      qr: !this.isConnected ? this.currentQR : null,
      geminiApiKey: this.geminiApiKey || '',
      maskedApiKey: this.geminiApiKey ? (this.geminiApiKey.slice(0, 6) + '...' + this.geminiApiKey.slice(-4)) : '',
      hasCustomApiKey: !!this.geminiApiKey,
      geminiModel: this.geminiModel,
      systemPrompt: this.systemPrompt,
      spreadsheetUrl: this.spreadsheetUrl,
      sheetName: this.sheetName,
      knownSheetDetails: this.knownSheetDetails || [],
      respondMode: this.respondMode,
      createdAt: this.createdAt
    };
  }

  getFullConfig() {
    return {
      id: this.id,
      name: this.name,
      phone: this.phone,
      lid: this.getMyLid(),
      connected: this.isConnected,
      geminiApiKey: this.geminiApiKey || '',
      geminiModel: this.geminiModel,
      systemPrompt: this.systemPrompt,
      spreadsheetUrl: this.spreadsheetUrl,
      sheetName: this.sheetName,
      knownSheetDetails: this.knownSheetDetails || [],
      respondMode: this.respondMode,
      createdAt: this.createdAt
    };
  }

  async sendBotMessage(targetJid, content) {
    try {
      if (!this.sock) return null;
      let sent = null;
      try {
        sent = await this.sock.sendMessage(targetJid, content);
      } catch (err) {
        if (targetJid.endsWith('@lid') && this.phone) {
          const fallbackJid = `${this.phone}@s.whatsapp.net`;
          console.warn(`[${this.name}] Gagal kirim ke ${targetJid}, mencoba fallback ke ${fallbackJid}...`);
          sent = await this.sock.sendMessage(fallbackJid, content);
        } else {
          throw err;
        }
      }
      if (sent?.key?.id) {
        this.sentBotMessageIds.add(sent.key.id);
        if (this.sentBotMessageIds.size > 2000) {
          const it = this.sentBotMessageIds.values();
          for (let i = 0; i < 500; i++) this.sentBotMessageIds.delete(it.next().value);
        }
      }
      if (content.text) {
        this.recentBotReplies.push(content.text.trim());
        if (this.recentBotReplies.length > 50) this.recentBotReplies.shift();
      }
      return sent;
    } catch (e) {
      console.error(`[${this.name}] Gagal mengirim pesan bot:`, e.message);
      return null;
    }
  }

  async initSocket() {
    if (this.sock || this.isConnecting) return;
    this.isConnecting = true;

    clearTimeout(this.reconnectTimer);

    const sessionAuthDir = path.join(SESSIONS_DIR, this.id);
    if (!fs.existsSync(sessionAuthDir)) {
      fs.mkdirSync(sessionAuthDir, { recursive: true });
    }

    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionAuthDir);

      let version = [2, 3000, 1043857760];
      try {
        const fetched = await fetchLatestBaileysVersion();
        if (fetched && fetched.version) version = fetched.version;
      } catch (e) {
        // Fallback version aman jika koneksi offline/timeout
      }

      console.log(`🚀 [${this.name}] Memulai engine Baileys v${version.join('.')}...`);

      const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.windows('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
      });

      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.currentQR = qr;
          console.log(`📱 [${this.name}] QR Code baru tersedia!`);
        }

        if (connection === 'close') {
          this.isConnected = false;
          this.isConnecting = false;
          this.currentQR = null;

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`⚠️ [${this.name}] Koneksi terputus (Status: ${statusCode || 'Unknown'}). Reconnect: ${shouldReconnect}`);

          if (statusCode === DisconnectReason.loggedOut) {
            console.log(`🔴 [${this.name}] Sesi di-logout. Menghapus auth folder...`);
            if (fs.existsSync(sessionAuthDir)) {
              try { fs.rmSync(sessionAuthDir, { recursive: true, force: true }); } catch (e) {}
            }
            this.phone = null;
            this.sock = null;
            persistAllSessions();
          } else if (shouldReconnect) {
            this.sock = null;
            const delayMs = statusCode === DisconnectReason.restartRequired ? 1000 : 3500;
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.initSocket(), delayMs);
          }
        } else if (connection === 'open') {
          this.isConnected = true;
          this.isConnecting = false;
          this.currentQR = null;

          const rawId = sock.user?.id || '';
          this.phone = rawId.split(':')[0].split('@')[0].replace(/\D/g, '');

          const rawLid = sock.user?.lid || sock.authState?.creds?.me?.lid || '';
          if (rawLid) {
            this.lid = rawLid.split(':')[0].split('@')[0].replace(/\D/g, '');
          }

          console.log(`\n🎉 ================================================`);
          console.log(`🟢 [${this.name}] WHATSAPP BERHASIL TERSAMBUNG!`);
          console.log(`📱 Nomor: +${this.phone}${this.lid ? ` (LID: ${this.lid})` : ''}`);
          console.log(`🛡️ Mode Respons: ${this.respondMode === 'all_private' ? 'Semua Chat Pribadi (CS)' : 'Hanya Chat Sendiri (Message Yourself)'}`);
          console.log(`🤖 AI Model: ${this.geminiModel}`);
          console.log(`📊 Spreadsheet: ${this.spreadsheetUrl ? (this.sheetName || 'Sheet1') : 'Belum Dikonfigurasi'}`);
          console.log(`================================================\n`);

          persistAllSessions();
        }
      });

      // ─── Incoming Message Handler ─────────────────────────────
      sock.ev.on('messages.upsert', async (upsert) => {
        try {
          // Terima baik 'notify' (pesan baru dari lawan chat) maupun 'append' (pesan dari HP sendiri / chat ke diri sendiri)
          if (upsert.type !== 'notify' && upsert.type !== 'append') return;

          const myPhone = this.phone || (sock.user?.id || '').split(':')[0].split('@')[0].replace(/\D/g, '');
          if (!myPhone) return;

          const myLid = this.getMyLid();

          for (const msg of upsert.messages) {
            if (!msg.message) continue;

            const jid = msg.key.remoteJid;
            if (!jid) continue;

            // 1. ATURAN WAJIB: Jangan balas di Grup, Status Story, atau Broadcast!
            if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid === 'status@broadcast') {
              continue;
            }

            // 2. Abaikan jika pesan ini berasal dari pengiriman bot sendiri
            if (msg.key.id && this.sentBotMessageIds.has(msg.key.id)) {
              continue;
            }

            // Ambil teks pesan dengan unwrap pesan lengkap (ephemeral, viewOnce, dll)
            const text = extractMessageText(msg.message);
            if (!text) continue;

            // Anti-loop: abaikan jika teks persis sama dengan balasan bot terakhir
            if (this.recentBotReplies.includes(text)) {
              continue;
            }

            // Abaikan pesan backlog lama dari masa lalu sebelum bot aktif (misal sync riwayat HP)
            const msgTimestampSec = Number(msg.messageTimestamp) || 0;
            if (msgTimestampSec > 0 && this.startupTimestampSec > 0) {
              if (msgTimestampSec < (this.startupTimestampSec - 120)) {
                continue;
              }
            }

            const rawTargetId = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
            const realPhone = this.resolvePhoneFromJid(jid);

            // Deteksi apakah pesan ini adalah chat ke diri sendiri (Message Yourself / You):
            // 1. Target ID cocok dengan nomor HP akun ini
            // 2. Target ID cocok dengan WhatsApp LID akun ini (@lid)
            // 3. realPhone cocok dengan nomor HP akun ini
            // 4. fromMe = true dan jid mengarah ke diri sendiri (nomor HP atau LID)
            const isChatWithSelf = (rawTargetId === myPhone) ||
                                   (myLid && rawTargetId === myLid) ||
                                   (realPhone === myPhone) ||
                                   (msg.key.fromMe && (rawTargetId === myPhone || (myLid && rawTargetId === myLid) || realPhone === myPhone));

            // Filter mode respons akun
            if (this.respondMode === 'self') {
              // HANYA BALAS DI CHAT DENGAN DIRI SENDIRI (Message Yourself)
              if (!isChatWithSelf) {
                console.log(`ℹ️ [${this.name}] Pesan dari +${realPhone || rawTargetId} diabaikan (Mode Respons: Hanya Chat Sendiri).`);
                continue;
              }
            } else {
              // Mode 'all_private' / 'all' (Semua Chat Pribadi):
              // Abaikan jika pemilik nomor mengetik chat keluar ke orang lain, KECUALI jika kirim ke diri sendiri
              if (msg.key.fromMe && !isChatWithSelf) {
                continue;
              }
            }

            const senderLabel = isChatWithSelf ? `Diri Sendiri (+${myPhone})` : `+${realPhone || rawTargetId}`;
            console.log(`📩 [${this.name} | +${myPhone}] Pesan masuk dari ${senderLabel}: "${text}"`);

            // Jalankan AI & Spreadsheet Handler
            await this.processMessage(jid, text, isChatWithSelf ? myPhone : (realPhone || rawTargetId));
          }
        } catch (err) {
          console.error(`[${this.name}] Error handling message:`, err);
        }
      });

    } catch (err) {
      console.error(`[${this.name}] Error in initSocket:`, err);
      this.isConnecting = false;
      this.sock = null;
    }
  }

  async processMessage(jid, userText, senderPhone) {
    const apiKey = this.geminiApiKey || getGlobalApiKey();
    if (!apiKey) {
      await this.sendBotMessage(jid, {
        text: `⚠️ *[${this.name}]* Gemini API Key belum dikonfigurasi di dashboard aplikasi web. Silakan masukkan API Key di dashboard terlebih dahulu.`
      });
      return;
    }

    try {
      await this.sock.sendPresenceUpdate('composing', jid);

      // Catat pesan pengguna dari WhatsApp ke riwayat chat sesi ini
      this.addChatMessage({
        role: 'user',
        content: userText,
        timestamp: Date.now(),
        sender: senderPhone || this.phone,
        source: 'whatsapp'
      });

      // 0. Deteksi otomatis jika pengguna mengirim URL Google Apps Script Web App langsung lewat WhatsApp
      const scriptUrlMatch = userText.match(/https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec[^\s]*/i);
      if (scriptUrlMatch) {
        const detectedUrl = scriptUrlMatch[0].trim();
        console.log(`🔗 [${this.name}] Mendeteksi pengiriman URL Apps Script dari user: ${detectedUrl}`);
        
        try {
          const testPingUrl = `${detectedUrl}${detectedUrl.includes('?') ? '&' : '?'}action=ping&sheet=Sheet1`;
          const pingRes = await fetch(testPingUrl, { redirect: 'follow' });
          const pingText = await pingRes.text();
          let pingData = null;
          try { pingData = JSON.parse(pingText); } catch (e) {}

          if (pingData && pingData.status === 'success') {
            this.spreadsheetUrl = detectedUrl;
            persistAllSessions();
            
            const sheetList = Array.isArray(pingData.sheets) && pingData.sheets.length > 0
              ? pingData.sheets.map((s, i) => `${i + 1}. *${s}*`).join('\n')
              : '1. *Sheet1*';

            const confirmMsg = `✅ *Google Spreadsheet Berhasil Dihubungkan!*\n\n` +
              `📊 *Judul Dokumen:* ${pingData.title || 'Google Spreadsheet'}\n` +
              `📑 *Daftar Sheet Tersedia:*\n${sheetList}\n\n` +
              `Sekarang Anda bisa meminta saya untuk:\n` +
              `• Melihat daftar sheet (*"Tampilkan daftar sheet"*)\n` +
              `• Membuat sheet baru (*"Buat sheet baru namanya Jadwal Ngopi"*)\n` +
              `• Mencatat data ke sheet pilihan (*"Saya mau catat data ke sheet..."*)\n\n` +
              `Ada yang ingin Anda catat atau kelola sekarang, Bos? 🚀`;

            await this.sendBotMessage(jid, { text: confirmMsg });
            this.addChatMessage({
              role: 'model',
              content: confirmMsg,
              timestamp: Date.now(),
              source: 'whatsapp'
            });
            return;
          }
        } catch (linkErr) {
          console.error(`[${this.name}] Gagal memvalidasi link Apps Script:`, linkErr.message);
        }
      }

      // Deteksi jika user mengirim URL docs.google.com/spreadsheets biasa
      const docsUrlMatch = userText.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+[^\s]*/i);
      if (docsUrlMatch && !scriptUrlMatch) {
        const guideMsg = `ℹ️ *Tautan Google Spreadsheet Diterima*\n\n` +
          `Untuk menghubungkan spreadsheet agar AI dapat membaca dan menulis data secara otomatis, sistem membutuhkan **URL Web App Google Apps Script** (yang berakhiran */exec*), bukan link dokumen spreadsheet biasa.\n\n` +
          `*Cara Mendapatkan Link Web App /exec:*\n` +
          `1. Buka spreadsheet Anda di laptop/komputer.\n` +
          `2. Klik menu *Ekstensi* (Extensions) > *Apps Script*.\n` +
          `3. Tempelkan script integrasi AN Cheat.\n` +
          `4. Klik tombol biru *Deploy* (Terapkan) > *Penerapan baru* (New deployment).\n` +
          `5. Pilih jenis *Aplikasi Web* (Web app).\n` +
          `6. Pastikan opsi *Yang memiliki akses* (Who has access) diatur ke: *"Siapa saja"* (Anyone).\n` +
          `7. Klik *Deploy* dan salin link yang berakhiran */exec*, lalu kirimkan link tersebut ke sini.`;

        await this.sendBotMessage(jid, { text: guideMsg });
        this.addChatMessage({
          role: 'model',
          content: guideMsg,
          timestamp: Date.now(),
          source: 'whatsapp'
        });
        return;
      }

      // Siapkan prompt Gemini spesifik akun ini
      let systemInstruction = this.systemPrompt || DEFAULT_SYSTEM_PROMPT;
      if (this.spreadsheetUrl) {
        const sheetContext = await this.getSpreadsheetContext();
        systemInstruction += `\n\n${sheetContext.promptContext}`;
      }
      systemInstruction += `\n\n[Panduan Komunikasi]: Bersikaplah ramah, bersahabat, cerdas, dan solutif. Anda adalah asisten khusus untuk nomor ini (${this.name}). Layani percakapan santai, brainstorming, maupun pengelolaan dan pencatatan data ke Google Spreadsheet sesuai kebutuhan pemilik nomor ini.`;

      // Siapkan riwayat percakapan sebelumnya untuk konteks multi-turn
      const recentTurns = (this.chatHistory || []).slice(-8);
      const contents = [];
      for (const turn of recentTurns) {
        if (turn.role && turn.content) {
          contents.push({
            role: turn.role === 'user' ? 'user' : 'model',
            parts: [{ text: turn.content }]
          });
        }
      }
      // Pastikan turn terakhir adalah userText jika belum masuk
      if (contents.length === 0 || contents[contents.length - 1].parts[0].text !== userText) {
        contents.push({ role: 'user', parts: [{ text: userText }] });
      }

      // Panggil Gemini AI dengan fallback model otomatis
      const aiResult = await callGeminiSafe({
        apiKey,
        model: this.geminiModel,
        systemInstruction,
        userText,
        contents
      });

      if (!aiResult.success) {
        console.error(`[${this.name}] Gemini AI Error:`, aiResult.error);
        await this.sendBotMessage(jid, {
          text: `❌ *[${this.name} AI Error]* Gagal memproses: ${aiResult.error}`
        });
        return;
      }

      const rawAiText = aiResult.text || 'Maaf, tidak ada respons dari AI.';

      // Deteksi dan ekstrak SPREADSHEET_ACTION jika ada
      const actionRegex = /<<<SPREADSHEET_ACTION\s*([\s\S]*?)\s*>>>/i;
      const match = rawAiText.match(actionRegex);
      let replyText = rawAiText.replace(actionRegex, '').trim();
      let spreadsheetAction = null;

      if (match && match[1]) {
        try {
          spreadsheetAction = JSON.parse(match[1]);
        } catch (parseErr) {
          console.error(`[${this.name}] Gagal parse SPREADSHEET_ACTION JSON:`, parseErr.message, match[1]);
        }
      }

      // Eksekusi aksi spreadsheet secara nyata di latar belakang
      if (spreadsheetAction && this.spreadsheetUrl) {
        try {
          const act = spreadsheetAction.action;
          const targetSheet = spreadsheetAction.sheet || this.sheetName || 'Sheet1';

          if (act === 'create_sheet' || act === 'create_table') {
            const headers = Array.isArray(spreadsheetAction.headers) ? spreadsheetAction.headers : [];
            const rows = Array.isArray(spreadsheetAction.rows) ? spreadsheetAction.rows : [];
            await createSpreadsheetSheet(this.spreadsheetUrl, targetSheet, headers, rows);
            console.log(`📊 [${this.name}] Berhasil membuat sheet "${targetSheet}" di Spreadsheet!`);
            this.addKnownSheet(targetSheet, headers);
            this.sheetName = targetSheet;
            persistAllSessions();
          } else if (act === 'append_rows' || act === 'append') {
            const rows = Array.isArray(spreadsheetAction.rows)
              ? spreadsheetAction.rows
              : (spreadsheetAction.row ? [spreadsheetAction.row] : []);
            if (rows.length > 0) {
              await appendSpreadsheetRows(this.spreadsheetUrl, targetSheet, rows);
              console.log(`📊 [${this.name}] Berhasil menambah ${rows.length} baris data ke sheet "${targetSheet}"!`);
              this.addKnownSheet(targetSheet);
              this.sheetName = targetSheet;
              persistAllSessions();
            }
          } else if (act === 'clear' || act === 'clear_sheet') {
            await clearSpreadsheetSheet(this.spreadsheetUrl, targetSheet);
            console.log(`📊 [${this.name}] Berhasil membersihkan sheet "${targetSheet}"!`);
            this.addKnownSheet(targetSheet, []);
            persistAllSessions();
          }
        } catch (sheetErr) {
          console.error(`[${this.name}] Gagal mengeksekusi SPREADSHEET_ACTION:`, sheetErr.message);
        }
      }

      // ⚡ 1. LANGSUNG kirim balasan bersih (tanpa tag SPREADSHEET_ACTION) ke WhatsApp
      await this.sendBotMessage(jid, { text: replyText });
      console.log(`⚡ [${this.name}] Balasan AI terkirim ke +${senderPhone || 'Self'} (Model: ${aiResult.usedModel})!`);

      // ⚡ 2. Catat balasan AI ke riwayat chat sesi ini
      this.addChatMessage({
        role: 'model',
        content: replyText,
        timestamp: Date.now(),
        model: aiResult.usedModel,
        source: 'whatsapp'
      });

    } catch (err) {
      console.error(`[${this.name}] Error processing message:`, err);
      await this.sendBotMessage(jid, {
        text: `❌ *[${this.name}]* Terjadi kesalahan: ${err.message}`
      });
    }
  }

  async disconnect() {
    this.isConnected = false;
    this.isConnecting = false;
    this.currentQR = null;
    this.phone = null;

    clearTimeout(this.reconnectTimer);

    if (this.sock) {
      try { await this.sock.logout(); } catch (e) {}
      try { this.sock.end(); } catch (e) {}
      this.sock = null;
    }

    const sessionAuthDir = path.join(SESSIONS_DIR, this.id);
    if (fs.existsSync(sessionAuthDir)) {
      try { fs.rmSync(sessionAuthDir, { recursive: true, force: true }); } catch (e) {}
    }

    persistAllSessions();
  }
}

// ─── Gemini Safe Caller with Automatic Model Fallback ─────────
async function callGeminiSafe({ apiKey, model, systemInstruction, userText, contents }) {
  // Model kandidat berurutan: model yang dipilih pengguna, lalu model stabil yang aktif
  const candidateModels = [
    model,
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.8-flash',
    'gemini-flash-lite-latest',
    'gemini-flash-latest'
  ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

  let lastError = null;

  for (const m of candidateModels) {
    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
      const payloadContents = (Array.isArray(contents) && contents.length > 0)
        ? contents
        : [{ role: 'user', parts: [{ text: userText }] }];

      const payload = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: payloadContents,
        generationConfig: {
          maxOutputTokens: 1000,
          temperature: 0.35
        }
      };

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const json = await response.json();
        const replyText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (replyText) {
          return { success: true, text: replyText, usedModel: m };
        }
      }

      const errText = await response.text();
      lastError = `HTTP ${response.status}: ${errText.slice(0, 160)}`;

      // Jika 404 (model not found / deprecated), lanjut ke model berikutnya
      if (response.status === 404) {
        console.warn(`[Gemini API] Model "${m}" 404 Not Found, beralih ke fallback...`);
        continue;
      }

      // Jika API Key tidak valid, jangan spam coba lagi
      if (errText.includes('API_KEY_INVALID') || errText.includes('API key not valid')) {
        return { success: false, error: 'API Key Gemini tidak valid. Periksa kembali di Google AI Studio.' };
      }
    } catch (e) {
      lastError = e.message;
    }
  }

  return { success: false, error: lastError || 'Gagal menghubungi Gemini API.' };
}

// ─── Google Spreadsheet Client Helpers with Redirect Following ────────
async function fetchSpreadsheetSheets(spreadsheetUrl, existingDetails = []) {
  if (!spreadsheetUrl || !spreadsheetUrl.startsWith('http')) {
    return { sheets: ['Sheet1'], sheetDetails: [{ name: 'Sheet1', headers: [], totalRows: 0 }] };
  }

  try {
    const url = `${spreadsheetUrl}${spreadsheetUrl.includes('?') ? '&' : '?'}action=list_sheets`;
    const res = await fetch(url, { redirect: 'follow' });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}

    if (data && Array.isArray(data.sheets) && data.sheets.length > 0) {
      return {
        sheets: data.sheets,
        sheetDetails: Array.isArray(data.sheetDetails)
          ? data.sheetDetails
          : data.sheets.map(s => ({ name: s, headers: [], totalRows: 0 }))
      };
    }
  } catch (e) {}

  const sheetNames = (existingDetails && existingDetails.length > 0)
    ? existingDetails.map(d => d.name || d)
    : ['Sheet1', 'Jadwal Ngopi'];
  const uniqueNames = Array.from(new Set(sheetNames.filter(Boolean)));
  return {
    sheets: uniqueNames,
    sheetDetails: uniqueNames.map(name => {
      const found = existingDetails.find(d => (d.name || d) === name);
      return typeof found === 'object' ? found : { name, headers: [], totalRows: 0 };
    })
  };
}

async function createSpreadsheetSheet(spreadsheetUrl, sheetName, headers = [], rows = []) {
  if (!spreadsheetUrl || !spreadsheetUrl.startsWith('http')) {
    throw new Error('URL Spreadsheet belum diisi.');
  }

  const payload = {
    action: 'create_table',
    sheet: sheetName || 'Sheet1',
    headers: headers,
    rows: rows
  };

  const response = await fetch(spreadsheetUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}

  if (!response.ok && (!json || json.status === 'error')) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 150)}`);
  }

  return json || { status: 'success' };
}

async function appendSpreadsheetRows(spreadsheetUrl, sheetName, rows = []) {
  if (!spreadsheetUrl || !spreadsheetUrl.startsWith('http')) {
    throw new Error('URL Spreadsheet belum diisi.');
  }

  if (!Array.isArray(rows) || rows.length === 0) return { status: 'success', count: 0 };

  // 1. Coba kirim batch action append_rows
  try {
    const batchPayload = {
      action: 'append_rows',
      sheet: sheetName || 'Sheet1',
      rows: rows
    };

    const res = await fetch(spreadsheetUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchPayload)
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}

    if (json && json.status === 'success') {
      return json;
    }
  } catch (err) {}

  // 2. Fallback untuk script versi lama: loop per baris dengan action 'append'
  let lastResult = null;
  for (const row of rows) {
    const rowPayload = {
      action: 'append',
      sheet: sheetName || 'Sheet1',
      row: Array.isArray(row) ? row : [row]
    };

    const res = await fetch(spreadsheetUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rowPayload)
    });

    const text = await res.text();
    try { lastResult = JSON.parse(text); } catch (e) { lastResult = { status: 'success' }; }
  }

  return lastResult || { status: 'success', count: rows.length };
}

async function appendSpreadsheetRow(spreadsheetUrl, sheetName, rowData) {
  return await appendSpreadsheetRows(spreadsheetUrl, sheetName, [rowData]);
}

async function clearSpreadsheetSheet(spreadsheetUrl, sheetName) {
  if (!spreadsheetUrl || !spreadsheetUrl.startsWith('http')) return null;

  const payload = {
    action: 'clear',
    sheet: sheetName || 'Sheet1'
  };

  const response = await fetch(spreadsheetUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return json || { status: 'success' };
}

// ─── Helpers ──────────────────────────────────────────────────
function getGlobalApiKey() {
  // Cek sesi-sesi yang ada terlebih dahulu
  for (const s of activeSessions.values()) {
    if (s.geminiApiKey) return s.geminiApiKey;
  }

  // Fallback ke config.json jika ada
  try {
    if (fs.existsSync(LEGACY_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, 'utf-8'));
      if (cfg.geminiApiKey) return cfg.geminiApiKey;
    }
  } catch (e) {}

  return '';
}

function persistAllSessions() {
  const arr = Array.from(activeSessions.values()).map(s => ({
    id: s.id,
    name: s.name,
    phone: s.phone,
    geminiApiKey: s.geminiApiKey,
    geminiModel: s.geminiModel,
    systemPrompt: s.systemPrompt,
    spreadsheetUrl: s.spreadsheetUrl,
    sheetName: s.sheetName,
    knownSheetDetails: s.knownSheetDetails || [],
    respondMode: s.respondMode,
    createdAt: s.createdAt
  }));
  saveSessionsData(arr);
}

// Inisialisasi semua sesi dari file saat startup
function initAllSessions() {
  const data = loadSessionsData();
  for (const meta of data) {
    if (!activeSessions.has(meta.id)) {
      const instance = new SessionInstance(meta);
      activeSessions.set(meta.id, instance);
      instance.initSocket();
    }
  }
}

// ─── Express App Setup ───────────────────────────────────────
const app = express();

// Full CORS & Chrome Private Network Access (PNA) Support
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// 0. Health check endpoint untuk testing koneksi dari InfinityFree / remote frontend
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'AN Cheat WhatsApp Server',
    version: '2.0.0',
    time: new Date().toISOString(),
    sessionsCount: activeSessions.size,
    cors: true
  });
});

// 1. Dapatkan daftar semua sesi WhatsApp (ringkasan public)
app.get('/api/sessions', (req, res) => {
  const list = Array.from(activeSessions.values()).map(s => s.getPublicStatus());
  res.json({ status: 'success', sessions: list });
});

// 2. Buat sesi WhatsApp baru (+ Tambah Nomor Baru dengan AI & Spreadsheet sendiri)
app.post('/api/sessions/create', async (req, res) => {
  try {
    const {
      name,
      geminiApiKey,
      geminiModel,
      systemPrompt,
      spreadsheetUrl,
      sheetName,
      respondMode
    } = req.body || {};

    const newId = 'session_' + Date.now();
    const sessionName = name && name.trim() ? name.trim() : `Nomor WA ${activeSessions.size + 1}`;

    const newMeta = {
      id: newId,
      name: sessionName,
      phone: null,
      geminiApiKey: (geminiApiKey || '').trim(),
      geminiModel: geminiModel || 'gemini-3.5-flash-lite',
      systemPrompt: systemPrompt || DEFAULT_SYSTEM_PROMPT,
      spreadsheetUrl: (spreadsheetUrl || '').trim(),
      sheetName: (sheetName || '').trim() || 'Sheet1',
      respondMode: respondMode || 'self',
      createdAt: Date.now()
    };

    const instance = new SessionInstance(newMeta);
    activeSessions.set(newId, instance);
    persistAllSessions();

    // Mulai socket agar QR code segera siap
    instance.initSocket();

    console.log(`➕ [Sesi Baru Dibuat]: ID=${newId}, Nama="${sessionName}", AI="${instance.geminiModel}", Sheet="${instance.sheetName}"`);
    res.json({ status: 'success', session: instance.getPublicStatus() });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 3. Ambil status sesi spesifik
app.get('/api/sessions/:id/status', (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }
  res.json({ status: 'success', session: instance.getPublicStatus() });
});

// 4. Ambil full config sesi spesifik (termasuk API key asli untuk diedit)
app.get('/api/sessions/:id/config', (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }
  res.json({ status: 'success', config: instance.getFullConfig() });
});

// 5. Ambil QR Code sesi spesifik
app.get('/api/sessions/:id/qr', async (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }

  if (instance.isConnected) {
    return res.json({ status: 'connected', phone: instance.phone });
  }

  if (!instance.sock && !instance.isConnecting) {
    await instance.initSocket();
  }

  let attempts = 0;
  while (!instance.currentQR && !instance.isConnected && attempts < 20) {
    await new Promise(r => setTimeout(r, 350));
    attempts++;
  }

  if (instance.isConnected) {
    return res.json({ status: 'connected', phone: instance.phone });
  }

  if (instance.currentQR) {
    return res.json({ status: 'qr', qr: instance.currentQR });
  }

  return res.json({ status: 'waiting', message: 'Sedang menyiapkan QR Code WhatsApp...' });
});

// 6. Request Pairing Code (OTP) untuk sesi spesifik
app.post('/api/sessions/:id/pair', async (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }

  const { phone } = req.body || {};
  if (!phone) {
    return res.status(400).json({ status: 'error', message: 'Nomor telepon harus diisi.' });
  }

  let cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '62' + cleanPhone.slice(1);
  }
  if (cleanPhone.length < 9) {
    return res.status(400).json({ status: 'error', message: 'Nomor telepon tidak valid (minimal 9 digit).' });
  }

  if (instance.isConnected) {
    return res.json({ status: 'connected', phone: instance.phone });
  }

  if (!instance.sock && !instance.isConnecting) {
    await instance.initSocket();
  }

  let attempts = 0;
  while ((!instance.sock || instance.isConnecting) && attempts < 25) {
    await new Promise(r => setTimeout(r, 350));
    attempts++;
  }

  if (!instance.sock) {
    return res.status(500).json({ status: 'error', message: 'Gagal menginisialisasi WhatsApp Baileys.' });
  }

  try {
    console.log(`📲 [${instance.name}] Meminta Pairing Code untuk +${cleanPhone}...`);
    await delay(1500);
    const code = await instance.sock.requestPairingCode(cleanPhone);
    instance.pairingCodeRequested = code;

    console.log(`✅ [${instance.name}] Kode Pairing: ${code}`);
    return res.json({
      status: 'success',
      code,
      phone: cleanPhone,
      instruction: 'Buka WhatsApp di HP Anda > Perangkat Tertaut > Tautkan dengan nomor telepon > Masukkan kode di atas.'
    });
  } catch (err) {
    console.error(`[${instance.name}] Error pairing code:`, err);
    return res.status(500).json({ status: 'error', message: err.message || 'Gagal membuat kode pairing.' });
  }
});

// 7. Update konfigurasi sesi spesifik (Nama, AI, Spreadsheet, RespondMode)
app.post('/api/sessions/:id/update', (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }

  instance.updateConfig(req.body);
  persistAllSessions();
  console.log(`⚙️ [${instance.name}] Konfigurasi berhasil diperbarui: AI=${instance.geminiModel}, Sheet=${instance.sheetName}`);
  res.json({ status: 'success', session: instance.getPublicStatus() });
});

// 8. Uji Coba AI spesifik sesi ini
app.post('/api/sessions/:id/test-ai', async (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }

  const apiKey = instance.geminiApiKey || getGlobalApiKey();
  if (!apiKey) {
    return res.status(400).json({ status: 'error', message: 'Gemini API Key belum diisi untuk nomor ini atau secara global.' });
  }

  const testPrompt = req.body?.prompt || 'Halo! Perkenalkan diri Anda secara singkat dalam 1 kalimat sesuai persona Anda.';
  const systemInstruction = instance.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  const result = await callGeminiSafe({
    apiKey,
    model: instance.geminiModel,
    systemInstruction,
    userText: testPrompt
  });

  if (result.success) {
    res.json({ status: 'success', reply: result.text, modelUsed: result.usedModel });
  } else {
    res.status(500).json({ status: 'error', message: result.error });
  }
});

// 8.1 Chat AI endpoint untuk Antarmuka Web UI Chat AI
app.post('/api/sessions/:id/chat', async (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi WhatsApp tidak ditemukan.' });
  }

  const { message, history } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ status: 'error', message: 'Pesan tidak boleh kosong.' });
  }

  const apiKey = instance.geminiApiKey || getGlobalApiKey();
  if (!apiKey) {
    return res.status(400).json({ status: 'error', message: 'Gemini API Key belum dikonfigurasi. Atur di tab Pengaturan API.' });
  }

  let fullInstruction = instance.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  if (instance.spreadsheetUrl) {
    const sheetContext = await instance.getSpreadsheetContext();
    fullInstruction += `\n\n${sheetContext.promptContext}`;
  }
  fullInstruction += `\n\n[Panduan Gaya]: Bersikaplah ramah, cerdas, kreatif, dan luwes. Anda sangat terbuka untuk diajak ngobrol santai, bertukar pikiran/brainstorming ide, maupun membantu spreadsheet secara terstruktur sesuai kebutuhan pengguna.`;

  // Prioritaskan riwayat sesi backend, gabungkan dengan history jika ada
  const combinedHistory = (instance.chatHistory && instance.chatHistory.length > 0)
    ? instance.chatHistory
    : (Array.isArray(history) ? history : []);

  // Format chat contents
  const contents = [];
  const recent = combinedHistory.slice(-8);
  for (const h of recent) {
    if (h.role && h.content) {
      contents.push({
        role: h.role === 'user' ? 'user' : 'model',
        parts: [{ text: h.content }]
      });
    }
  }
  contents.push({ role: 'user', parts: [{ text: message.trim() }] });

  const result = await callGeminiSafe({
    apiKey,
    model: instance.geminiModel,
    systemInstruction: fullInstruction,
    userText: message.trim(),
    contents
  });

  if (result.success) {
    const rawAiText = result.text || '';
    const actionRegex = /<<<SPREADSHEET_ACTION\s*([\s\S]*?)\s*>>>/i;
    const match = rawAiText.match(actionRegex);
    let replyText = rawAiText.replace(actionRegex, '').trim();
    let spreadsheetAction = null;

    if (match && match[1]) {
      try {
        spreadsheetAction = JSON.parse(match[1]);
      } catch (parseErr) {}
    }

    if (spreadsheetAction && instance.spreadsheetUrl) {
      try {
        const act = spreadsheetAction.action;
        const targetSheet = spreadsheetAction.sheet || instance.sheetName || 'Sheet1';

        if (act === 'create_sheet' || act === 'create_table') {
          const headers = Array.isArray(spreadsheetAction.headers) ? spreadsheetAction.headers : [];
          const rows = Array.isArray(spreadsheetAction.rows) ? spreadsheetAction.rows : [];
          await createSpreadsheetSheet(instance.spreadsheetUrl, targetSheet, headers, rows);
          instance.addKnownSheet(targetSheet, headers);
          instance.sheetName = targetSheet;
          persistAllSessions();
        } else if (act === 'append_rows' || act === 'append') {
          const rows = Array.isArray(spreadsheetAction.rows)
            ? spreadsheetAction.rows
            : (spreadsheetAction.row ? [spreadsheetAction.row] : []);
          if (rows.length > 0) {
            await appendSpreadsheetRows(instance.spreadsheetUrl, targetSheet, rows);
            instance.addKnownSheet(targetSheet);
            instance.sheetName = targetSheet;
            persistAllSessions();
          }
        } else if (act === 'clear' || act === 'clear_sheet') {
          await clearSpreadsheetSheet(instance.spreadsheetUrl, targetSheet);
          console.log(`📊 [${instance.name}] Web chat: Berhasil membersihkan sheet "${targetSheet}"!`);
          instance.addKnownSheet(targetSheet, []);
          persistAllSessions();
        }
      } catch (sheetErr) {
        console.error(`[${instance.name}] Web chat spreadsheet action error:`, sheetErr.message);
      }
    }

    // Simpan percakapan web ke riwayat sesi
    instance.addChatMessage({
      role: 'user',
      content: message.trim(),
      timestamp: Date.now(),
      source: 'web'
    });
    instance.addChatMessage({
      role: 'model',
      content: replyText,
      timestamp: Date.now(),
      model: result.usedModel,
      source: 'web'
    });

    res.json({
      status: 'success',
      reply: replyText,
      modelUsed: result.usedModel,
      spreadsheetUrl: instance.spreadsheetUrl,
      sheetName: instance.sheetName
    });
  } else {
    res.status(500).json({ status: 'error', message: result.error });
  }
});

// 10b. Dapatkan riwayat percakapan sesi spesifik (WhatsApp + Web)
app.get('/api/sessions/:id/chat-history', (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }
  res.json({
    status: 'success',
    sessionId: instance.id,
    sessionName: instance.name,
    history: instance.chatHistory || []
  });
});

// 10c. Reset riwayat percakapan sesi spesifik
app.post('/api/sessions/:id/chat-history/reset', (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }
  instance.clearChatHistory();
  console.log(`🧹 [${instance.name}] Riwayat chat AI berhasil direset.`);
  res.json({
    status: 'success',
    message: `Riwayat chat untuk nomor "${instance.name}" berhasil direset.`,
    history: []
  });
});

// 8.2 Fallback Chat endpoint umum
app.post('/api/chat', async (req, res) => {
  const primary = getPrimarySession();
  if (!primary) {
    return res.status(400).json({ status: 'error', message: 'Tidak ada sesi WhatsApp aktif.' });
  }
  req.params.id = primary.id;
  // Forward to /api/sessions/:id/chat logic
  const apiKey = primary.geminiApiKey || getGlobalApiKey();
  if (!apiKey) {
    return res.status(400).json({ status: 'error', message: 'Gemini API Key belum dikonfigurasi.' });
  }

  const { message, history } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ status: 'error', message: 'Pesan tidak boleh kosong.' });
  }

  let fullInstruction = primary.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  if (primary.spreadsheetUrl) {
    fullInstruction += `\n\n[Konfigurasi Spreadsheet Aktif]: URL=${primary.spreadsheetUrl}, Sheet=${primary.sheetName}`;
  }

  const contents = [];
  if (Array.isArray(history)) {
    const recent = history.slice(-6);
    for (const h of recent) {
      if (h.role && h.content) {
        contents.push({
          role: h.role === 'user' ? 'user' : 'model',
          parts: [{ text: h.content }]
        });
      }
    }
  }
  contents.push({ role: 'user', parts: [{ text: message.trim() }] });

  const result = await callGeminiSafe({
    apiKey,
    model: primary.geminiModel,
    systemInstruction: fullInstruction,
    userText: message.trim(),
    contents
  });

  if (result.success) {
    res.json({
      status: 'success',
      reply: result.text,
      modelUsed: result.usedModel
    });
  } else {
    res.status(500).json({ status: 'error', message: result.error });
  }
});

// 9. Uji Coba Spreadsheet spesifik sesi ini
app.post('/api/sessions/:id/test-sheet', async (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }

  if (!instance.spreadsheetUrl) {
    return res.status(400).json({ status: 'error', message: 'URL Google Spreadsheet belum diisi untuk nomor ini.' });
  }

  try {
    const nowStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const row = [nowStr, `Test Koneksi dari ${instance.name}`, 'Status: Berhasil Terkoneksi 🟢'];
    const result = await appendSpreadsheetRow(instance.spreadsheetUrl, instance.sheetName, row);
    res.json({ status: 'success', message: `Berhasil mencatat baris uji coba ke sheet "${instance.sheetName}"!`, detail: result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 9b. Dapatkan daftar sheet dari spreadsheet sesi ini
app.get('/api/sessions/:id/sheets', async (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }

  if (!instance.spreadsheetUrl) {
    return res.status(400).json({ status: 'error', message: 'URL Google Spreadsheet belum diisi untuk nomor ini.' });
  }

  try {
    const info = await instance.getSpreadsheetContext();
    res.json({
      status: 'success',
      activeSheet: instance.sheetName || 'Sheet1',
      sheets: info.sheets,
      sheetDetails: instance.knownSheetDetails || []
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 9c. Baca data sheet spesifik sesi ini (Proxy aman dari CORS browser)
app.get('/api/sessions/:id/sheet-data', async (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }
  if (!instance.spreadsheetUrl) {
    return res.status(400).json({ status: 'error', message: 'URL Spreadsheet belum diisi.' });
  }

  const sheet = req.query.sheet || instance.sheetName || 'Sheet1';
  try {
    const fetchUrl = `${instance.spreadsheetUrl}${instance.spreadsheetUrl.includes('?') ? '&' : '?'}action=read&sheet=${encodeURIComponent(sheet)}`;
    const upstream = await fetch(fetchUrl, { redirect: 'follow' });
    const text = await upstream.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    res.json(json || { status: 'success', headers: [], rows: [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 9d. Proxy ping / uji URL Apps Script apa pun (untuk testing koneksi dari UI tanpa CORS)
app.post('/api/test-spreadsheet-url', async (req, res) => {
  const { url, sheetName } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ status: 'error', message: 'URL Google Apps Script tidak valid.' });
  }

  const targetSheet = sheetName || 'Sheet1';
  try {
    const pingUrl = `${url}${url.includes('?') ? '&' : '?'}action=ping&sheet=${encodeURIComponent(targetSheet)}`;
    const upstream = await fetch(pingUrl, { redirect: 'follow' });
    const text = await upstream.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}

    if (json && json.status === 'success') {
      return res.json(json);
    }

    // Coba baca action=read jika action=ping belum ada di script lama
    const readUrl = `${url}${url.includes('?') ? '&' : '?'}action=read&sheet=${encodeURIComponent(targetSheet)}`;
    const readUpstream = await fetch(readUrl, { redirect: 'follow' });
    const readText = await readUpstream.text();
    let readJson = null;
    try { readJson = JSON.parse(readText); } catch (e) {}
    if (readJson && readJson.status === 'success') {
      return res.json(readJson);
    }

    res.status(400).json({
      status: 'error',
      message: 'Web App Apps Script merespons tetapi tidak mengembalikan format sukses yang diharapkan.',
      raw: text.slice(0, 200)
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 10. Putuskan koneksi sesi spesifik
app.post('/api/sessions/:id/disconnect', async (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }

  await instance.disconnect();
  console.log(`🔴 [${instance.name}] Berhasil diputuskan.`);

  // Auto-restart socket agar siap pairing kembali jika diinginkan
  setTimeout(() => instance.initSocket(), 1000);
  res.json({ status: 'success', message: `WhatsApp [${instance.name}] berhasil diputuskan.` });
});

// 11. Hapus sesi spesifik secara permanen
app.delete('/api/sessions/:id', async (req, res) => {
  const instance = activeSessions.get(req.params.id);
  if (!instance) {
    return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan.' });
  }

  if (activeSessions.size <= 1) {
    return res.status(400).json({ status: 'error', message: 'Minimal harus ada 1 slot akun WhatsApp tersisa.' });
  }

  await instance.disconnect();
  activeSessions.delete(req.params.id);

  const sessionAuthDir = path.join(SESSIONS_DIR, req.params.id);
  if (fs.existsSync(sessionAuthDir)) {
    try { fs.rmSync(sessionAuthDir, { recursive: true, force: true }); } catch (e) {}
  }

  const historyFile = path.join(SESSIONS_DIR, `${req.params.id}_history.json`);
  if (fs.existsSync(historyFile)) {
    try { fs.unlinkSync(historyFile); } catch (e) {}
  }

  persistAllSessions();
  console.log(`🗑️ [Sesi Dihapus]: ID=${req.params.id}`);
  res.json({ status: 'success', message: 'Sesi berhasil dihapus.' });
});

// ─── Legacy API Compatibility ────────────────────────────────
function getPrimarySession() {
  const it = activeSessions.values().next();
  return it.value || null;
}

app.get('/api/wa/status', (req, res) => {
  const primary = getPrimarySession();
  if (!primary) return res.json({ connected: false, phone: null, hasQR: false, qr: null });
  res.json({
    connected: primary.isConnected,
    phone: primary.phone,
    hasQR: !primary.isConnected && !!primary.currentQR,
    qr: !primary.isConnected ? primary.currentQR : null
  });
});

app.get('/api/wa/qr', async (req, res) => {
  const primary = getPrimarySession();
  if (!primary) return res.json({ status: 'error', message: 'Tidak ada sesi aktif.' });
  if (primary.isConnected) return res.json({ status: 'connected', phone: primary.phone });
  if (!primary.sock && !primary.isConnecting) await primary.initSocket();

  let attempts = 0;
  while (!primary.currentQR && !primary.isConnected && attempts < 20) {
    await new Promise(r => setTimeout(r, 350));
    attempts++;
  }
  if (primary.isConnected) return res.json({ status: 'connected', phone: primary.phone });
  if (primary.currentQR) return res.json({ status: 'qr', qr: primary.currentQR });
  return res.json({ status: 'waiting', message: 'Sedang menyiapkan QR Code...' });
});

app.post('/api/wa/pair', async (req, res) => {
  const primary = getPrimarySession();
  if (!primary) return res.status(500).json({ status: 'error', message: 'Tidak ada sesi aktif.' });
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ status: 'error', message: 'Nomor telepon harus diisi.' });
  const cleanPhone = phone.replace(/\D/g, '');
  if (primary.isConnected) return res.json({ status: 'connected', phone: primary.phone });
  if (!primary.sock && !primary.isConnecting) await primary.initSocket();

  let attempts = 0;
  while ((!primary.sock || primary.isConnecting) && attempts < 25) {
    await new Promise(r => setTimeout(r, 350));
    attempts++;
  }
  if (!primary.sock) return res.status(500).json({ status: 'error', message: 'Gagal inisialisasi socket.' });

  try {
    await delay(1500);
    const code = await primary.sock.requestPairingCode(cleanPhone);
    return res.json({ status: 'success', code, phone: cleanPhone });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/wa/disconnect', async (req, res) => {
  const primary = getPrimarySession();
  if (!primary) return res.json({ status: 'success' });
  await primary.disconnect();
  setTimeout(() => primary.initSocket(), 1000);
  res.json({ status: 'success', message: 'WhatsApp berhasil diputuskan.' });
});

app.get('/api/config', (req, res) => {
  const primary = getPrimarySession();
  if (!primary) return res.json({});
  res.json({
    geminiApiKey: primary.geminiApiKey,
    geminiModel: primary.geminiModel,
    spreadsheetUrl: primary.spreadsheetUrl,
    sheetName: primary.sheetName,
    systemPrompt: primary.systemPrompt
  });
});

app.post('/api/config', (req, res) => {
  const primary = getPrimarySession();
  if (primary) {
    primary.updateConfig(req.body);
    persistAllSessions();
  }
  res.json({ status: 'success' });
});

// ─── Start Express Server ────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n====================================================`);
  console.log(`🟢 AN CHEAT MULTI-SESSION - SERVER AKTIF DI http://localhost:${PORT}`);
  console.log(`📊 Mendukung Banyak Nomor WA dengan AI & Spreadsheet Mandiri.`);
  console.log(`🛡️ Fitur Keamanan: Crash Protection & Auto Reconnect Aktif.`);
  console.log(`====================================================\n`);

  // Mulai semua sesi yang terdaftar
  initAllSessions();
});
