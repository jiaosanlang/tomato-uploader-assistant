import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UploadEngine, loadState } from './engine.mjs';
import { parseNovel, loadConfig, normalizeConfig } from './parse.js';
import { computeSchedule } from './schedule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, 'web');
const CONFIG = path.join(__dirname, 'config.json');
const PORT = Number(process.env.PORT || 4321);

const engine = new UploadEngine();
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}
engine.on('log', (m) => broadcast('log', m));
engine.on('status', (s) => broadcast('status', s));

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); }
    });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function serveStatic(res, pathname) {
  let p = path.normalize(path.join(WEB, pathname === '/' ? 'index.html' : pathname));
  if (!p.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end(data);
  });
}

function scheduleSummary(schedule) {
  const byDay = new Map();
  for (const s of schedule) {
    if (!byDay.has(s.date)) byDay.set(s.date, { count: 0, words: 0 });
    const d = byDay.get(s.date);
    d.count++;
    d.words += s.chars;
  }
  return [...byDay.entries()].map(([date, d]) => ({ date, count: d.count, words: d.words }));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function chooseLocalPath(kind) {
  const isFolder = kind === 'directory';
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = ' + (isFolder
      ? 'New-Object System.Windows.Forms.FolderBrowserDialog'
      : 'New-Object System.Windows.Forms.OpenFileDialog'),
    isFolder
      ? `$dialog.Description = ${psQuote('选择存放分章 TXT 的正文文件夹')}`
      : `$dialog.Filter = ${psQuote('文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*')}`,
    isFolder ? '$dialog.ShowNewFolderButton = $false' : '$dialog.Multiselect = $false',
    '$result = $dialog.ShowDialog()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
    isFolder ? '  [Console]::Write($dialog.SelectedPath)' : '  [Console]::Write($dialog.FileName)',
    '}',
  ].join('; ');
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
      { cwd: __dirname, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) return reject(new Error((stderr || error.message).trim()));
        resolve(stdout.trim());
      },
    );
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => clearInterval(hb));
      return;
    }

    if (p === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, loadConfig());
    }
    if (p === '/api/config' && req.method === 'POST') {
      const cfg = await readBody(req);
      fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/choose-source' && req.method === 'POST') {
      const { kind } = await readBody(req);
      if (kind !== 'file' && kind !== 'directory') {
        return sendJson(res, 400, { error: 'kind 必须是 file 或 directory' });
      }
      const selectedPath = await chooseLocalPath(kind);
      return sendJson(res, 200, { path: selectedPath });
    }
    if (p === '/api/parse' && req.method === 'POST') {
      const cfg = normalizeConfig(await readBody(req));
      const book = parseNovel(cfg.novelFile, { stripMetaLines: cfg.stripMetaLines });
      let totalCh = 0, totalWords = 0;
      for (const v of book.volumes) for (const c of v.chapters) { totalCh++; totalWords += c.chars; }
      return sendJson(res, 200, { book, totalCh, totalWords });
    }
    if (p === '/api/schedule' && req.method === 'POST') {
      const cfg = normalizeConfig(await readBody(req));
      const book = parseNovel(cfg.novelFile, { stripMetaLines: cfg.stripMetaLines });
      const schedule = computeSchedule(book, cfg);
      fs.writeFileSync(path.join(__dirname, 'schedule.json'), JSON.stringify(schedule, null, 2), 'utf8');
      return sendJson(res, 200, { schedule, summary: scheduleSummary(schedule) });
    }
    if (p === '/api/state') {
      return sendJson(res, 200, loadState());
    }
    if (p === '/api/status') {
      return sendJson(res, 200, { ...engine.progress, running: engine.running });
    }
    if (p === '/api/inspect' && req.method === 'POST') {
      const cfg = normalizeConfig(await readBody(req));
      const data = await engine.inspect(cfg);
      return sendJson(res, 200, data);
    }
    if (p === '/api/inspect-publish-dialog' && req.method === 'POST') {
      const cfg = normalizeConfig(await readBody(req));
      const data = await engine.inspectPublishDialog(cfg);
      return sendJson(res, 200, data);
    }
    if (p === '/api/validate-chapter-form' && req.method === 'POST') {
      const cfg = normalizeConfig(await readBody(req));
      const data = await engine.validateChapterForm(cfg);
      return sendJson(res, 200, data);
    }
    if (p === '/api/inspect-current-page') {
      const data = await engine.inspectCurrentPage();
      return sendJson(res, 200, data);
    }
    if (p === '/api/inspect-fresh-chapter' && req.method === 'POST') {
      const cfg = normalizeConfig(await readBody(req));
      const data = await engine.inspectFreshChapter(cfg);
      return sendJson(res, 200, data);
    }
    if (p === '/api/upload/continue' && req.method === 'POST') {
      engine.continueUpload();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/login' && req.method === 'POST') {
      engine.login(loadConfig()).catch((e) => broadcast('log', '登录打开失败：' + e.message));
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/upload/start' && req.method === 'POST') {
      engine.start(loadConfig());
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/upload/stop' && req.method === 'POST') {
      engine.requestStop();
      return sendJson(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'no route' });
    return serveStatic(res, p);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const u = `http://127.0.0.1:${PORT}`;
  console.log(`📚 番茄定时上传助手已启动：${u}`);
  console.log('仅本机可访问。关闭本窗口即停止服务。');
  if (!process.argv.includes('--noopen')) {
    try { exec(`start "" "${u}"`); } catch {}
  }
});
