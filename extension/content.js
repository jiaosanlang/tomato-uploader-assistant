(() => {
  if (window.__tomatoUploaderAssistantLoaded) return;
  window.__tomatoUploaderAssistantLoaded = true;
  const visible = (el) => el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && (el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const describe = (el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', id: el.id || '', name: el.getAttribute('name') || '', placeholder: el.getAttribute('placeholder') || '', aria: el.getAttribute('aria-label') || '', text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80), className: String(el.className || '').slice(0, 180) });
  const inspect = () => ({ url: location.href, title: document.title, inputs: [...document.querySelectorAll('input, textarea, [contenteditable="true"]')].filter(visible).slice(0, 80).map(describe), buttons: [...document.querySelectorAll('button, [role="button"]')].filter(visible).slice(0, 100).map(describe), bodyText: (document.body?.innerText || '').trim().slice(0, 1800) });
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function first(selectors) { for (const selector of selectors) { const el = document.querySelector(selector); if (visible(el)) return el; } return null; }
  function fill(chapter) {
    const serial = first(['input.serial-input', 'input[placeholder*="序号"]', 'input[aria-label*="序号"]']);
    const title = first(['input[placeholder*="标题"]', 'input[placeholder*="章名"]', 'input[aria-label*="标题"]', 'input[type="text"]']);
    const editor = first(['.ProseMirror[contenteditable="true"]', '[contenteditable="true"]', 'textarea']);
    if (!title || !editor) return { ok: false, error: '当前页面没有识别到标题输入框或正文编辑器。', inspection: inspect() };
    if (serial && chapter.number) setValue(serial, chapter.number);
    const cleanTitle = String(chapter.title || '').replace(/^第\s*([0-9０-９一二三四五六七八九十百千万零〇两]+)\s*[章节回]\s*/, '').trim();
    setValue(title, cleanTitle);
    if (editor.isContentEditable) {
      editor.focus();
      const selection = window.getSelection(); const range = document.createRange();
      range.selectNodeContents(editor); selection?.removeAllRanges(); selection?.addRange(range);
      document.execCommand('insertText', false, chapter.content || '');
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    } else setValue(editor, chapter.content || '');
    return { ok: true, title: title.value || cleanTitle, contentLength: (editor.innerText || editor.value || '').trim().length, message: '已填写当前章节，请在页面中检查内容后手动点击下一步。' };
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'inspect-page') sendResponse(inspect());
    if (message?.type === 'fill-chapter') sendResponse(fill(message.chapter || {}));
    return true;
  });
})();
