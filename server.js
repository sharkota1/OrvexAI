import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const { API_KEY, BASE_URL = 'https://triklz27.ru/v1', MODEL = 'claude-opus-4-6', PORT = 3000 } = process.env;
if (!API_KEY) console.warn('Внимание: переменная API_KEY не задана');

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const SYSTEM = 'Ты ORVEX — дружелюбный и точный помощник. Отвечай на языке пользователя.';
const LANG = { ru: ' Всегда отвечай по-русски.', en: ' Always answer in English.' };
const MODE = { short: ' Отвечай кратко.', detailed: ' Отвечай подробно, с примерами.' };

// простой лимит: 20 запросов в минуту с одного IP (хранится в памяти)
const hits = new Map();
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(ip, a);
  return a.length > 20;
}
function readBody(req, max = 1_000_000) {
  return new Promise((ok, no) => {
    let n = 0; const b = [];
    req.on('data', c => { n += c.length; if (n > max) { no(new Error('too big')); req.destroy(); } else b.push(c); });
    req.on('end', () => ok(Buffer.concat(b).toString()));
    req.on('error', no);
  });
}

http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method === 'POST' && req.url === '/api/chat') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (limited(ip)) { res.writeHead(429); return res.end('Слишком много запросов, подожди минуту'); }
      let j;
      try { j = JSON.parse(await readBody(req)); } catch { res.writeHead(400); return res.end('Некорректный запрос'); }
      const msgs = (Array.isArray(j.messages) ? j.messages : [])
        .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-40);
      if (!msgs.length) { res.writeHead(400); return res.end('Пустой запрос'); }

      const ctrl = new AbortController();
      res.on('close', () => ctrl.abort()); // клиент нажал «Стоп» или закрыл вкладку
      const up = await fetch(BASE_URL.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
        body: JSON.stringify({
          model: MODEL, stream: true,
          messages: [{ role: 'system', content: SYSTEM + (LANG[j.lang] || '') + (MODE[j.mode] || '') }, ...msgs],
        }),
      });
      if (!up.ok) {
        console.error('Ошибка провайдера', up.status, (await up.text()).slice(0, 300));
        res.writeHead(502); return res.end('Сервис ИИ временно недоступен');
      }
      res.writeHead(200, { 'Content-Type': up.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-cache' });
      return Readable.fromWeb(up.body).pipe(res);
    }

    // статические файлы
    let f = '/'; try { f = decodeURIComponent(req.url.split('?')[0]); } catch {}
    const p = path.normalize(path.join(dir, f === '/' ? 'index.html' : f));
    if (!p.startsWith(dir + path.sep) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('Не найдено'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, () => console.log('ORVEX AI: http://localhost:' + PORT));
