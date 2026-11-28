import 'dotenv/config';
import express from 'express';
import {
  getAuthStorageMode,
  getConnectionStatus,
  startWhatsApp,
  stopWhatsApp,
} from './services/baileysService.js';
import { getModelInfo } from './services/geminiService.js';
import { getWebSearchMode } from './services/webSearchService.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Endpoint simple de healthcheck (requerido por Render / Railway y monitoreo local)
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'whatsapp-gemini-chatbot',
    whatsapp: getConnectionStatus(),
    authStorage: getAuthStorageMode(),
    webSearch: getWebSearchMode(),
    model: getModelInfo(),
    timestamp: new Date().toISOString(),
  });
});

// Manejo de rutas no encontradas (404)
app.use((req, res) => {
  res.status(404).json({
    error: 'Ruta no encontrada',
    path: req.originalUrl,
  });
});

// Middleware global de manejo de errores
app.use((err, _req, res, _next) => {
  console.error('[Server] Error no controlado:', err);
  res.status(err.status || 500).json({
    error: 'Error interno del servidor.',
  });
});

function checkEnvironment() {
  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      '[Aviso] Falta la variable de entorno GEMINI_API_KEY. ' +
        'Copia .env.example a .env y configúrala para que el bot pueda generar respuestas con Gemini.'
    );
  }
}

const server = app.listen(PORT, () => {
  checkEnvironment();
  console.log(`[Server] Healthcheck escuchando en http://localhost:${PORT}/health`);

  startWhatsApp().catch((err) => {
    console.error('[WhatsApp] Error fatal al iniciar Baileys:', err);
  });
});

let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Server] Señal ${signal} recibida. Cerrando servicios...`);
  stopWhatsApp();
  server.close(() => {
    console.log('[Server] Servidor detenido correctamente.');
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
