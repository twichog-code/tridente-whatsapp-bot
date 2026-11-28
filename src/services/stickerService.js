import sharp from 'sharp';

const STICKER_SIZE = 512;
const MAX_STATIC_STICKER_BYTES = 100 * 1024; // WhatsApp recomienda <= 100 KB para stickers estáticos

/**
 * Escapa caracteres especiales para incrustar texto de forma segura dentro de un SVG.
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Divide un texto en líneas equilibradas para que quepa centrado en un sticker 512x512.
 * @param {string} text
 * @param {number} maxCharsPerLine
 * @returns {string[]}
 */
function wrapTextLines(text, maxCharsPerLine) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word.length > maxCharsPerLine ? word.slice(0, maxCharsPerLine) : word;
    } else if (`${current} ${word}`.length <= maxCharsPerLine) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word.length > maxCharsPerLine ? word.slice(0, maxCharsPerLine) : word;
    }
    if (lines.length >= 5) break;
  }

  if (current && lines.length < 5) {
    lines.push(current);
  }

  return lines;
}

/**
 * Convierte una imagen (JPG/PNG/WEBP/GIF) en un sticker WebP 512x512 con fondo transparente
 * listo para enviar por WhatsApp con Baileys.
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<Buffer>}
 */
export async function createStickerFromImage(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error('No se recibió una imagen válida para crear el sticker.');
  }

  const qualities = [80, 60, 42];
  let webpBuffer = null;

  for (const quality of qualities) {
    webpBuffer = await sharp(imageBuffer)
      .rotate()
      .resize(STICKER_SIZE, STICKER_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality, effort: 4 })
      .toBuffer();

    if (webpBuffer.length <= MAX_STATIC_STICKER_BYTES) {
      break;
    }
  }

  return webpBuffer;
}

/**
 * Genera un sticker WebP 512x512 con fondo transparente a partir de un texto corto
 * (estilo meme/cartel legible tanto en modo claro como oscuro de WhatsApp).
 *
 * @param {string} rawText
 * @returns {Promise<Buffer>}
 */
export async function createStickerFromText(rawText) {
  const cleanText = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  if (!cleanText) {
    throw new Error('Escribe un texto después de !sticker para generar el sticker.');
  }

  let fontSize = 78;
  let maxCharsPerLine = 11;

  if (cleanText.length > 55) {
    fontSize = 48;
    maxCharsPerLine = 18;
  } else if (cleanText.length > 28) {
    fontSize = 60;
    maxCharsPerLine = 15;
  } else if (cleanText.length > 14) {
    fontSize = 68;
    maxCharsPerLine = 13;
  }

  const lines = wrapTextLines(cleanText, maxCharsPerLine);
  const lineHeight = Math.round(fontSize * 1.22);
  const totalHeight = lines.length * lineHeight;
  const startY = Math.round((STICKER_SIZE - totalHeight) / 2 + fontSize * 0.85);
  const strokeWidth = Math.max(8, Math.round(fontSize * 0.16));

  const textElements = lines
    .map((line, index) => {
      const y = startY + index * lineHeight;
      const escaped = escapeXml(line);
      return `<text x="256" y="${y}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-weight="900" font-size="${fontSize}" fill="#FFFFFF" stroke="#111111" stroke-width="${strokeWidth}" paint-order="stroke" stroke-linejoin="round">${escaped}</text>`;
    })
    .join('\n  ');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${STICKER_SIZE}" height="${STICKER_SIZE}" viewBox="0 0 ${STICKER_SIZE} ${STICKER_SIZE}">
  <rect width="100%" height="100%" fill="none"/>
  ${textElements}
</svg>`;

  return sharp(Buffer.from(svg, 'utf8'))
    .webp({ quality: 85, effort: 4 })
    .toBuffer();
}
