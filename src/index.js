const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleIncomingMessage } = require('./stickerHandler');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('\n================================================');
    console.log('Escanea este código QR desde tu WhatsApp:');
    console.log('(Configuración -> Dispositivos vinculados)');
    console.log('================================================\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ ¡Bot de Stickers conectado y listo!');
    console.log(`📱 Cuenta vinculada: ${client.info.wid._serialized}`);
    console.log('👉 Envía cualquier imagen con el pie de foto "!sticker" para convertirla en sticker.');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Error de autenticación:', msg);
});

client.on('disconnected', (reason) => {
    console.warn('⚠️ Cliente desconectado:', reason);
});

client.on('message_create', async (msg) => {
    await handleIncomingMessage(msg, client);
});

process.on('unhandledRejection', (reason) => {
    console.error('[ERROR] Promesa no manejada:', reason);
});

client.initialize();
