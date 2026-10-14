const { MessageMedia } = require('whatsapp-web.js');
const sharp = require('sharp');

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Cache of the user's own IDs (phone-number JID and Linked Identity JID).
let myIdsCache = null;

/**
 * Resolves the user's own serialized IDs (@c.us and @lid) from WhatsApp Web.
 */
async function getMyIds(client) {
    if (myIdsCache && myIdsCache.size > 0) return myIdsCache;

    const ids = new Set();
    if (client.info && client.info.wid) ids.add(client.info.wid._serialized);

    try {
        const extra = await client.pupPage.evaluate(() => {
            const me = window.require('WAWebUserPrefsMeUser');
            const out = [];
            try { const lid = me.getMaybeMeLidUser(); if (lid) out.push(lid._serialized); } catch (e) { /* ignore */ }
            try { const pn = me.getMaybeMePnUser(); if (pn) out.push(pn._serialized); } catch (e) { /* ignore */ }
            return out;
        });
        extra.forEach((id) => ids.add(id));
    } catch (err) {
        console.warn('[WARN] No se pudo obtener el LID propio:', err.message);
    }

    myIdsCache = ids;
    console.log(`[INFO] IDs propios detectados: ${[...ids].join(', ')}`);
    return ids;
}

/**
 * Checks if the message was sent by the user into their own personal chat ("Message yourself").
 * Compares msg.to against the user's own @c.us AND @lid IDs, so images sent to
 * other contacts that happen to use @lid addressing are NOT treated as self-chat.
 */
async function isSelfChatMessage(msg, client) {
    if (!msg.fromMe) return false;
    if (msg.to === msg.from) return true;
    const myIds = await getMyIds(client);
    return myIds.has(msg.to);
}

/**
 * Resizes any image to a 512x512 WebP with transparent padding to preserve aspect ratio.
 */
async function normalizeImageToWebpBase64(base64Data) {
    const inputBuffer = Buffer.from(base64Data, 'base64');
    const outputBuffer = await sharp(inputBuffer)
        .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp({ quality: 90 })
        .toBuffer();

    return outputBuffer.toString('base64');
}

/**
 * Newer WhatsApp Web builds no longer populate msg.id._serialized, which makes
 * whatsapp-web.js call Msg.get(undefined) and fail with the opaque "r: r".
 * Rebuild it from its parts: "<fromMe>_<remote>_<id>[_<participant>]".
 */
function serializeWid(wid) {
    if (!wid) return undefined;
    if (typeof wid === 'string') return wid;
    if (wid._serialized) return wid._serialized;
    if (wid.user && wid.server) return `${wid.user}@${wid.server}`;
    return undefined;
}

function ensureSerializedId(msg) {
    const id = msg.id || {};
    if (id._serialized) return id._serialized;

    const remote = serializeWid(id.remote) || (msg.fromMe ? msg.to : msg.from);
    let serialized = `${Boolean(id.fromMe ?? msg.fromMe)}_${remote}_${id.id}`;
    const participant = serializeWid(id.participant);
    if (participant) serialized += `_${participant}`;

    id._serialized = serialized;
    msg.id = id;
    return serialized;
}

/**
 * Downloads media directly inside WhatsApp Web using several strategies, and
 * returns detailed diagnostics instead of the opaque minified "r: r" error.
 */
async function downloadMediaRobust(msg, client) {
    const msgId = ensureSerializedId(msg);
    const rawId = msg.id && msg.id.id;
    return client.pupPage.evaluate(async ({ msgId, rawId }) => {
        const describe = (e) => {
            if (!e) return String(e);
            const parts = [e.name, e.message, e.constructor && e.constructor.name];
            try { parts.push(JSON.stringify(e, Object.getOwnPropertyNames(e))); } catch (x) { /* ignore */ }
            return parts.filter(Boolean).join(' | ').slice(0, 600);
        };
        const toB64 = (buf) => window.WWebJS.arrayBufferToBase64Async(buf);
        const diag = { errors: [], msgId, rawId };

        // Message lookup: this is where the opaque "r: r" was being thrown.
        // Try several strategies, each guarded so we get real diagnostics.
        const Coll = window.require('WAWebCollections');
        let msg = null;

        try { msg = Coll.Msg.get(msgId); } catch (e) { diag.errors.push('Msg.get(str): ' + describe(e)); }

        if (!msg) {
            try {
                const MsgKey = window.require('WAWebMsgKey');
                const key = MsgKey.fromString ? MsgKey.fromString(msgId) : MsgKey.from(msgId);
                msg = Coll.Msg.get(key);
            } catch (e) { diag.errors.push('Msg.get(MsgKey): ' + describe(e)); }
        }

        if (!msg) {
            try {
                const all = Coll.Msg.getModelsArray ? Coll.Msg.getModelsArray() : (Coll.Msg._models || []);
                msg = all.find((m) => m.id && (m.id._serialized === msgId || m.id.id === rawId)) || null;
                if (msg) diag.lookup = 'scan';
            } catch (e) { diag.errors.push('scan: ' + describe(e)); }
        }

        if (!msg) {
            try {
                msg = (await Coll.Msg.getMessagesById([msgId]))?.messages?.[0] || null;
            } catch (e) { diag.errors.push('getMessagesById: ' + describe(e)); }
        }

        if (!msg) return { ok: false, retry: true, diag: { ...diag, reason: 'msg-not-found' } };
        if (!msg.mediaData) return { ok: false, retry: true, diag: { ...diag, reason: 'no-mediaData' } };

        diag.stageBefore = msg.mediaData.mediaStage;
        diag.msgMimetype = msg.mimetype;
        // msg.mimetype can be empty in newer builds; fall back to a valid image type
        // (sharp sniffs the real format from the bytes anyway).
        const mimetype = (msg.mimetype && msg.mimetype.startsWith('image/'))
            ? msg.mimetype.split(';')[0]
            : 'image/jpeg';
        const meta = { mimetype, filename: msg.filename, filesize: msg.size };

        // Ask WhatsApp Web itself to fetch/decrypt the media (same as tapping "download").
        if (msg.mediaData.mediaStage !== 'RESOLVED') {
            try {
                await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true });
            } catch (e) {
                diag.errors.push('wa.downloadMedia: ' + describe(e));
            }
        }
        diag.stageAfter = msg.mediaData.mediaStage;

        const sources = [
            ['mediaData', msg.mediaData],
            ['mediaObject', msg.mediaObject]
        ];

        // Strategy A: decrypted blob already held in memory by WhatsApp Web.
        for (const [name, src] of sources) {
            try {
                const mb = src && src.mediaBlob;
                if (mb) {
                    const blob = typeof mb.forceToBlob === 'function' ? mb.forceToBlob() : mb;
                    const buf = await blob.arrayBuffer();
                    return { ok: true, via: `${name}.mediaBlob`, data: await toB64(buf), ...meta };
                }
            } catch (e) { diag.errors.push(`${name}.mediaBlob: ` + describe(e)); }
        }

        // Strategy B: renderable blob: URL used by the chat UI.
        for (const [name, src] of sources) {
            try {
                const url = src && src.renderableUrl;
                if (url) {
                    const res = await fetch(url);
                    const buf = await res.arrayBuffer();
                    return { ok: true, via: `${name}.renderableUrl`, data: await toB64(buf), ...meta };
                }
            } catch (e) { diag.errors.push(`${name}.renderableUrl: ` + describe(e)); }
        }

        // Strategy C: download + decrypt from the CDN, passing an explicit mimetype
        // (without it WhatsApp defaults to application/octet-stream and rejects it).
        try {
            const qpl = { addAnnotations() { return this; }, addPoint() { return this; }, end() { return this; } };
            const buf = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
                directPath: msg.directPath,
                encFilehash: msg.encFilehash,
                filehash: msg.filehash,
                mediaKey: msg.mediaKey,
                mediaKeyTimestamp: msg.mediaKeyTimestamp,
                type: msg.type,
                mimetype,
                mimeType: mimetype,
                signal: new AbortController().signal,
                downloadQpl: qpl
            });
            return { ok: true, via: 'downloadAndMaybeDecrypt', data: await toB64(buf), ...meta };
        } catch (e) { diag.errors.push('downloadAndMaybeDecrypt: ' + describe(e)); }

        return { ok: false, retry: true, diag };
    }, { msgId, rawId });
}

/**
 * Retries the robust download a few times to give WhatsApp Web time to sync
 * media that was just sent from the phone.
 */
async function downloadMediaWithRetry(msg, client, maxRetries = 5, delayMs = 1500) {
    let lastDiag = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await downloadMediaRobust(msg, client);
            if (result && result.ok && result.data) {
                console.log(`[SYNC] Imagen descargada (vía ${result.via}, intento ${attempt}).`);
                return new MessageMedia(result.mimetype, result.data, result.filename, result.filesize);
            }
            lastDiag = result && result.diag;
        } catch (err) {
            lastDiag = { nodeError: err && (err.stack || err.message || String(err)) };
        }
        console.warn(`[SYNC] Intento ${attempt}/${maxRetries} sin éxito:`, JSON.stringify(lastDiag));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // Final fallback: the library's own implementation.
    try {
        return await msg.downloadMedia();
    } catch (err) {
        console.error('[ERROR] msg.downloadMedia() también falló:', err && err.message);
        return null;
    }
}

async function handleIncomingMessage(msg, client) {
    try {
        // 1. Loop & Media Guard
        if (!msg || msg.type === 'sticker' || !msg.hasMedia) {
            return;
        }

        // 2. Routing Filter: ONLY activate when the image caption contains '!sticker'
        const caption = (msg.body || '').trim().toLowerCase();
        const hasStickerCommand = caption === '!sticker' || caption.startsWith('!sticker');

        if (!hasStickerCommand) {
            return;
        }

        const isSelfChat = await isSelfChatMessage(msg, client);

        // Only static images are processed (skip video, audio, documents early).
        if (msg.type !== 'image') {
            return;
        }

        // 3. Download & Validate Media
        const media = await downloadMediaWithRetry(msg, client);
        if (!media) {
            throw new Error('No se pudo descargar la imagen tras varios intentos.');
        }
        if (!ALLOWED_IMAGE_TYPES.includes(media.mimetype)) {
            console.log(`[INFO] Formato no soportado: ${media.mimetype}`);
            return;
        }

        // 4. Normalize Image to 512x512 WebP
        const normalizedBase64 = await normalizeImageToWebpBase64(media.data);
        const stickerMedia = new MessageMedia('image/webp', normalizedBase64, 'sticker.webp');

        // 5. Resolve Destination Chat & Send Sticker
        const targetChatId = msg.fromMe ? msg.to : msg.from;

        await client.sendMessage(targetChatId, stickerMedia, {
            sendMediaAsSticker: true,
            stickerName: 'Argon Stickers',
            stickerAuthor: 'Argon Bot'
        });

        console.log(`[OK] Sticker generado y enviado a ${targetChatId} (SelfChat:${isSelfChat})`);
    } catch (error) {
        console.error('[ERROR] Fallo al convertir la imagen en sticker:', error);
        try {
            const targetChatId = msg.fromMe ? msg.to : msg.from;
            await client.sendMessage(targetChatId, '⚠️ Hubo un error procesando la imagen para el sticker.');
        } catch (replyErr) {
            console.error('[ERROR] No se pudo enviar el mensaje de alerta:', replyErr);
        }
    }
}

module.exports = { handleIncomingMessage };
