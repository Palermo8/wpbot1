require('dotenv').config();
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const twilio = require('twilio');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio client (initialized lazily so server starts even without creds)
let twilioClient = null;
function getClient(sid, token) {
  if (sid && token) return twilio(sid, token);
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return null;
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// File upload (memory storage for Excel, disk for media)
const uploadExcel = multer({ storage: multer.memoryStorage() });
const uploadMedia = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '../uploads');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
  }),
  limits: { fileSize: 16 * 1024 * 1024 } // 16MB max (Twilio limit)
});

// ── Active campaigns store ────────────────────────────────────────────────────
const campaigns = new Map(); // id -> { status, contacts, stats, sseClients }

// ── SSE endpoint for live logs ────────────────────────────────────────────────
app.get('/api/campaign/:id/stream', (req, res) => {
  const campaign = campaigns.get(req.params.id);
  if (!campaign) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  campaign.sseClients.push(res);

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ type: 'state', data: campaign.stats })}\n\n`);

  req.on('close', () => {
    campaign.sseClients = campaign.sseClients.filter(c => c !== res);
  });
});

function broadcast(campaign, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  campaign.sseClients.forEach(c => {
    try { c.write(payload); } catch {}
  });
}

// ── Parse Excel / CSV ─────────────────────────────────────────────────────────
function parseContactFile(buffer, mimetype) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!rows.length) throw new Error('El archivo está vacío');

  const cols = Object.keys(rows[0]);
  // Auto-detect phone column
  const phoneCol = cols.find(c =>
    ['telefono','teléfono','phone','tel','numero','número','celular','mobile','whatsapp']
      .includes(c.toLowerCase().trim())
  );
  if (!phoneCol) throw new Error(
    `No encontré columna de teléfono. Columnas disponibles: ${cols.join(', ')}. Renombrá la columna a "telefono".`
  );

  return rows.map(row => {
    const phone = String(row[phoneCol]).replace(/\D/g, '');
    return { ...row, _phone: phone, _cols: cols };
  }).filter(r => r._phone.length >= 7);
}

// ── Personalize message ───────────────────────────────────────────────────────
function personalize(template, row) {
  let msg = template;
  Object.keys(row).forEach(k => {
    if (!k.startsWith('_')) {
      msg = msg.replaceAll(`{{${k}}}`, row[k] || '');
    }
  });
  return msg;
}

// ── Upload contacts ───────────────────────────────────────────────────────────
app.post('/api/contacts/parse', uploadExcel.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const contacts = parseContactFile(req.file.buffer);
    const cols = contacts.length ? contacts[0]._cols : [];
    res.json({
      count: contacts.length,
      columns: cols,
      preview: contacts.slice(0, 5).map(c => {
        const { _cols, ...rest } = c;
        return rest;
      }),
      contacts: contacts.map(c => {
        const { _cols, ...rest } = c;
        return rest;
      })
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Upload media file ─────────────────────────────────────────────────────────
app.post('/api/media/upload', uploadMedia.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Return the public URL (assumes server is public-facing)
  const baseUrl = req.protocol + '://' + req.get('host');
  res.json({
    filename: req.file.filename,
    originalname: req.file.originalname,
    url: `${baseUrl}/uploads/${req.file.filename}`,
    size: req.file.size
  });
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ── Launch campaign ───────────────────────────────────────────────────────────
app.post('/api/campaign/launch', async (req, res) => {
  const {
    accountSid, authToken, fromNumber,
    contacts, messageTemplate, mediaUrl,
    ratePerSecond = 1
  } = req.body;

  if (!contacts || !contacts.length)
    return res.status(400).json({ error: 'No hay contactos' });
  if (!messageTemplate && !mediaUrl)
    return res.status(400).json({ error: 'Necesitás un mensaje o un archivo' });

  const client = getClient(accountSid, authToken);
  if (!client) return res.status(400).json({ error: 'Credenciales Twilio inválidas o no configuradas' });

  const from = fromNumber
    ? (fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`)
    : process.env.TWILIO_WHATSAPP_FROM;

  const id = Date.now().toString();
  const campaign = {
    id,
    status: 'running',
    contacts,
    stats: { total: contacts.length, sent: 0, failed: 0, pending: contacts.length },
    sseClients: [],
    pauseFlag: false,
    stopFlag: false,
    failedContacts: []
  };
  campaigns.set(id, campaign);

  res.json({ campaignId: id });

  // Run campaign async
  runCampaign(campaign, client, from, messageTemplate, mediaUrl, ratePerSecond);
});

async function runCampaign(campaign, client, from, messageTemplate, mediaUrl, ratePerSecond) {
  const delayMs = Math.max(200, Math.floor(1000 / ratePerSecond));

  for (let i = 0; i < campaign.contacts.length; i++) {
    if (campaign.stopFlag) break;

    while (campaign.pauseFlag) {
      await sleep(300);
    }

    const contact = campaign.contacts[i];
    let phone = String(contact._phone || contact.telefono || contact.phone || '').replace(/\D/g, '');
    if (!phone) phone = String(Object.values(contact)[0]).replace(/\D/g, '');

    const to = `whatsapp:+${phone}`;
    const body = messageTemplate ? personalize(messageTemplate, contact) : undefined;

    try {
      const msgParams = { from, to };
      if (body) msgParams.body = body;
      if (mediaUrl) msgParams.mediaUrl = [mediaUrl];

      const msg = await client.messages.create(msgParams);

      campaign.stats.sent++;
      campaign.stats.pending--;

      broadcast(campaign, {
        type: 'log',
        level: 'ok',
        message: `✓ +${phone} · ${msg.sid.substring(0, 20)}…`,
        stats: { ...campaign.stats }
      });

    } catch (err) {
      campaign.stats.failed++;
      campaign.stats.pending--;
      campaign.failedContacts.push({ ...contact, error: err.message });

      broadcast(campaign, {
        type: 'log',
        level: 'err',
        message: `✗ +${phone} · ${err.message}`,
        stats: { ...campaign.stats }
      });
    }

    if (i < campaign.contacts.length - 1) await sleep(delayMs);
  }

  campaign.status = campaign.stopFlag ? 'stopped' : 'done';
  broadcast(campaign, {
    type: 'done',
    status: campaign.status,
    stats: { ...campaign.stats },
    failedCount: campaign.failedContacts.length
  });
}

// ── Campaign control ──────────────────────────────────────────────────────────
app.post('/api/campaign/:id/pause', (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  c.pauseFlag = !c.pauseFlag;
  broadcast(c, { type: 'control', action: c.pauseFlag ? 'paused' : 'resumed' });
  res.json({ paused: c.pauseFlag });
});

app.post('/api/campaign/:id/stop', (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  c.stopFlag = true;
  c.pauseFlag = false;
  res.json({ stopped: true });
});

// ── Export failed contacts ────────────────────────────────────────────────────
app.get('/api/campaign/:id/export-failed', (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(c.failedContacts);
  XLSX.utils.book_append_sheet(wb, ws, 'Fallidos');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="fallidos_${req.params.id}.xlsx"`);
  res.send(buf);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', campaigns: campaigns.size }));

// ── Twilio webhook (incoming messages) ───────────────────────────────────────
app.post('/webhook/whatsapp', (req, res) => {
  const { From, Body } = req.body;
  console.log(`[Webhook] Mensaje de ${From}: ${Body}`);
  // Auto-reply (optional — customize as needed)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Gracias por tu mensaje. Te responderemos a la brevedad.</Message>
</Response>`;
  res.type('text/xml').send(twiml);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => {
  console.log(`\n🤖 WABot server running on http://localhost:${PORT}`);
  console.log(`   Panel: http://localhost:${PORT}`);
  console.log(`   Webhook: http://localhost:${PORT}/webhook/whatsapp\n`);
});
