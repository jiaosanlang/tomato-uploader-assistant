import fs from 'node:fs';

const files = {
  html: fs.readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8'),
  js: fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8'),
  server: fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8'),
};

const forbidden = [
  ['webkitdirectory', /webkitdirectory/i],
  ['directory file input', /<input[^>]+\bdirectory\b/i],
  ['showDirectoryPicker', /showDirectoryPicker\s*\(/],
  ['FileSystemDirectoryHandle', /FileSystemDirectoryHandle/],
];

const failures = [];
for (const [name, pattern] of forbidden) {
  if (pattern.test(files.html) || pattern.test(files.js)) failures.push(`侧边栏禁止使用 ${name}`);
}

for (const required of [
  '/api/extension/scan-directory',
  'maxFiles: 2000',
  'maxFileBytes: 10 * 1024 * 1024',
  'maxTotalBytes: 30 * 1024 * 1024',
]) {
  if (!files.server.includes(required)) failures.push(`本地扫描助手缺少安全约束：${required}`);
}

if (failures.length) {
  console.error(failures.map((item) => `FAIL: ${item}`).join('\n'));
  process.exit(1);
}

console.log('PASS: 扩展未直接读取目录，扫描由带容量限制的本地助手执行。');
