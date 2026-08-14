const $ = (id) => document.getElementById(id);
const cfgFields = ['novelFile', 'uploadUrl', 'dailyWordLimit', 'startDate', 'dailyPublishTime',
  'chapterIntervalMinutes', 'dailyChapterLimit', 'startChapter', 'uploadDelaySeconds', 'stripMetaLines', 'headless'];
const selFields = [];

async function api(path, method = 'GET', body) {
  const opt = { method, headers: {} };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  return r.json();
}

function readForm() {
  const cfg = {};
  for (const f of cfgFields) {
    const el = $(f);
    cfg[f] = el.type === 'checkbox' ? el.checked : el.value;
  }
  cfg.selectors = {};
  for (const s of selFields) cfg.selectors[s] = $(`sel_${s}`).value;
  return cfg;
}
function fillForm(cfg) {
  for (const f of cfgFields) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!cfg[f]; else el.value = cfg[f] ?? '';
  }
  for (const s of selFields) $(`sel_${s}`).value = (cfg.selectors && cfg.selectors[s]) || '';
}

// 页签切换
document.querySelectorAll('nav button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(b.dataset.tab).classList.add('active');
  };
});

// 配置
(async () => { try { fillForm(await api('/api/config')); } catch {} })();
$('saveCfg').onclick = async () => {
  const r = await api('/api/config', 'POST', readForm());
  log('配置已保存 ' + (r.ok ? '✅' : ''));
};

async function chooseNovelSource(kind) {
  const result = await api('/api/choose-source', 'POST', { kind });
  if (result.error) { log('选择路径失败：' + result.error); return; }
  if (result.path) {
    $('novelFile').value = result.path;
    log(kind === 'directory' ? '已选择正文文件夹' : '已选择整本 TXT');
  }
}
$('chooseNovelFolder').onclick = () => chooseNovelSource('directory');
$('chooseNovelFile').onclick = () => chooseNovelSource('file');
$('btnLogin').onclick = async () => {
  await api('/api/config', 'POST', readForm());
  await api('/api/login', 'POST');
  log('已触发登录，浏览器即将打开，请登录后直接关闭浏览器窗口。');
};

// 选择器识别助手
$('btnInspect').onclick = async () => {
  await api('/api/config', 'POST', readForm());
  const pre = $('inspectResult');
  pre.style.display = 'block';
  $('inspectLoading').textContent = '识别中，正在打开上传页（约 5~15 秒）…';
  pre.textContent = '';
  const d = await api('/api/inspect', 'POST', readForm());
  $('inspectLoading').textContent = '';
  if (!d || !d.inputs) { pre.textContent = '识别失败：' + (d && d.error); return; }
  let out = `页面：${d.pageTitle}\n网址：${d.pageUrl}\n\n`;
  out += '【输入框 / 文本域】\n';
  const describe = (el) => {
    const bits = [];
    if (el.id) bits.push('#' + el.id);
    if (el.name) bits.push('name=' + el.name);
    if (el.ph) bits.push('placeholder="' + el.ph + '"');
    if (el.aria) bits.push('aria="' + el.aria + '"');
    return (el.tag.toLowerCase()) + (bits.length ? '[' + bits.join(' ') + ']' : '');
  };
  for (const el of [...d.inputs, ...d.textareas, ...d.editables]) out += '  ' + describe(el) + '\n';
  out += '\n【按钮】\n';
  for (const el of d.buttons) {
    if (el.text) out += `  button「${el.text}」${el.id ? '#' + el.id : ''}${el.cls ? ' .' + el.cls.split(' ')[0] : ''}\n`;
  }
  out += '\n【单选/复选（定时发布）】\n';
  for (const el of d.radios) {
    out += `  input[type=${el.type}] ${el.id ? '#' + el.id : ''} label=「${el.label || ''}」${el.checked ? '已勾选' : ''}\n`;
  }
  out += '\n【下拉框（分卷）】\n';
  for (const el of d.selects) {
    out += `  select ${el.id ? '#' + el.id : ''}：${el.options.join(' / ')}\n`;
  }
  pre.textContent = out;
};

// 解析
$('btnParse').onclick = async () => {
  const res = await api('/api/parse', 'POST', readForm());
  if (res.error) { $('parseInfo').textContent = '解析失败：' + res.error; return; }
  const sourceLabel = res.book.sourceType === 'directory' ? '分章文件夹' : '整本 TXT';
  $('parseInfo').textContent = `来源：${sourceLabel}　书名：${res.book.bookName || '（未识别）'}　共 ${res.totalCh} 章 / ${res.totalWords} 字`;
  let html = '';
  for (const v of res.book.volumes) {
    html += `<h3 style="margin:12px 0 6px;">${v.name}（${v.chapters.length} 章）</h3>`;
    html += `<div class="scroll"><table><tr><th>章节</th><th>来源文件</th><th>字数</th></tr>`;
    for (const c of v.chapters) html += `<tr><td>${c.title}</td><td>${c.sourceFile || ''}</td><td>${c.chars}</td></tr>`;
    html += `</table></div>`;
  }
  $('parseResult').innerHTML = html;
};

// 排期
$('btnSchedule').onclick = async () => {
  const res = await api('/api/schedule', 'POST', readForm());
  if (res.error) { $('scheduleSummary').textContent = '排期失败：' + res.error; return; }
  let s = `<div class="scroll"><table><tr><th>日期</th><th>章数</th><th>字数</th></tr>`;
  for (const d of res.summary) s += `<tr><td>${d.date}</td><td>${d.count}</td><td>${d.words}</td></tr>`;
  s += `</table></div><p class="note">共 ${res.schedule.length} 章，跨 ${res.summary.length} 天。超出每日上限的章节会自动顺延到次日。</p>`;
  $('scheduleSummary').innerHTML = s;
  let l = `<div class="scroll" style="margin-top:12px;"><table><tr><th>日期</th><th>时间</th><th>章节</th><th>字数</th></tr>`;
  for (const c of res.schedule) l += `<tr><td>${c.date}</td><td>${c.time}</td><td>${c.title}</td><td>${c.chars}</td></tr>`;
  l += `</table></div>`;
  $('scheduleList').innerHTML = l;
};

// 上传
function log(m) {
  const el = $('log');
  el.textContent += (el.textContent ? '\n' : '') + new Date().toLocaleTimeString() + '  ' + m;
  el.scrollTop = el.scrollHeight;
}
function renderStatus(s) {
  $('upStatus').textContent = s.running
    ? (s.waiting ? '⏸ 等待你操作…' : '运行中') + (s.currentTitle ? '：' + s.currentTitle : '')
    : '未在运行';
  $('upCount').textContent = `已完成 ${s.done} / ${s.total} 章`;
  if (s.total) $('upBar').style.width = Math.round((s.done / s.total) * 100) + '%';
  $('btnStart').disabled = s.running;
}
$('btnStart').onclick = async () => {
  await api('/api/config', 'POST', readForm());
  await api('/api/upload/start', 'POST');
  log('▶ 开始上传');
};
$('btnStop').onclick = async () => { await api('/api/upload/stop', 'POST'); log('已请求停止'); };

$('btnContinue').onclick = async () => { await api('/api/upload/continue', 'POST'); };

// 实时事件流
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('log', (e) => log(JSON.parse(e.data)));
  es.addEventListener('status', (e) => renderStatus(JSON.parse(e.data)));
  es.addEventListener('waiting', (e) => {
    const w = JSON.parse(e.data);
    const box = $('waitingBox');
    if (w) { $('waitingMsg').textContent = w.message; box.style.display = 'block'; }
    else box.style.display = 'none';
  });
  es.onopen = () => { $('conn').textContent = '● 已连接'; };
  es.onerror = () => { $('conn').textContent = '○ 连接断开，重连中…'; setTimeout(connect, 1500); };
}
connect();
(async () => { try { renderStatus(await api('/api/status')); } catch {} })();
