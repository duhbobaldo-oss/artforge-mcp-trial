// Arabic (RTL) pages for the gateway. Everything that comes from a client (name, domain, host) is escaped.
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root{color-scheme:light dark;--bg:#0f1a2c;--card:#16243b;--text:#f4efe3;--muted:#b9c2d3;--accent:#f1b652;--danger:#ff8a80;--line:#2a3a57}
@media (prefers-color-scheme: light){:root{--bg:#f6f3ec;--card:#ffffff;--text:#1b2433;--muted:#556074;--accent:#a66a00;--danger:#b3261e;--line:#e2ddd2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.7 system-ui,"Segoe UI",Tahoma,sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px}h1{font-size:1.45rem;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:16px 0}
.muted{color:var(--muted)}.warn{color:var(--danger);font-weight:600}.err{border-color:var(--danger);color:var(--danger)}
label{display:block;font-weight:600;margin:12px 0 6px}input[type=text]{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;direction:ltr;text-align:left;letter-spacing:.05em}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}button{flex:1 1 160px;padding:12px 16px;border-radius:10px;border:1px solid var(--line);font:inherit;font-weight:700;cursor:pointer;background:transparent;color:inherit}
button.primary{background:var(--accent);border-color:var(--accent);color:#1b1404}ul{padding-inline-start:20px;margin:8px 0}code{direction:ltr;unicode-bidi:embed;background:rgba(127,127,127,.15);padding:2px 6px;border-radius:6px;word-break:break-all}a{color:var(--accent)}`;

function shell(title, body) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function consentPage(details, handle, { error, siteUrl } = {}) {
  const origin = details.clientDomain
    ? `التطبيق منشور من النطاق <strong dir="ltr">${escape(details.clientDomain)}</strong>.`
    : 'هذا التطبيق سجّل نفسه تلقائيًا، واسمه غير موثّق.';
  return shell('ربط ArtForge AI', `
<h1>ربط ArtForge AI بـ ${escape(details.clientName)}</h1>
<p class="muted">خدمة مجانية للجميع وقيد التطوير من OBR Group لإنشاء التصاميم العربية داخل المحادثة.</p>
${error ? `<div class="card err" role="alert">${escape(error)}</div>` : ''}
<div class="card">
  <p>${origin}</p>
  <p>سيُرسَل إذن الوصول إلى <strong dir="ltr">${escape(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? '<p class="warn">سيُرسَل الإذن إلى تطبيق على جهازك. تابع فقط إذا بدأت الربط بنفسك الآن (مثل Claude Code).</p>' : ''}
  <p>الصلاحية المطلوبة: إنشاء التصاميم وتعديلها وتصديرها كصور بالإمكانات المتاحة حاليًا.</p>
  <ul class="muted"><li>أبعاد التصميم حتى 1600 بكسل لكل ضلع.</li><li>التصدير بصيغ PNG وJPEG وWebP.</li><li>قد تُحذف ملفات التصميم عند سكون الخادم المجاني؛ احفظ الصور من المحادثة.</li></ul>
</div>
<form method="post" class="card">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p class="muted">الربط مجاني ومتاح للجميع.</p>
  <div class="row"><button class="primary" name="decision" value="approve">متابعة الربط</button><button name="decision" value="deny" formnovalidate>إلغاء</button></div>
</form>`);
}

export function messagePage(title, text) {
  return shell(title, `<h1>${escape(title)}</h1><div class="card"><p>${escape(text)}</p></div>`);
}

export function landingPage({ mcpUrl, siteUrl }) {
  return shell('ArtForge AI MCP', `
<h1>ArtForge AI MCP</h1>
<p class="muted">خادم MCP مجاني وقيد التطوير من OBR Group للتصاميم العربية.</p>
<div class="card"><p>رابط الخادم:</p><p><code>${escape(mcpUrl)}</code></p>
<ul><li>ChatGPT: الإعدادات ← التطبيقات والموصلات ← إضافة خادم MCP مخصّص، ثم اختر OAuth.</li>
<li>Claude: الإعدادات ← الموصلات ← إضافة موصل مخصّص، ثم الصق الرابط.</li>
<li>Claude Code: <code>claude mcp add --transport http artforge ${escape(mcpUrl)}</code> ثم <code>/mcp</code>.</li></ul>
<p class="muted">اربط الخادم وابدأ الاستخدام مجانًا.</p></div>
${siteUrl ? `<p><a href="${escape(siteUrl)}" rel="noopener">موقع OBR Group</a></p>` : ''}`);
}
