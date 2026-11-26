/**
 * Logic.gs —— 純計算：日期、每組數量 × 組數、每週加總、匯出內容的版面。
 * 這個檔案不碰試算表，所以可以單獨測試。
 */

var L_WD = ['日', '一', '二', '三', '四', '五', '六'];

function L_pad(n) { return (n < 10 ? '0' : '') + n; }
function L_round(n) { return Math.round(n * 1000) / 1000; }
function L_r2(n) { return Math.round(n * 100) / 100; }
function L_num(n) { return L_round(n).toLocaleString('en-US', { maximumFractionDigits: 3 }); }

/* ---------- 日期（一律用 'YYYY-MM-DD' 字串，避免時區問題） ---------- */
function L_parseDate(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3];
  var t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y: y, m: mo, d: d, t: t };
}
function L_fmtDate(t) { return t.getUTCFullYear() + '-' + L_pad(t.getUTCMonth() + 1) + '-' + L_pad(t.getUTCDate()); }
function L_addDays(s, n) { return L_fmtDate(new Date(L_parseDate(s).t.getTime() + n * 86400000)); }
function L_weekStart(s) { return L_addDays(s, -((L_parseDate(s).t.getUTCDay() + 6) % 7)); }   // 週一
function L_weekday(s) { return L_WD[L_parseDate(s).t.getUTCDay()]; }
function L_md(s) { var p = L_parseDate(s); return p.m + '/' + p.d; }

/* ---------- 班級、課程 ---------- */
var L_DEFAULT_CLASSES = { '日間部': ['加一甲', '加一乙', '加二甲', '加二乙', '加三甲', '加三乙', '國中技藝班', '技藝競賽選手'], '夜間部': ['烘焙一', '烘焙二', '烘焙三'] };
var L_DEFAULT_COURSES = {
  '日間部': ['烘焙食品加工實習', '食品加工實習', '進階食品加工實習', '國中技藝班', '技藝競賽選手'],
  '夜間部': ['食品加工實習', '麵包製作實習', '西式點心製作實習', '中式點心製作實習', '蛋糕製作實習', '蛋糕裝飾實習']
};
/* 使用者打的字：去掉多的空白，開頭不能是 = + - @（避免被試算表當成公式） */
function L_safeText(s, max) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().replace(/^[=+\-@\s]+/, '').slice(0, max || 60); }
/* 班級屬於哪個部別（日間部或夜間部），不在清單裡就回傳空字串 */
function L_deptOf(cls, classes) {
  var c = classes || L_DEFAULT_CLASSES, out = '';
  ['日間部', '夜間部'].forEach(function (d) { if ((c[d] || []).indexOf(cls) >= 0) out = d; });
  return out;
}

/* ---------- 目錄（產品、材料、器具） ---------- */
function L_buildCatalog(products, items, tools) {
  var cat = { products: {}, items: {}, tools: {}, order: [] };
  products.forEach(function (p) { cat.products[p.pid] = p; cat.order.push(p.pid); cat.items[p.pid] = []; cat.tools[p.pid] = []; });
  items.forEach(function (it) { if (cat.items[it.pid]) cat.items[it.pid].push(it); });
  tools.forEach(function (t) { if (cat.tools[t.pid]) cat.tools[t.pid].push(t); });
  return cat;
}
/* 給某位使用者看的目錄：模板 + 自己的自創 + 大家共用的（+ 排過課用到的） */
function L_catalogForClient(cat, email, refPids, isAdmin) {
  var ref = {}; (refPids || []).forEach(function (p) { ref[p] = 1; });
  var products = cat.order.map(function (id) { return cat.products[id]; }).filter(function (p) {
    if (!p.custom) return isAdmin || ref[p.pid] || !p.hidden;                 // 被隱藏的預設材料單：只有管理者看得到
    return ref[p.pid] || (!p.deleted && (p.owner === email || p.shared));
  });
  var items = {}, tools = {};
  products.forEach(function (p) { items[p.pid] = cat.items[p.pid]; tools[p.pid] = cat.tools[p.pid]; });
  return { products: products, items: items, tools: tools, classes: cat.classes || L_DEFAULT_CLASSES, courses: cat.courses || L_DEFAULT_COURSES, categories: cat.categories || [], gradeNames: cat.gradeNames || { '一': '一年級', '二': '二年級', '三': '三年級' } };
}

/* ---------- 自創材料單 ---------- */
var L_UNITS = ['g', 'ml', '顆', '個', '條', '包', '罐', '瓶', '支', '片', '束', '公分'];
function L_cleanCustom(rec, nameMap) {
  var title = L_safeText(rec.title, 40);
  if (!title) throw new Error('請填材料單的名稱');
  var dsets = Number(rec.dsets); if (!(dsets > 0 && dsets <= 200)) dsets = 4;
  var rows = rec.rows || [];
  if (!rows.length) throw new Error('至少要有一項材料');
  if (rows.length > 80) throw new Error('材料最多 80 項');
  var num = function (v) { return (v === '' || v === null || v === undefined) ? NaN : Number(v); };
  var items = rows.map(function (r, i) {
    var raw = L_safeText(r.raw, 30);
    if (!raw) throw new Error('第 ' + (i + 1) + ' 項材料的名稱沒填');
    // 三種：每組數量（× 組數）、固定總量（不跟組數變）、文字（適量、3~4顆…不加總）
    var mode = r.mode || (r.kind ? 'text' : 'per');
    var it = { id: String(r.id || ''), raw: raw, per: null, total: null, unit: L_UNITS.indexOf(r.unit) >= 0 ? r.unit : 'g', kind: '',
               note: L_safeText(r.note, 40), procure: L_safeText(r.procure, 20) };
    var prevStd = (r.std && r.origRaw === raw) ? L_safeText(r.std, 30) : '';
    it.std = (nameMap && nameMap[raw]) || prevStd || raw;
    it.raw = it.std;                       // 名稱一律統一：打「高粉」存起來就是「高筋麵粉」
    if (mode === 'text') {
      var tx = L_safeText(r.text !== undefined ? r.text : (r.kind === '適量' ? '適量' : String(r.kind || '').replace(/^範圍 /, '')), 20);
      if (!tx && r.kind !== '原表沒填數量') throw new Error('「' + raw + '」要填內容（例如適量）');
      it.kind = !tx ? '原表沒填數量' : (tx === '適量' ? '適量' : '範圍 ' + tx);
    } else if (mode === 'fixed') {
      var t = num(r.total);
      if (!isFinite(t) || t < 0 || t > 1000000) throw new Error('「' + raw + '」的固定總量要填數字');
      it.total = Math.round(t * 10000) / 10000;
    } else {
      var p = num(r.per);
      if (!isFinite(p) || p < 0 || p > 1000000) throw new Error('「' + raw + '」的每組數量要填數字（不確定的話選「文字」填適量）');
      it.per = L_round(p);
    }
    return it;
  });
  var tools = L_cleanTools(rec.tools);
  return { pid: String(rec.pid || ''), title: title, serving: L_safeText(rec.serving, 20), dsets: dsets, items: items, tools: tools };
}
/* 材料列的編號要固定（老師改過的數字靠編號對應），新的列接在最大號後面 */
function L_assignRowIds(pid, items) {
  var prefix = pid + '-', max = 0, seen = {};
  function num(id) { id = String(id || ''); if (id.indexOf(prefix) !== 0) return null; var t = id.slice(prefix.length); return /^\d+$/.test(t) ? +t : null; }
  items.forEach(function (it) { var n = num(it.id); if (n !== null) max = Math.max(max, n); });
  items.forEach(function (it) {
    var n = num(it.id);
    if (n === null || seen[it.id]) { max++; it.id = prefix + (max < 10 ? '0' : '') + max; }
    seen[it.id] = 1;
  });
  return items;
}
/* 自創材料單（存在試算表的一列）→ 跟模板同樣形狀的產品、材料、器具 */
function L_customToCatalog(c) {
  var product = { pid: c.pid, sem: '自創', course: '', cls: '', title: c.title, serving: c.serving || '', note: '', dsets: c.dsets || 4,
                  custom: true, owner: String(c.owner || '').toLowerCase(), ownerName: c.ownerName || '', shared: !!c.shared, deleted: !!c.deleted };
  var items = (c.items || []).map(function (r) {
    return { id: r.id, pid: c.pid, raw: r.raw, std: r.std || r.raw, per: r.kind || r.per === undefined ? null : r.per, unit: r.unit || 'g', sets: null,
             total: r.kind || r.total === undefined ? null : r.total, procure: r.procure || '', kind: r.kind || '', note: r.note || '' };
  });
  var tools = (c.tools || []).map(function (t) { return { pid: c.pid, who: t.who, name: t.name, qty: t.qty }; });
  return { product: product, items: items, tools: tools };
}
/* 管理者改過的預設材料單：蓋在原本的模板上（原本的資料不動，可以隨時還原）。
 * ov = { pid, title, serving, dsets, items, tools, hidden }；items 是空的就只是「隱藏」。 */
function L_applyTemplateOverrides(cat, overrides) {
  (overrides || []).forEach(function (o) {
    var p = cat.products[o.pid];
    if (!p || p.custom) return;
    p.hidden = !!o.hidden;
    if (o.items && o.items.length) {
      p.modified = true;
      if (o.title) p.title = o.title;
      p.serving = o.serving == null ? p.serving : o.serving;
      if (o.dsets) p.dsets = o.dsets;
      var x = L_customToCatalog({ pid: o.pid, title: p.title, serving: p.serving, dsets: p.dsets, items: o.items, tools: o.tools });
      cat.items[o.pid] = x.items; cat.tools[o.pid] = x.tools;
    }
  });
}

/* ---------- 一堂課（entry）的材料明細 ---------- */
/* entry = { id, pid, date:'YYYY-MM-DD', dept, cls, sets, ov:{列ID: 改過的數字} } */
function L_scale(entry) { var k = Number(entry.scale); return k > 0 ? k : 1; }
function L_scaleNote(entry) {
  var k = L_scale(entry);
  if (k === 1) return '';
  var u = entry.yUnit || '';
  return (entry.yFrom > 0 && entry.yTo > 0)
    ? '每組份量 ' + L_num(entry.yFrom) + u + ' → ' + L_num(entry.yTo) + u + '（材料 ×' + L_num(k) + '）'
    : '每組份量 ×' + L_num(k);
}

/* 老師這堂課另外加的材料（entry.extra）。per 存的是「倍率 ×1」的每組數量，所以改倍率時也會跟著變。 */
function L_extraItems(entry) {
  return (entry.extra || []).map(function (r) {
    return { id: r.id, pid: entry.pid, raw: r.raw, std: r.std || r.raw, per: r.kind || r.per === undefined ? null : r.per, unit: r.unit || 'g', sets: null,
             total: r.kind || r.total === undefined ? null : r.total, procure: '', kind: r.kind || '', note: r.note || '', extra: true };
  });
}

/* ov[列ID] 也是「倍率 ×1」的每組數量：老師改了某個材料，之後再改倍率，那個材料照樣跟著倍率變 */
function L_lines(entry, cat) {
  var ov = entry.ov || {}, k = L_scale(entry), omit = {};
  (entry.omit || []).forEach(function (id) { omit[id] = 1; });                 // 老師這堂課不要的材料
  return (cat.items[entry.pid] || []).filter(function (it) { return !omit[it.id]; }).concat(L_extraItems(entry)).map(function (it) {
    var o = { id: it.id, raw: it.raw, std: it.std, unit: it.unit || '', note: it.note || '', procure: it.procure || '', extra: !!it.extra,
              mode: 'text', per: null, sets: null, total: null, text: '', orig: null, changed: false };
    var has = Object.prototype.hasOwnProperty.call(ov, it.id), cv = it.kind ? (entry.conv || {})[it.id] : null;
    if (cv && cv.mode === 'per') {                        // 老師把「適量」這類材料改成有數量的（存的是倍率 ×1，會加總、也跟著倍率變）
      o.mode = 'per'; o.per = L_r2(cv.per * k); o.unit = cv.unit || 'g'; o.sets = entry.sets; o.total = L_round(o.per * entry.sets); o.changed = true; o.conv = true;
    } else if (cv && cv.mode === 'fixed') {
      o.mode = 'fixed'; o.total = cv.total; o.unit = cv.unit || 'g'; o.changed = true; o.conv = true;
    } else if (cv && cv.mode === 'text') {
      o.text = cv.text; o.conv = true;
    } else if (!it.kind && it.per !== null) {
      o.mode = 'per'; o.orig = it.per; o.per = L_r2((has ? ov[it.id] : it.per) * k);
      o.sets = entry.sets; o.total = L_round(o.per * entry.sets); o.changed = has;
    } else if (!it.kind && it.total !== null) {
      o.mode = 'fixed'; o.orig = it.total; o.total = has ? ov[it.id] : it.total; o.changed = has;
    } else {
      o.text = it.kind === '適量' ? '適量' : (/^範圍 /.test(it.kind || '') ? it.kind.replace(/^範圍 /, '') : '原表沒填');
    }
    return o;
  });
}

function L_cleanExtra(list, nameMap) {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > 30) throw new Error('另外加的材料最多 30 項');
  var items = L_cleanCustom({ title: 'x', rows: list }, nameMap).items;
  var seen = {};
  items.forEach(function (it) { if (!/^x-\d+$/.test(it.id) || seen[it.id]) it.id = ''; seen[it.id || '?'] = 1; });
  return L_assignRowIds('x', items);
}

/* ---------- 檢查、整理老師送來的排課 ---------- */
function L_cleanEntry(e, cat, free) {
  var prod = cat.products[e.pid];
  if (!prod) throw new Error('找不到產品：' + e.pid);
  if (!L_parseDate(e.date)) throw new Error('「' + prod.title + '」的上課日期不正確');
  var sets = Number(e.sets);
  if (!(sets > 0 && sets <= 200)) throw new Error('「' + prod.title + '」的組數要在 1 到 200 之間');
  // 班級：一堂課一個班，部別由班級決定
  var cls = L_safeText(e.cls, 10), dept;
  if (free) {                                                         // 額外材料單（臨時活動）：班級可以不填（填了就要是班級清單裡的班），部別自己選
    if (cls) { dept = L_deptOf(cls, cat.classes); if (!dept) throw new Error('「' + prod.title + '」的班級「' + cls + '」不在班級清單裡'); }
    else dept = ['日間部', '夜間部'].indexOf(e.dept) >= 0 ? e.dept : '日間部';
  } else {
    if (!cls) throw new Error('「' + prod.title + '」還沒選班級');
    dept = L_deptOf(cls, cat.classes);
    if (!dept) throw new Error('「' + prod.title + '」的班級「' + cls + '」不在班級清單裡');
  }
  // 課程：教學進度表排的課用進度表的課程；額外材料單的「課程名稱」（例如活動名稱）由老師自己填
  var course = L_safeText(e.course, 20);
  if (!course) throw new Error(free ? '「' + prod.title + '」還沒填課程名稱（例如活動名稱）' : '「' + prod.title + '」還沒選課程');
  // 每組份量：原本 → 改成（兩格都填才換算），或直接給倍率
  var yF = Number(e.yFrom), yT = Number(e.yTo), hasY = yF > 0 && yT > 0 && yF <= 100000 && yT <= 100000;
  var scale = hasY ? Math.round(yT / yF * 10000) / 10000 : (Number(e.scale) > 0 ? Math.round(Number(e.scale) * 10000) / 10000 : 1);
  if (!(scale >= 0.05 && scale <= 20)) throw new Error('「' + prod.title + '」的份量倍率要在 0.05 到 20 之間');
  var r4 = function (n) { return Math.round(n * 10000) / 10000; };
  var base = {};   // 沒被手動改的時候，這格的原始數字（倍率 ×1）
  (cat.items[e.pid] || []).forEach(function (it) {
    base[it.id] = (!it.kind && it.per !== null) ? it.per : ((!it.kind && it.total !== null) ? it.total : null);
  });
  var omit = [];
  (Array.isArray(e.omit) ? e.omit : []).forEach(function (k) { if (base[k] !== undefined && omit.indexOf(k) < 0) omit.push(String(k)); });
  omit.sort();
  var textIds = {};
  (cat.items[e.pid] || []).forEach(function (it) { if (it.kind) textIds[it.id] = 1; });
  var conv = {};
  Object.keys(e.conv || {}).forEach(function (k) {                          // 只有「適量、範圍、原表沒填」這類材料可以改成數量
    var c = e.conv[k] || {}, u = L_safeText(c.unit, 6) || 'g';
    if (!textIds[k] || omit.indexOf(k) >= 0) return;
    if (c.mode === 'per') { var v = Number(c.per); if (isFinite(v) && v >= 0 && v <= 1000000) conv[k] = { mode: 'per', per: r4(v), unit: u }; }
    else if (c.mode === 'fixed') { var t = Number(c.total); if (isFinite(t) && t >= 0 && t <= 1000000) conv[k] = { mode: 'fixed', total: Math.round(t * 1000) / 1000, unit: u }; }
    else if (c.mode === 'text') { var tx = L_safeText(c.text, 20); if (tx) conv[k] = { mode: 'text', text: tx }; }
  });
  var ov = {};
  Object.keys(e.ov || {}).forEach(function (k) {
    var v = Number(e.ov[k]);
    if (omit.indexOf(k) >= 0) return;
    if (base[k] === undefined || base[k] === null) return;
    if (!isFinite(v) || v < 0 || v > 1000000) return;
    v = r4(v);
    if (v !== r4(base[k])) ov[k] = v;
  });
  var ttl = L_safeText(e.title, 40); if (ttl === prod.title) ttl = '';                          // 沒改就當沒有
  return { id: String(e.id || ''), pid: e.pid, title: ttl, date: e.date, dept: dept, cls: cls, course: course, tools: Array.isArray(e.tools) ? L_cleanTools(e.tools) : null,
           extra: L_cleanExtra(e.extra, cat.nameMap), omit: omit, conv: conv, sets: L_round(sets), scale: scale,
           yFrom: hasY ? yF : null, yTo: hasY ? yT : null, yUnit: hasY ? L_safeText(e.yUnit, 6) : '', ov: ov };
}

/* ---------- 這堂課要準備的器具 ---------- */
/* 老師改過的用改過的；沒改過（tools 是 null）就用材料單模板的。who：技士、實習股長（網頁上叫小老師） */
function L_cleanTools(list) {
  return (list || []).slice(0, 40).map(function (t) {
    return { who: t && t.who === '實習股長' ? '實習股長' : '技士', name: L_safeText(t && t.name, 30), qty: L_safeText(t && t.qty, 20) };
  }).filter(function (t) { return t.name; });
}
function L_toolsFor(entry, cat) {
  var src = Array.isArray(entry.tools) ? entry.tools : (cat.tools[entry.pid] || []);
  return src.map(function (t) { return { who: t.who === '實習股長' ? '實習股長' : '技士', name: t.name, qty: t.qty }; });
}

/* ---------- 器具數量文字 '4支'、'2支(0~32oBrix)' ---------- */
function L_parseQty(text) {
  var s = String(text == null ? '' : text).trim();
  var m = /^(\d+(?:\.\d+)?)\s*([^\d\s(（][^(（]*)?\s*([(（].*)?$/.exec(s);
  if (!m) return null;
  return { n: Number(m[1]), unit: (m[2] || '').trim(), rest: (m[3] || '').trim() };
}

/* ---------- 誰送單了：每個人這學期送了幾堂、這段日期幾堂、最後什麼時候送 ---------- */
function L_submissionStatus(plans, users, term, start, end) {
  var by = {};
  users.forEach(function (u) { if (u.role === '老師') by[u.email] = { email: u.email, name: u.name || u.email.split('@')[0], role: u.role, total: 0, inRange: 0, changed: 0, drafts: 0, pending: 0, lastAt: '', listed: true }; });
  var names = {}; users.forEach(function (u) { names[u.email] = u; });
  plans.forEach(function (e) {
    if (e.term !== term) return;
    var r = by[e.teacher];
    if (!r) { var u = names[e.teacher]; r = by[e.teacher] = { email: e.teacher, name: u ? (u.name || e.teacher.split('@')[0]) : e.teacher, role: u ? u.role : '', total: 0, inRange: 0, changed: 0, drafts: 0, pending: 0, lastAt: '', listed: !!u }; }
    if (e.draft) { r.drafts++; return; }                    // 進度表排給他、他還沒確認送出的，另外算
    r.total++; if (e.pending) r.pending++;                   // 送出過、之後又改了但還沒匯出的，技士看到的還是匯出的那一版
    if (e.updated && e.updated > r.lastAt) r.lastAt = e.updated;
    if (e.date >= start && e.date <= end) { r.inRange++; if (e.created && e.updated && e.updated !== e.created) r.changed++; }
  });
  return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return ((b.total > 0) - (a.total > 0)) || (a.name < b.name ? -1 : 1); });
}

/* ---------- 加總（技士看的）：可以看任何日期範圍 ---------- */
/* onlyTeacher：只看某位老師（老師信箱），不填就是全部。
 * 回傳的 lessons 是逐堂課的材料單（不是統計），materials 是加總。 */
/* 只看某一部分：id = 某一堂課、course = 某門課、cls = 某個班（分組算同一班）、q = 產品名稱裡有這些字。都不給就是全部。 */
function L_cleanFilter(f) {
  f = f || {};
  return { id: L_safeText(f.id, 40), course: L_safeText(f.course, 20), cls: L_safeText(f.cls, 10), q: L_safeText(f.q, 30) };
}
function L_hasFilter(f) { return !!(f && (f.id || f.course || f.cls || f.q)); }
function L_entryMatches(e, f, cat) {
  if (!L_hasFilter(f)) return true;
  if (f.id && e.id !== f.id) return false;
  if (f.course && (e.course || '') !== f.course) return false;
  if (f.cls && e.cls !== f.cls) return false;
  if (f.q) { var prod = cat && cat.products[e.pid], t = String((e.title || (prod && prod.title) || '')).toLowerCase(); if (t.indexOf(f.q.toLowerCase()) < 0) return false; }
  return true;
}
/* 「用於」：同一天、同一門課合併成一筆（數量加總），顯示成「11/26 烘焙食品加工實習 720」，不顯示老師 */
function L_mergeUses(uses) {
  var out = [], idx = {};
  (uses || []).forEach(function (u) {
    var k = u.date + '|' + (u.course || u.title) + '|' + (u.teacher || '');
    if (idx[k] === undefined) { idx[k] = out.length; out.push({ date: u.date, course: u.course || u.title, teacher: u.teacher || '', qty: typeof u.qty === 'number' ? u.qty : null, items: [] }); }
    else if (typeof u.qty === 'number') out[idx[k]].qty = (out[idx[k]].qty || 0) + u.qty;
    out[idx[k]].items.push({ title: u.title || '', cls: u.cls || '', qty: typeof u.qty === 'number' ? L_round(u.qty) : null });
  });
  return out.map(function (u) { if (typeof u.qty === 'number') u.qty = L_round(u.qty); return u; });
}
function L_rangeAggregate(entries, cat, start, end, teacherNames, onlyTeacher, filter, order) {
  var nameOf = function (email) { return (teacherNames && teacherNames[email]) || email || ''; };
  var all = entries.filter(function (e) { return e.date >= start && e.date <= end && cat.products[e.pid]; })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0); });
  var seenT = {}, teachers = [];
  all.forEach(function (e) { if (!seenT[e.teacher]) { seenT[e.teacher] = 1; teachers.push({ email: e.teacher, name: nameOf(e.teacher) }); } });
  teachers.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  var list = onlyTeacher ? all.filter(function (e) { return e.teacher === onlyTeacher; }) : all;
  var fCourses = {}, fClasses = {};                                                  // 篩選的選項：這段日期（這位老師）有哪些課程、班級
  list.forEach(function (e) { if (e.course) fCourses[e.course] = 1; if (e.cls) fClasses[e.cls] = 1; });
  var facets = { courses: Object.keys(fCourses).sort(), classes: Object.keys(fClasses).sort() };
  filter = L_cleanFilter(filter);
  if (L_hasFilter(filter)) list = list.filter(function (e) { return L_entryMatches(e, filter, cat); });
  if (order === 'class' || order === 'course') list = L_orderEntries(list, cat, order);                    // 逐張材料單、匯出的順序：依課程、班級
  var mats = {}, others = {}, classes = [], lessons = [], byDate = {};
  list.forEach(function (e) {
    var prod = cat.products[e.pid], tname = nameOf(e.teacher), lines = L_lines(e, cat); var ttl = e.title || prod.title;
    classes.push({ id: e.id || '', date: e.date, wd: L_weekday(e.date), pid: e.pid, title: ttl, course: e.course || '', cls: e.cls + (e.group ? '（' + e.group + '）' : ''), dept: e.dept, sets: e.sets,
                   scaleNote: L_scaleNote(e), teacher: tname, teacherEmail: e.teacher,
                   changed: !!(e.created && e.updated && e.updated !== e.created), updated: e.updated || '' });
    lessons.push({
      id: e.id || '', date: e.date, wd: L_weekday(e.date), course: e.course || '', cls: e.cls + (e.group ? '（' + e.group + '）' : ''), dept: e.dept, sets: e.sets, scaleNote: L_scaleNote(e),
      teacher: tname, teacherEmail: e.teacher, title: ttl, serving: prod.serving || '', note: prod.note || '',
      changed: !!(e.created && e.updated && e.updated !== e.created), updated: e.updated || '',
      lines: lines.map(function (l) { return { raw: l.raw, extra: l.extra, mode: l.mode, per: l.per, unit: l.unit || 'g', sets: l.sets, total: l.total, text: l.text, note: l.note, procure: l.procure, changed: l.changed }; }),
      tools: L_toolsFor(e, cat).filter(function (t) { return t.who === '技士'; }).map(function (t) { return { name: t.name, qty: t.qty }; }),
      helperTools: L_toolsFor(e, cat).filter(function (t) { return t.who === '實習股長'; }).map(function (t) { return { name: t.name, qty: t.qty }; })
    });
    lines.forEach(function (l) {
      if (l.mode === 'text') {
        var ok = l.std + '|' + l.text;
        var o = others[ok] || (others[ok] = { std: l.std, text: l.text, uses: [] });
        o.uses.push({ date: e.date, title: ttl, teacher: tname, course: e.course || '' });
        return;
      }
      var key = l.std + '|' + l.unit;
      var m = mats[key] || (mats[key] = { std: l.std, unit: l.unit || 'g', total: 0, uses: [] });
      m.total += l.total;
      m.uses.push({ date: e.date, title: ttl, teacher: tname, course: e.course || '', cls: e.cls + (e.group ? '（' + e.group + '）' : ''), qty: l.total });
    });
    var day = byDate[e.date] || (byDate[e.date] = { date: e.date, wd: L_weekday(e.date), map: {}, texts: [] });
    L_toolsFor(e, cat).forEach(function (t) {
      if (t.who !== '技士') return;
      var q = L_parseQty(t.qty);
      var tu = { course: e.course || '', teacher: tname, cls: e.cls + (e.group ? '（' + e.group + '）' : ''), title: ttl, qty: t.qty };
      if (!q) { day.texts.push({ name: t.name, qty: t.qty, title: ttl, uses: [tu] }); return; }
      var k = t.name + '|' + q.unit;
      var x = day.map[k] || (day.map[k] = { name: t.name, unit: q.unit, n: 0, rest: q.rest, uses: [] });
      x.n += q.n; x.uses.push(tu);
    });
  });
  var materials = Object.keys(mats).map(function (k) { var m = mats[k]; m.total = L_round(m.total); m.uses = L_mergeUses(m.uses); return m; })
    .sort(function (a, b) { return (a.unit === 'g' ? 0 : 1) - (b.unit === 'g' ? 0 : 1) || b.total - a.total || (a.std < b.std ? -1 : 1); });
  var totalG = L_round(materials.reduce(function (s, m) { return s + (m.unit === 'g' ? m.total : 0); }, 0));
  var tools = Object.keys(byDate).sort().map(function (d) {
    var day = byDate[d];
    var items = Object.keys(day.map).map(function (k) { var x = day.map[k]; return { name: x.name, n: L_round(x.n), unit: x.unit, rest: x.rest, uses: x.uses }; });
    day.texts.forEach(function (t) { items.push({ name: t.name, n: null, unit: '', rest: t.qty, uses: t.uses }); });
    return { date: d, wd: day.wd, items: items };
  });
  return { start: start, weekStart: start, end: end, teachers: teachers, onlyTeacher: onlyTeacher || '', filter: filter, facets: facets, classes: classes, lessons: lessons, materials: materials, totalG: totalG,
           others: Object.keys(others).map(function (k) { var o = others[k]; o.uses = L_mergeUses(o.uses); return o; }), tools: tools };
}

function L_weekAggregate(entries, cat, weekStart, teacherNames, onlyTeacher) {
  return L_rangeAggregate(entries, cat, weekStart, L_addDays(weekStart, 6), teacherNames, onlyTeacher);
}

/* =====================================================================
 * 匯出內容（文件模型）。版面照原本的「員林農工實習材料申請單」：A4 直印、標楷體、一堂課一張。
 * doc = { name, cw:[欄寬(字元)], rows:[[cell|null…]…], merges:[[r0,c0,r1,c1]…], heights:{列(0起算):pt}, defH, page:{scale, m:{l,r,t,b,h,f}} }
 * cell = { v, f(公式，不含=), b(粗體), sz(字級), ff(字型), al('l'|'c'|'r'), va, bd('lrtb'的子集), wrap, bg, fmt('@'=當文字) }
 * ===================================================================== */
var L_FONT = '標楷體';
var L_PAGE = { paper: 9, scale: 85, fit: 'page', orient: 'portrait', m: { l: 0.7, r: 0.7, t: 0.75, b: 0.75, h: 0.3, f: 0.3 } };   // fit：page = 一張剛好一頁 A4；width = 寬度剛好、高度不限
function L_c(v, o) { var c = { v: v }; if (o) for (var k in o) c[k] = o[k]; return c; }
function L_safeSheetName(s, used) {
  var base = String(s).replace(/[\[\]\*\?\/\\:]/g, '').slice(0, 26) || '工作表', n = base, i = 2;
  while (used[n]) { n = base.slice(0, 23) + '#' + i++; }
  used[n] = 1; return n;
}

/* 一堂課一張申請單 */
/* 材料單的順序：'date' = 依日期（同一天再依產品）；'course' = 依課程、再依日期（不分班）；'class' = 依課程、班級（日間部在前，課程和班級照設定的順序），同一個班再依日期 */
function L_orderEntries(list, cat, order) {
  var cmp = function (x, y) { return x < y ? -1 : x > y ? 1 : 0; };
  var byDate = function (a, b) { return cmp(a.date, b.date) || cmp(a.pid, b.pid) || cmp(a.id || '', b.id || ''); };
  if (order !== 'class' && order !== 'course') return list.slice().sort(byDate);
  var deptRank = function (d) { return d === '日間部' ? 0 : d === '夜間部' ? 1 : 2; };
  var idx = function (arr, v) { var i = (arr || []).indexOf(v); return i < 0 ? 9999 : i; };
  if (order === 'course') return list.slice().sort(function (a, b) {                                    // 依課程、再依日期（不分班；全部放一個檔）
    return deptRank(a.dept) - deptRank(b.dept)
      || idx(cat && cat.courses && cat.courses[a.dept], a.course || '') - idx(cat && cat.courses && cat.courses[b.dept], b.course || '') || cmp(a.course || '', b.course || '')
      || byDate(a, b);
  });
  return list.slice().sort(function (a, b) {
    return deptRank(a.dept) - deptRank(b.dept)
      || idx(cat && cat.courses && cat.courses[a.dept], a.course || '') - idx(cat && cat.courses && cat.courses[b.dept], b.course || '') || cmp(a.course || '', b.course || '')
      || idx(cat && cat.classes && cat.classes[a.dept], a.cls || '') - idx(cat && cat.classes && cat.classes[b.dept], b.cls || '') || cmp(a.cls || '', b.cls || '')
      || cmp(a.group || '', b.group || '') || byDate(a, b);
  });
}
function L_docRequisition(entries, cat, ctx) {
  var used = {}, docs = [];
  var list = L_orderEntries(entries, cat, ctx && ctx.order);
  var T = function (v, o) { return L_c(v, Object.assign({ ff: L_FONT, sz: 16, b: 1, va: 'center' }, o)); };
  var BD = 'lrtb';
  list.forEach(function (e) {
    var prod = cat.products[e.pid]; if (!prod) return; var ttl = e.title || prod.title;
    var p = L_parseDate(e.date), lines = L_lines(e, cat);
    var allTools = L_toolsFor(e, cat);
    var tk = allTools.filter(function (t) { return t.who === '技士'; });
    var st = allTools.filter(function (t) { return t.who === '實習股長'; });
    var N = Math.max(lines.length, 16), M = Math.max(tk.length, st.length, 4);
    var rows = [], merges = [], heights = {};
    var R = function (arr, h) { rows.push(arr); if (h) heights[rows.length - 1] = h; return rows.length - 1; };
    var r = R([T('員 林 農 工 實 習 材 料 申 請 單', { sz: 20, al: 'c' })], 27.75); merges.push([r, 0, r, 7]);
    R([]);
    // 日期和班級一列；課程名稱另外放在下一列（名稱長、又有分組的時候，同一列會擠在一起）
    r = R([T('實習日期：'), T(p.m + '月', { al: 'r' }), T(p.d + '日　星期' + L_weekday(e.date) + '　班級：' + e.cls + (e.group ? '（' + e.group + '）' : ''), { al: 'l' })]);
    merges.push([r, 2, r, 7]);
    r = R([T('課程名稱：' + (e.course || ''), { al: 'l' })]); merges.push([r, 0, r, 7]);
    R([T((e.dept === '日間部' ? '■' : '□') + '日間部'), null, T((e.dept === '夜間部' ? '■' : '□') + '夜間部')]);
    r = R([T([prod.note, L_scaleNote(e)].filter(Boolean).join('　　'), { sz: 14 })]); merges.push([r, 0, r, 7]);
    // 標題列
    var hr = R([T('實習項目', { al: 'c', bd: BD }), T('材  料  名  稱', { al: 'c', bd: BD }), T('', { bd: BD }), T('每組數量', { al: 'c', bd: BD }), T('組 數', { al: 'c', bd: BD }),
                T('總 量', { al: 'c', bd: BD }), T('單  價', { al: 'c', bd: BD }), T('總  價', { al: 'c', bd: BD })]);
    merges.push([hr, 1, hr, 2]);
    // 材料（至少留 16 列，方便手寫補充）
    var title = ttl + (prod.serving ? '\n(' + prod.serving + ')' : '');               // 產品名稱一行、份量（1個/組）換到下一行
    var b0 = rows.length;
    for (var i = 0; i < N; i++) {
      var l = lines[i], rn = rows.length + 1, side = i === N - 1 ? 'lrb' : 'lr';
      var A = i === 0 ? T(title, { sz: 14, bd: side, wrap: 1, al: 'c', va: 'center' }) : T('', { bd: side });
      var D = T('', { al: 'c', bd: BD }), E = T('', { al: 'c', bd: BD }), F = T('', { b: 1, al: 'c', bd: BD }), Hn = T('', { sz: 12, al: 'l', bd: BD }), nm = T('', { b: 0, al: 'l', bd: BD });
      if (l) {
        nm = T(l.raw, { b: 0, al: 'l', bd: BD });
        var note = [l.extra ? '另加' : '', l.note, l.procure && l.mode !== 'text' ? '原表：' + l.procure : ''].filter(Boolean).join('；');
        Hn = T(note, { sz: 12, al: 'l', bd: BD });
        if (l.mode === 'per' && l.unit === 'g') { D = T(l.per, { b: 0, al: 'c', bd: BD }); E = T(l.sets, { b: 0, al: 'c', bd: BD }); F = T('', { b: 1, al: 'c', bd: BD, f: 'D' + rn + '*E' + rn }); }
        else if (l.mode === 'per') { D = T(L_num(l.per) + l.unit, { b: 0, al: 'c', bd: BD }); E = T(l.sets, { b: 0, al: 'c', bd: BD }); F = T(L_num(l.total) + l.unit, { b: 1, al: 'c', bd: BD }); }
        else if (l.mode === 'fixed') { F = T(l.unit === 'g' ? l.total : L_num(l.total) + l.unit, { b: 1, al: 'c', bd: BD }); }
        else { F = T(l.text, { b: 1, al: 'c', bd: BD }); }
      }
      R([A, nm, T('', { bd: BD }), D, E, F, T('', { bd: BD }), Hn]);
      merges.push([rows.length - 1, 1, rows.length - 1, 2]);
    }
    merges.push([b0, 0, b0 + N - 1, 0]);
    // 應備器具
    R([T('應備器具：')]);
    var th = R([T('器具名稱', { al: 'c', bd: BD }), T('', { bd: BD }), T('數量(技士)', { al: 'c', bd: BD }), T('', { bd: BD }), T('器具名稱', { al: 'c', bd: BD }), T('', { bd: BD }), T('數量(實習股長)', { al: 'c', bd: BD }), T('', { bd: BD })]);
    merges.push([th, 0, th, 1], [th, 2, th, 3], [th, 4, th, 5], [th, 6, th, 7]);
    for (var j = 0; j < M; j++) {
      var a = tk[j], b = st[j];
      var tr = R([T(a ? a.name : '', { b: 0, al: 'c', bd: BD }), T('', { bd: BD }), T(a ? a.qty : '', { b: 0, al: 'c', bd: BD }), T('', { bd: BD }),
                  T(b ? b.name : '', { b: 0, al: 'c', bd: BD }), T('', { bd: BD }), T(b ? b.qty : '', { b: 0, al: 'c', bd: BD }), T('', { bd: BD })]);
      merges.push([tr, 0, tr, 1], [tr, 2, tr, 3], [tr, 4, tr, 5], [tr, 6, tr, 7]);
    }
    var sg = R([T('實習股長：'), null, null, null, T('任課老師簽名：' + (e.teacherName || (ctx && ctx.teacherName) || ''))]);
    merges.push([sg, 0, sg, 1], [sg, 4, sg, 7]);
    docs.push({ name: L_safeSheetName(L_pad(p.m) + '-' + L_pad(p.d) + ' ' + e.cls + (e.group ? e.group : '') + ' ' + ttl, used),
                cw: [17.9, 8.4, 17.9, 15.4, 10.6, 8.9, 13.1, 20.1], rows: rows, merges: merges, heights: heights, defH: 21, page: L_PAGE, stack: true, group: (e.dept || '') + '・' + (e.course || '') });
  });
  return docs;
}

/* 技士的加總表：材料總量、課程、器具（也是 A4 直印） */
function L_docWeek(agg) {
  var T = function (v, o) { return L_c(v, Object.assign({ ff: L_FONT, sz: 12, va: 'center' }, o)); };
  var HD = { b: 1, al: 'c', bd: 'lrtb', bg: '#DDEBE6' }, BD = { bd: 'lrtb' };
  var titleTxt = '備料總表　' + agg.start + ' ～ ' + agg.end;
  var rows = [], merges = [];
  rows.push([T(titleTxt, { sz: 16, b: 1 })]); merges.push([0, 0, 0, 4]);
  rows.push([]);
  rows.push([T('材料', HD), T('總量', HD), T('單位', HD), T('公斤', HD), T('用於', HD)]);
  var first = rows.length + 1;
  agg.materials.forEach(function (m) {
    var r = rows.length + 1;
    var uses = m.uses.map(function (u) { return L_md(u.date) + ' ' + u.course + (u.teacher ? '（' + u.teacher + '）' : '') + (u.qty === null || u.qty === undefined ? '' : ' ' + L_num(u.qty) + (m.unit === 'g' ? '克' : m.unit)); }).join('；');
    rows.push([T(m.std, BD), T(m.total, Object.assign({ al: 'r' }, BD)), T(m.unit, Object.assign({ al: 'c' }, BD)),
               m.unit === 'g' ? T('', Object.assign({ al: 'r', f: 'ROUND(B' + r + '/1000,2)' }, BD)) : T('', BD), T(uses, Object.assign({ wrap: 1, va: 'top' }, BD))]);
  });
  var last = rows.length, tr = rows.length + 1;
  rows.push([T('合計（公克類）', Object.assign({ b: 1 }, BD)), T('', Object.assign({ b: 1, al: 'r', f: 'SUMIF(C' + first + ':C' + last + ',"g",B' + first + ':B' + last + ')' }, BD)), T('g', Object.assign({ al: 'c' }, BD)),
             T('', Object.assign({ b: 1, al: 'r', f: 'ROUND(B' + tr + '/1000,2)' }, BD)), T('', BD)]);
  if (agg.others.length) {
    rows.push([]);
    rows.push([T('另計（不加總）', HD), T('內容', HD), T('', HD), T('', HD), T('用於', HD)]);
    merges.push([rows.length - 1, 1, rows.length - 1, 3]);
    agg.others.forEach(function (o) {
      rows.push([T(o.std, BD), T(o.text, BD), T('', BD), T('', BD), T(o.uses.map(function (u) { return L_md(u.date) + ' ' + u.course + (u.teacher ? '（' + u.teacher + '）' : ''); }).join('；'), Object.assign({ wrap: 1 }, BD))]);
      merges.push([rows.length - 1, 1, rows.length - 1, 3]);
    });
  }
  var d1 = { name: '材料總量', cw: [16, 10, 6, 8, 52], rows: rows, merges: merges, heights: { 0: 24 }, defH: 18, page: Object.assign({}, L_PAGE, { fit: 'width' }) };
  var r2 = [[T('日期', HD), T('星期', HD), T('課程', HD), T('實習項目', HD), T('班級', HD), T('部別', HD), T('組數', HD), T('任課老師', HD), T('份量調整', HD), T('修改時間', HD)]];
  agg.classes.forEach(function (c) {
    r2.push([T(c.date, Object.assign({ fmt: '@' }, BD)), T(c.wd, Object.assign({ al: 'c' }, BD)), T(c.course || '', BD), T(c.title, BD), T(c.cls, BD), T(c.dept, BD), T(c.sets, Object.assign({ al: 'c' }, BD)),
             T(c.teacher, BD), T(c.scaleNote || '', BD), T(c.changed ? '已修改 ' + String(c.updated).slice(5, 16) : '', BD)]);
  });
  var d2 = { name: '課程', cw: [11, 6, 16, 22, 9, 8, 6, 12, 26, 16], rows: r2, merges: [], heights: {}, defH: 18, page: Object.assign({}, L_PAGE, { orient: 'landscape', fit: 'width' }) };
  var r3 = [[T('日期', HD), T('星期', HD), T('器具（技士備）', HD), T('數量', HD), T('備註', HD)]];
  agg.tools.forEach(function (d) {
    d.items.forEach(function (x) { r3.push([T(d.date, Object.assign({ fmt: '@' }, BD)), T(d.wd, Object.assign({ al: 'c' }, BD)), T(x.name, BD), T(x.n === null ? '' : x.n + x.unit, BD), T(x.rest || '', BD)]); });
  });
  var d3 = { name: '器具（技士）', cw: [11, 6, 22, 10, 26], rows: r3, merges: [], heights: {}, defH: 18, page: Object.assign({}, L_PAGE, { fit: 'width' }) };
  return [d1, d2, d3];
}

/* 字體：中文用標楷體、英文和數字用 Times New Roman。
 * 同一格裡中英文混在一起的，拆成好幾段（xlsx 的「多種字體」格 / PDF 的 span），每一段各用各的字體。 */
var L_FONT_EN = 'Times New Roman';
function L_fontSplit(text, base) {                                                   // 一段文字 → 依英數字、中文切成幾段
  var out = [], re = /[\x21-\x7E]+/g, last = 0, m, t = String(text);
  var push = function (v, en) { if (v) out.push({ v: v, ff: en ? L_FONT_EN : L_FONT, sz: base.sz, b: base.b, color: base.color }); };
  while ((m = re.exec(t))) { push(t.slice(last, m.index), false); push(m[0], true); last = m.index + m[0].length; }
  push(t.slice(last), false);
  return out;
}
function L_fontDocs(docs) {
  return docs.map(function (d) {
    var rows = d.rows.map(function (row) {
      return row.map(function (c) {
        if (!c || c.ff !== L_FONT) return c;
        var n = {}; for (var k in c) n[k] = c[k];
        if (c.f || typeof c.v === 'number') { n.ff = L_FONT_EN; return n; }                // 公式、數字：Times New Roman
        if (c.runs) { var rr = []; c.runs.forEach(function (rn) { L_fontSplit(rn.v, { sz: rn.sz, b: rn.b, color: rn.color }).forEach(function (x) { rr.push(x); }); }); n.runs = rr; return n; }
        var t = c.v === null || c.v === undefined ? '' : String(c.v);
        if (!/[\x21-\x7E]/.test(t)) return n;                                            // 沒有英數字：全部標楷體
        if (!/[^\x00-\x7F]/.test(t)) { n.ff = L_FONT_EN; return n; }                     // 全是英數字：Times New Roman
        n.runs = L_fontSplit(t, { sz: c.sz, b: c.b }); return n;                         // 中英混合：分段
      });
    });
    var o = {}; for (var k in d) o[k] = d[k]; o.rows = rows; return o;
  });
}

/* =====================================================================
 * PDF：把同一批 docs（跟 xlsx 一樣的內容）排成 HTML，一份 docs 一頁（或多頁）A4 直印，全部放在同一個 PDF。
 * 欄寬、字級、列高都直接照比例縮好（不靠 CSS zoom，Apps Script 轉 PDF 時比較穩）。
 * ===================================================================== */
/* PDF 用的字體順序：電腦有標楷體就用標楷體；沒有（例如手機）就用楷體系的網頁字型。英數字 Times New Roman */
function L_cssFont(ff) {
  return ff === 'Times New Roman' ? "'Times New Roman','Liberation Serif',serif" : "'標楷體','DFKai-SB','BiauKai','Kaiti TC','LXGW WenKai TC',serif";
}
function L_docsToHtml(docs) {
  docs = L_fontDocs(docs);
  var W_IN = 7.55, H_IN = 10.4, PX = 96;                                                   // A4 扣掉邊界後可用的寬、高
  var esc = function (t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var col = function (s) { return s.charCodeAt(0) - 65; };
  var pages = docs.map(function (doc, di) {
    var memo = {};
    var val = function (r, c) {
      var k = r + ',' + c; if (k in memo) return memo[k];
      var cell = (doc.rows[r] || [])[c], v = cell ? cell.v : '';
      if (cell && cell.f) v = evalF(cell.f);
      memo[k] = v; return v;
    };
    var evalF = function (f) {
      var m;
      if ((m = /^([A-Z])(\d+)\*([A-Z])(\d+)$/.exec(f))) return (Number(val(+m[2] - 1, col(m[1]))) || 0) * (Number(val(+m[4] - 1, col(m[3]))) || 0);
      if ((m = /^ROUND\(([A-Z])(\d+)\/1000,2\)$/.exec(f))) return Math.round((Number(val(+m[2] - 1, col(m[1]))) || 0) / 10) / 100;
      if ((m = /^SUMIF\(([A-Z])(\d+):[A-Z](\d+),"g",([A-Z])(\d+):[A-Z](\d+)\)$/.exec(f))) {
        var s = 0; for (var r = +m[2] - 1; r <= +m[3] - 1; r++) if (val(r, col(m[1])) === 'g') s += Number(val(r, col(m[4]))) || 0; return s;
      }
      return '';
    };
    var nR = doc.rows.length, nC = doc.cw.length, cover = {}, span = {};
    (doc.merges || []).forEach(function (m) {
      span[m[0] + ',' + m[1]] = [m[2] - m[0] + 1, m[3] - m[1] + 1];
      for (var r = m[0]; r <= m[2]; r++) for (var c = m[1]; c <= m[3]; c++) if (r !== m[0] || c !== m[1]) cover[r + ',' + c] = 1;
    });
    var widths = doc.cw.map(function (w) { return w * 7 + 5; }), totalW = widths.reduce(function (a, b) { return a + b; }, 0);
    var hts = [], totalH = 0;
    for (var r0 = 0; r0 < nR; r0++) { var ht = ((doc.heights && doc.heights[r0]) || doc.defH || 15) * PX / 72; hts.push(ht); totalH += ht; }
    var k = Math.min((doc.page && doc.page.grow) ? 1.3 : 1, W_IN * PX / totalW);
    if (!doc.page || doc.page.fit === 'page') k = Math.min(k, H_IN * PX / totalH);
    var ws = widths.map(function (w) { return Math.round(w * k * 10) / 10; });
    var tw = ws.reduce(function (a, b) { return a + b; }, 0);
    var h = '<div style="' + (di < docs.length - 1 ? 'page-break-after:always;' : '') + '"><table style="border-collapse:collapse;table-layout:fixed;width:' + tw + 'px;font-family:' + L_cssFont('') + '"><colgroup>' +
      ws.map(function (w) { return '<col width="' + w + '" style="width:' + w + 'px">'; }).join('') + '</colgroup>';
    for (var r = 0; r < nR; r++) {
      h += '<tr style="height:' + Math.round(hts[r] * k * 10) / 10 + 'px">';
      for (var c = 0; c < nC; c++) {
        if (cover[r + ',' + c]) continue;
        var cell = (doc.rows[r] || [])[c], sp = span[r + ',' + c];
        var st = 'padding:0 2px;overflow:hidden;white-space:' + (cell && cell.wrap ? 'normal' : 'nowrap') + ';';
        if (cell) {
          st += 'font-size:' + Math.round((cell.sz || 11) * k * 10) / 10 + 'pt;' + (cell.ff ? 'font-family:' + L_cssFont(cell.ff) + ';' : '');
          if (cell.b) st += 'font-weight:bold;';
          st += 'text-align:' + ({ c: 'center', r: 'right', l: 'left' }[cell.al] || 'left') + ';vertical-align:' + ({ top: 'top', bottom: 'bottom' }[cell.va] || 'middle') + ';';
          if (cell.bg) st += 'background-color:' + cell.bg + ';';
          var bd = cell.bd || '';
          if (sp) {                                                                              // 合併的格子：四邊的線各取範圍邊緣那一格的（左上角那格只有自己的線，下面的線會不見）
            var edge = function (rr, cc) { var x = (doc.rows[rr] || [])[cc]; return (x && x.bd) || ''; };
            bd = (edge(r, c).indexOf('l') >= 0 || bd.indexOf('l') >= 0 ? 'l' : '') + (edge(r, c).indexOf('t') >= 0 || bd.indexOf('t') >= 0 ? 't' : '') +
                 (edge(r, c + sp[1] - 1).indexOf('r') >= 0 ? 'r' : '') + (edge(r + sp[0] - 1, c).indexOf('b') >= 0 ? 'b' : '');
          }
          st += 'border-left:' + (bd.indexOf('l') >= 0 ? '1px solid #000' : '0') + ';border-right:' + (bd.indexOf('r') >= 0 ? '1px solid #000' : '0') + ';border-top:' + (bd.indexOf('t') >= 0 ? '1px solid #000' : '0') + ';border-bottom:' + (bd.indexOf('b') >= 0 ? '1px solid #000' : '0') + ';';
        } else st += 'font-size:' + Math.round(11 * k * 10) / 10 + 'pt;';
        var v = val(r, c); if (typeof v === 'number') v = Math.round(v * 1000) / 1000;
        var inner = (cell && cell.runs) ? cell.runs.map(function (rn) {
          var rst = (rn.ff ? 'font-family:' + L_cssFont(rn.ff) + ';' : '') + (rn.b ? 'font-weight:bold;' : '') + (rn.sz ? 'font-size:' + Math.round(rn.sz * k * 10) / 10 + 'pt;' : '') + (rn.color ? 'color:#' + rn.color + ';' : '');
          return '<span style="' + rst + '">' + esc(rn.v).replace(/\n/g, '<br>') + '</span>';
        }).join('') : (esc(v).replace(/\n/g, '<br>') || '&nbsp;');
        h += '<td' + (sp ? ' rowspan="' + sp[0] + '" colspan="' + sp[1] + '"' : '') + ' style="' + st + '">' + inner + '</td>';
      }
      h += '</tr>';
    }
    return h + '</table></div>';
  });
  return '<html><head><meta charset="utf-8"><style>@page{size:A4;margin:0.6in}body{margin:0}</style></head><body>' + pages.join('') + '</body></html>';
}

/* =====================================================================
 * xlsx 檔（自己組，不靠試算表轉檔）：這樣才能設定 A4、縮放 85%、邊界，跟原本的申請單一樣
 * 回傳 [{name, xml}]，由 Code.gs 用 Utilities.zip 打包
 * ===================================================================== */
function L_xmlEsc(s) { return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function L_colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

/* Excel：連續的材料申請單（stack）疊在同一張工作表裡，每一堂課之間插一個手動分頁線，列印時剛好一堂課一張 A4 */
function L_stackDocs(docs) {
  var out = [], i = 0;
  while (i < docs.length) {
    if (!docs[i].stack) { out.push(docs[i]); i++; continue; }
    var rows = [], merges = [], heights = {}, breaks = [], cw = docs[i].cw;
    while (i < docs.length && docs[i].stack) {
      var d = docs[i], off = rows.length;
      d.rows.forEach(function (r) {
        rows.push(r.map(function (c) {                                                   // 公式裡的列號跟著往下平移（不改到原本的格子）
          if (!c || !c.f || !off) return c;
          var n = {}; for (var k in c) n[k] = c[k];
          n.f = c.f.replace(/([A-Z])(\d+)/g, function (m0, col, num) { return col + (Number(num) + off); });
          return n;
        }));
      });
      (d.merges || []).forEach(function (m) { merges.push([m[0] + off, m[1], m[2] + off, m[3]]); });
      Object.keys(d.heights || {}).forEach(function (k) { heights[Number(k) + off] = d.heights[k]; });
      breaks.push(rows.length);                                                           // 這一堂課最後一列的列號（1 開始）：它後面分頁
      i++;
    }
    breaks.pop();                                                                        // 最後一堂後面不用分頁
    out.push({ name: '材料申請單', cw: cw, rows: rows, merges: merges, heights: heights, defH: 21, breaks: breaks,
               page: Object.assign({}, L_PAGE, { fit: 'width' }) });
  }
  return out;
}

function L_xlsxFiles(docs) {
  docs = L_stackDocs(docs);
  docs = L_fontDocs(docs);
  var fonts = ['<font><sz val="11"/><name val="新細明體"/></font>'], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  var borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'], xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  var fm = {}, fl = {}, bm = {}, xm = {};
  function reg(map, arr, key, xml) { if (!(key in map)) { map[key] = arr.length; arr.push(xml); } return map[key]; }
  function styleOf(c) {
    if (!c) return 0;
    var fk = (c.ff || '') + '|' + (c.sz || 11) + '|' + (c.b ? 1 : 0);
    var fid = reg(fm, fonts, fk, '<font>' + (c.b ? '<b/>' : '') + '<sz val="' + (c.sz || 11) + '"/><name val="' + L_xmlEsc(c.ff || '新細明體') + '"/><family val="1"/><charset val="136"/></font>');
    var lid = c.bg ? reg(fl, fills, c.bg, '<fill><patternFill patternType="solid"><fgColor rgb="FF' + String(c.bg).replace('#', '').toUpperCase() + '"/><bgColor indexed="64"/></patternFill></fill>') : 0;
    var bd = c.bd || '', bk = bd;
    var bid = bd ? reg(bm, borders, bk, '<border>' + ['left:l', 'right:r', 'top:t', 'bottom:b'].map(function (x) { var p = x.split(':'); return bd.indexOf(p[1]) >= 0 ? '<' + p[0] + ' style="thin"><color auto="1"/></' + p[0] + '>' : '<' + p[0] + '/>'; }).join('') + '<diagonal/></border>') : 0;
    var h = { l: 'left', c: 'center', r: 'right' }[c.al] || '', v = { top: 'top', center: 'center', bottom: 'bottom' }[c.va] || '';
    var xk = [fid, lid, bid, h, v, c.wrap ? 1 : 0, c.fmt || ''].join('|');
    return reg(xm, xfs, xk, '<xf numFmtId="' + (c.fmt === '@' ? 49 : 0) + '" fontId="' + fid + '" fillId="' + lid + '" borderId="' + bid + '" xfId="0" applyFont="1"' + (lid ? ' applyFill="1"' : '') + (bid ? ' applyBorder="1"' : '') +
      (c.fmt === '@' ? ' applyNumberFormat="1"' : '') + ' applyAlignment="1"><alignment' + (h ? ' horizontal="' + h + '"' : '') + (v ? ' vertical="' + v + '"' : '') + (c.wrap ? ' wrapText="1"' : '') + '/></xf>');
  }
  var sheets = docs.map(function (d) {
    var nC = d.cw.length, maxR = d.rows.length, out = [];
    d.rows.forEach(function (row, ri) {
      var cells = [];
      for (var ci = 0; ci < nC; ci++) {
        var c = row[ci]; if (!c) continue;
        var ref = L_colName(ci) + (ri + 1), s = styleOf(c), sa = s ? ' s="' + s + '"' : '';
        if (c.f) cells.push('<c r="' + ref + '"' + sa + '><f>' + L_xmlEsc(c.f) + '</f></c>');
        else if (c.runs) {                                                                     // 好幾種字體的同一格（例如產品名稱粗體、老師名稱小字）
          var isXml = c.runs.map(function (rn) {
            var sz = rn.sz || c.sz || 11, ff = rn.ff || c.ff || '新細明體';
            return '<r><rPr>' + (rn.b ? '<b/>' : '') + '<sz val="' + sz + '"/>' + (rn.color ? '<color rgb="FF' + String(rn.color).toUpperCase() + '"/>' : '') +
              '<rFont val="' + L_xmlEsc(ff) + '"/><family val="1"/><charset val="136"/></rPr><t xml:space="preserve">' + L_xmlEsc(rn.v) + '</t></r>';
          }).join('');
          cells.push('<c r="' + ref + '"' + sa + ' t="inlineStr"><is>' + isXml + '</is></c>');
        }
        else if (typeof c.v === 'number' && isFinite(c.v)) cells.push('<c r="' + ref + '"' + sa + '><v>' + c.v + '</v></c>');
        else if (c.v === '' || c.v === null || c.v === undefined) { if (s) cells.push('<c r="' + ref + '"' + sa + '/>'); }
        else cells.push('<c r="' + ref + '"' + sa + ' t="inlineStr"><is><t xml:space="preserve">' + L_xmlEsc(c.v) + '</t></is></c>');
      }
      var ht = d.heights && d.heights[ri];
      if (cells.length || ht) out.push('<row r="' + (ri + 1) + '"' + (ht ? ' ht="' + ht + '" customHeight="1"' : '') + '>' + cells.join('') + '</row>');
    });
    var pg = d.page || L_PAGE, m = pg.m;
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (pg.fit ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '') + '<dimension ref="A1:' + L_colName(nC - 1) + Math.max(1, maxR) + '"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="' + (d.defH || 15) + '"' + (d.defH ? ' customHeight="1"' : '') + '/>' +
      '<cols>' + d.cw.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>' +
      '<sheetData>' + out.join('') + '</sheetData>' +
      (d.merges && d.merges.length ? '<mergeCells count="' + d.merges.length + '">' + d.merges.map(function (g) { return '<mergeCell ref="' + L_colName(g[1]) + (g[0] + 1) + ':' + L_colName(g[3]) + (g[2] + 1) + '"/>'; }).join('') + '</mergeCells>' : '') +
      '<pageMargins left="' + m.l + '" right="' + m.r + '" top="' + m.t + '" bottom="' + m.b + '" header="' + m.h + '" footer="' + m.f + '"/>' +
      '<pageSetup paperSize="' + pg.paper + '"' + (pg.fit ? ' fitToWidth="1" fitToHeight="' + (pg.fit === 'page' ? 1 : 0) + '"' : ' scale="' + pg.scale + '"') + ' orientation="' + pg.orient + '"/>' +
      (d.breaks && d.breaks.length ? '<rowBreaks count="' + d.breaks.length + '" manualBreakCount="' + d.breaks.length + '">' + d.breaks.map(function (n) { return '<brk id="' + n + '" max="16383" man="1"/>'; }).join('') + '</rowBreaks>' : '') + '</worksheet>';
  });
  var files = [];
  files.push({ name: '[Content_Types].xml', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    docs.map(function (d, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' });
  files.push({ name: '_rels/.rels', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
  files.push({ name: 'xl/workbook.xml', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>' +
    docs.map(function (d, i) { return '<sheet name="' + L_xmlEsc(d.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets></workbook>' });
  files.push({ name: 'xl/_rels/workbook.xml.rels', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    docs.map(function (d, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
    '<Relationship Id="rId' + (docs.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' });
  files.push({ name: 'xl/styles.xml', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts><fills count="' + fills.length + '">' + fills.join('') +
    '</fills><borders count="' + borders.length + '">' + borders.join('') + '</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' });
  sheets.forEach(function (x, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', xml: x }); });
  return files;
}


/* =====================================================================
 * 這堂課有沒有被老師改過（叫出以前的紀錄用）
 * ===================================================================== */
function L_customized(e) {
  return !!(e.title || (e.tools && e.tools.length) || Object.keys(e.ov || {}).length || (e.extra && e.extra.length) || (e.omit && e.omit.length) ||
            Object.keys(e.conv || {}).length || (Number(e.scale) && Number(e.scale) !== 1) || e.yFrom);
}

/* =====================================================================
 * 教學進度表：週次、格子內容、由格子產生每位老師的材料單
 * ===================================================================== */
function L_md2(s) { var p = L_parseDate(s); return p ? L_pad(p.m) + '/' + L_pad(p.d) : ''; }
/* 從開學日那一週的週一，一週一週排到包含結業式的那一週：[{n, mon, fri, label:'08/31~09/04'}] */
function L_weeks(start, end) {
  var a = L_parseDate(start), b = L_parseDate(end);
  if (!a || !b || b.t < a.t) return [];
  var mon = L_weekStart(start), out = [], n = 1;
  while (mon <= end && n <= 40) {
    var fri = L_addDays(mon, 4);
    out.push({ n: n, mon: mon, fri: fri, label: L_md2(mon) + '~' + L_md2(fri) });
    mon = L_addDays(mon, 7); n++;
  }
  return out;
}
/* 寒暑假也要上課（例如技藝競賽選手）：某一張進度表可以另外加一段日期，那幾週排在學期的前面或後面，用日期編號（不受開學日改變影響） */
function L_weekId(mon) { return 100000 + Math.floor(L_parseDate(mon).t / 86400000 / 7); }
function L_weeksExt(start, end, ext) {
  var base = L_weeks(start, end);
  if (!ext || !L_parseDate(ext.from) || !L_parseDate(ext.to) || ext.to < ext.from) return base;
  var have = {}, out = base.slice(), m = L_weekStart(ext.from), last = L_weekStart(ext.to), guard = 0;
  base.forEach(function (w) { have[w.mon] = 1; });
  while (m <= last && guard++ < 60) {
    if (!have[m]) { var fri = L_addDays(m, 4); out.push({ n: L_weekId(m), mon: m, fri: fri, label: L_md2(m) + '~' + L_md2(fri), vac: true }); }
    m = L_addDays(m, 7);
  }
  out.sort(function (a, b) { return a.mon < b.mon ? -1 : a.mon > b.mon ? 1 : 0; });
  return out;
}
/* 整理一個格子：{kind:'note', note} 或 {kind:'lesson', mode:'joint'|'split', label, groups:[{label, teacher, pids}]} */
/* 一格的文字說明（衝突提示用）：例如「鳳梨酥（王老師）／海綿蛋糕（林老師）」 */
function L_cellSummary(cell, products, names) {
  if (!cell) return '（空的）';
  if (cell.kind === 'note') return cell.note;
  return cell.groups.map(function (g) { return g.pids.map(function (p) { return products[p] ? products[p].title : p; }).join('、') + (g.teacher ? '（' + ((names && names[g.teacher]) || g.teacher.split('@')[0]) + '）' : ''); }).filter(function (x) { return x; }).join('／');
}
/* me / okPids：自己自創、還沒分享的材料單，自己可以排進進度表（排給哪位老師都可以）；已經在這張進度表裡用著的（okPids），別人編輯這一格時也能留著 */
function L_cleanCell(raw, table, products, emails, me, okPids) {
  raw = raw || {};
  if (raw.kind === 'note') {
    var note = L_safeText(raw.note, 40);
    if (!note) throw new Error('請填內容，例如：教師節放假、考前複習');
    return { kind: 'note', note: note };
  }
  if (raw.kind !== 'lesson') throw new Error('格子的類型不正確。');
  var labels = table.groups || [], split = raw.mode === 'split' && labels.length >= 2;
  var use = split ? labels : [''], groups = [];
  use.forEach(function (label, i) {
    var g = (Array.isArray(raw.groups) ? raw.groups[i] : null) || {}, pids = [];
    (Array.isArray(g.pids) ? g.pids : []).forEach(function (p) {
      p = String(p);
      if (pids.indexOf(p) >= 0) return;
      var pr = products[p];
      if (!pr || pr.deleted || (pr.custom && !pr.shared && !(me && pr.owner === me) && !(okPids && okPids.indexOf(p) >= 0))) throw new Error('找不到材料單：' + p + '（別人自創、還沒分享的材料單，不能排進進度表）');
      pids.push(p);
    });
    if (pids.length > 8) throw new Error('一格最多 8 個產品。');
    var teacher = String(g.teacher || '').toLowerCase().trim();
    if (pids.length && !teacher) throw new Error((label ? '「' + label + '」' : '') + '要選開單的老師。');
    if (teacher && emails.indexOf(teacher) < 0) throw new Error('找不到這位老師：' + teacher);
    if (teacher && table.teachers && table.teachers.length && table.teachers.indexOf(teacher) < 0) throw new Error('這位老師不是這門課這學期的授課老師：' + teacher + '。請技士、科主任或管理者先設定授課老師。');
    groups.push({ label: label, teacher: pids.length ? teacher : '', pids: pids });
  });
  if (!groups.some(function (g) { return g.pids.length; })) throw new Error('至少要選一個產品。');
  return { kind: 'lesson', mode: split ? 'split' : 'joint', label: L_safeText(raw.label, 30), groups: groups };
}
/* 一個班每週哪幾天上課：一般一天（例如週一）；技藝競賽選手這類每天訓練的，可以是每天（一到五）或幾到幾 */
function L_classDays(c) {
  var d = (c && Array.isArray(c.days) ? c.days : []).map(Number).filter(function (x) { return x >= 1 && x <= 5; }), u = [];
  d.forEach(function (x) { if (u.indexOf(x) < 0) u.push(x); });
  u.sort();
  if (!u.length) { var w = Number(c && c.wd); u = [w >= 1 && w <= 5 ? w : 1]; }
  return u;
}
/* 一張進度表的班級，依上課的星期排：星期一的放前面（同一天的照原本的順序） */
function L_sortClasses(list) {
  return (list || []).map(function (c, i) { return { c: c, i: i, d: L_classDays(c)[0] }; })
    .sort(function (a, b) { return a.d - b.d || a.i - b.i; }).map(function (x) { return x.c; });
}
function L_cellKey(week, cls, day) { return week + '|' + cls + (day ? '|' + day : ''); }
/* 一個「格子」會產生哪些材料單：每個產品一堂，歸開單的老師；sid 是這堂課在進度表裡的編號。
 * 每天上課的班（一週好幾天），每一天是一格，day 是星期幾（1~5） */
function L_scheduleDerive(table, week, cls, cell, products, day) {
  var c = (table.classes || []).filter(function (x) { return x.cls === cls; })[0], out = [];
  if (!c || !week || !cell || cell.kind !== 'lesson') return out;
  var days = L_classDays(c), multi = days.length > 1, dn = Number(day) || 0;
  var d = multi ? dn : (dn > 0 ? dn : days[0]);                       // 平常上課日以外，某一週額外加練的一天（1~7 = 週一到週日）
  if (!(d >= 1 && d <= 7)) return out;
  var suffix = multi || dn > 0;
  var date = L_addDays(week.mon, d - 1);
  cell.groups.forEach(function (g) {
    g.pids.forEach(function (pid) {
      if (!products[pid]) return;
      out.push({ sid: table.id + '|' + week.n + '|' + cls + '|' + g.label + '|' + pid + (suffix ? '|d' + d : ''), teacher: g.teacher, date: date, dept: table.dept, course: table.course, cls: cls, group: g.label, pid: pid, day: suffix ? d : 0 });
    });
  });
  return out;
}

/* 上課日的文字：[5] → 週五；[1,2,3,4,5] → 每天（週一到週五）；[2,3,4] → 週二到週四；[1,3,5] → 週一、週三、週五（short：W五 / 每天 / W二~四） */
function L_daysText(days, short) {
  var W = '日一二三四五六日', d = days.slice().sort();
  if (d.length === 1) return short ? 'W' + W.charAt(d[0]) : '週' + W.charAt(d[0]);
  var consecutive = d.every(function (x, i) { return i === 0 || x === d[i - 1] + 1; });
  if (d.length === 5) return short ? '每天' : '每天（週一到週五）';
  if (consecutive) return short ? 'W' + W.charAt(d[0]) + '~' + W.charAt(d[d.length - 1]) : '週' + W.charAt(d[0]) + '到週' + W.charAt(d[d.length - 1]);
  return d.map(function (x) { return (short ? 'W' : '週') + W.charAt(x); }).join('、');
}
/* 進度表文件（匯出材料單的第一頁）：A4 直印、一頁放得下，一次呈現這個年級的兩個班 */
function L_docSchedule(table, weeks, cells, ctx) {
  ctx = ctx || {};
  var names = ctx.names || {}, products = ctx.products || {}, hl = String(ctx.highlight || '').toLowerCase();
  var T = function (v, o) { return L_c(v, Object.assign({ ff: L_FONT, sz: 11, va: 'center' }, o)); };
  var TR = function (runs, o) { return L_c(runs.map(function (r) { return r.v; }).join(''), Object.assign({ ff: L_FONT, sz: 11, va: 'center', runs: runs }, o)); };   // 一格好幾種字（產品名稱粗體、老師名稱小字灰色）
  var BD = 'lrtb', HD = { b: 1, al: 'c', bd: BD, bg: '#DDEBE6' };
  var SHADES = ['FFFFFF', 'E7E7E7', 'D2D2D2', 'BEBEBE', 'AAAAAA'];                                   // 同一班不同老師的底色（用灰階深淺，黑白列印也分得出來）
  var clsTeachers = {};                                                                              // 這班（這欄）依序出現過哪些老師，只有兩位以上才需要分顏色
  Object.keys(cells).forEach(function (k) {
    var x = cells[k]; if (!x || x.kind !== 'lesson') return;
    var cls = k.split('|')[1]; var list = clsTeachers[cls] = clsTeachers[cls] || [];
    x.groups.forEach(function (g) { if (g.teacher && list.indexOf(g.teacher) < 0) list.push(g.teacher); });
  });
  var shadeFor = function (cls, teacher) {
    var list = clsTeachers[cls] || []; if (list.length < 2 || !teacher) return undefined;
    var idx = list.indexOf(teacher); return idx < 0 ? undefined : '#' + SHADES[idx % SHADES.length];
  };
  var classes = L_sortClasses(table.classes), labels = (table.groups && table.groups.length >= 2) ? table.groups : [], gN = Math.max(1, labels.length);
  var single = classes.length === 1, regD = single ? L_classDays(classes[0]) : [0];
  var dayKey = function (c, d) { var rd = L_classDays(c); return (rd.length === 1 && d === rd[0]) ? 0 : d; };      // 只有一天上課的班，平常那一天的格子存成 0
  var rowDays = function (w) {                                                                                   // 這一週要印哪幾天：平常上課日 + 這週額外加練的日子
    if (!single) return [0];
    var out = regD.slice();
    for (var d = 1; d <= 7; d++) if (regD.indexOf(d) < 0 && cells[L_cellKey(w.n, classes[0].cls, d)]) out.push(d);
    return out.sort();
  };
  var multi = single && (regD.length > 1 || weeks.some(function (w) { return rowDays(w).length > 1; }));
  var nCols = 2 + classes.length * gN, rows = [], merges = [], heights = {};
  var cw = [4.5, 11], per = classes.length >= 3 ? 26 : 38;
  classes.forEach(function () { for (var g = 0; g < gN; g++) cw.push(per / gN * (gN > 1 ? 1.0 : 1)); });
  var R = function (arr, h) { rows.push(arr); if (h) heights[rows.length - 1] = h; return rows.length - 1; };
  var title = (ctx.term ? ctx.term + ' ' : '') + table.course + '　教學進度表';
  var r = R([T(title, { sz: 17, b: 1, al: 'c' })], 30); merges.push([r, 0, r, nCols - 1]);
  var sub = '班級：' + classes.map(function (c) { return c.cls + '（' + L_daysText(L_classDays(c)) + '）'; }).join('　') + (ctx.printed ? '　　' + ctx.printed + ' 列印' : '');
  r = R([T(sub, { sz: 10, al: 'l' })], 20); merges.push([r, 0, r, nCols - 1]);
  var h1 = R([T('週次', HD), T('日期', HD)]);
  classes.forEach(function (c, ci) {
    var col = 2 + ci * gN; rows[h1][col] = T(c.cls + '（' + L_daysText(L_classDays(c), true) + '）', HD);
    for (var g = 1; g < gN; g++) rows[h1][col + g] = T('', HD);
    if (gN > 1) merges.push([h1, col, h1, col + gN - 1]);
  });
  if (gN > 1) {
    var h2 = R([T('', HD), T('', HD)]);
    classes.forEach(function (c, ci) { labels.forEach(function (lb, g) { rows[h2][2 + ci * gN + g] = T(lb, HD); }); });
    merges.push([h1, 0, h2, 0], [h1, 1, h2, 1]);
  }
  var WDN = '日一二三四五六日', wkStart = rows.length, rowNeed = {};
  weeks.forEach(function (w) {
    var dr = multi ? rowDays(w) : [0];
    dr.forEach(function (d, di) {
      var row = [T(di === 0 ? w.n : '', { al: 'c', bd: BD }), T(multi ? L_md2(L_addDays(w.mon, d - 1)) + '（' + WDN.charAt(d % 7) + '）' + (regD.indexOf(d) < 0 ? ' 加練' : '') : w.label, { al: 'c', bd: BD, sz: 10 })], ri = rows.length;
      for (var k = 2; k < nCols; k++) row[k] = T('', { bd: BD });
      rows.push(row); heights[ri] = ctx.rowH || (multi ? 30 : 32);
      if (di === dr.length - 1 && dr.length > 1) merges.push([ri - di, 0, ri, 0]);
      classes.forEach(function (c, ci) {
        var cell = cells[L_cellKey(w.n, c.cls, multi ? dayKey(c, d) : 0)], col = 2 + ci * gN;
        var runsFor = function (g, span) {
          var ttl = cell.label || g.pids.map(function (p) { return products[p] ? products[p].title : p; }).join('、'), cap = -1;
          for (var q = 0; q < span; q++) cap += cw[col + q];
          var u = 0; String(ttl).split('').forEach(function (ch) { u += /[^\x00-\x7f]/.test(ch) ? 2.1 : 1.2; });          // 估算文字寬度（中文字約 2.1 個數字寬）
          var sz = 11, lines = Math.max(1, Math.ceil(u / cap));
          if (u > cap) { sz = 10; lines = Math.max(1, Math.ceil(u * 10 / 11 / cap)); if (lines > 1) { sz = 9; lines = Math.max(1, Math.ceil(u * 9 / 11 / cap)); } }
          rowNeed[ri] = Math.max(rowNeed[ri] || 0, lines * sz * 1.35 + (g.teacher ? 12 * 1.35 : 0) + 5);
          var runs = [{ v: ttl, b: 1, sz: sz }];
          if (g.teacher) runs.push({ v: '\n' + (names[g.teacher] || g.teacher.split('@')[0]), sz: 12, b: 1, color: '000000' });
          return runs;
        };
        var bgFor = function (teacher) { return hl && teacher === hl ? '#FFF2A8' : shadeFor(c.cls, teacher); };
        if (!cell) return;
        if (cell.kind === 'note') {
          row[col] = T(cell.note, { al: 'c', bd: BD, bg: '#EEEEEE', wrap: 1 });
          if (gN > 1) merges.push([ri, col, ri, col + gN - 1]);
        } else if (cell.mode === 'joint' || gN === 1) {
          var g0 = cell.groups[0]; row[col] = TR(runsFor(g0, gN), { al: 'c', bd: BD, wrap: 1, bg: bgFor(g0.teacher) });
          if (gN > 1) merges.push([ri, col, ri, col + gN - 1]);
        } else {
          cell.groups.forEach(function (g, gi) { row[col + gi] = g.pids.length ? TR(runsFor(g, 1), { al: 'c', bd: BD, wrap: 1, bg: bgFor(g.teacher) }) : T('', { al: 'c', bd: BD, wrap: 1 }); });
        }
      });
    });
  });
  for (var ni in rowNeed) if (!ctx.rowH && rowNeed[ni] > (heights[ni] || 0)) heights[ni] = Math.ceil(rowNeed[ni]);       // 文字比較長要換行的列，列高跟著加高（不然會被切掉）
  var dataN = rows.length - wkStart;                                                      // 週次很多（例如 21 週，或每天上課的班）：列高盡量縮小，一定要放在同一頁
  if (!ctx.rowH && dataN > 18) {
    var hdrH = 0; for (var hi = 0; hi < wkStart; hi++) hdrH += heights[hi] || 18;
    var fitH = Math.max(14, Math.floor((730 - hdrH) / dataN));
    for (var wi = wkStart; wi < rows.length; wi++) { var mn = Math.max(fitH, Math.ceil(rowNeed[wi] || 0)); if (heights[wi] > mn) heights[wi] = mn; }
  }
  var nm = '進度表' + (ctx.n ? ctx.n : '');
  return { name: nm, group: (table.dept || '') + '・' + (table.course || ''), cw: cw, rows: rows, merges: merges, heights: heights, defH: 18, page: Object.assign({}, L_PAGE, { fit: 'page', grow: true, m: { l: 0.3, r: 0.3, t: 0.3, b: 0.3, h: 0.1, f: 0.1 } }) };
}


/* 進度表排了、但老師還沒送出的課：進度表每一堂課現在是「已送出／待確認（老師還沒確認）／沒有人（排課被刪掉了）」哪一種
 * start、end 給空字串 = 整個學期 */
function L_scheduleStatus(tables, cells, weeks, plans, products, names, start, end, weeksOf) {
  var bySid = {}, items = [];
  plans.forEach(function (e) { if (e.sid) bySid[e.sid] = e; });
  tables.forEach(function (t) {
    var wmap = {}; (weeksOf ? weeksOf(t) : weeks).forEach(function (w) { wmap[w.n] = w; });
    cells.forEach(function (x) {
      if (x.tableId !== t.id || !x.cell || x.cell.kind !== 'lesson') return;
      var w = wmap[x.week]; if (!w) return;
      L_scheduleDerive(t, w, x.cls, x.cell, products, x.day || 0).forEach(function (sp) {
        if ((start && sp.date < start) || (end && sp.date > end)) return;
        var e = bySid[sp.sid], pr = products[sp.pid];
        items.push({ sid: sp.sid, tableId: t.id, dept: t.dept, course: t.course, cls: sp.cls, group: sp.group, week: x.week, date: sp.date, pid: sp.pid,
                     title: (e && e.title) || (pr ? pr.title : sp.pid), teacher: sp.teacher, teacherName: (names && names[sp.teacher]) || sp.teacher.split('@')[0],
                     status: !e ? 'missing' : (e.draft ? 'draft' : 'sent'), updated: e ? e.updated : '' });
      });
    });
  });
  items.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.course + a.cls + a.group + a.pid < b.course + b.cls + b.group + b.pid ? -1 : 1); });
  return items;
}


/* 每學期「應該有」的進度表（管理的人設定一次，以後每學期照用）：現在每個班是什麼狀況
 * required = [{id, dept, course, classes:[班級], half, note, skip}]（已經只留這學期用得到的）
 * 狀態由差到好：no-table 還沒建進度表 → empty 建了但一週都還沒排 → partial 還沒排完 → pending 排完了、有課還沒送出 → done 全部送出 */
var L_REQ_ORDER = ['no-table', 'empty', 'partial', 'pending', 'done'];
function L_termHalf(term) { return /-2$/.test(String(term || '')) ? '下' : '上'; }
function L_requiredStatus(required, tables, cells, weeks, plans, products, weeksOf) {
  var bySid = {};
  plans.forEach(function (e) { if (e.sid) bySid[e.sid] = e; });
  return (required || []).map(function (r) {
    var classes = (r.classes || []).map(function (rc) {
      var cls = typeof rc === 'string' ? rc : rc.cls;
      var t = tables.filter(function (x) { return x.dept === r.dept && x.course === r.course && x.classes.some(function (c) { return c.cls === cls; }); })[0];
      if (!t) return { cls: cls, hasTable: false, state: 'no-table' };
      var wmap = {}; (weeksOf ? weeksOf(t) : weeks).forEach(function (w) { wmap[w.n] = w; });
      var tc = t.classes.filter(function (c) { return c.cls === cls; })[0], days = L_classDays(tc), need = days.length > 1 ? days : [0];
      var got = {}, lessons = 0, sent = 0, draft = 0, missing = 0;
      cells.forEach(function (x) {
        if (x.tableId !== t.id || x.cls !== cls) return;
        (got[x.week] = got[x.week] || {})[x.day || 0] = 1;
        if (x.cell && x.cell.kind === 'lesson') L_scheduleDerive(t, wmap[x.week], cls, x.cell, products, x.day || 0).forEach(function (sp) {
          lessons++; var e = bySid[sp.sid];
          if (!e) missing++; else if (e.draft) draft++; else sent++;
        });
      });
      var ws = (r.half === '假' && weeksOf) ? weeksOf(t).filter(function (w) { return w.vac; }) : weeks;             // 「只有寒暑假」的課：只看寒暑假加的那幾週
      var wf = 0, any = 0, wt = ws.length;
      ws.forEach(function (w) { var g = got[w.n]; if (g) { any++; if (need.every(function (d) { return g[d]; })) wf++; } });
      var state = (!wt || any === 0) ? 'empty' : wf < wt ? 'partial' : (sent < lessons ? 'pending' : 'done');
      return { cls: cls, hasTable: true, tableId: t.id, weeksFilled: wf, weeksTotal: wt, lessons: lessons, sent: sent, draft: draft, missing: missing, state: state };
    });
    var worst = 'done';
    classes.forEach(function (c) { if (L_REQ_ORDER.indexOf(c.state) < L_REQ_ORDER.indexOf(worst)) worst = c.state; });
    return { id: r.id, dept: r.dept, course: r.course, half: r.half, note: r.note || '', skip: !!r.skip, classes: classes, state: r.skip ? 'skip' : worst };
  });
}


/* 每學期「應該要有」的進度表，預設的樣子（第一次用的時候系統自動放進去，管理的人可以再改）：
 * 日間部一個年級分甲、乙兩班，一年級烘焙食品加工實習、二年級食品加工實習、三年級進階食品加工實習，上下學期都一樣；
 * 夜間部只有烘焙一、二、三，一年級食品加工、麵包製作，二年級西式點心製作，三年級中式點心製作、蛋糕製作、蛋糕裝飾。夜間部一堂課只有一位老師。 */
var L_REQUIRED_DEFAULTS = [
  { id: 'd1', dept: '日間部', course: '烘焙食品加工實習', classes: [{ cls: '加一甲', days: [5] }, { cls: '加一乙', days: [1] }], groups: ['單數組', '雙數組'], half: '每', note: '一年級' },
  { id: 'd2', dept: '日間部', course: '食品加工實習', classes: [{ cls: '加二甲', days: [5] }, { cls: '加二乙', days: [1] }], groups: ['單數組', '雙數組'], half: '每', note: '二年級' },
  { id: 'd3', dept: '日間部', course: '進階食品加工實習', classes: [{ cls: '加三甲', days: [5] }, { cls: '加三乙', days: [1] }], groups: ['單數組', '雙數組'], half: '每', note: '三年級' },
  { id: 'd4', dept: '日間部', course: '國中技藝班', classes: [{ cls: '國中技藝班', days: [1] }], groups: [], half: '每', note: '' },
  { id: 'd5', dept: '日間部', course: '技藝競賽選手', classes: [{ cls: '技藝競賽選手', days: [1, 2, 3, 4, 5] }], groups: [], half: '每', note: '每天訓練，一天可以有好幾樣產品' },
  { id: 'n1', dept: '夜間部', course: '食品加工實習', classes: [{ cls: '烘焙一', days: [1] }], groups: [], half: '每', note: '一年級' },
  { id: 'n2', dept: '夜間部', course: '麵包製作實習', classes: [{ cls: '烘焙一', days: [1] }], groups: [], half: '每', note: '一年級' },
  { id: 'n3', dept: '夜間部', course: '西式點心製作實習', classes: [{ cls: '烘焙二', days: [1] }], groups: [], half: '每', note: '二年級' },
  { id: 'n4', dept: '夜間部', course: '中式點心製作實習', classes: [{ cls: '烘焙三', days: [1] }], groups: [], half: '每', note: '三年級' },
  { id: 'n5', dept: '夜間部', course: '蛋糕製作實習', classes: [{ cls: '烘焙三', days: [1] }], groups: [], half: '每', note: '三年級' },
  { id: 'n6', dept: '夜間部', course: '蛋糕裝飾實習', classes: [{ cls: '烘焙三', days: [1] }], groups: [], half: '每', note: '三年級' }
];
