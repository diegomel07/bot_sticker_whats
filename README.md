# Local WhatsApp Self-Chat Sticker Bot

Bot ligero de WhatsApp en Node.js que convierte automáticamente imágenes en stickers de WhatsApp con ajuste de aspecto y fondo transparente (`512x512`), ejecutado 100% de manera local.

---

## 📋 Requisitos Previos

- **Node.js**: Versión 18 o superior.
- **npm**: Gestor de paquetes incluido con Node.js.
- Conexión a Internet y un dispositivo móvil con WhatsApp activo.

---

## 🚀 Instalación

1. Clona o ubícate en el directorio del proyecto:
   ```bash
   cd /Users/diegomellizo/Documents/Code/bot_whats
   ```

2. Instala las dependencias:
   ```bash
   npm install
   ```

---

## ⚡ Ejecución

1. Inicia el bot:
   ```bash
   npm start
   ```

2. En la terminal aparecerá un código QR.
3. Abre WhatsApp en tu teléfono móvil:
   - Ve a **Ajustes** / **Configuración** -> **Dispositivos vinculados**.
   - Toca **Vincular un dispositivo** y escanea el código QR de la terminal.
4. Una vez autenticado, verás el mensaje:
   ```text
   ✅ ¡Bot de Stickers conectado y listo!
   ```
   La sesión quedará guardada de forma local en la carpeta `.wwebjs_auth`, por lo que no necesitarás escanear el QR cada vez que inicies el bot.

---

## 💬 Modo de Uso

### Uso general (en cualquier chat o en tu propio chat)
- Envía **cualquier imagen estática** (PNG, JPG o WebP) adjuntando en el pie de foto / comentario el texto:
  ```text
  !sticker
  ```
- El bot responderá en ese mismo chat con el sticker procesado manteniendo la proporción original (canvas transparente de 512x512).
- **Importante:** Cualquier imagen enviada **sin** el texto `!sticker` será ignorada por el bot para no interferir con tus fotos cotidianas.

> **Nota de seguridad:** El bot ignora automáticamente stickers enviados y mensajes sin archivos multimedia para evitar bucles de respuesta.
