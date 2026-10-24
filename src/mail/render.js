const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');

// Bộ nhớ đệm ngắn hạn cho thư đã phân tích (xem thư rồi tải tệp đính kèm không phải tải lại từ máy chủ).
const cache = new Map();
const TTL = 3 * 60e3;
async function parse(key, raw) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.m;
  const m = await simpleParser(raw, { skipImageLinks: true, keepCidLinks: true });
  cache.set(key, { m, t: Date.now() });
  if (cache.size > 200) for (const [k, v] of cache) if (Date.now() - v.t > TTL || cache.size > 150) cache.delete(k);
  return m;
}

const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'dfn', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li',
  'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var', 'wbr', 'figure', 'figcaption', 'section', 'article', 'header', 'footer', 'main', 'nav', 'style',
];
const COMMON_ATTR = ['style', 'class', 'id', 'title', 'dir', 'lang', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'border'];

// Lọc CSS: bỏ expression(), javascript:, @import, position:fixed và (khi chặn ảnh) mọi url() từ xa.
function cleanCss(css, blockRemote) {
  let s = String(css)
    .replace(/expression\s*\(/gi, '(')
    .replace(/javascript\s*:/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/behavior\s*:/gi, 'x:')
    .replace(/position\s*:\s*(fixed|sticky)/gi, 'position:static');
  if (blockRemote) s = s.replace(/url\s*\(\s*['"]?\s*(https?:)?\/\/[^)]*\)/gi, 'none');
  return s;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function textToHtml(text) {
  const esc = escapeHtml(text || '');
  const linked = esc.replace(/\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g, '<a href="$1">$1</a>');
  return `<div style="white-space:pre-wrap;font-family:inherit">${linked}</div>`;
}

// partUrl(i) dựng đường dẫn tải tệp thứ i (dùng cho ảnh cid:).
function safeHtml(html, { blockRemote, partUrl, cidMap }) {
  let blocked = 0;
  const out = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowVulnerableTags: true, // cho phép <style> (đã lọc nội dung) – trang thư nằm trong iframe sandbox không có script
    allowedAttributes: {
      '*': COMMON_ATTR,
      a: ['href', 'name', 'target', 'rel', ...COMMON_ATTR],
      img: ['src', 'alt', 'width', 'height', ...COMMON_ATTR],
      td: ['colspan', 'rowspan', 'nowrap', 'background', ...COMMON_ATTR],
      th: ['colspan', 'rowspan', 'nowrap', ...COMMON_ATTR],
      table: ['cellpadding', 'cellspacing', 'summary', 'background', ...COMMON_ATTR],
      font: ['face', 'size', 'color', ...COMMON_ATTR],
      col: ['span', ...COMMON_ATTR], colgroup: ['span', ...COMMON_ATTR],
      ol: ['start', 'type', ...COMMON_ATTR], li: ['value', ...COMMON_ATTR],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid', 'data'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'], a: ['http', 'https', 'mailto', 'tel'] },
    allowProtocolRelative: false,
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'head', 'iframe', 'object', 'embed', 'form'],
    transformTags: {
      a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
      img: (tag, attribs) => {
        const a = { ...attribs };
        const src = (a.src || '').trim();
        if (/^cid:/i.test(src)) {
          const i = cidMap.get(src.slice(4).replace(/^<|>$/g, '').toLowerCase());
          a.src = i === undefined ? '' : partUrl(i);
        } else if (/^https?:/i.test(src) && blockRemote) {
          blocked++;
          a['data-blocked-src'] = src;
          a.src = '';
          a.alt = a.alt || '';
        } else if (/^data:/i.test(src) && !/^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(src)) a.src = '';
        return { tagName: 'img', attribs: a };
      },
      td: (tag, attribs) => {
        const a = { ...attribs };
        if (a.background && (blockRemote || !/^https?:/i.test(a.background))) delete a.background;
        return { tagName: 'td', attribs: a };
      },
      table: (tag, attribs) => {
        const a = { ...attribs };
        if (a.background && (blockRemote || !/^https?:/i.test(a.background))) delete a.background;
        return { tagName: 'table', attribs: a };
      },
    },
    exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src && !frame.attribs['data-blocked-src'],
    textFilter: (text, tag) => (tag === 'style' ? cleanCss(text, blockRemote) : text),
  });
  // Lọc thuộc tính style sau cùng.
  const final = out.replace(/style="([^"]*)"/gi, (m, css) => `style="${cleanCss(css, blockRemote)}"`);
  const hasRemote = blocked > 0 || (blockRemote && /url\s*\(\s*['"]?\s*https?:/i.test(html));
  return { html: final, blocked: hasRemote ? Math.max(blocked, 1) : 0 };
}

const addrs = v => (v?.value || []).map(a => ({ name: a.name || '', address: a.address || '' }));

function toView(m, { blockRemote, partUrl }) {
  const atts = (m.attachments || []).map((a, i) => ({
    i, filename: a.filename || `attachment-${i + 1}${extFor(a.contentType)}`,
    contentType: a.contentType, size: a.size, cid: a.cid || null,
    inline: !!a.related || a.contentDisposition === 'inline',
  }));
  const cidMap = new Map();
  atts.forEach(a => { if (a.cid) cidMap.set(a.cid.replace(/^<|>$/g, '').toLowerCase(), a.i); });
  let body;
  let blocked = 0;
  if (m.html) {
    const r = safeHtml(m.html, { blockRemote, partUrl, cidMap });
    body = r.html; blocked = r.blocked;
  } else body = textToHtml(m.text || '');
  // Ảnh nhúng đã hiển thị trong thân thư thì không liệt kê lại thành tệp đính kèm.
  const shownCids = new Set();
  if (m.html) for (const [cid, i] of cidMap) if (m.html.toLowerCase().includes('cid:' + cid)) shownCids.add(i);
  const header = k => { const v = m.headers.get(k); return typeof v === 'string' ? v : v?.text || null; };
  return {
    subject: m.subject || '',
    from: addrs(m.from), to: addrs(m.to), cc: addrs(m.cc), bcc: addrs(m.bcc), replyTo: addrs(m.replyTo),
    date: m.date && !isNaN(m.date) ? m.date.toISOString() : null,
    messageId: m.messageId || null,
    inReplyTo: m.inReplyTo || null,
    references: Array.isArray(m.references) ? m.references : m.references ? [m.references] : [],
    priority: m.priority || 'normal',
    receiptTo: header('disposition-notification-to'),
    listUnsubscribe: header('list-unsubscribe'),
    html: body,
    text: m.text || '',
    isHtml: !!m.html,
    blocked,
    attachments: atts.filter(a => !shownCids.has(a.i)),
  };
}

function extFor(type = '') {
  return { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'application/pdf': '.pdf', 'text/plain': '.txt', 'message/rfc822': '.eml', 'text/calendar': '.ics' }[type] || '';
}

// HTML để trích dẫn khi trả lời/chuyển tiếp/sửa nháp. Ảnh nhúng (cid:) được chuyển thành data: URI
// để trình soạn thảo hiển thị; khi gửi, máy chủ lại đổi chúng thành tệp nhúng cid.
function quoteHtml(m) {
  if (!m.html) return textToHtml(m.text || '');
  const atts = m.attachments || [];
  const cidMap = new Map();
  atts.forEach((a, i) => { if (a.cid && a.size < 5 * 1024 * 1024 && /^image\//i.test(a.contentType)) cidMap.set(a.cid.replace(/^<|>$/g, '').toLowerCase(), i); });
  const partUrl = i => `data:${atts[i].contentType};base64,${atts[i].content.toString('base64')}`;
  return safeHtml(m.html, { blockRemote: false, partUrl, cidMap }).html;
}

module.exports = { parse, toView, quoteHtml, escapeHtml, textToHtml };
