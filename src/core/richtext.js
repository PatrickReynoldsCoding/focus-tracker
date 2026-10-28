/**
 * Rich text for notes on cards. The browser editor produces HTML; only a small set of tags and styles is kept,
 * so a stored note can never run script or load anything when it is shown. Every note also has a plain-text copy,
 * so the sheet stays readable by hand and by Claude.
 */

var RICH_TAGS_ = { b: 1, strong: 1, i: 1, em: 1, u: 1, s: 1, strike: 1, ul: 1, ol: 1, li: 1, p: 1, div: 1, br: 1, span: 1, font: 1, h1: 1, h2: 1, h3: 1, h4: 1, blockquote: 1, a: 1 };
var RICH_VOID_TAGS_ = { br: 1 };
// Tags whose content is dropped too, not only the tag.
var RICH_DROP_TAGS_ = { script: 1, style: 1, iframe: 1, object: 1, embed: 1, template: 1, svg: 1, math: 1, noscript: 1, textarea: 1, select: 1 };
var RICH_STYLE_PROPS_ = { color: 1, 'background-color': 1, 'font-size': 1, 'font-weight': 1, 'font-style': 1, 'text-decoration': 1, 'text-decoration-line': 1 };
var RICH_COLOR_ = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)|[a-z]{3,20})$/i;
var RICH_MAX_LENGTH_ = 40000;

/** Clean editor HTML down to the allowed tags and styles. */
function sanitizeRichText_(html) {
  var source = typeof html === 'string' ? html : '';
  assert_(source.length <= RICH_MAX_LENGTH_, 'That note is too long to save. Make it shorter or move some of it to the project notes.');
  var tagPattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  var out = [], dropDepth = 0, linkDepth = 0, last = 0, match;
  function text(segment) { return linkDepth ? escapeRichText_(segment) : linkRichText_(escapeRichText_(segment)); }
  while ((match = tagPattern.exec(source))) {
    if (!dropDepth) out.push(text(source.slice(last, match.index)));
    last = tagPattern.lastIndex;
    if (match[0].indexOf('<!--') === 0) continue;
    var closing = match[1] === '/', tag = match[2].toLowerCase();
    if (RICH_DROP_TAGS_[tag]) { dropDepth = Math.max(0, dropDepth + (closing ? -1 : 1)); continue; }
    if (dropDepth || !RICH_TAGS_[tag]) continue;
    if (tag === 'a') linkDepth = Math.max(0, linkDepth + (closing ? -1 : 1));
    if (closing) { if (!RICH_VOID_TAGS_[tag]) out.push('</' + tag + '>'); continue; }
    out.push('<' + tag + richAttributes_(tag, match[3]) + '>');
  }
  if (!dropDepth) out.push(text(source.slice(last)));
  return out.join('').trim();
}

/** Web addresses typed into a note become links. The text is already escaped, so an address cannot hold < > or quotes. */
function linkRichText_(escaped) {
  return escaped.replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, function (url) {
    return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
  });
}

/** Text between tags is already entity-encoded by the browser. Any raw angle bracket left is escaped so it stays text. */
function escapeRichText_(text) {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function richAttributes_(tag, raw) {
  var attrs = {}, pattern = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g, m;
  while ((m = pattern.exec(raw || ''))) {
    attrs[m[1].toLowerCase()] = decodeRichEntities_(m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5]);
  }
  var kept = [];
  if (tag === 'font') {
    if (attrs.color && RICH_COLOR_.test(attrs.color)) kept.push('color="' + attrs.color + '"');
    if (/^[1-7]$/.test(attrs.size || '')) kept.push('size="' + attrs.size + '"');
  }
  if (tag === 'a' && /^https?:\/\/[^\s"<>]+$/i.test(attrs.href || '')) {
    kept.push('href="' + attrs.href.replace(/&/g, '&amp;') + '"', 'target="_blank"', 'rel="noopener noreferrer"');
  }
  var style = cleanRichStyle_(attrs.style);
  if (style) kept.push('style="' + style + '"');
  return kept.length ? ' ' + kept.join(' ') : '';
}

function cleanRichStyle_(style) {
  if (!style) return '';
  return style.split(';').map(function (declaration) {
    var parts = declaration.split(':');
    if (parts.length !== 2) return '';
    var prop = parts[0].trim().toLowerCase(), value = parts[1].trim();
    if (!RICH_STYLE_PROPS_[prop] || !/^[#a-z0-9(),.%\s-]+$/i.test(value) || /url|expression/i.test(value)) return '';
    if ((prop === 'color' || prop === 'background-color') && !RICH_COLOR_.test(value)) return '';
    return prop + ': ' + value;
  }).filter(Boolean).join('; ');
}

function decodeRichEntities_(text) {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** Plain-text copy of cleaned HTML: lines kept, list items start with "- ", links keep their address. */
function richTextToPlain_(html) {
  var text = String(html || '')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, function (all, href, label) {
      var plainLabel = label.replace(/<[^>]+>/g, '');
      return decodeRichEntities_(plainLabel).trim() === decodeRichEntities_(href).trim() ? plainLabel : plainLabel + ' (' + href + ')';
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h3|h4|blockquote|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeRichEntities_(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** HTML for a note written as plain text (for example an import): escaped, with links and line breaks kept. */
function plainToRichText_(text) {
  var escaped = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return escaped
    .replace(/https?:\/\/[^\s<>()\]]+/g, function (url) { return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>'; })
    .replace(/\n/g, '<br>');
}
