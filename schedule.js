// 按每日字数上限，为每一章计算定时发布日期时间
export function computeSchedule(book, cfg) {
  const dailyLimit = cfg.dailyWordLimit;
  const maxPerDay = Math.max(1, Number(cfg.dailyChapterLimit || 3));
  const startChapter = Math.max(1, Number(cfg.startChapter || 1));
  const [startH, startM] = String(cfg.dailyPublishTime).split(':').map(Number);
  const intervalMin = cfg.chapterIntervalMinutes || 0;

  const start = parseLocalDate(cfg.startDate);
  let day = new Date(start);
  let dayWords = 0;
  let slots = 0;

  const schedule = [];
  let sourceIndex = 0;
  for (const vol of book.volumes) {
    for (const ch of vol.chapters) {
      const chapterIndex = sourceIndex++;
      const digits = ch.title.match(/第\s*([0-9０-９]+)/)?.[1] || '';
      const chapterNumber = Number(digits.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)));
      if (Number.isFinite(chapterNumber) && chapterNumber < startChapter) continue;
      if (slots >= maxPerDay) {
        day = addDays(day, 1);
        dayWords = 0;
        slots = 0;
      }
      // 当天放不下 → 顺延到下一天
      if (dayWords + ch.chars > dailyLimit && dayWords > 0) {
        day = addDays(day, 1);
        dayWords = 0;
        slots = 0;
      }

      let t = dayAtTime(day, startH, startM + slots * intervalMin);
      // 时间排到午夜之后 → 整体推到下一天
      if (t.getDate() !== day.getDate()) {
        day = addDays(day, 1);
        dayWords = 0;
        slots = 0;
        t = dayAtTime(day, startH, startM);
      }

      schedule.push({
        chapterIndex,
        volume: vol.name,
        title: ch.title,
        sourceFile: ch.sourceFile,
        chars: ch.chars,
        date: fmtDate(t),
        time: fmtTime(t),
        dayOffset: Math.round((t - start) / 86400000),
      });

      dayWords += ch.chars;
      slots++;
    }
  }
  return schedule;
}

function parseLocalDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function dayAtTime(date, h, m) {
  const t = new Date(date);
  t.setHours(h, m, 0, 0);
  return t;
}
export function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function fmtTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 打印按天汇总，便于人工核对
export function printScheduleSummary(schedule, dailyLimit) {
  const byDay = new Map();
  for (const s of schedule) {
    if (!byDay.has(s.date)) byDay.set(s.date, { count: 0, words: 0 });
    const d = byDay.get(s.date);
    d.count++;
    d.words += s.chars;
  }
  console.log(`共 ${schedule.length} 章，按每日 ${dailyLimit} 字上限，需要 ${byDay.size} 天发布完：`);
  for (const [date, d] of byDay) {
    console.log(`  ${date}  (第${schedule.find((x) => x.date === date).dayOffset + 1}天): ${d.count} 章 / ${d.words} 字`);
  }
}
