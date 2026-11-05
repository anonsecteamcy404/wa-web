const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ============================================================================
// 0. PATCH GLOBAL NODE.JS UNTUK BUG WA WEB 2.3000.x (_serialized -> $1 = Error "r")
// ============================================================================
if (!Object.getOwnPropertyDescriptor(Object.prototype, '_serialized')) {
    Object.defineProperty(Object.prototype, '_serialized', {
        get() {
            if (this && typeof this.$1 === 'string') return this.$1;
            if (this && this.user && this.server) return `${this.user}@${this.server}`;
            if (this && typeof this.fromMe === 'boolean' && this.remote && this.id) {
                const rem = typeof this.remote === 'string' ? this.remote : (this.remote.$1 || `${this.remote.user}@${this.remote.server}`);
                const part = this.participant ? '_' + (typeof this.participant === 'string' ? this.participant : (this.participant.$1 || `${this.participant.user}@${this.participant.server}`)) : '';
                return `${this.fromMe}_${rem}_${this.id}${part}`;
            }
            return undefined;
        },
        set(val) {
            Object.defineProperty(this, '_serialized', {
                value: val,
                writable: true,
                enumerable: true,
                configurable: true
            });
        },
        configurable: true
    });
}

// ============================================================================
// 1. GLOBAL GUARD ANTI-CRASH UNTUK NODE.JS & PUPPETEER
// ============================================================================
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (
        msg.includes('Execution context was destroyed') ||
        msg.includes('Target closed') ||
        msg.includes('Protocol error') ||
        msg.includes('Session closed')
    ) {
        return;
    }
    console.error('[Unhandled Rejection]:', msg);
});

process.on('uncaughtException', (err) => {
    const msg = err?.message || String(err);
    if (
        msg.includes('Execution context was destroyed') ||
        msg.includes('Target closed') ||
        msg.includes('Protocol error')
    ) {
        return;
    }
    console.error('[Uncaught Exception]:', msg);
});

const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

const io = new Server(server, {
    maxHttpBufferSize: 100 * 1024 * 1024,
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(express.static('public'));
app.use('/exports', express.static('exports'));

app.get('/ping', (req, res) => {
    res.json({ ok: true, status: 'WhatsApp iGlass Backend Active', tunnel: publicTunnelUrl });
});

const EXPORT_DIR = path.join(__dirname, 'exports');
const MEDIA_DIR = path.join(EXPORT_DIR, 'media');
const CHAT_DIR = path.join(EXPORT_DIR, 'chats');

[EXPORT_DIR, MEDIA_DIR, CHAT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

let config = {
    autoExportChat: true,
    autoExportMedia: true
};

let callLogs = [];
let statusStore = [];
let isReady = false;
let currentQr = null;
let publicTunnelUrl = null;

function getBrowserExecutablePath() {
    const paths = [
        '/data/data/com.termux/files/usr/bin/chromium-browser',
        '/data/data/com.termux/files/usr/bin/chromium',
        process.env.PREFIX ? `${process.env.PREFIX}/bin/chromium-browser` : '',
        process.env.PREFIX ? `${process.env.PREFIX}/bin/chromium` : '',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium'
    ].filter(Boolean);

    for (const p of paths) {
        if (fs.existsSync(p)) {
            console.log(`[Browser] Menggunakan browser di: ${p}`);
            return p;
        }
    }
    return undefined;
}

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'iglass-v2'
    }),
    bypassCSP: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    puppeteer: {
        headless: true,
        executablePath: getBrowserExecutablePath(),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--disable-features=IsolateOrigins,site-per-process',
            '--blink-settings=imagesEnabled=true'
        ]
    }
});

// ============================================================================
// 2. PATCH CLIENT.INJECT & SAFEEVALUATE
// ============================================================================
const originalInject = client.inject.bind(client);
let isInjecting = false;

client.inject = async function (...args) {
    if (isInjecting) return;
    isInjecting = true;
    try {
        await originalInject(...args);
        setTimeout(() => injectWhatsAppPatches().catch(() => {}), 500);
    } catch (err) {
        const msg = err?.message || String(err);
        if (!msg.includes('Execution context was destroyed') && !msg.includes('Target closed')) {
            console.error('[Inject Error]:', msg);
        }
    } finally {
        isInjecting = false;
    }
};

async function safeEvaluate(pageFn, ...args) {
    if (!client.pupPage || client.pupPage.isClosed()) return null;
    try {
        return await client.pupPage.evaluate(pageFn, ...args);
    } catch (err) {
        const msg = err?.message || String(err);
        if (msg.includes('Execution context was destroyed')) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                return await client.pupPage.evaluate(pageFn, ...args);
            } catch {
                return null;
            }
        }
        return null;
    }
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 KB';
    const k = 1024;
    if (bytes < k * k) return Math.max(1, Math.round(bytes / k)) + ' KB';
    return (bytes / (k * k)).toFixed(1) + ' MB';
}

function getInitials(name) {
    if (!name) return 'WA';
    const clean = String(name).replace(/[^a-zA-Z0-9\s]/g, '').trim();
    if (!clean) return 'WA';
    const parts = clean.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return clean.substring(0, 2).toUpperCase();
}

// ============================================================================
// 3. PATCH INTERNAL WHATSAPP WEB 2026 (FIX ERROR "r" / _serialized -> $1)
// ============================================================================
async function injectWhatsAppPatches() {
    await safeEvaluate(() => {
        // 1. Polyfill Global _serialized -> $1 di dalam Browser WA Web (Solusi Utama Error "r")
        if (!Object.getOwnPropertyDescriptor(Object.prototype, '_serialized')) {
            Object.defineProperty(Object.prototype, '_serialized', {
                get() {
                    if (this && typeof this.$1 === 'string') return this.$1;
                    if (this && this.user && this.server) return `${this.user}@${this.server}`;
                    if (this && typeof this.fromMe === 'boolean' && this.remote && this.id) {
                        const rem = typeof this.remote === 'string' ? this.remote : (this.remote._serialized || this.remote.$1 || `${this.remote.user}@${this.remote.server}`);
                        const part = this.participant ? '_' + (typeof this.participant === 'string' ? this.participant : (this.participant._serialized || this.participant.$1 || `${this.participant.user}@${this.participant.server}`)) : '';
                        return `${this.fromMe}_${rem}_${this.id}${part}`;
                    }
                    return undefined;
                },
                set(val) {
                    Object.defineProperty(this, '_serialized', {
                        value: val,
                        writable: true,
                        enumerable: true,
                        configurable: true
                    });
                },
                configurable: true
            });
        }

        // 2. Pastikan window.onCodeReceivedEvent tersedia untuk Pairing Code 8 Digit
        if (typeof window.onCodeReceivedEvent !== 'function') {
            window.onCodeReceivedEvent = (code) => code;
        }

        // 3. Patch Status Gating
        try {
            const gatingMod = window.require('WAWebStatusGatingUtils');
            if (gatingMod && typeof gatingMod.canCheckStatusRankingPosterGating !== 'function') {
                gatingMod.canCheckStatusRankingPosterGating = () => false;
            }
        } catch (e) {}

        // 4. Patch sendSeen
        if (window.WWebJS && window.WWebJS.sendSeen) {
            const origSendSeen = window.WWebJS.sendSeen;
            window.WWebJS.sendSeen = async (chatId) => {
                try {
                    return await origSendSeen(chatId);
                } catch (e) {
                    return true;
                }
            };
        }

        // 5. Patch getMessageModel agar selalu menyertakan id._serialized
        if (window.WWebJS && window.WWebJS.getMessageModel) {
            const origGetMsg = window.WWebJS.getMessageModel;
            window.WWebJS.getMessageModel = (message) => {
                const res = origGetMsg(message);
                if (res && res.id && !res.id._serialized) {
                    res.id._serialized = res.id.$1 || message?.id?._serialized || message?.id?.$1;
                }
                return res;
            };
        }
    });
}

async function getRealProfilePic(jid) {
    if (!isReady || !jid) return null;
    const url = await safeEvaluate(async (targetId) => {
        try {
            const Store = window.Store;
            if (!Store || !Store.ProfilePicThumb) return null;

            const userNum = String(targetId).split('@')[0].split(':')[0];
            const models = Store.ProfilePicThumb.getModelsArray ? Store.ProfilePicThumb.getModelsArray() : (Store.ProfilePicThumb.models || []);

            for (const m of models) {
                const mId = m.id?._serialized || m.id?.$1 || m.id?.user || String(m.id || '');
                if (mId === targetId || mId.includes(userNum)) {
                    if (m.eurl || m.imgFull || m.img) return m.eurl || m.imgFull || m.img;
                }
            }

            const wid = Store.WidFactory.createWid(targetId);
            await Store.ProfilePicThumb.find(wid).catch(() => {});
            const found = Store.ProfilePicThumb.get(wid) || Store.ProfilePicThumb.get(targetId);
            if (found && (found.eurl || found.imgFull || found.img)) {
                return found.eurl || found.imgFull || found.img;
            }
            return null;
        } catch {
            return null;
        }
    }, jid);

    return url || null;
}

async function getRealAbout(jid) {
    if (!isReady || !jid) return '';
    const about = await safeEvaluate(async (targetId) => {
        try {
            const Store = window.Store;
            const wid = Store.WidFactory.createWid(targetId);
            if (Store.StatusUtils && Store.StatusUtils.getStatus) {
                const res = await Store.StatusUtils.getStatus(wid).catch(() => null);
                if (res && res.status) return res.status;
            }
            const contact = Store.Contact.get(wid);
            if (contact && contact.statusMute) return contact.statusMute;
            return '';
        } catch {
            return '';
        }
    }, jid);

    return about || '';
}

// ============================================================================
// 4. EVENT UTAMA WHATSAPP CLIENT (QR & KODE 8 DIGIT NOMOR HP)
// ============================================================================
client.on('qr', async (qr) => {
    await injectWhatsAppPatches();
    console.log('[WA] QR Code siap! Scan di web atau gunakan tab Pakai Nomor HP (Kode 8 Digit).');
    currentQr = await qrcode.toDataURL(qr);
    io.emit('qr', currentQr);
});

client.on('authenticated', () => {
    console.log('[WA] Autentikasi berhasil!');
    io.emit('auth_status', 'Autentikasi berhasil! Mengimpor seluruh riwayat chat...');
});

client.on('ready', async () => {
    isReady = true;
    currentQr = null;

    await injectWhatsAppPatches();
    console.log('[WA] WhatsApp iGlass Siap & Terhubung Stabil!');

    const profile = await getFullProfile();
    io.emit('ready', profile);

    // Kirim daftar chat langsung & ulangi beberapa detik kemudian saat sinkronisasi riwayat selesai
    await sendRealChats();
    setTimeout(() => sendRealChats().catch(() => {}), 4000);
    setTimeout(() => sendRealChats().catch(() => {}), 9000);

    await syncRealStatuses();
    sendExportedFiles();
});

// Handler Pesan Baru Tanpa Memanggil msg.getChat() (Bebas Error "r")
client.on('message_create', async (msg) => {
    try {
        await injectWhatsAppPatches();

        const rawFrom = msg.from || msg._data?.from?._serialized || msg._data?.from?.$1 || '';
        const rawTo = msg.to || msg._data?.to?._serialized || msg._data?.to?.$1 || '';

        if (rawFrom === 'status@broadcast' || rawTo === 'status@broadcast' || msg.isStatusV3) {
            await handleIncomingStatus(msg);
            return;
        }

        const chatId = msg.fromMe ? rawTo : rawFrom;
        if (!chatId) return;

        // Ambil nama chat langsung dari Store.Chat tanpa msg.getChat()
        const chatName = await safeEvaluate((cId) => {
            const c = window.Store?.Chat?.get(cId);
            return c ? (c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || cId.split('@')[0]) : cId.split('@')[0];
        }, chatId) || chatId.split('@')[0];

        const savedMedia = await processAutoExportDirect(msg, chatId, chatName);
        const msgIdStr = msg.id?._serialized || msg.id?.$1 || `${msg.fromMe}_${chatId}_${msg.id?.id || Date.now()}`;
        const time = new Date((msg.timestamp || Math.floor(Date.now() / 1000)) * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

        const durSec = msg._data?.duration || 0;
        const formattedMsg = {
            id: msgIdStr,
            body: msg.body || msg._data?.caption || '',
            fromMe: Boolean(msg.fromMe),
            time: time,
            timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
            type: msg.type || 'chat',
            hasMedia: Boolean(msg.hasMedia),
            mediaUrl: savedMedia ? savedMedia.url : null,
            mimetype: savedMedia ? savedMedia.mimetype : (msg._data?.mimetype || null),
            fileName: savedMedia ? savedMedia.fileName : (msg._data?.filename || 'File'),
            fileSize: savedMedia ? savedMedia.size : formatBytes(msg._data?.size || 0),
            duration: `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, '0')}`,
            reactions: []
        };

        io.emit('new_message', {
            chatId: chatId,
            chatName: chatName,
            message: formattedMsg
        });

        await sendRealChats();
    } catch (err) {
        // Jangan biarkan error pesan menggagalkan proses
    }
});

client.on('call', async (call) => {
    const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    callLogs.unshift({
        id: call.id,
        from: String(call.from || '').replace('@c.us', ''),
        isVideo: call.isVideo,
        time: time
    });
    io.emit('call_logs', callLogs);
});

async function getFullProfile() {
    try {
        const wid = client.info?.wid?._serialized || client.info?.wid?.$1 || `${client.info?.wid?.user}@c.us`;
        const name = client.info?.pushname || 'WhatsApp User';
        const number = client.info?.wid?.user || '-';
        const platform = client.info?.platform || 'WhatsApp';

        const picUrl = await getRealProfilePic(wid);
        const about = await getRealAbout(wid);

        return {
            name,
            number,
            wid,
            platform,
            picUrl,
            initials: getInitials(name),
            about: about || 'Ada',
            battery: 100,
            tunnelUrl: publicTunnelUrl
        };
    } catch (e) {
        return { name: 'User', number: '-', platform: 'Web', battery: 100, initials: 'WA' };
    }
}

// ============================================================================
// AMBIL SEMUA DAFTAR CHAT (TERMASUK CHAT LAMA SEBELUM TERTAUT)
// ============================================================================
async function sendRealChats() {
    if (!isReady) return;
    try {
        const rawChats = await safeEvaluate(() => {
            try {
                const Store = window.Store;
                if (!Store || !Store.Chat) return [];

                const chats = Store.Chat.getModelsArray();
                const thumbModels = Store.ProfilePicThumb?.getModelsArray ? Store.ProfilePicThumb.getModelsArray() : [];

                return chats
                    .filter(c => {
                        const cid = c.id?._serialized || c.id?.$1 || '';
                        return cid && cid !== 'status@broadcast';
                    })
                    .sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || (b.t || 0) - (a.t || 0))
                    .slice(0, 120)
                    .map(c => {
                        const chatId = c.id?._serialized || c.id?.$1 || `${c.id.user}@${c.id.server}`;
                        const userNum = c.id?.user || chatId.split('@')[0];
                        const msgsArr = c.msgs?.getModelsArray ? c.msgs.getModelsArray() : [];
                        const lastMsg = msgsArr.length > 0 ? msgsArr[msgsArr.length - 1] : null;
                        const name = c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || userNum;

                        let picUrl = null;
                        const directThumb = Store.ProfilePicThumb.get(c.id) || Store.ProfilePicThumb.get(chatId);
                        if (directThumb && (directThumb.eurl || directThumb.imgFull || directThumb.img)) {
                            picUrl = directThumb.eurl || directThumb.imgFull || directThumb.img;
                        } else {
                            for (const m of thumbModels) {
                                const mId = m.id?._serialized || m.id?.$1 || String(m.id || '');
                                if (mId === chatId || mId.includes(userNum)) {
                                    if (m.eurl || m.imgFull || m.img) {
                                        picUrl = m.eurl || m.imgFull || m.img;
                                        break;
                                    }
                                }
                            }
                        }

                        return {
                            id: chatId,
                            user: userNum,
                            name: name,
                            picUrl: picUrl,
                            isGroup: Boolean(c.isGroup),
                            pinned: Boolean(c.pin),
                            unreadCount: c.unreadCount || 0,
                            timestamp: c.t || (lastMsg ? lastMsg.t : 0) || 0,
                            lastBody: lastMsg ? (lastMsg.body || lastMsg.caption || '') : '',
                            lastType: lastMsg ? (lastMsg.type || 'chat') : 'chat',
                            lastFromMe: lastMsg ? Boolean(lastMsg.id?.fromMe) : false,
                            lastDuration: lastMsg ? (lastMsg.duration || 0) : 0
                        };
                    });
            } catch (e) {
                return [];
            }
        });

        if (!rawChats) return;

        const chatList = rawChats.map(c => {
            const time = c.timestamp
                ? new Date(c.timestamp * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
                : '';

            let lastType = 'text';
            let lastBody = c.lastBody || '';

            if (c.lastType === 'ptt' || c.lastType === 'audio') {
                lastType = 'voice';
                if (!lastBody) lastBody = `Pesan Suara (${c.lastDuration || 0} dtk)`;
            } else if (c.lastType === 'image') {
                lastType = 'image';
                if (!lastBody) lastBody = '📷 Foto';
            } else if (c.lastType === 'video') {
                lastType = 'video';
                if (!lastBody) lastBody = '🎥 Video';
            } else if (c.lastType === 'document') {
                lastType = 'document';
                if (!lastBody) lastBody = '📄 Dokumen';
            } else if (c.lastFromMe) {
                lastType = 'sent';
            }

            return {
                id: c.id,
                user: c.user,
                name: c.name,
                initials: getInitials(c.name),
                picUrl: c.picUrl,
                isGroup: c.isGroup,
                pinned: c.pinned,
                unreadCount: c.unreadCount,
                timestamp: c.timestamp,
                time: time,
                lastType: lastType,
                lastMessage: lastBody
            };
        });

        io.emit('chats', chatList);

        setTimeout(async () => {
            for (let i = 0; i < Math.min(15, chatList.length); i++) {
                if (!chatList[i].picUrl) {
                    const url = await getRealProfilePic(chatList[i].id);
                    if (url) {
                        io.emit('chat_pic', { chatId: chatList[i].id, picUrl: url });
                    }
                }
            }
        }, 1200);
    } catch (err) {
        console.error('[Error sendRealChats]:', err.message);
    }
}

// ============================================================================
// BUKA CHAT & TARIK RIWAYAT PESAN LAMA LANGSUNG DARI STORE.CHAT (ANTI ERROR "r")
// ============================================================================
async function loadChatMessagesDirect(chatId, loadOlder = false) {
    if (!isReady || !chatId) return null;

    const result = await safeEvaluate(async (targetChatId, fetchOlder) => {
        try {
            const Store = window.Store;
            let chat = Store.Chat.get(targetChatId);
            if (!chat) {
                const wid = Store.WidFactory.createWid(targetChatId);
                chat = await Store.Chat.find(wid).catch(() => null);
            }
            if (!chat) return null;

            // Tarik riwayat pesan lama dari server/HP (Import History sebelum perangkat tertaut)
            const currentCount = chat.msgs ? chat.msgs.length : 0;
            if (fetchOlder || currentCount < 25) {
                try {
                    if (Store.ConversationMsgs && Store.ConversationMsgs.loadEarlierMsgs) {
                        await Store.ConversationMsgs.loadEarlierMsgs(chat).catch(() => {});
                        if (fetchOlder) {
                            await Store.ConversationMsgs.loadEarlierMsgs(chat).catch(() => {});
                        }
                    } else if (chat.msgs && chat.msgs.loadEarlierMsgs) {
                        await chat.msgs.loadEarlierMsgs().catch(() => {});
                    }
                } catch (e) {}
            }

            const name = chat.formattedTitle || chat.name || chat.contact?.name || chat.contact?.pushname || targetChatId.split('@')[0];
            const rawMsgs = chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : [];
            const sliceMsgs = rawMsgs.slice(-60);

            const messages = sliceMsgs
                .filter(m => m && m.type !== 'gp2' && m.type !== 'e2e_notification' && m.type !== 'notification_template')
                .map(m => {
                    const msgId = m.id?._serialized || m.id?.$1 || `${Boolean(m.id?.fromMe)}_${targetChatId}_${m.id?.id}`;
                    const ts = m.t || Math.floor(Date.now() / 1000);
                    const dur = m.duration || 0;
                    const hasMedia = Boolean(m.type === 'image' || m.type === 'video' || m.type === 'ptt' || m.type === 'audio' || m.type === 'document' || m.type === 'sticker' || m.mediaObject);

                    return {
                        id: msgId,
                        body: m.body || m.caption || '',
                        fromMe: Boolean(m.id?.fromMe),
                        timestamp: ts,
                        type: m.type || 'chat',
                        hasMedia: hasMedia,
                        mimetype: m.mimetype || null,
                        fileName: m.filename || 'File',
                        sizeBytes: m.size || 0,
                        durationSec: dur
                    };
                });

            return {
                chatId: targetChatId,
                name: name,
                isGroup: Boolean(chat.isGroup),
                messages: messages
            };
        } catch (err) {
            return null;
        }
    }, chatId, loadOlder);

    if (!result) return null;

    const picUrl = await getRealProfilePic(chatId);
    const about = result.isGroup ? 'Grup WhatsApp' : (await getRealAbout(chatId)) || 'Online di WhatsApp';
    const safeChatName = (result.name || 'chat').replace(/[^a-zA-Z0-9_-]/g, '_');

    const formattedMessages = [];
    for (let i = 0; i < result.messages.length; i++) {
        const m = result.messages[i];
        const time = new Date(m.timestamp * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        const mins = Math.floor((m.durationSec || 0) / 60);
        const secs = String((m.durationSec || 0) % 60).padStart(2, '0');

        let mediaUrl = null;
        let fileSize = formatBytes(m.sizeBytes);

        // Jika pesan punya media di 12 pesan terakhir, download otomatis agar tampil di layar
        if (m.hasMedia && i >= result.messages.length - 12) {
            const downloaded = await downloadMediaByMsgId(m.id, safeChatName, m.timestamp);
            if (downloaded) {
                mediaUrl = downloaded.url;
                fileSize = downloaded.size;
                m.mimetype = downloaded.mimetype || m.mimetype;
            }
        }

        // Simpan ke log chat (.txt)
        if (config.autoExportChat) {
            saveMessageLineToTxt(safeChatName, m.timestamp, m.fromMe ? 'Saya' : result.name, m.body || (m.hasMedia ? `[MEDIA: ${m.type}]` : ''));
        }

        formattedMessages.push({
            id: m.id,
            body: m.body,
            fromMe: m.fromMe,
            time: time,
            timestamp: m.timestamp,
            type: m.type,
            hasMedia: m.hasMedia,
            mediaUrl: mediaUrl,
            mimetype: m.mimetype,
            fileName: m.fileName,
            fileSize: fileSize,
            duration: `${mins}:${secs}`,
            reactions: []
        });
    }

    sendExportedFiles();

    return {
        chatId: result.chatId,
        name: result.name,
        initials: getInitials(result.name),
        picUrl: picUrl,
        statusInfo: about,
        isGroup: result.isGroup,
        messages: formattedMessages
    };
}

function saveMessageLineToTxt(safeChatName, timestamp, sender, text) {
    try {
        const txtPath = path.join(CHAT_DIR, `${safeChatName}.txt`);
        const timeStr = new Date(timestamp * 1000).toLocaleString('id-ID');
        const line = `[${timeStr}] ${sender}: ${text}\n`;
        if (fs.existsSync(txtPath)) {
            const existing = fs.readFileSync(txtPath, 'utf8');
            if (existing.includes(line)) return;
        }
        fs.appendFileSync(txtPath, line, 'utf8');
    } catch {}
}

// Download Media Langsung Berdasarkan ID Pesan di Store.Msg
async function downloadMediaByMsgId(msgId, safeChatName, timestamp) {
    try {
        // Cek apakah file sudah pernah di-download
        const shortId = String(msgId).slice(-8).replace(/[^a-zA-Z0-9]/g, '');
        const existingFiles = fs.readdirSync(MEDIA_DIR);
        const matchFile = existingFiles.find(f => f.includes(`_${timestamp}_${shortId}`));
        if (matchFile) {
            const st = fs.statSync(path.join(MEDIA_DIR, matchFile));
            return {
                url: `/exports/media/${matchFile}`,
                size: formatBytes(st.size),
                mimetype: null
            };
        }

        const mediaData = await safeEvaluate(async (targetMsgId) => {
            try {
                const msg = window.Store.Msg.get(targetMsgId);
                if (!msg) return null;
                if (window.WWebJS && window.WWebJS.downloadMedia) {
                    return await window.WWebJS.downloadMedia(targetMsgId).catch(() => null);
                }
                return null;
            } catch {
                return null;
            }
        }, msgId);

        if (mediaData && mediaData.data) {
            let ext = (mediaData.mimetype.split('/')[1] || 'bin').split(';')[0];
            if (ext === 'ogg') ext = 'ogg';
            if (ext === 'jpeg') ext = 'jpg';

            const fileName = `${safeChatName}_${timestamp}_${shortId}.${ext}`;
            const filePath = path.join(MEDIA_DIR, fileName);
            fs.writeFileSync(filePath, mediaData.data, 'base64');
            const stat = fs.statSync(filePath);

            return {
                url: `/exports/media/${fileName}`,
                mimetype: mediaData.mimetype,
                size: formatBytes(stat.size),
                fileName: mediaData.filename || fileName
            };
        }
    } catch {}
    return null;
}

async function processAutoExportDirect(msg, chatId, chatName) {
    try {
        const safeName = (chatName || 'chat').replace(/[^a-zA-Z0-9_-]/g, '_');
        const ts = msg.timestamp || Math.floor(Date.now() / 1000);
        const sender = msg.fromMe ? 'Saya' : (msg._data?.notifyName || chatName);

        if (config.autoExportChat) {
            saveMessageLineToTxt(safeName, ts, sender, msg.body || (msg.hasMedia ? `[MEDIA: ${msg.type}]` : ''));
        }

        if (msg.hasMedia && config.autoExportMedia) {
            const msgId = msg.id?._serialized || msg.id?.$1;
            if (msgId) {
                return await downloadMediaByMsgId(msgId, safeName, ts);
            }
        }
    } catch {}
    return null;
}

async function handleIncomingStatus(msg) {
    try {
        const authorId = msg.author || msg.from;
        let authorName = msg._data?.notifyName || String(authorId).split('@')[0];
        const picUrl = await getRealProfilePic(authorId);
        const msgId = msg.id?._serialized || msg.id?.$1 || 'st_' + Date.now();
        const ts = msg.timestamp || Math.floor(Date.now() / 1000);

        let mediaUrl = null;
        let mimetype = null;
        if (msg.hasMedia) {
            const saved = await downloadMediaByMsgId(msgId, 'Status_Story', ts);
            if (saved) {
                mediaUrl = saved.url;
                mimetype = saved.mimetype;
            }
        }

        const statusItem = {
            id: msgId,
            authorId: authorId,
            authorName: authorName,
            initials: getInitials(authorName),
            picUrl: picUrl,
            fromMe: msg.fromMe,
            type: msg.type,
            body: msg.body || '',
            mediaUrl: mediaUrl,
            mimetype: mimetype,
            color: '#059669',
            time: new Date(ts * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
            timestamp: ts
        };

        statusStore = [statusItem, ...statusStore.filter(s => s.id !== statusItem.id)].slice(0, 50);
        io.emit('statuses', statusStore);
    } catch (e) {}
}

async function syncRealStatuses() {
    if (!isReady) return;
    try {
        const rawStatuses = await safeEvaluate(() => {
            const list = [];
            try {
                const msgs = window.Store.Msg.getModelsArray().filter(m =>
                    m.isStatusV3 || (m.id?.remote?._serialized || m.id?.remote?.$1) === 'status@broadcast'
                );
                for (const m of msgs.slice(-25)) {
                    const authorId = m.author?._serialized || m.author?.$1 || m.author || '';
                    const contact = authorId ? window.Store.Contact.get(authorId) : null;
                    const name = contact?.name || contact?.pushname || m.notifyName || String(authorId).split('@')[0] || 'Kontak';
                    list.push({
                        id: m.id?._serialized || m.id?.$1 || String(Date.now()),
                        authorId: authorId,
                        authorName: name,
                        fromMe: Boolean(m.id?.fromMe),
                        type: m.type || 'chat',
                        body: m.body || m.caption || '',
                        timestamp: m.t || Math.floor(Date.now() / 1000)
                    });
                }
            } catch (e) {}
            return list;
        });

        if (!rawStatuses) return;

        for (const s of rawStatuses) {
            if (!statusStore.find(x => x.id === s.id)) {
                const picUrl = await getRealProfilePic(s.authorId);
                statusStore.push({
                    ...s,
                    initials: getInitials(s.authorName),
                    picUrl: picUrl,
                    mediaUrl: null,
                    mimetype: null,
                    color: '#0d9488',
                    time: new Date(s.timestamp * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
                });
            }
        }
        statusStore.sort((a, b) => b.timestamp - a.timestamp);
        io.emit('statuses', statusStore);
    } catch (err) {}
}

async function postStatusTextBypass(text, hexColor = '#059669') {
    const colorInt = parseInt('ff' + hexColor.replace('#', ''), 16);
    return await safeEvaluate(async (statusText, bgInt) => {
        try {
            const gating = window.require('WAWebStatusGatingUtils');
            if (gating && typeof gating.canCheckStatusRankingPosterGating !== 'function') {
                gating.canCheckStatusRankingPosterGating = () => false;
            }
        } catch (e) {}

        const statusAction = window.require('WAWebSendStatusMsgAction');
        if (statusAction && typeof statusAction.sendStatusTextMsgAction === 'function') {
            await statusAction.sendStatusTextMsgAction({
                color: bgInt,
                font: 0,
                text: statusText
            });
            return true;
        }
        throw new Error('Modul sendStatusTextMsgAction tidak ditemukan');
    }, text, colorInt);
}

function sendExportedFiles() {
    try {
        const chatFiles = fs.readdirSync(CHAT_DIR).map(f => {
            const st = fs.statSync(path.join(CHAT_DIR, f));
            return { name: f, url: `/exports/chats/${f}`, size: formatBytes(st.size), mtime: st.mtimeMs };
        }).sort((a, b) => b.mtime - a.mtime);

        const mediaFiles = fs.readdirSync(MEDIA_DIR).map(f => {
            const st = fs.statSync(path.join(MEDIA_DIR, f));
            return { name: f, url: `/exports/media/${f}`, size: formatBytes(st.size), mtime: st.mtimeMs };
        }).sort((a, b) => b.mtime - a.mtime);

        io.emit('exported_files', { chatFiles, mediaFiles });
    } catch {}
}

// ============================================================================
// 5. SOCKET.IO REAL-TIME HANDLERS
// ============================================================================
io.on('connection', async (socket) => {
    socket.emit('config', config);
    socket.emit('call_logs', callLogs);
    socket.emit('statuses', statusStore);
    sendExportedFiles();

    if (isReady && client.info) {
        const profile = await getFullProfile();
        socket.emit('ready', profile);
        await sendRealChats();
    } else if (currentQr) {
        socket.emit('qr', currentQr);
    }

    // Request Kode Tautan 8 Digit via Nomor HP (Sudah Di-Fix window.onCodeReceivedEvent)
    socket.on('request_pairing_code', async (phoneNumber) => {
        try {
            let cleanNum = String(phoneNumber || '').replace(/[^0-9]/g, '');
            if (cleanNum.startsWith('08')) cleanNum = '62' + cleanNum.slice(1);
            if (cleanNum.startsWith('8')) cleanNum = '62' + cleanNum;
            if (cleanNum.length < 9) {
                return socket.emit('notify', { title: 'Nomor Tidak Valid', message: 'Masukkan nomor WA dengan format 08xx atau 628xx' });
            }

            await injectWhatsAppPatches();
            const rawCode = await client.requestPairingCode(cleanNum);
            const formattedCode = rawCode && rawCode.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode;
            console.log(`\n🔑 [KODE LOGIN 8 DIGIT] Nomor: ${cleanNum} ===> ${formattedCode}\n`);
            socket.emit('pairing_code', formattedCode);
        } catch (err) {
            console.error('[Pairing Code Error]:', err.message);
            socket.emit('notify', { title: 'Gagal Meminta Kode', message: 'Tunggu beberapa detik hingga halaman WA siap, lalu klik lagi.' });
        }
    });

    // Buka Chat & Tarik Pesan Lama (Bebas Error "r")
    socket.on('open_chat', async (chatId) => {
        if (!isReady) return;
        const data = await loadChatMessagesDirect(chatId, false);
        if (data) {
            socket.emit('chat_messages', data);
        }
    });

    // Muat Lebih Banyak Pesan Lama di Dalam Ruang Chat
    socket.on('load_older_messages', async (chatId) => {
        if (!isReady || !chatId) return;
        socket.emit('notify', { title: 'Memuat Riwayat Lama...', message: 'Menarik pesan terdahulu dari WhatsApp...' });
        const data = await loadChatMessagesDirect(chatId, true);
        if (data) {
            socket.emit('chat_messages', data);
            socket.emit('notify', { title: 'Selesai', message: `${data.messages.length} pesan dimuat ke ruang chat.` });
        }
    });

    // Tombol Import & Sinkronkan Semua Riwayat Chat Lama
    socket.on('import_all_history', async () => {
        if (!isReady) return;
        socket.emit('notify', { title: 'Mengimpor Semua Chat...', message: 'Menarik daftar & pesan lama dari seluruh obrolan...' });
        await sendRealChats();

        const chatIds = await safeEvaluate(() => {
            return window.Store.Chat.getModelsArray()
                .filter(c => (c.id?._serialized || c.id?.$1) !== 'status@broadcast')
                .slice(0, 20)
                .map(c => c.id?._serialized || c.id?.$1);
        });

        if (chatIds && chatIds.length > 0) {
            for (const cid of chatIds) {
                await loadChatMessagesDirect(cid, true);
            }
        }
        await sendRealChats();
        sendExportedFiles();
        socket.emit('notify', { title: 'Import Selesai!', message: 'Seluruh chat & riwayat pesan lama berhasil diimpor!' });
    });

    socket.on('send_text', async ({ chatId, text }) => {
        if (!isReady || !chatId || !text) return;
        try {
            await client.sendMessage(chatId, text, { sendSeen: false });
            const data = await loadChatMessagesDirect(chatId, false);
            if (data) socket.emit('chat_messages', data);
        } catch (err) {
            socket.emit('notify', { title: 'Gagal Kirim Pesan', message: err.message });
        }
    });

    socket.on('send_media', async ({ chatId, base64, mimetype, filename, caption }) => {
        if (!isReady || !chatId || !base64) return;
        try {
            const cleanBase64 = base64.includes(',') ? base64.split(',')[1] : base64;
            const media = new MessageMedia(mimetype, cleanBase64, filename);
            await client.sendMessage(chatId, media, { caption: caption || '', sendSeen: false });
            const data = await loadChatMessagesDirect(chatId, false);
            if (data) socket.emit('chat_messages', data);
        } catch (err) {
            socket.emit('notify', { title: 'Gagal Kirim Media', message: err.message });
        }
    });

    socket.on('send_voice_note', async ({ chatId, base64 }) => {
        if (!isReady || !chatId || !base64) return;
        try {
            const cleanBase64 = base64.includes(',') ? base64.split(',')[1] : base64;
            const media = new MessageMedia('audio/ogg; codecs=opus', cleanBase64, 'voicenote.ogg');
            await client.sendMessage(chatId, media, { sendAudioAsVoice: true, sendSeen: false });
            const data = await loadChatMessagesDirect(chatId, false);
            if (data) socket.emit('chat_messages', data);
        } catch (err) {
            socket.emit('notify', { title: 'Gagal Kirim Voice Note', message: err.message });
        }
    });

    socket.on('react_message', async ({ chatId, msgId, emoji }) => {
        if (!isReady) return;
        try {
            await safeEvaluate(async (mId, em) => {
                const msg = window.Store.Msg.get(mId);
                if (msg && window.Store.SendReactionToMsg) {
                    await window.Store.SendReactionToMsg(msg, em).catch(() => {});
                }
            }, msgId, emoji);
            socket.emit('notify', { title: 'Reaksi Terkirim', message: `Mengirim ${emoji} ke pesan` });
        } catch (err) {}
    });

    socket.on('post_wa_status', async ({ text, color }) => {
        if (!isReady || !text) return;
        try {
            await postStatusTextBypass(text, color || '#059669');
            const myProf = await getFullProfile();
            const newMyStatus = {
                id: 'mystatus_' + Date.now(),
                authorId: myProf.wid,
                authorName: 'Status Saya (' + myProf.name + ')',
                initials: myProf.initials,
                picUrl: myProf.picUrl,
                fromMe: true,
                type: 'chat',
                body: text,
                color: color || '#059669',
                time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
                timestamp: Math.floor(Date.now() / 1000)
            };
            statusStore.unshift(newMyStatus);
            io.emit('statuses', statusStore);
            socket.emit('notify', { title: 'Status Berhasil Diupload!', message: 'Status sudah tayang di Story WhatsApp kamu.' });
        } catch (err) {
            socket.emit('notify', { title: 'Gagal Upload Status', message: err.message });
        }
    });

    socket.on('like_status', async ({ statusId, authorId, replyText }) => {
        if (!isReady || !authorId) return;
        try {
            await safeEvaluate(async (sId) => {
                const msg = window.Store.Msg.get(sId);
                if (msg && window.Store.SendReactionToMsg) {
                    await window.Store.SendReactionToMsg(msg, '❤️').catch(() => {});
                }
            }, statusId);

            const textMsg = replyText || '❤️ Menyukai Status Anda';
            await client.sendMessage(authorId, textMsg, { sendSeen: false });
            socket.emit('notify', {
                title: replyText ? 'Balasan Status Terkirim!' : 'Status Disukai ❤️',
                message: `Terkirim ke pembuat status`
            });
        } catch (err) {
            socket.emit('notify', { title: 'Gagal Merespons Status', message: err.message });
        }
    });

    socket.on('update_profile', async ({ name, about }) => {
        if (!isReady) return;
        try {
            if (name) await client.setDisplayName(name);
            if (about !== undefined) await client.setStatus(about);
            const profile = await getFullProfile();
            io.emit('ready', profile);
            socket.emit('notify', { title: 'Profil Diperbarui!', message: 'Nama & Bio WhatsApp berhasil disimpan.' });
        } catch (err) {
            socket.emit('notify', { title: 'Gagal Update Profil', message: err.message });
        }
    });

    socket.on('update_profile_pic', async ({ base64, mimetype }) => {
        if (!isReady || !base64) return;
        try {
            const clean = base64.includes(',') ? base64.split(',')[1] : base64;
            const media = new MessageMedia(mimetype || 'image/jpeg', clean, 'profile.jpg');
            await client.setProfilePicture(media);
            const profile = await getFullProfile();
            io.emit('ready', profile);
            socket.emit('notify', { title: 'Foto Profil Diperbarui!', message: 'PP WhatsApp kamu berhasil diganti.' });
        } catch (err) {
            socket.emit('notify', { title: 'Gagal Ganti Foto Profil', message: err.message });
        }
    });

    socket.on('export_chat_full', async (chatId) => {
        if (!isReady || !chatId) return;
        socket.emit('notify', { title: 'Mengekspor...', message: 'Menarik seluruh pesan & media dari obrolan ini...' });
        const data = await loadChatMessagesDirect(chatId, true);
        if (data) {
            socket.emit('chat_messages', data);
            socket.emit('notify', { title: 'Ekspor Selesai!', message: `${data.messages.length} pesan & media disimpan ke Media & Dokumen` });
        }
    });

    socket.on('logout_wa', async () => {
        try {
            await client.logout();
            isReady = false;
            io.emit('logged_out');
            client.initialize();
        } catch {}
    });
});

client.initialize();

// ============================================================================
// 6. START SERVER & AUTO CLOUDFLARE TUNNEL
// ============================================================================
server.listen(3000, () => {
    console.log('🚀 Server Lokal aktif di: http://localhost:3000');
    console.log('🌐 Membuka jalur publik Cloudflare Tunnel...');

    const cf = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:3000']);

    cf.stderr.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && !publicTunnelUrl) {
            publicTunnelUrl = match[0];
            console.log('\n============================================================');
            console.log('🔥 BUKA LINK INI LANGSUNG (TAMPILAN TERBARU TANPA DEPLOY VERCEL):');
            console.log(`👉 ${publicTunnelUrl}`);
            console.log('\n🚀 ATAU BUKA LEWAT VERCEL (Jalankan "vercel --prod" dulu jika HTML diubah):');
            console.log(`👉 https://wa-web-neon.vercel.app/?server=${publicTunnelUrl}`);
            console.log('============================================================\n');
        }
    });

    cf.on('error', () => {
        console.log('ℹ️ cloudflared belum terinstall.');
    });
});