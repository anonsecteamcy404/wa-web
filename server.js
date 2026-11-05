const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ============================================================================
// 1. GLOBAL GUARD ANTI-CRASH UNTUK NODE.JS V24 & PUPPETEER
// ============================================================================
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (
        msg.includes('Execution context was destroyed') ||
        msg.includes('Target closed') ||
        msg.includes('Protocol error') ||
        msg.includes('Session closed')
    ) {
        console.log('[Guard] Mengabaikan transisi navigasi Puppeteer, sesi tetap berjalan...');
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
        console.log('[Guard] Mengabaikan exception navigasi Puppeteer...');
        return;
    }
    console.error('[Uncaught Exception]:', msg);
});

const app = express();
const server = http.createServer(app);

// AKTIFKAN CORS AGAR BISA DIAKSES DARI DOMAIN VERCEL (*.vercel.app)
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

// Endpoint cek kesehatan server dari Vercel
app.get('/ping', (req, res) => {
    res.json({ ok: true, status: 'WhatsApp iGlass Backend Active' });
});

// Folder Penyimpanan Auto-Export
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
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium'
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: getBrowserExecutablePath(),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

// ============================================================================
// 2. PATCH CLIENT.INJECT (FIX ERROR Client.js:503 SAAT FRAMENAVIGATED)
// ============================================================================
const originalInject = client.inject.bind(client);
let isInjecting = false;

client.inject = async function (...args) {
    if (isInjecting) return;
    isInjecting = true;
    try {
        await originalInject(...args);
        setTimeout(() => injectWhatsAppPatches().catch(() => {}), 800);
    } catch (err) {
        const msg = err?.message || String(err);
        if (msg.includes('Execution context was destroyed') || msg.includes('Target closed')) {
            console.log('[Inject Guard] Halaman sedang memuat ulang konteks, menunggu stabil...');
        } else {
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
            await new Promise(r => setTimeout(r, 1200));
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
    const clean = name.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    if (!clean) return 'WA';
    const parts = clean.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return clean.substring(0, 2).toUpperCase();
}

// ============================================================================
// 3. PATCH INTERNAL WHATSAPP WEB 2026
// ============================================================================
async function injectWhatsAppPatches() {
    await safeEvaluate(() => {
        try {
            const gatingMod = window.require('WAWebStatusGatingUtils');
            if (gatingMod && typeof gatingMod.canCheckStatusRankingPosterGating !== 'function') {
                gatingMod.canCheckStatusRankingPosterGating = () => false;
            }
        } catch (e) {}

        try {
            if (window.Store && window.Store.StatusUtils && typeof window.Store.StatusUtils.canCheckStatusRankingPosterGating !== 'function') {
                window.Store.StatusUtils.canCheckStatusRankingPosterGating = () => false;
            }
        } catch (e) {}

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

        if (window.WWebJS && window.WWebJS.getChatModel) {
            window.WWebJS.getChats = async () => {
                const chats = window.Store.Chat.getModelsArray();
                const results = [];
                for (const c of chats) {
                    try {
                        const model = await window.WWebJS.getChatModel(c);
                        if (model) results.push(model);
                    } catch (err) {}
                }
                return results;
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

            const userNum = targetId.split('@')[0].split(':')[0];
            const models = Store.ProfilePicThumb.getModelsArray ? Store.ProfilePicThumb.getModelsArray() : (Store.ProfilePicThumb.models || []);

            for (const m of models) {
                const mId = m.id?._serialized || m.id?.user || String(m.id || '');
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

            if (Store.User && Store.User.getMaybeMeLidUser) {
                const meLid = Store.User.getMaybeMeLidUser();
                const mePn = Store.User.getMaybeMePnUser ? Store.User.getMaybeMePnUser() : null;
                if (mePn && mePn.user === userNum && meLid) {
                    await Store.ProfilePicThumb.find(meLid).catch(() => {});
                    const lidThumb = Store.ProfilePicThumb.get(meLid);
                    if (lidThumb && (lidThumb.eurl || lidThumb.imgFull || lidThumb.img)) {
                        return lidThumb.eurl || lidThumb.imgFull || lidThumb.img;
                    }
                }
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

client.on('qr', async (qr) => {
    currentQr = await qrcode.toDataURL(qr);
    io.emit('qr', currentQr);
});

client.on('authenticated', () => {
    io.emit('auth_status', 'Autentikasi berhasil! Menyiapkan antarmuka WhatsApp...');
});

client.on('ready', async () => {
    isReady = true;
    currentQr = null;

    await new Promise(r => setTimeout(r, 1000));
    await injectWhatsAppPatches();

    console.log('[WA] WhatsApp iGlass Siap & Terhubung Stabil!');
    const profile = await getFullProfile();
    io.emit('ready', profile);

    await sendRealChats();
    await syncRealStatuses();
    sendExportedFiles();
});

client.on('message_create', async (msg) => {
    try {
        if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast' || msg.isStatusV3) {
            await handleIncomingStatus(msg);
            return;
        }

        const savedMedia = await processAutoExport(msg);
        const chat = await msg.getChat();
        const formattedMsg = await formatRealMessage(msg, savedMedia);

        io.emit('new_message', {
            chatId: chat.id._serialized,
            chatName: chat.name || chat.id.user,
            message: formattedMsg
        });

        await sendRealChats();
    } catch (err) {
        console.error('[Error message_create]:', err.message);
    }
});

client.on('call', async (call) => {
    const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    callLogs.unshift({
        id: call.id,
        from: call.from.replace('@c.us', ''),
        isVideo: call.isVideo,
        time: time
    });
    io.emit('call_logs', callLogs);
});

async function getFullProfile() {
    try {
        const wid = client.info?.wid?._serialized || '';
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

async function sendRealChats() {
    if (!isReady) return;
    try {
        const rawChats = await safeEvaluate(() => {
            try {
                const Store = window.Store;
                const chats = Store.Chat.getModelsArray();
                const thumbModels = Store.ProfilePicThumb?.getModelsArray ? Store.ProfilePicThumb.getModelsArray() : [];

                return chats
                    .filter(c => c.id && c.id._serialized !== 'status@broadcast')
                    .slice(0, 45)
                    .map(c => {
                        const chatId = c.id._serialized;
                        const userNum = c.id.user || chatId.split('@')[0];
                        const lastMsg = c.lastReceivedKey ? Store.Msg.get(c.lastReceivedKey) : (c.msgs && c.msgs.length > 0 ? c.msgs.last() : null);
                        const name = c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || userNum;

                        let picUrl = null;
                        const directThumb = Store.ProfilePicThumb.get(c.id) || Store.ProfilePicThumb.get(chatId);
                        if (directThumb && (directThumb.eurl || directThumb.imgFull || directThumb.img)) {
                            picUrl = directThumb.eurl || directThumb.imgFull || directThumb.img;
                        } else {
                            for (const m of thumbModels) {
                                const mId = m.id?._serialized || String(m.id || '');
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
                            timestamp: c.t || 0,
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
            for (let i = 0; i < Math.min(12, chatList.length); i++) {
                if (!chatList[i].picUrl) {
                    const url = await getRealProfilePic(chatList[i].id);
                    if (url) {
                        io.emit('chat_pic', { chatId: chatList[i].id, picUrl: url });
                    }
                }
            }
        }, 1500);
    } catch (err) {
        console.error('[Error sendRealChats]:', err.message);
    }
}

async function handleIncomingStatus(msg) {
    try {
        const authorId = msg.author || msg.from;
        let authorName = msg._data?.notifyName || authorId.split('@')[0];
        const picUrl = await getRealProfilePic(authorId);
        let mediaUrl = null;
        let mimetype = null;

        if (msg.hasMedia) {
            const saved = await processAutoExport(msg, true);
            if (saved) {
                mediaUrl = saved.url;
                mimetype = saved.mimetype;
            }
        }

        const statusItem = {
            id: msg.id._serialized,
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
            time: new Date(msg.timestamp * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
            timestamp: msg.timestamp
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
                    m.isStatusV3 || m.id?.remote?._serialized === 'status@broadcast'
                );
                for (const m of msgs.slice(-25)) {
                    const authorId = m.author?._serialized || m.author || m.from?._serialized || '';
                    const contact = authorId ? window.Store.Contact.get(authorId) : null;
                    const name = contact?.name || contact?.pushname || m.notifyName || authorId.split('@')[0] || 'Kontak';
                    list.push({
                        id: m.id._serialized,
                        authorId: authorId,
                        authorName: name,
                        fromMe: Boolean(m.id.fromMe),
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

async function formatRealMessage(m, savedMedia = null) {
    const time = new Date(m.timestamp * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    let reactionsList = [];

    if (m.hasReaction) {
        try {
            const reacts = await m.getReactions();
            reacts.forEach(r => {
                reactionsList.push(`${r.aggregateEmoji} ${r.senders.length > 1 ? r.senders.length : ''}`.trim());
            });
        } catch {}
    }

    const durSec = m._data?.duration || 0;
    const mins = Math.floor(durSec / 60);
    const secs = String(durSec % 60).padStart(2, '0');

    return {
        id: m.id._serialized,
        body: m.body || '',
        fromMe: m.fromMe,
        time: time,
        timestamp: m.timestamp,
        type: m.type,
        hasMedia: m.hasMedia,
        mediaUrl: savedMedia ? savedMedia.url : null,
        mimetype: savedMedia ? savedMedia.mimetype : (m._data?.mimetype || null),
        fileName: savedMedia ? savedMedia.fileName : (m._data?.filename || 'File'),
        fileSize: savedMedia ? savedMedia.size : formatBytes(m._data?.size || 0),
        duration: `${mins}:${secs}`,
        reactions: reactionsList
    };
}

async function processAutoExport(msg, force = false) {
    try {
        const isStatus = msg.from === 'status@broadcast' || msg.isStatusV3;
        let safeName = 'Status_Story';

        if (!isStatus) {
            const chat = await msg.getChat();
            safeName = (chat.name || chat.id.user || 'chat').replace(/[^a-zA-Z0-9_-]/g, '_');
        }

        if (!isStatus && (config.autoExportChat || force)) {
            const txtPath = path.join(CHAT_DIR, `${safeName}.txt`);
            const timeStr = new Date(msg.timestamp * 1000).toLocaleString('id-ID');
            const sender = msg.fromMe ? 'Saya' : (msg._data?.notifyName || msg.author || msg.from);
            const content = msg.body || (msg.hasMedia ? `[MEDIA: ${msg.type.toUpperCase()}]` : '');
            fs.appendFileSync(txtPath, `[${timeStr}] ${sender}: ${content}\n`, 'utf8');
        }

        if (msg.hasMedia && (config.autoExportMedia || force)) {
            const media = await msg.downloadMedia();
            if (media && media.data) {
                let ext = (media.mimetype.split('/')[1] || 'bin').split(';')[0];
                if (ext === 'ogg' || msg.type === 'ptt') ext = 'ogg';
                if (ext === 'jpeg') ext = 'jpg';

                const cleanId = msg.id.id.substring(0, 8);
                const fileName = `${safeName}_${msg.timestamp}_${cleanId}.${ext}`;
                const filePath = path.join(MEDIA_DIR, fileName);

                if (!fs.existsSync(filePath)) {
                    fs.writeFileSync(filePath, media.data, 'base64');
                }
                const stat = fs.statSync(filePath);
                sendExportedFiles();

                return {
                    url: `/exports/media/${fileName}`,
                    mimetype: media.mimetype,
                    size: formatBytes(stat.size),
                    fileName: media.filename || fileName
                };
            }
        }
    } catch (err) {}
    return null;
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

    socket.on('open_chat', async (chatId) => {
        if (!isReady) return;
        try {
            const chat = await client.getChatById(chatId);
            const picUrl = await getRealProfilePic(chatId);
            const about = chat.isGroup
                ? `Grup WhatsApp`
                : (await getRealAbout(chatId)) || 'Online di WhatsApp';

            const rawMessages = await chat.fetchMessages({ limit: 35 });
            const formattedMessages = [];

            for (let i = 0; i < rawMessages.length; i++) {
                const m = rawMessages[i];
                let savedMedia = null;
                if (m.hasMedia && i >= rawMessages.length - 12) {
                    savedMedia = await processAutoExport(m, true);
                }
                formattedMessages.push(await formatRealMessage(m, savedMedia));
            }

            socket.emit('chat_messages', {
                chatId: chat.id._serialized,
                name: chat.name || `+${chat.id.user}`,
                initials: getInitials(chat.name || chat.id.user),
                picUrl: picUrl,
                statusInfo: about,
                isGroup: chat.isGroup,
                messages: formattedMessages
            });
        } catch (err) {
            console.error('[Error open_chat]:', err.message);
        }
    });

    socket.on('send_text', async ({ chatId, text }) => {
        if (!isReady || !chatId || !text) return;
        try {
            await client.sendMessage(chatId, text, { sendSeen: false });
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
        } catch (err) {
            socket.emit('notify', { title: 'Gagal Kirim Voice Note', message: err.message });
        }
    });

    socket.on('react_message', async ({ chatId, msgId, emoji }) => {
        if (!isReady) return;
        try {
            const chat = await client.getChatById(chatId);
            const msgs = await chat.fetchMessages({ limit: 40 });
            const target = msgs.find(m => m.id._serialized === msgId);
            if (target) {
                await target.react(emoji);
                socket.emit('notify', { title: 'Reaksi Terkirim', message: `Mengirim ${emoji} ke pesan` });
            }
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
        try {
            const chat = await client.getChatById(chatId);
            socket.emit('notify', { title: 'Mengekspor...', message: `Mengunduh pesan & media dari ${chat.name}` });
            const msgs = await chat.fetchMessages({ limit: 100 });
            for (const m of msgs) {
                await processAutoExport(m, true);
            }
            sendExportedFiles();
            socket.emit('notify', { title: 'Ekspor Selesai!', message: `${msgs.length} pesan & media disimpan ke Media & Dokumen` });
        } catch (err) {
            socket.emit('notify', { title: 'Gagal Ekspor', message: err.message });
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
            console.log('🔥 LINK CLOUDFLARE TUNNEL (BISA LANGSUNG DIBUKA / DIPAKAI DI VERCEL):');
            console.log(`👉 ${publicTunnelUrl}`);
            console.log('============================================================\n');
        }
    });

    cf.on('error', () => {
        console.log('ℹ️ cloudflared belum terinstall (berjalan di mode localhost).');
    });
});