import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseNovel } from './parse.js';
import { computeSchedule } from './schedule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(__dirname, 'state.json');

function findBundledChromium() {
  const browserRoot = path.join(__dirname, 'browsers');
  if (!fs.existsSync(browserRoot)) return '';
  const candidates = fs.readdirSync(browserRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    .map((entry) => path.join(browserRoot, entry.name, 'chrome-win64', 'chrome.exe'));
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

const bundledChromium = findBundledChromium();

function splitChapterTitle(fullTitle) {
  const match = String(fullTitle || '').trim().match(/^第\s*([0-9０-９]+)\s*[章节回]\s*(.*)$/);
  if (!match) return { number: '', title: String(fullTitle || '').trim() };
  const number = match[1].replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  return { number: String(Number(number)), title: match[2].trim() || String(fullTitle || '').trim() };
}

function normalizeEditorContent(content) {
  return String(content || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]*\n+/g, '\n')
    .trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeComparableText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[“”‘’'"`]/g, '');
}

export function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { done: [], log: [] }; }
}
export function saveState(s) {
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8');
}

export class UploadEngine extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.stopRequested = false;
    this.waiting = null;
    this._continueResolve = null;
    this.browserContext = null;
    this.browserLaunchPromise = null;
    this.chapterManagerUrl = '';
    this.progress = { total: 0, done: 0, currentTitle: '' };
  }

  log(msg) { this.emit('log', msg); }
  emitStatus() { this.emit('status', { ...this.progress, running: this.running, waiting: !!this.waiting }); }

  async requestStop() {
    this.stopRequested = true;
    this.log('⏹ 已请求停止，当前这一章完成后停止。');
    // 若正在等待用户手动建卷，先放行让循环看到停止标记
    if (this._continueResolve) this._continueResolve();
  }

  // 暂停上传，等待用户在界面上点「继续」
  async waitForContinue(message) {
    this.log('⏸ ' + message);
    this.waiting = { message };
    this.emit('waiting', this.waiting);
    this.emitStatus();
    await new Promise((res) => { this._continueResolve = res; });
    this.waiting = null;
    this._continueResolve = null;
    this.log('▶ 继续上传。');
    this.emit('waiting', null);
    this.emitStatus();
  }

  continueUpload() {
    if (this._continueResolve) this._continueResolve();
  }

  _contextIsOpen(ctx) {
    if (!ctx) return false;
    try { ctx.pages(); return true; } catch { return false; }
  }

  async _stopStaleBrowser(profileDir) {
    if (process.platform !== 'win32') return false;
    const escapedProfile = profileDir.replace(/'/g, "''");
    const escapedRoot = path.join(__dirname, 'browsers').replace(/'/g, "''");
    const script = [
      `$profile = '${escapedProfile}'`,
      `$browserRoot = '${escapedRoot}'`,
      "$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.ExecutablePath -like ($browserRoot + '*') -and $_.CommandLine -like ('*' + $profile + '*') }",
      'if ($items) { $items | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; [Console]::Write("stopped") }',
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true }, (error, stdout) => {
        resolve(!error && stdout.includes('stopped'));
      });
    });
  }

  async _launchBrowser(cfg, headless) {
    const profileDir = path.resolve(__dirname, cfg.userDataDir || 'profile');
    const options = {
      headless,
      viewport: { width: 1360, height: 900 },
      ...(bundledChromium ? { executablePath: bundledChromium } : {}),
    };
    try {
      return await chromium.launchPersistentContext(profileDir, options);
    } catch (error) {
      // 上次服务异常退出时，内置 Chromium 可能仍占用 profile。只清理本助手自己的浏览器后重试。
      const stopped = await this._stopStaleBrowser(profileDir);
      if (!stopped) throw error;
      this.log('检测到上次遗留的内置浏览器，已自动关闭并重新连接。');
      await new Promise((resolve) => setTimeout(resolve, 500));
      return chromium.launchPersistentContext(profileDir, options);
    }
  }

  async getBrowserContext(cfg, { headless = false } = {}) {
    if (this._contextIsOpen(this.browserContext)) return this.browserContext;
    if (this.browserLaunchPromise) return this.browserLaunchPromise;

    this.browserLaunchPromise = this._launchBrowser(cfg, headless)
      .then((ctx) => {
        this.browserContext = ctx;
        ctx.once('close', () => {
          if (this.browserContext === ctx) this.browserContext = null;
          this.log('浏览器已关闭，登录会话已保存。');
        });
        return ctx;
      })
      .finally(() => { this.browserLaunchPromise = null; });
    return this.browserLaunchPromise;
  }

  async setInputValue(locator, value, label = '输入框') {
    await locator.waitFor({ state: 'visible', timeout: 15000 });
    await locator.scrollIntoViewIfNeeded();

    // 番茄的日期/时间框由 React 控制。直接改 DOM value 会在弹窗重绘时恢复默认值，
    // 必须像用户一样实际聚焦、全选、输入并确认，才能更新组件内部状态。
    const readOnly = await locator.evaluate((el) => el.readOnly);
    if (readOnly) await locator.evaluate((el) => el.removeAttribute('readonly'));
    await locator.click({ force: true });
    await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await locator.fill(value);
    // 只用失焦提交输入值。回车会冒泡到发布弹窗，可能提前触发“确认发布”。
    await locator.press('Tab').catch(() => {});
    await locator.page().waitForTimeout(800);

    const actual = (await locator.inputValue()).trim();
    if (!actual.includes(value)) {
      throw new Error(`${label}填写失败：期望 ${value}，页面实际为“${actual}”`);
    }
    return actual;
  }

  async setDatePickerValue(page, locator, value) {
    await locator.waitFor({ state: 'visible', timeout: 15000 });
    await locator.scrollIntoViewIfNeeded();
    await locator.click({ force: true });
    await page.waitForTimeout(400);

    const [targetYear, targetMonth, targetDay] = value.split('-').map(Number);
    let popup = page.locator('.arco-picker-container:visible').last();
    if (!(await popup.isVisible().catch(() => false))) {
      popup = page.locator('.arco-picker-dropdown:visible, .byte-date-picker-dropdown:visible')
        .filter({ has: page.locator('[class*="cell"]') }).last();
    }
    if (!(await popup.isVisible().catch(() => false))) {
      throw new Error('点击日期输入框后没有打开日期选择面板。');
    }

    const readPanelYearMonth = async () => {
      const text = (await popup.innerText()).replace(/\s+/g, ' ');
      let match = text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月/);
      if (match) return { year: Number(match[1]), month: Number(match[2]) };
      match = text.match(/(20\d{2})[-/.](\d{1,2})/);
      return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
    };

    for (let steps = 0; steps < 24; steps++) {
      const current = await readPanelYearMonth();
      if (!current || (current.year === targetYear && current.month === targetMonth)) break;
      const currentIndex = current.year * 12 + current.month;
      const targetIndex = targetYear * 12 + targetMonth;
      const direction = targetIndex > currentIndex ? 'next' : 'prev';
      let nav = null;

      // 新版 Arco 日期面板的四个纯图标依次为：上一年、上个月、下个月、下一年。
      // 优先按固定位置取“月”按钮，避免误点成上一年或下一年。
      const iconButtons = popup.locator('.arco-picker-header-icon:visible');
      const iconCount = await iconButtons.count();
      if (iconCount >= 4) {
        nav = direction === 'next' ? iconButtons.nth(iconCount - 2) : iconButtons.nth(1);
      } else {
        const candidates = direction === 'next'
          ? popup.locator('button[aria-label*="next month" i], button[aria-label*="下个月"], button[title*="下个月"], button:has(svg[class*="right"])')
          : popup.locator('button[aria-label*="previous month" i], button[aria-label*="prev month" i], button[aria-label*="上个月"], button[title*="上个月"], button:has(svg[class*="left"])');
        const candidateCount = await candidates.count();
        for (let index = 0; index < candidateCount; index++) {
          const candidate = candidates.nth(direction === 'next' ? candidateCount - 1 - index : index);
          if (await candidate.isVisible().catch(() => false)) {
            nav = candidate;
            break;
          }
        }
      }

      if (!nav || !(await nav.isVisible().catch(() => false))) {
        throw new Error(`日期面板无法切换到 ${value}`);
      }
      await nav.click({ force: true });
      await page.waitForTimeout(250);
    }

    const finalPanel = await readPanelYearMonth();
    if (!finalPanel) {
      throw new Error(`无法识别日期面板当前月份，不能安全选择 ${value}`);
    }
    if (finalPanel.year !== targetYear || finalPanel.month !== targetMonth) {
      throw new Error(`日期面板停留在 ${finalPanel.year}-${String(finalPanel.month).padStart(2, '0')}，无法切换到 ${value}`);
    }

    const dayPattern = new RegExp(`^\\s*${targetDay}\\s*$`);
    const dayCandidates = popup.locator('.arco-picker-cell-in-view:not(.arco-picker-cell-disabled)')
      .filter({ hasText: dayPattern });
    const dayCount = await dayCandidates.count();
    let selected = false;
    for (let index = 0; index < dayCount; index++) {
      const candidate = dayCandidates.nth(index);
      const text = (await candidate.innerText().catch(() => '')).trim();
      if (text !== String(targetDay)) continue;
      await candidate.click({ force: true });
      selected = true;
      break;
    }
    if (!selected) {
      const debug = await popup.locator('button, td, [role="button"], [class*="cell"], [class*="date"]')
        .evaluateAll((elements) => elements.slice(0, 120).map((el) => ({
          tag: el.tagName,
          text: (el.textContent || '').trim(),
          cls: String(el.className || ''),
          aria: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
        })));
      throw new Error(`日期面板中没有找到可选的 ${targetDay} 日。面板元素：${JSON.stringify(debug)}`);
    }
    await page.waitForTimeout(800);

    const actual = (await locator.inputValue()).trim();
    if (!actual.includes(value)) {
      throw new Error(`定时日期选择失败：期望 ${value}，页面实际为“${actual}”`);
    }
    return actual;
  }

  async configurePublishDialog(page, schedule, { confirmPublish = true } = {}) {
    const dialogs = page.locator('[role="dialog"]:visible, .arco-modal:visible');
    const deadline = Date.now() + 30000;
    let dialog = null;

    // 点击下一步后依次处理：错别字提示 -> 仅基础检测 -> 发布设置。
    while (Date.now() < deadline) {
      const typoDialog = dialogs.filter({ hasText: /错别字|是否确定提交/ }).last();
      if (await typoDialog.isVisible().catch(() => false)) {
        await typoDialog.getByRole('button', { name: /^提交$/ }).last().click();
        await typoDialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
        continue;
      }

      const checkDialog = dialogs.filter({ hasText: /选择内容检测方式|基础检测/ }).last();
      if (await checkDialog.isVisible().catch(() => false)) {
        await checkDialog.getByRole('button', { name: /仅基础检测/ }).last().click();
        await checkDialog.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
        continue;
      }

      const publishDialog = dialogs.filter({ hasText: /发布设置/ }).last();
      if (await publishDialog.isVisible().catch(() => false)) {
        dialog = publishDialog;
        break;
      }
      await page.waitForTimeout(250);
    }
    if (!dialog) throw new Error('点击下一步后，30 秒内没有进入发布设置。');

    // 发布设置中保持“使用 AI”为开启状态。
    const useAi = dialog.getByText('是', { exact: true }).last();
    if (await useAi.count()) await useAi.click();

    const scheduleSwitch = dialog.locator('button.arco-switch').last();
    if (await scheduleSwitch.count()) {
      const checked = await scheduleSwitch.evaluate((el) =>
        el.classList.contains('arco-switch-checked') || el.getAttribute('aria-checked') === 'true');
      if (!checked) await scheduleSwitch.click();
    }
    await page.waitForTimeout(300);

    const visibleInputs = dialog.locator('input:visible');
    const count = await visibleInputs.count();
    let dateInput = null;
    let timeInput = null;
    for (let index = 0; index < count; index++) {
      const input = visibleInputs.nth(index);
      const info = await input.evaluate((el) => ({
        type: el.type,
        placeholder: el.placeholder || '',
        value: el.value || '',
        outer: el.outerHTML,
        parent: (el.parentElement?.parentElement?.textContent || '').trim(),
      }));
      const haystack = `${info.placeholder} ${info.value} ${info.outer} ${info.parent}`;
      if (!dateInput && (info.type === 'date' || /^\d{4}-\d{2}-\d{2}$/.test(info.value) || /YYYY/i.test(haystack))) dateInput = input;
      if (!timeInput && (info.type === 'time' || /^\d{2}:\d{2}$/.test(info.value) || /HH/i.test(haystack))) timeInput = input;
    }
    if ((!dateInput || !timeInput) && count >= 3) {
      dateInput ||= visibleInputs.nth(count - 3);
      timeInput ||= visibleInputs.nth(count - 2);
    }
    if (!dateInput || !timeInput) {
      throw new Error('已进入发布设置，但没有识别到定时日期/时间输入框。');
    }
    await this.setDatePickerValue(page, dateInput, schedule.date);
    await this.setInputValue(timeInput, schedule.time, '定时时间');
    // 等待一次组件重绘，再检查一遍，防止只改到输入框表面值。
    await page.waitForTimeout(1000);
    const actualDate = await dateInput.inputValue();
    const actualTime = await timeInput.inputValue();
    if (!actualDate.includes(schedule.date) || !actualTime.includes(schedule.time)) {
      throw new Error(`定时时间填写失败：期望 ${schedule.date} ${schedule.time}，实际 ${actualDate} ${actualTime}`);
    }

    if (!confirmPublish) {
      return { date: actualDate, time: actualTime };
    }

    const confirm = dialog.locator('button:visible').last();
    await confirm.waitFor({ state: 'visible', timeout: 15000 });

    // 必须等到番茄服务器实际收到章节提交请求，不能只以弹窗关闭作为成功依据。
    const expectedTitle = splitChapterTitle(schedule.title).title;
    const submissionResponsePromise = page.waitForResponse((response) => {
      const request = response.request();
      if (!['POST', 'PUT', 'PATCH'].includes(request.method())) return false;
      const url = response.url();
      if (/track|report|monitor|collect|analytics|log\/web/i.test(url)) return false;
      const body = request.postData() || '';
      return body.includes(expectedTitle) || /publish|chapter|content|creation|submit/i.test(url);
    }, { timeout: 15000 }).catch(() => null);

    await confirm.click();
    await dialog.waitFor({ state: 'hidden', timeout: 20000 });
    await page.waitForTimeout(1200);

    const submissionResponse = await submissionResponsePromise;
    if (!submissionResponse) {
      throw new Error(`第${splitChapterTitle(schedule.title).number}章确认发布后，未检测到服务器提交请求，不能记为成功`);
    }
    if (!submissionResponse.ok()) {
      throw new Error(`章节提交接口返回 HTTP ${submissionResponse.status()}，不能记为成功`);
    }
    const submissionResult = await submissionResponse.json().catch(() => null);
    if (submissionResult && submissionResult.success === false) {
      throw new Error(`章节提交接口返回失败：${submissionResult.message || submissionResult.msg || '未知原因'}`);
    }

    // 发布接口拒绝提交时弹窗仍可能关闭，必须在记录进度前识别错误提示。
    const notices = await page.locator([
      '.arco-message:visible',
      '.arco-notification:visible',
      '.arco-alert:visible',
      '[role="alert"]:visible',
      '[class*="toast"]:visible',
    ].join(', ')).allInnerTexts().catch(() => []);
    const publishError = notices.map((text) => text.trim()).find((text) =>
      /超出|失败|错误|异常|未成功|上限/.test(text));
    if (publishError) throw new Error(`发布失败：${publishError}`);

    return {
      submissionAccepted: true,
      status: submissionResponse.status(),
      result: submissionResult,
    };
  }

  async dismissInfoDialogs(page) {
    for (const name of ['我知道了', '知道了']) {
      const button = page.getByRole('button', { name, exact: true }).last();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }
    }
  }

  async openFreshChapterPage(ctx, cfg, { inspectOnly = false } = {}) {
    const managerPage = await ctx.newPage();
    await managerPage.goto(cfg.uploadUrl, { waitUntil: 'domcontentloaded' });
    await managerPage.locator('input[placeholder="请输入标题"]').first()
      .waitFor({ state: 'visible', timeout: 20000 });
    await managerPage.waitForTimeout(1200);
    await this.dismissInfoDialogs(managerPage);

    // 配置中的 publish/{itemId} 是“编辑已有章节”地址。读取书名与 bookId，
    // 直接进入稳定的章节管理路由，再点击真正的“新建章节”。
    const bookName = (await managerPage.locator('.publish-maintain-volume .font1 span').first()
      .innerText().catch(() => '')).trim();
    const upload = new URL(cfg.uploadUrl);
    const routeMatch = upload.pathname.match(/\/main\/writer\/([^/]+)\/publish(?:\/|$)/);
    const bookId = routeMatch?.[1] || '';
    if (!bookId || !bookName) {
      await managerPage.close().catch(() => {});
      throw new Error('无法从上传页识别书籍 ID 或书名，不能安全进入章节管理页');
    }
    this.chapterManagerUrl = `${upload.origin}/main/writer/chapter-manage/${bookId}&${encodeURIComponent(bookName)}?type=1`;
    await managerPage.goto(this.chapterManagerUrl, { waitUntil: 'domcontentloaded' });
    const createButton = managerPage.getByRole('button', { name: /^新建章节$/ }).first();
    await createButton.waitFor({ state: 'visible', timeout: 20000 });

    const newPagePromise = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await createButton.click();
    const openedPage = await newPagePromise;
    const page = openedPage || managerPage;
    if (openedPage) await managerPage.close().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.locator('input[placeholder="请输入标题"]').first()
      .waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('.ProseMirror:visible').first()
      .waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(1200);
    await this.dismissInfoDialogs(page);

    const existingTitle = (await page.locator('input[placeholder="请输入标题"]').first().inputValue()).trim();
    const rawExistingContent = (await page.locator('.ProseMirror:visible').first().innerText()).trim();
    const existingContent = /^请输入正文[。.!！]?$/.test(rawExistingContent) ? '' : rawExistingContent;
    const initial = {
      url: page.url(),
      chapterNumber: (await page.locator('input.serial-input').first().inputValue().catch(() => '')).trim(),
      title: existingTitle,
      contentLength: existingContent.length,
      contentStart: existingContent.slice(0, 300),
    };
    if (inspectOnly) return { page, initial };
    const newRoute = page.url().match(/\/main\/writer\/([^/]+)\/publish\/([^/?]+)/);
    const configuredRoute = cfg.uploadUrl.match(/\/main\/writer\/([^/]+)\/publish\/([^/?]+)/);
    const openedItemId = newRoute?.[2] || '';
    const configuredItemId = configuredRoute?.[2] || '';
    if (!openedItemId || openedItemId === configuredItemId) {
      await page.close().catch(() => {});
      throw new Error('“新建章节”没有生成新的章节页面，已停止以防覆盖已有章节。');
    }
    if (existingTitle || existingContent) {
      await page.close().catch(() => {});
      throw new Error('点击“新建章节”后页面中已有真实标题或正文，已停止以防覆盖。');
    }
    return page;
  }

  async inspectFreshChapter(cfg) {
    const ctx = await this.getBrowserContext(cfg, { headless: false });
    const result = await this.openFreshChapterPage(ctx, cfg, { inspectOnly: true });
    try {
      return result.initial;
    } finally {
      await result.page.close().catch(() => {});
    }
  }

  async verifyChapterInManager(page, schedule, submissionEvidence = null) {
    if (!this.chapterManagerUrl) throw new Error('缺少章节管理页地址，无法核验发布结果');
    if (page.isClosed()) throw new Error('发布页面已关闭，无法核验发布结果');
    const chapter = splitChapterTitle(schedule.title);
    const normalizedTitle = normalizeComparableText(chapter.title);
    const expectedNumber = new RegExp(`第0*${escapeRegExp(chapter.number)}章`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.goto(this.chapterManagerUrl, { waitUntil: 'domcontentloaded' });
      const createButton = page.getByRole('button', { name: /^新建章节$/ }).first();
      await createButton.waitFor({ state: 'visible', timeout: 20000 });

      const search = page.locator('input[placeholder*="搜索章节"]').first();
      if (await search.isVisible().catch(() => false)) {
        await search.fill(chapter.title);
      }
      await page.waitForTimeout(1500 * attempt);

      const managerText = normalizeComparableText(await page.locator('body').innerText());
      if (expectedNumber.test(managerText) && managerText.includes(normalizedTitle)) {
        return { foundInManager: true };
      }
    }

    if (submissionEvidence?.submissionAccepted) {
      this.log(`  ⚠ 服务器已确认接收第${chapter.number}章，但章节管理列表暂未刷新；已按提交成功保存进度，避免重复上传。`);
      return { foundInManager: false, acceptedByServer: true };
    }

    throw new Error(`发布弹窗已关闭，但章节管理页没有找到“第${chapter.number}章 ${chapter.title}”，且没有服务器成功回执，不能记为成功`);
  }

  // 打开持久化浏览器供手动登录；用户关掉窗口即保存会话
  async login(cfg) {
    const url = cfg.uploadUrl || 'https://writer.fanqienovel.com';
    this.log(`打开浏览器登录：${url}  （登录后请直接关闭浏览器窗口）`);
    const ctx = await this.getBrowserContext(cfg, { headless: false });
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => this.log('打开页面失败：' + e.message));
    return ctx;
  }

  // 打开上传页，抓取表单元素供用户识别选择器
  async inspect(cfg) {
    const url = cfg.uploadUrl || 'https://writer.fanqienovel.com';
    this.log(`🔍 正在打开 ${url} 抓取页面元素…（若未登录会跳到登录页，请先用「登录」按钮登录）`);
    const ctx = await this.getBrowserContext(cfg, { headless: false });
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const data = await page.evaluate(() => {
        const q = (el) => ({
          tag: el.tagName, type: el.type || '', id: el.id, name: el.name || '',
          cls: (el.className && String(el.className)) || '', ph: el.placeholder || '',
          aria: el.getAttribute('aria-label') || '', value: el.value || '',
          text: (el.textContent || '').trim().slice(0, 30),
        });
        const pick = (list) => list.filter(Boolean).map(q);
        return {
          pageUrl: location.href,
          pageTitle: document.title,
          bodyText: (document.body.innerText || '').trim().slice(0, 5000),
          topLeftElements: document.elementsFromPoint(40, 55).map((el) => ({
            tag: el.tagName,
            cls: String(el.className || ''),
            text: (el.textContent || '').trim().slice(0, 80),
            html: el.outerHTML.slice(0, 1000),
          })),
          inputs: pick([...document.querySelectorAll('input[type="text"], input[type="textarea"], input:not([type])')]),
          allInputs: [...document.querySelectorAll('input')].map((el) => ({
            ...q(el),
            parentText: (el.parentElement?.parentElement?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
            html: el.outerHTML.slice(0, 500),
          })),
          textareas: pick([...document.querySelectorAll('textarea')]),
          editables: pick([...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')]),
          radios: pick([...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')]).map((r) => {
            const lab = r.id ? (() => { try { return document.querySelector(`label[for="${r.id}"]`)?.textContent.trim().slice(0, 20) || ''; } catch { return ''; } })() : '';
            return { ...r, label: lab };
          }),
          buttons: [...document.querySelectorAll('button, [role="button"]')].map((el) => ({
            ...q(el),
            parentText: (el.parentElement?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
            html: el.outerHTML.slice(0, 500),
          })),
          links: [...document.querySelectorAll('a')].map((el) => ({
            ...q(el),
            href: el.href || '',
            parentText: (el.parentElement?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
            html: el.outerHTML.slice(0, 700),
          })),
          selects: [...document.querySelectorAll('select')].map((el) => ({
            id: el.id, name: el.name, cls: (el.className && String(el.className)) || '',
            options: Array.from(el.options).slice(0, 12).map((o) => o.text.trim()),
          })),
        };
      });
      return data;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async inspectPublishDialog(cfg) {
    const book = parseNovel(cfg.novelFile, { stripMetaLines: cfg.stripMetaLines });
    const schedule = computeSchedule(book, cfg);
    const item = schedule[0];
    const source = book.volumes.flatMap((volume) => volume.chapters)[item?.chapterIndex];
    if (!item || !source) throw new Error('没有可用于检查发布设置的章节。');
    const chapter = splitChapterTitle(item.title);

    const ctx = await this.getBrowserContext(cfg, { headless: false });
    const existingPages = new Set(ctx.pages());
    const page = await this.openFreshChapterPage(ctx, cfg);
    try {
      const chapterNumber = page.locator('input.serial-input').first();
      const title = page.locator('input[placeholder="请输入标题"]').first();
      const editor = page.locator('.ProseMirror:visible').first();
      await chapterNumber.click();
      await chapterNumber.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.type(chapter.number, { delay: 30 });
      await chapterNumber.press('Tab');
      await title.click();
      await title.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.type(chapter.title, { delay: 30 });
      await title.press('Tab');
      await editor.click();
      await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await editor.press('Backspace');
      await page.keyboard.insertText(normalizeEditorContent(source.content));
      await editor.press('Tab');
      await page.waitForTimeout(1200);
      const next = page.locator('button.publish-button').first();
      await next.waitFor({ state: 'visible', timeout: 15000 });
      if (await next.isDisabled()) throw new Error('填写章节后“下一步”仍不可用。');
      const newPagePromise = ctx.waitForEvent('page', { timeout: 3000 }).catch(() => null);
      await next.click();
      const openedPage = await newPagePromise;
      const targetPage = openedPage || (page.isClosed() ? ctx.pages().at(-1) : page);
      if (!targetPage) throw new Error('点击下一步后未找到发布设置页面。');
      await targetPage.waitForLoadState('domcontentloaded').catch(() => {});
      await targetPage.waitForTimeout(800);
      const result = await this.configurePublishDialog(targetPage, item, { confirmPublish: false });
      return { ...result, expectedDate: item.date, expectedTime: item.time, confirmed: false };
    } finally {
      for (const candidate of ctx.pages()) {
        if (!existingPages.has(candidate)) await candidate.close().catch(() => {});
      }
    }
  }

  async validateChapterForm(cfg) {
    const book = parseNovel(cfg.novelFile, { stripMetaLines: cfg.stripMetaLines });
    const schedule = computeSchedule(book, cfg);
    const sourceChapters = book.volumes.flatMap((volume) => volume.chapters);
    const item = schedule[0];
    if (!item) throw new Error('没有可验证的待上传章节。');
    const source = sourceChapters[item.chapterIndex];
    if (!source) throw new Error('找不到第一个待上传章节的正文。');
    const chapter = splitChapterTitle(item.title);

    const ctx = await this.getBrowserContext(cfg, { headless: false });
    const page = await ctx.newPage();
    try {
      await page.goto(cfg.uploadUrl, { waitUntil: 'domcontentloaded' });
      await page.locator('input[placeholder="请输入标题"]').first().waitFor({ state: 'visible', timeout: 20000 });
      await page.locator('.ProseMirror:visible').first().waitFor({ state: 'visible', timeout: 20000 });
      await page.waitForTimeout(2500);
      const numberInput = page.locator('input.serial-input').first();
      const titleInput = page.locator('input[placeholder="请输入标题"]').first();
      const editor = page.locator('.ProseMirror:visible').first();
      await numberInput.click();
      await numberInput.press('Control+A');
      await page.keyboard.type(chapter.number, { delay: 30 });
      await numberInput.press('Tab');
      await titleInput.click();
      await titleInput.press('Control+A');
      await page.keyboard.type(chapter.title, { delay: 30 });
      await titleInput.press('Tab');
      await editor.click();
      await editor.press('Control+A');
      await editor.press('Backspace');
      await page.keyboard.insertText(normalizeEditorContent(source.content));
      await editor.press('Tab');
      await page.waitForTimeout(1500);
      const nextButton = page.locator('button.publish-button').first();
      return {
        number: await numberInput.inputValue(),
        title: await titleInput.inputValue(),
        contentLength: (await editor.innerText()).trim().length,
        nextDisabled: await nextButton.isDisabled(),
        validationMessages: await page.locator('.arco-alert:visible, [class*="error"]:visible').allInnerTexts(),
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async inspectCurrentPage() {
    const ctx = this.browserContext;
    if (!this._contextIsOpen(ctx)) throw new Error('当前没有已连接的内置浏览器。');
    const page = ctx.pages().at(-1);
    if (!page) throw new Error('当前没有可检查的页面。');
    return page.evaluate(() => {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      return {
        url: location.href,
        dialogs: [...document.querySelectorAll('[role="dialog"], .arco-modal')].filter(visible).map((dialog) => ({
          text: (dialog.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 1200),
          inputs: [...dialog.querySelectorAll('input')].filter(visible).map((el, index) => ({
            index, type: el.type, value: el.value, placeholder: el.placeholder || '',
            readOnly: el.readOnly, className: String(el.className || ''),
            parentText: (el.parentElement?.parentElement?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300),
            html: el.outerHTML.slice(0, 1000),
          })),
          buttons: [...dialog.querySelectorAll('button')].filter(visible).map((el, index) => ({
            index, text: (el.textContent || '').trim(), className: String(el.className || ''),
          })),
        })),
      };
    });
  }

  async start(cfg) {
    if (this.running) { this.log('已在运行中，忽略重复开始。'); return; }
    this.running = true;
    this.stopRequested = false;
    this.emitStatus();
    try {
      await this.run(cfg);
    } catch (e) {
      this.log('❌ 运行出错：' + (e && e.message));
    }
    this.running = false;
    this.emitStatus();
  }

  async run(cfg) {
    const sel = {
      titleInput: 'input[placeholder="请输入标题"]',
      contentEditor: '.ProseMirror',
      ...(cfg.selectors || {}),
    };
    if (!cfg.uploadUrl) { this.log('⚠️ 请先在「设置」里填写上传页网址 uploadUrl。'); return; }

    const book = parseNovel(cfg.novelFile, { stripMetaLines: cfg.stripMetaLines });
    const schedule = computeSchedule(book, cfg);
    if (!schedule.length) {
      this.log(`⚠️ 从第 ${cfg.startChapter || 1} 章开始没有找到可上传章节，请检查起始章节。`);
      return;
    }
    const sourceChapters = book.volumes.flatMap((volume) => volume.chapters);
    for (const item of schedule) {
      const source = sourceChapters[item.chapterIndex];
      if (!source) throw new Error(`找不到排期章节对应的正文：${item.title}`);
        item.content = source.content;
    }

    const state = loadState();
    const loggedChapterNumbers = (state.log || [])
      .map((entry) => Number(splitChapterTitle(entry.title).number))
      .filter(Number.isFinite);
    const completedChapters = new Set((state.completedChapters || loggedChapterNumbers).map(Number));
    const skippedChapters = new Set((state.skippedChapters || []).map(Number));
    const chapterNumberOf = (item) => Number(splitChapterTitle(item.title).number);
    const isCompleted = (item) => completedChapters.has(chapterNumberOf(item));
    const isSkipped = (item) => skippedChapters.has(Number(splitChapterTitle(item.title).number));
    const skippedCount = schedule.filter(isSkipped).length;
    let completedCount = schedule.filter((item) => isCompleted(item) && !isSkipped(item)).length;
    const todo = schedule.map((s, i) => ({ i, s })).filter(({ s }) => !isCompleted(s) && !isSkipped(s));

    this.progress = { total: schedule.length - skippedCount, done: completedCount, currentTitle: '' };
    this.emitStatus();
    this.log(`📖 共 ${schedule.length} 章，跳过 ${skippedCount} 章，已完成 ${completedCount} 章，待上传 ${todo.length} 章。`);

    const ctx = await this.getBrowserContext(cfg, { headless: !!cfg.headless });
    let page = null;
    let uploadedThisRun = 0;

    try {
      for (const { i, s } of todo) {
        if (this.stopRequested) { this.log('⏹ 已停止。进度已保存，之后可断点续传。'); break; }
        // 绝不直接复用 uploadUrl 中的旧草稿；每次都从章节管理页点击“新建章节”。
        page = await this.openFreshChapterPage(ctx, cfg);
        this.progress.currentTitle = s.title;
        this.progress.done = completedCount;
        this.emitStatus();
        this.log(`\n[${i + 1}/${schedule.length}] ${s.title}  → 定时 ${s.date} ${s.time}`);

        await page.locator(sel.titleInput).first().waitFor({ state: 'visible', timeout: 20000 });
        await page.locator('.ProseMirror:visible').first().waitFor({ state: 'visible', timeout: 20000 });
        await page.waitForTimeout(2500);

        const chapter = splitChapterTitle(s.title);
        const numberInput = page.locator('input.serial-input').first();
        const titleInput = page.locator(sel.titleInput).first();
        if (chapter.number) {
          await numberInput.click();
          await numberInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await page.keyboard.type(chapter.number, { delay: 30 });
          await numberInput.press('Tab');
        }
        await titleInput.click();
        await titleInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await page.keyboard.type(chapter.title, { delay: 30 });
        await titleInput.press('Tab');

        // 番茄页面还包含人物设定、故事大纲等多个 ProseMirror，第一 个是章节正文编辑器。
        const editor = page.locator(`${sel.contentEditor}:visible`).first();
        const editorContent = normalizeEditorContent(s.content);
        const editable = await editor.evaluate((el) => (el.isContentEditable ? 1 : 0)).catch(() => 0);
        if (editable) {
          await editor.click();
          await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await editor.press('Backspace');
          await page.keyboard.insertText(editorContent);
          await editor.press('Tab');
        } else {
          await editor.fill(editorContent);
        }

        // 番茄采用受控输入框；点击下一步前必须确认页面状态确实收到数据。
        const actualNumber = (await numberInput.inputValue()).trim();
        const actualTitle = (await titleInput.inputValue()).trim();
        const actualContent = (await editor.innerText()).trim();
        if (chapter.number && actualNumber !== chapter.number) {
          throw new Error(`章节序号填写失败：期望 ${chapter.number}，页面实际为“${actualNumber}”`);
        }
        if (actualTitle !== chapter.title) {
          throw new Error(`章节标题填写失败：期望“${chapter.title}”，页面实际为“${actualTitle}”`);
        }
        if (actualContent.length < 1000) {
          throw new Error(`正文填写失败：原文 ${s.content.length} 字，页面实际只有 ${actualContent.length} 字`);
        }

        const nextButton = page.locator('button.publish-button').first();
        await nextButton.waitFor({ state: 'visible', timeout: 10000 });
        const disabled = await nextButton.isDisabled();
        if (disabled) throw new Error('标题和正文已填入，但“下一步”按钮仍不可用，请检查页面上的红色校验提示。');

        await nextButton.click();
        const publishPage = page.isClosed() ? ctx.pages().at(-1) : page;
        if (!publishPage) throw new Error('点击下一步后未找到发布设置页面。');
        await publishPage.waitForTimeout(800);
        const submissionEvidence = await this.configurePublishDialog(publishPage, s);
        await publishPage.waitForTimeout(1200);
        await this.verifyChapterInManager(publishPage, s, submissionEvidence);

        completedChapters.add(Number(chapter.number));
        completedCount++;
        state.completedChapters = [...completedChapters].sort((a, b) => a - b);
        // 旧版 done 保存的是排期数组下标，修改起始章节后会错套进度；保留空数组仅兼容旧界面。
        state.done = [];
        (state.log = state.log || []).push({ at: new Date().toISOString(), title: s.title, date: s.date, time: s.time });
        saveState(state);
        this.progress.done = completedCount;
        this.emitStatus();
        this.log(`  ✔ 已设置定时发布：${s.date} ${s.time}`);
        uploadedThisRun++;

        await page.waitForTimeout((cfg.uploadDelaySeconds || 4) * 1000);
        await page.close().catch(() => {});
        page = null;
        if (uploadedThisRun >= 1) {
          this.log('  ⏸ 安全模式：本次只处理一章。确认后台正常后，再点“开始上传”处理下一章。');
          break;
        }
      }
      this.log('\n🏁 本轮上传完成！请到番茄作家后台「定时发布/草稿箱」核对。');
    } catch (e) {
      saveState(state);
      this.log('❌ 出错：' + e.message);
      this.log(`  进度已保存（已完成 ${completedCount} 章）。修复问题后重新点「开始上传」即可断点续传。`);
    } finally {
      if (page) await page.close().catch(() => {});
      this.progress.currentTitle = '';
      this.emitStatus();
    }
  }
}
