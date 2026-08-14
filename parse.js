import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 合并整本 TXT 中的卷标题和章节标题。
const VOLUME_RE = /^=+\s*卷\s*([^=\s][^=]*?)\s*=+$/;
const CHAPTER_RE = /^第[一二三四五六七八九十百千万零〇两0-9０-９]+[章节回]/;
const SEP_RE = /^={5,}\s*$/;
const TXT_RE = /\.txt$/i;

const naturalCompare = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
}).compare;

function countChars(text) {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const nonSpace = text.replace(/\s/g, '').length;
  return { cjk, nonSpace };
}

function readText(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return data.subarray(2).toString('utf16le');
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    const swapped = Buffer.from(data.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }

  const utf8 = data.toString('utf8').replace(/^\uFEFF/, '');
  // 兼容常见的 ANSI/GBK/GB18030 中文 TXT。
  if (utf8.includes('\uFFFD')) {
    try { return new TextDecoder('gb18030').decode(data).replace(/^\uFEFF/, ''); } catch {}
  }
  return utf8;
}

function cleanContent(text, opts) {
  let content = text.replace(/\r\n?/g, '\n').trim();
  if (opts.stripMetaLines) {
    content = content
      .split('\n')
      .filter((line) => !/卷[一二三四五六七八九十百千0-9]+.*(待续|待更|未完待续)/.test(line.trim()))
      .join('\n')
      .trim();
  }
  return content;
}

function makeChapter(title, content, sourceFile) {
  const chars = countChars(content);
  return {
    title,
    content,
    chars: chars.cjk,
    totalChars: chars.nonSpace,
    sourceFile,
  };
}

function parseCombinedFile(filePath, opts) {
  const text = readText(filePath);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const volumes = [];
  let bookName = '';
  let currentVolume = null;
  let currentChapter = null;

  const pushChapter = () => {
    if (!currentVolume || !currentChapter) return;
    const content = cleanContent(currentChapter.lines.join('\n'), opts);
    currentVolume.chapters.push(makeChapter(
      currentChapter.title,
      content,
      path.basename(filePath),
    ));
    currentChapter = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (currentChapter) currentChapter.lines.push('');
      continue;
    }

    const volumeMatch = line.match(VOLUME_RE);
    if (volumeMatch) {
      pushChapter();
      currentVolume = { name: '卷' + volumeMatch[1].trim(), chapters: [] };
      volumes.push(currentVolume);
      continue;
    }
    if (SEP_RE.test(line)) continue;

    if (CHAPTER_RE.test(line)) {
      pushChapter();
      if (!currentVolume) {
        currentVolume = { name: '未分卷', chapters: [] };
        volumes.push(currentVolume);
      }
      currentChapter = { title: line, lines: [] };
      continue;
    }

    const bookMatch = line.match(/^《(.+?)》$/);
    if (bookMatch && !currentVolume && !currentChapter) {
      bookName = bookMatch[1];
      continue;
    }
    if (currentChapter) currentChapter.lines.push(raw);
  }
  pushChapter();

  if (!volumes.some((volume) => volume.chapters.length)) {
    throw new Error('没有识别到章节标题。若每章是单独的 TXT，请填写正文文件夹路径。');
  }
  return { bookName, volumes, sourceType: 'file', sourcePath: filePath };
}

function titleFromFile(filePath, text) {
  const fileTitle = path.basename(filePath, path.extname(filePath)).trim();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const firstIndex = lines.findIndex((line) => line.trim());
  const firstLine = firstIndex >= 0 ? lines[firstIndex].trim() : '';
  const normalizedFirstLine = firstLine.replace(/^#+\s*/, '').trim();

  // 文件名已经包含章节名时，以文件名为准；若正文首行重复章节标题则移除。
  if (CHAPTER_RE.test(fileTitle)) {
    if (normalizedFirstLine === fileTitle || CHAPTER_RE.test(normalizedFirstLine)) {
      lines.splice(firstIndex, 1);
      return { title: fileTitle, content: lines.join('\n') };
    }
    return { title: fileTitle, content: text };
  }
  // 001.txt 之类的文件，以正文首行的章节名为准，并移除重复标题行。
  if (CHAPTER_RE.test(normalizedFirstLine)) {
    lines.splice(firstIndex, 1);
    return { title: normalizedFirstLine, content: lines.join('\n') };
  }
  return { title: fileTitle, content: text };
}

function listTxtFiles(dirPath) {
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && TXT_RE.test(entry.name) && !entry.name.startsWith('~$'))
    .sort((a, b) => naturalCompare(a.name, b.name))
    .map((entry) => path.join(dirPath, entry.name));
}

function collectTxtRecursive(dirPath) {
  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => naturalCompare(a.name, b.name))) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) files.push(...collectTxtRecursive(fullPath));
    else if (entry.isFile() && TXT_RE.test(entry.name) && !entry.name.startsWith('~$')) files.push(fullPath);
  }
  return files;
}

function chaptersFromFiles(files, rootPath, opts) {
  return files.map((filePath) => {
    const text = readText(filePath);
    const parsed = titleFromFile(filePath, text);
    return makeChapter(
      parsed.title,
      cleanContent(parsed.content, opts),
      path.relative(rootPath, filePath),
    );
  });
}

function parseChapterDirectory(dirPath, opts) {
  const rootFiles = listTxtFiles(dirPath);
  const subdirs = fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => naturalCompare(a.name, b.name));
  const volumes = [];

  if (rootFiles.length) {
    volumes.push({ name: '未分卷', chapters: chaptersFromFiles(rootFiles, dirPath, opts) });
  }
  for (const subdir of subdirs) {
    const fullPath = path.join(dirPath, subdir.name);
    const files = collectTxtRecursive(fullPath);
    if (files.length) {
      volumes.push({ name: subdir.name, chapters: chaptersFromFiles(files, dirPath, opts) });
    }
  }

  if (!volumes.length) throw new Error('所选文件夹及其子文件夹中没有找到 TXT 文件。');
  const folderName = path.basename(dirPath);
  const bookName = folderName === '正文' ? path.basename(path.dirname(dirPath)) : folderName;
  return { bookName, volumes, sourceType: 'directory', sourcePath: dirPath };
}

export function parseNovel(sourcePath, opts = {}) {
  const input = String(sourcePath || '').trim().replace(/^['"]|['"]$/g, '');
  if (!input) throw new Error('请先选择整本 TXT，或选择存放分章 TXT 的正文文件夹。');
  if (!fs.existsSync(input)) throw new Error(`路径不存在：${input}`);

  const stat = fs.statSync(input);
  if (stat.isDirectory()) return parseChapterDirectory(input, opts);
  if (stat.isFile() && TXT_RE.test(input)) return parseCombinedFile(input, opts);
  throw new Error('仅支持 TXT 文件或包含分章 TXT 的文件夹。');
}

export const DEFAULT_CONFIG = Object.freeze({
  novelFile: '',
  uploadUrl: '',
  dailyWordLimit: 10000,
  startDate: '',
  dailyPublishTime: '07:00',
  chapterIntervalMinutes: 10,
  dailyChapterLimit: 3,
  startChapter: 1,
  uploadDelaySeconds: 4,
  stripMetaLines: true,
  headless: false,
  userDataDir: 'profile',
  selectors: {},
});

const NUM_FIELDS = [
  'dailyWordLimit',
  'chapterIntervalMinutes',
  'dailyChapterLimit',
  'startChapter',
  'uploadDelaySeconds',
];

export function normalizeConfig(cfg) {
  for (const key of NUM_FIELDS) if (key in cfg) cfg[key] = Number(cfg[key]);
  return cfg;
}

export function loadConfig() {
  const cfgPath = path.join(__dirname, 'config.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  return normalizeConfig({
    ...DEFAULT_CONFIG,
    ...saved,
    selectors: { ...DEFAULT_CONFIG.selectors, ...(saved.selectors || {}) },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const book = parseNovel(cfg.novelFile, { stripMetaLines: cfg.stripMetaLines });
  console.log(`书名: ${book.bookName || '(未识别)'}`);
  let totalChapters = 0;
  let totalChars = 0;
  for (const volume of book.volumes) {
    const words = volume.chapters.reduce((sum, chapter) => sum + chapter.chars, 0);
    totalChapters += volume.chapters.length;
    totalChars += words;
    console.log(`  ${volume.name}: ${volume.chapters.length} 章 / ${words} 字`);
  }
  console.log(`总计: ${totalChapters} 章 / ${totalChars} 字`);
}
