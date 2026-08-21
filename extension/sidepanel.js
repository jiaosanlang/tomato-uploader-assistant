const $ = (id) => document.getElementById(id);

const LIMITS = { maxFiles: 2000, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 30 * 1024 * 1024 };
const state = { step: 'source', chapters: [], schedule: [], page: null, cancelled: false };
const steps = ['source', 'schedule', 'page'];
const chapterPattern = /^第[一二三四五六七八九十百千万零〇两0-9０-９]+[章节回]\s*(.*)$/;

function setStep(step) {
  state.step = step;
  steps.forEach((name, index) => {
    $(`${name}View`).classList.toggle('active', name === step);
    const marker = document.querySelector(`[data-step="${name}"]`);
    marker.classList.toggle('active', name === step);
    marker.classList.toggle('done', index < steps.indexOf(step));
  });
  $('prevButton').disabled = steps.indexOf(step) === 0;
  $('nextButton').disabled = steps.indexOf(step) === steps.length - 1;
}

function setFooter(message) { $('footerStatus').textContent = message; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function nextFrame() { return new Promise((resolve) => requestAnimationFrame(resolve)); }

function parseChapterNumber(title) {
  const match = title.match(/^第\s*([0-9０-９一二三四五六七八九十百千万零〇两]+)\s*[章节回]/);
  if (!match) return 0;
  const digits = match[1].replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(digits)) return Number(digits);
  const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0; let section = 0;
  for (const char of digits) {
    if ('十百千万'.includes(char)) {
      const unit = { 十: 10, 百: 100, 千: 1000, 万: 10000 }[char];
      section = (section || 1) * unit;
      if (unit === 10000) { total += section; section = 0; }
    } else section += map[char] ?? 0;
  }
  return total + section;
}

function addDays(date, amount) { const next = new Date(date); next.setDate(next.getDate() + amount); return next; }
function fmtDate(date) { const p = (n) => String(n).padStart(2, '0'); return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`; }
function fmtTime(date) { return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }

function appendChaptersFromText(chapters, fileName, text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let current = null;
  const push = () => {
    if (!current) return;
    const content = current.content.join('\n').trim();
    if (content) chapters.push({ ...current, content, chars: (content.match(/[一-鿿]/g) || []).length });
    current = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (chapterPattern.test(line)) { push(); current = { title: line, number: parseChapterNumber(line), content: [], source: fileName }; }
    else if (current) current.content.push(raw);
  }
  push();
  if (!chapters.some((chapter) => chapter.source === fileName) && text.trim()) {
    const title = fileName.replace(/\.txt$/i, '').trim();
    chapters.push({ title, number: parseChapterNumber(title), content: text.trim(), chars: (text.match(/[一-鿿]/g) || []).length, source: fileName });
  }
}

async function readTextFile(file, fileName, totalBytes) {
  if (file.size > LIMITS.maxFileBytes) throw new Error(`${fileName} 超过单文件 ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)} MB 限制`);
  if (totalBytes + file.size > LIMITS.maxTotalBytes) throw new Error(`正文总大小超过 ${Math.round(LIMITS.maxTotalBytes / 1024 / 1024)} MB 限制`);
  return { fileName, text: await file.text(), bytes: file.size };
}

async function collectDirectoryFiles(directoryHandle, files, prefix = '') {
  for await (const [name, handle] of directoryHandle.entries()) {
    if (state.cancelled || files.length >= LIMITS.maxFiles) break;
    const relativeName = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') await collectDirectoryFiles(handle, files, relativeName);
    else if (handle.kind === 'file' && /\.txt$/i.test(name)) files.push({ handle, name: relativeName });
    if (files.length % 50 === 0) { $('sourceStatus').textContent = `正在扫描目录，已找到 ${files.length} 个 TXT…`; await nextFrame(); }
  }
}

async function processFiles(fileEntries, label) {
  if (!fileEntries.length) { $('sourceStatus').textContent = '没有找到 TXT 文件。'; return; }
  state.cancelled = false; state.chapters = [];
  let totalBytes = 0; const skipped = [];
  $('directoryButton').disabled = true; $('novelFiles').disabled = true; $('cancelButton').hidden = false;
  try {
    for (let index = 0; index < fileEntries.length; index++) {
      if (state.cancelled) break;
      if (index >= LIMITS.maxFiles) { skipped.push(`超过最多 ${LIMITS.maxFiles} 个文件`); break; }
      const entry = fileEntries[index];
      try { const file = entry.file || await entry.handle.getFile(); const result = await readTextFile(file, entry.name, totalBytes); totalBytes += result.bytes; appendChaptersFromText(state.chapters, result.fileName, result.text); }
      catch (error) { skipped.push(error.message); }
      $('sourceStatus').textContent = `${label}：${index + 1}/${fileEntries.length} 个文件，已识别 ${state.chapters.length} 章`;
      await nextFrame();
    }
    state.chapters.sort((a, b) => (a.number || Number.MAX_SAFE_INTEGER) - (b.number || Number.MAX_SAFE_INTEGER) || a.source.localeCompare(b.source, 'zh-CN', { numeric: true }));
    state.schedule = computeSchedule(state.chapters); renderChapters(); renderSchedule();
    $('sourceStatus').textContent = state.cancelled ? `已取消，保留 ${state.chapters.length} 章。` : `已识别 ${state.chapters.length} 章，读取 ${(totalBytes / 1024 / 1024).toFixed(1)} MB。`;
    setFooter(state.cancelled ? '读取已取消' : '章节已解析');
    if (skipped.length) console.warn('[Tomato Uploader Assistant] skipped files', skipped.slice(0, 20));
  } finally { $('directoryButton').disabled = false; $('novelFiles').disabled = false; $('cancelButton').hidden = true; }
}

function computeSchedule(chapters) {
  const dailyLimit = Math.max(1, Number($('dailyWordLimit').value) || 10000); const chapterLimit = Math.max(1, Number($('dailyChapterLimit').value) || 3);
  const start = $('startDate').value ? new Date(`${$('startDate').value}T00:00:00`) : new Date(); const [hours, minutes] = ($('dailyPublishTime').value || '07:00').split(':').map(Number);
  let day = new Date(start); let words = 0; let count = 0;
  return chapters.map((chapter) => { if (count >= chapterLimit || (words + chapter.chars > dailyLimit && words > 0)) { day = addDays(day, 1); words = 0; count = 0; } const date = new Date(day); date.setHours(hours, minutes, 0, 0); words += chapter.chars; count++; return { ...chapter, date: fmtDate(date), time: fmtTime(date) }; });
}

function renderChapters() { $('chapterCount').textContent = `${state.chapters.length} 章`; $('chapterPreview').innerHTML = state.chapters.slice(0, 30).map((chapter, index) => `<div class="preview-item"><span class="index">${String(index + 1).padStart(2, '0')}</span><span class="title">${escapeHtml(chapter.title)}</span><small>${chapter.chars} 字</small></div>`).join(''); if (state.chapters.length > 30) $('chapterPreview').insertAdjacentHTML('beforeend', `<p class="status-line">仅显示前 30 章，实际已读取 ${state.chapters.length} 章。</p>`); }
function renderSchedule() { const days = new Set(state.schedule.map((chapter) => chapter.date)); $('dayCount').textContent = `${days.size} 天`; const totalChars = state.schedule.reduce((sum, chapter) => sum + chapter.chars, 0); $('scheduleSummary').className = 'summary-card'; $('scheduleSummary').innerHTML = `<strong>${state.schedule.length} 章</strong><span>${totalChars} 字 · ${days.size} 天完成 · 每天最多 ${$('dailyChapterLimit').value || 3} 章</span>`; $('scheduleList').innerHTML = state.schedule.slice(0, 60).map((chapter) => `<div class="schedule-item"><span class="date">${chapter.date}</span><span class="title">${escapeHtml(chapter.title)}</span><small>${chapter.time}</small></div>`).join(''); }
async function sendToPage(message) { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id || !/^https:\/\/(fanqienovel\.com|writer\.fanqienovel\.com)\//.test(tab.url || '')) throw new Error('当前标签页不是番茄作者后台页面。'); return chrome.tabs.sendMessage(tab.id, message); }
async function selectIndividualFiles(event) { await processFiles([...event.target.files].filter((file) => /\.txt$/i.test(file.name)).map((file) => ({ file, name: file.name })), '正在读取文件'); event.target.value = ''; }
async function selectDirectory() { if (!window.showDirectoryPicker) { $('sourceStatus').textContent = '当前 Chrome 不支持目录选择，请升级 Chrome 后重试。'; return; } try { const directory = await window.showDirectoryPicker({ mode: 'read' }); const entries = []; await collectDirectoryFiles(directory, entries); if (entries.length >= LIMITS.maxFiles) $('sourceStatus').textContent = `目录文件过多，最多处理 ${LIMITS.maxFiles} 个 TXT。`; await processFiles(entries, '正在读取目录'); } catch (error) { if (error?.name !== 'AbortError') { $('sourceStatus').textContent = `目录读取失败：${error.message}`; setFooter('读取失败'); } } }

$('novelFiles').addEventListener('change', selectIndividualFiles); $('directoryButton').addEventListener('click', selectDirectory); $('cancelButton').addEventListener('click', () => { state.cancelled = true; setFooter('正在停止读取…'); }); $('scheduleButton').addEventListener('click', () => { state.schedule = computeSchedule(state.chapters); renderSchedule(); setFooter('排期已更新'); });
$('inspectButton').addEventListener('click', async () => { try { state.page = await sendToPage({ type: 'inspect-page' }); $('connectionDot').classList.add('connected'); $('pageBadge').textContent = '已连接'; $('pageInfo').className = 'page-card'; $('pageInfo').innerHTML = `<strong>${escapeHtml(state.page.title || '未命名页面')}</strong><code>${escapeHtml(state.page.url)}</code><p>${state.page.inputs.length} 个输入项 · ${state.page.buttons.length} 个按钮</p>`; $('debugOutput').textContent = JSON.stringify(state.page, null, 2); $('fillButton').disabled = !state.schedule.length; setFooter('页面已识别'); } catch (error) { $('pageInfo').textContent = error.message; setFooter('连接失败'); } });
$('fillButton').addEventListener('click', async () => { if (!state.schedule.length) return; try { const result = await sendToPage({ type: 'fill-chapter', chapter: state.schedule[0] }); if (!result.ok) throw new Error(result.error || '填写失败'); $('pageInfo').innerHTML = `<strong>${escapeHtml(result.message)}</strong><p>标题：${escapeHtml(result.title || '')}</p><p>正文：${result.contentLength || 0} 字</p>`; setFooter('已填写，请检查页面'); } catch (error) { setFooter(error.message); } });
$('prevButton').addEventListener('click', () => setStep(steps[Math.max(0, steps.indexOf(state.step) - 1)])); $('nextButton').addEventListener('click', () => setStep(steps[Math.min(steps.length - 1, steps.indexOf(state.step) + 1)]));
(async () => { const fields = ['dailyWordLimit', 'dailyChapterLimit', 'startDate', 'dailyPublishTime']; const saved = await chrome.storage.local.get(fields); for (const key of fields) { if (saved[key] != null) $(key).value = saved[key]; $(key).addEventListener('change', () => chrome.storage.local.set({ [key]: $(key).value })); } setStep('source'); })();
