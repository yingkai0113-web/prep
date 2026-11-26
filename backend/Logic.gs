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


/* =====================================================================
 * 估價單（報價單）：照廠商（金益昇食品原料行）的報價單格式，列出要請購的材料和器具，廠商自己填單價。
 * rec = { date: 送貨日期 yyyy-mm-dd, today: 送單日期 yyyy-mm-dd, purpose: 用途備註, items: [{ name, qty, unit, note }] }
 * ===================================================================== */
var L_QUOTE = { vendor: '金益昇食品原料行', client: '員林農工', tax: '60004108', contact: '蘇修妍', phone: '傳真8385451', addr: '彰化縣員林鎮員水路二段313號',
                vTel: '048-336-630', vFax: '048-318-385', vAddr: '彰化縣員林鎮員鹿路140號1F' };
var L_STAMP_B64 = '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';
function L_docQuote(rec) {
  var Q = L_QUOTE, T = function (v, o) { return L_c(v, Object.assign({ ff: L_FONT, sz: 12, va: 'center' }, o)); };
  var d = L_parseDate(rec.today), roc = d ? '中華民國' + (d.y - 1911) + '年 ' + d.m + '月 ' + d.d + '日' : '';
  var dv = L_parseDate(rec.date), rm = (rec.purpose ? String(rec.purpose) : '') + (dv ? '（' + L_pad(dv.m) + '/' + L_pad(dv.d) + '送貨）' : '');
  var items = (rec.items || []).filter(function (x) { return x && x.name; });
  var nRows = Math.max(21, items.length);
  var rows = [], merges = [], heights = {};
  var line = function (r, h) { heights[r] = h; };
  rows.push([T(Q.vendor, { sz: 18, al: 'c' })]); merges.push([0, 0, 0, 6]); line(0, 30);
  rows.push([T('報    價   單', { sz: 18, al: 'c' })]); merges.push([1, 0, 1, 6]); line(1, 26);
  var info = function (a, b, c2, d2, bot) {
    var r = rows.length, o = bot ? { bd: 'b' } : {};
    var row = [T(a, Object.assign({ al: 'l' }, o)), T(b, Object.assign({ al: 'l' }, o)), T('', o), T(c2, Object.assign({ al: 'l' }, o)), T(d2, Object.assign({ al: 'l', fmt: '@' }, o)), T('', o), T('', o)];
    rows.push(row); merges.push([r, 1, r, 2]); merges.push([r, 4, r, 6]); line(r, bot ? 26 : 20);
  };
  info('客戶名稱：', Q.client, '聯絡人：', Q.contact);
  info('統一編號：', Q.tax, '聯絡電話：', Q.phone);
  info('公司地址：', Q.addr, '送貨地址：', Q.addr);
  info('送單日期：', roc, '備註：', rm, true);
  var H = { sz: 14, al: 'c', bd: 'lrtb' };
  rows.push([T('編號', H), T('品名', H), T('數量', H), T('單位規格', H), T('單價', H), T('總價', H), T('備註(克數)', H)]); line(rows.length - 1, 20);
  var first = rows.length + 1;
  for (var i = 0; i < nRows; i++) {
    var x = items[i], r = rows.length + 1, B = { sz: 14, bd: 'lrtb', al: 'c' };
    rows.push([T(i + 1, B), T(x ? x.name : '', Object.assign({}, B, { wrap: 1 })), T(x ? Number(x.qty) : '', B), T(x ? x.unit : '', B), T('', B),
               T('', Object.assign({}, B, { f: 'IF(E' + r + '="","",C' + r + '*E' + r + ')' })), T(x ? (x.note || '') : '', B)]);
    line(rows.length - 1, 20);
  }
  var last = rows.length, tr = rows.length + 1;
  rows.push([T('', {}), T('', {}), T('', {}), T('', {}), T('合計:', { sz: 14, al: 'c', bd: 'lrtb' }), T('', { sz: 14, al: 'c', bd: 'lrtb', f: 'SUM(F' + first + ':F' + last + ')' }), T('', {})]); line(rows.length - 1, 20);
  ['1.本報價單有效期間為15天', '2.以上報價皆含稅', '3.近日物價波動幅度大，故有價格異動則另行通知'].forEach(function (t) { rows.push([T(t, { ff: L_FONT })]); merges.push([rows.length - 1, 0, rows.length - 1, 6]); });
  rows.push([]);
  rows.push([T(Q.vendor, { al: 'l' })]); merges.push([rows.length - 1, 0, rows.length - 1, 6]);
  [T('電話：' + Q.vTel), T('傳真：' + Q.vFax), T('地址：' + Q.vAddr)].forEach(function (c) { rows.push([c]); merges.push([rows.length - 1, 0, rows.length - 1, 3]); });
  var img = { b64: L_STAMP_B64, ext: 'jpeg', col: 3, colOff: 760320, row: tr + 2, rowOff: 104760, cx: 2421000, cy: 1247760 };
  return { name: '報價單', img: img, cw: [12.74, 23.74, 10.37, 14.37, 10.99, 11.87, 16.5], rows: rows, merges: merges, heights: heights, defH: 18,
           page: { paper: 9, scale: 100, fit: 'width', orient: 'portrait', m: { l: 0.4, r: 0.4, t: 0.6, b: 0.6, h: 0.3, f: 0.3 } } };
}

/* ---------------- 分配單（附給廠商：每個上課日期各一張表，品名、全班總計、備註＝哪位老師做什麼） ----------------
 * rec.items[i].uses = [{ date, teacher, titles[], qty }]（qty 已經是最後要給廠商的數量） */
function L_splitModel(items) {
  var by = {}, dates = [];
  (items || []).forEach(function (it, ix) {
    var perDate = {};
    (it.uses || []).forEach(function (u) {
      if (!L_parseDate(u.date) || !isFinite(Number(u.qty)) || Number(u.qty) <= 0) return;
      (perDate[u.date] = perDate[u.date] || []).push(u);
    });
    Object.keys(perDate).forEach(function (d) {
      var us = perDate[d], total = 0;
      us.forEach(function (u) { total += Number(u.qty); });
      var parts = us.map(function (u) {
        var t = (u.titles || []).filter(Boolean).join('、'), who = String(u.teacher || '');
        return (who + (t ? '(' + t + ')' : '')) + (us.length > 1 ? ' ' + L_num(Number(u.qty)) + (it.unit || '') : '');
      });
      if (!by[d]) { by[d] = []; dates.push(d); }
      by[d].push({ name: it.name + (it.unit ? '/' + it.unit : ''), total: L_round(total), note: parts.join('、'), key: String(us[0].teacher || ''), ix: ix });
    });
  });
  dates.sort();
  return dates.map(function (d) {
    var rows = by[d].slice().sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : a.ix - b.ix; });
    var prev = null;
    rows.forEach(function (r) { var n = r.note; r.note = n === prev ? '' : n; prev = n; });
    return { date: d, rows: rows };
  });
}
function L_docxSplitFiles(model) {
  var X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  var rf = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="' + L_FONT + '" w:cs="Times New Roman" w:hint="eastAsia"/>';
  var run = function (t, sz, b) { return '<w:r><w:rPr>' + rf + (b ? '<w:b/>' : '') + '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/></w:rPr><w:t xml:space="preserve">' + L_xmlEsc(t) + '</w:t></w:r>'; };
  var para = function (t, sz, b, o) { return '<w:p><w:pPr>' + (o && o.keep ? '<w:keepNext/>' : '') + '<w:spacing w:before="' + ((o && o.before) || 0) + '" w:after="0"/>' + (o && o.jc ? '<w:jc w:val="' + o.jc + '"/>' : '') + '</w:pPr>' + (t ? run(t, sz, b) : '') + '</w:p>'; };
  var W = [988, 3827, 1417, 3828];
  var bd = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (k) { return '<w:' + k + ' w:val="single" w:sz="4" w:space="0" w:color="auto"/>'; }).join('') + '</w:tblBorders>';
  var cell = function (i, t, jc) { return '<w:tc><w:tcPr><w:tcW w:w="' + W[i] + '" w:type="dxa"/></w:tcPr>' + para(t, 28, false, { jc: jc }) + '</w:tc>'; };
  var row = function (a, hdr) { return '<w:tr><w:trPr><w:cantSplit/>' + (hdr ? '<w:tblHeader/>' : '') + '</w:trPr>' + cell(0, a[0], 'center') + cell(1, a[1], hdr ? 'center' : null) + cell(2, a[2], 'center') + cell(3, a[3], hdr ? 'center' : null) + '</w:tr>'; };
  var body = para('員林農工食品加工科', 44, false);
  model.forEach(function (d, i) {
    var p = L_parseDate(d.date);
    body += para('上課日期：' + (p.y - 1911) + '.' + p.m + '.' + p.d + '(' + L_weekday(d.date) + ')', 44, true, { keep: 1, before: i ? 240 : 0 });
    body += '<w:tbl><w:tblPr><w:tblW w:w="' + W.reduce(function (a, b) { return a + b; }, 0) + '" w:type="dxa"/>' + bd + '<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>' + W.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join('') + '</w:tblGrid>' +
      row(['項目', '品名', '全班總計', '備註'], true) + d.rows.map(function (r) { return row(['', r.name, L_num(r.total), r.note]); }).join('') + '</w:tbl>';
  });
  body += para('', 28, false);
  var doc = X + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>';
  var styles = X + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>' + rf + '<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>';
  return [
    { name: '[Content_Types].xml', xml: X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: '_rels/.rels', xml: X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', xml: X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'word/document.xml', xml: doc },
    { name: 'word/styles.xml', xml: styles }
  ];
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
    var h = '<div style="position:relative;' + (di < docs.length - 1 ? 'page-break-after:always;' : '') + '"><table style="border-collapse:collapse;table-layout:fixed;width:' + tw + 'px;font-family:' + L_cssFont('') + '"><colgroup>' +
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
    if (doc.img) {
      var g = doc.img, left = 0, top = 0, q;
      for (q = 0; q < g.col; q++) left += ws[q];
      for (q = 0; q < g.row; q++) top += hts[q] * k;
      left += g.colOff / 9525 * k; top += g.rowOff / 9525 * k;
      return h + '</table><img src="data:image/' + g.ext + ';base64,' + g.b64 + '" style="position:absolute;left:' + Math.round(left) + 'px;top:' + Math.round(top) + 'px;width:' + Math.round(g.cx / 9525 * k) + 'px;height:' + Math.round(g.cy / 9525 * k) + 'px"></div>';
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
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      (pg.fit ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '') + '<dimension ref="A1:' + L_colName(nC - 1) + Math.max(1, maxR) + '"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="' + (d.defH || 15) + '"' + (d.defH ? ' customHeight="1"' : '') + '/>' +
      '<cols>' + d.cw.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>' +
      '<sheetData>' + out.join('') + '</sheetData>' +
      (d.merges && d.merges.length ? '<mergeCells count="' + d.merges.length + '">' + d.merges.map(function (g) { return '<mergeCell ref="' + L_colName(g[1]) + (g[0] + 1) + ':' + L_colName(g[3]) + (g[2] + 1) + '"/>'; }).join('') + '</mergeCells>' : '') +
      '<pageMargins left="' + m.l + '" right="' + m.r + '" top="' + m.t + '" bottom="' + m.b + '" header="' + m.h + '" footer="' + m.f + '"/>' +
      '<pageSetup paperSize="' + pg.paper + '"' + (pg.fit ? ' fitToWidth="1" fitToHeight="' + (pg.fit === 'page' ? 1 : 0) + '"' : ' scale="' + pg.scale + '"') + ' orientation="' + pg.orient + '"/>' +
      (d.breaks && d.breaks.length ? '<rowBreaks count="' + d.breaks.length + '" manualBreakCount="' + d.breaks.length + '">' + d.breaks.map(function (n) { return '<brk id="' + n + '" max="16383" man="1"/>'; }).join('') + '</rowBreaks>' : '') + (d.img ? '<drawing r:id="rId1"/>' : '') + '</worksheet>';
  });
  var files = [];
  files.push({ name: '[Content_Types].xml', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    docs.map(function (d, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
    docs.map(function (d, i) { return d.img ? '<Override PartName="/xl/drawings/drawing' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''; }).join('') +
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
  var XH = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n', RN = 'http://schemas.openxmlformats.org/package/2006/relationships', RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  docs.forEach(function (d, i) {
    if (!d.img) return; var n = i + 1, g = d.img;
    files.push({ name: 'xl/worksheets/_rels/sheet' + n + '.xml.rels', xml: XH + '<Relationships xmlns="' + RN + '"><Relationship Id="rId1" Type="' + RT + 'drawing" Target="../drawings/drawing' + n + '.xml"/></Relationships>' });
    files.push({ name: 'xl/drawings/drawing' + n + '.xml', xml: XH + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:oneCellAnchor><xdr:from><xdr:col>' + g.col + '</xdr:col><xdr:colOff>' + g.colOff + '</xdr:colOff><xdr:row>' + g.row + '</xdr:row><xdr:rowOff>' + g.rowOff + '</xdr:rowOff></xdr:from><xdr:ext cx="' + g.cx + '" cy="' + g.cy + '"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="stamp"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + g.cx + '" cy="' + g.cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>' });
    files.push({ name: 'xl/drawings/_rels/drawing' + n + '.xml.rels', xml: XH + '<Relationships xmlns="' + RN + '"><Relationship Id="rId1" Type="' + RT + 'image" Target="../media/image' + n + '.' + g.ext + '"/></Relationships>' });
    files.push({ name: 'xl/media/image' + n + '.' + g.ext, b64: g.b64 });
  });
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
