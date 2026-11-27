/**
 * Code.gs —— 員林農工材料單系統（Google Apps Script 網頁應用程式）
 * 綁定在資料庫試算表上，資料都放在試算表的分頁裡。
 * 部署方式：執行身分「我」；存取權「學校網域內的所有人」（選項寫作「員林農工的所有使用者」）。誰能看資料，還要再由「使用者」分頁決定。
 */

var TZ = 'Asia/Taipei';

/* ---------------- 新架構：畫面放在 GitHub Pages，這裡只負責資料 ----------------
 * 部署方式：執行身分「我」；存取權「所有人」。老師在網頁上用 Google 登入，網頁把登入憑證（ID token）
 * 連同要呼叫的函式名稱一起 POST 過來；這裡先驗證憑證、取得信箱，再看信箱有沒有列在「使用者」分頁。 */
var CLIENT_ID_ = '464168761979-8jfd9ut1fjpst60hqlsva6peopvol2n6.apps.googleusercontent.com';
var SITE_URL_ = 'https://yingkai0113-web.github.io/prep/';
var REQ_AS_ = '';          // 技士「代為操作」某位老師時，網頁帶來的老師信箱（只有技士才會生效）
var REQ_EMAIL_ = null;     // 這一次請求驗證過的登入信箱（小寫）

function doGet() {
  return HtmlService.createHtmlOutput('<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<div style="font:16px sans-serif;padding:32px;max-width:520px;margin:auto"><h2>員林農工材料單系統</h2>' +
    '<p>請從這個網址使用：<br><a href="' + SITE_URL_ + '">' + SITE_URL_ + '</a></p></div>')
    .setTitle('員林農工材料單系統');
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* 驗證 Google 登入憑證，回傳小寫信箱；失敗丟出帶 AUTH 標記的錯誤。驗證過的憑證快取 5 分鐘，少打一次 Google。 */
function verifyToken_(token) {
  token = String(token || '');
  if (!token) throw new Error('AUTH:請先用 Google 登入。');
  var cache = CacheService.getScriptCache(), key = 'tk' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  var hit = cache.get(key);
  if (hit) return hit;
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('AUTH:登入已逾時，請重新登入。');
  var info = JSON.parse(res.getContentText());
  if (info.aud !== CLIENT_ID_) throw new Error('AUTH:登入憑證不是給這個系統的。');
  if (String(info.email_verified) !== 'true' || !info.email) throw new Error('AUTH:這個 Google 帳號的信箱沒有通過驗證。');
  var exp = Number(info.exp) || 0, left = exp - Math.floor(Date.now() / 1000);
  if (left <= 10) throw new Error('AUTH:登入已逾時，請重新登入。');
  var email = String(info.email).toLowerCase();
  cache.put(key, email, Math.min(300, left));
  return email;
}

/* 網頁用 POST 呼叫：body 是 JSON 字串 {fn, args, token}。只允許名稱 api 開頭的函式。 */
function doPost(e) {
  var t0_ = Date.now();
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var name = String(req.fn || '');
    if (!/^api[A-Z]\w*$/.test(name)) throw new Error('不明的呼叫：' + name);
    var fn = globalThis[name];
    if (typeof fn !== 'function') throw new Error('不明的呼叫：' + name);
    REQ_EMAIL_ = verifyToken_(req.token);
    REQ_AS_ = String(req.as || '').toLowerCase().trim();
    try { var sp = SpreadsheetApp.getActiveSpreadsheet(); if (sp.getSpreadsheetTimeZone() !== TZ) sp.setSpreadsheetTimeZone(TZ); } catch (tzErr) {}   // 複製到別的帳號時，試算表時區會變成預設的美國時區，日期會差一天
    var out = fn.apply(null, Array.isArray(req.args) ? req.args : []);
    return json_({ ok: true, data: out === undefined ? null : out, ms: Date.now() - t0_ });
  } catch (err) {
    var msg = String((err && err.message) || err);
    var auth = msg.indexOf('AUTH:') === 0;
    return json_({ ok: false, code: auth ? 'AUTH' : '', error: auth ? msg.slice(5) : msg });
  } finally {
    REQ_EMAIL_ = null; REQ_AS_ = '';
  }
}
function curEmail_() {
  return REQ_EMAIL_ !== null ? REQ_EMAIL_ : String(Session.getActiveUser().getEmail() || '').toLowerCase();
}

/* ---------------- 讀寫試算表 ---------------- */
var SS_ = null, TRIAL_ = false;
/* 試用頁面：管理者開了之後，所有人都改用另一份「試用」試算表（複製自正式資料），正式資料完全不動 */
function ss_() {
  if (SS_) return SS_;
  try {
    var pr = PropertiesService.getScriptProperties(), id = pr.getProperty('TRIAL_ID');
    if (id && pr.getProperty('TRIAL_ON') === '1') { SS_ = SpreadsheetApp.openById(id); TRIAL_ = true; return SS_; }
  } catch (e) { TRIAL_ = false; }
  return (SS_ = SpreadsheetApp.getActiveSpreadsheet());
}

var RT_ = {}, RT_OK_ = { '設定': 1, '使用者': 1, '排課': 1, '教學進度表': 1, '教學進度內容': 1, '應有進度表': 1, '產品': 1, '配方明細': 1, '器具': 1, '自創材料單': 1, '預設材料單修改': 1, '材料單分類指定': 1, '名稱對照': 1 };   // 這幾個分頁：同一次請求讀過就不再重讀，跨請求也用快取（最多 5 分鐘；系統自己寫入時會立刻作廢）
var RT_VER_ = null, RT_TTL_ = 300, RT_SV_ = null;
var RT_CATSHEETS_ = { '產品': 1, '配方明細': 1, '器具': 1, '自創材料單': 1, '預設材料單修改': 1, '材料單分類指定': 1 };   // 材料單目錄是由這幾張分頁算出來的
function rtVer_() {
  if (RT_VER_ === null) { try { RT_VER_ = CacheService.getScriptCache().get('rtver') || '0'; } catch (e) { RT_VER_ = 'x' + Date.now(); } }
  return RT_VER_;
}
/* 每張分頁各有自己的版本號：只改到哪一張，就只讓那一張的快取作廢，其餘照用 */
function rtSV_(name) {
  if (RT_SV_ === null) {
    RT_SV_ = {};
    try {
      var keys = Object.keys(RT_OK_).map(function (n) { return 'rtv|' + n; }), got = CacheService.getScriptCache().getAll(keys);
      Object.keys(RT_OK_).forEach(function (n) { RT_SV_[n] = got['rtv|' + n] || '0'; });
    } catch (e) { RT_SV_ = {}; Object.keys(RT_OK_).forEach(function (n) { RT_SV_[n] = 'x' + Date.now(); }); }
  }
  return RT_SV_[name] || '0';
}
/* rtClear_()＝全部作廢；rtClear_(['排課', …])＝只作廢列出的這幾張分頁 */
function rtClear_(names) {
  if (names && names.length) {
    var put = {}, hitCat = false;
    names.forEach(function (n) { delete RT_[n]; if (RT_CATSHEETS_[n]) hitCat = true; });
    if (hitCat) { CAT_ = null; PL_ = null; }
    try {
      rtSV_('設定');
      names.forEach(function (n) { var v = String(Date.now()) + Math.floor(Math.random() * 1000); RT_SV_[n] = v; put['rtv|' + n] = v; });
      CacheService.getScriptCache().putAll(put, 21600);
    } catch (e) { rtClear_(); }
    return;
  }
  RT_ = {}; CAT_ = null; PL_ = null; RT_SV_ = null;
  try { RT_VER_ = String(Date.now()) + Math.floor(Math.random() * 1000); CacheService.getScriptCache().put('rtver', RT_VER_, 21600); } catch (e) { RT_VER_ = 'x' + Date.now(); }
}
function rtJson_(rows) { return JSON.stringify(rows, function (k, v) { return (this[k] instanceof Date) ? { __d: this[k].getTime() } : v; }); }
function rtParse_(txt) { return JSON.parse(txt, function (k, v) { return (v && typeof v === 'object' && v.__d !== undefined && Object.keys(v).length === 1) ? new Date(v.__d) : v; }); }
function rtCacheGet_(name) {
  ss_(); if (TRIAL_) return null;                                                // 試用頁面不用跨請求快取（不跟正式資料混在一起）
  try {
    var c = CacheService.getScriptCache(), base = 'rt|' + rtVer_() + '|' + rtSV_(name) + '|' + name, n = Number(c.get(base + '|n'));
    if (!n) return null;
    var keys = []; for (var i = 0; i < n; i++) keys.push(base + '|' + i);
    var got = c.getAll(keys), txt = '';
    for (var j = 0; j < n; j++) { if (got[keys[j]] === undefined || got[keys[j]] === null) return null; txt += got[keys[j]]; }
    return rtParse_(txt);
  } catch (e) { return null; }
}
function rtCachePut_(name, rows) {
  ss_(); if (TRIAL_) return;
  try {
    var c = CacheService.getScriptCache(), base = 'rt|' + rtVer_() + '|' + rtSV_(name) + '|' + name, txt = rtJson_(rows), size = 25000, put = {}, n = Math.ceil(txt.length / size) || 1;
    if (n > 40) return;
    for (var i = 0; i < n; i++) put[base + '|' + i] = txt.slice(i * size, (i + 1) * size);
    put[base + '|n'] = String(n);
    c.putAll(put, RT_TTL_);
  } catch (e) {}
}
function readTable_(name) {
  if (!RT_OK_[name]) return readTableRaw_(name);
  var rows = RT_[name];
  if (!rows) { rows = rtCacheGet_(name); if (!rows) { rows = readTableRaw_(name); rtCachePut_(name, rows); } RT_[name] = rows; }
  return rows.map(function (o) { return Object.assign({}, o); });
}
function readTableRaw_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('試算表裡找不到分頁「' + name + '」');
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  var head = v[0].map(String), out = [];
  for (var i = 1; i < v.length; i++) {
    var row = v[i], empty = true, o = {};
    for (var j = 0; j < head.length; j++) {
      if (row[j] !== '') empty = false;
      o[head[j]] = row[j] === '' ? null : row[j];
    }
    if (!empty) out.push(o);
  }
  return out;
}
function num_(v) { if (v === null || v === '' || v === undefined) return null; var n = Number(v); return isNaN(n) ? null : n; }
function str_(v) { return v === null || v === undefined ? '' : String(v); }
function dateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return str_(v).slice(0, 10);
}

/* 只要「產品名稱、份量、預設組數」的輕量版（不讀幾千列的配方明細），進度表畫面用這個，比 loadCatalog_ 快很多 */
var PL_ = null;
function loadProductsLite_() {
  if (CAT_) return CAT_.products;
  if (PL_) return PL_;
  var prods = {};
  readTable_('產品').forEach(function (r) {
    var pid = str_(r['產品編號']); if (!pid) return;
    prods[pid] = { pid: pid, sem: str_(r['學期']), course: str_(r['來源課程']), cls: '', title: str_(r['實習項目']), serving: str_(r['份量說明']), note: str_(r['備註']), dsets: num_(r['預設組數']) || 1 };
  });
  readCustom_().forEach(function (cu) { prods[cu.pid] = L_customToCatalog(cu).product; });
  readOverrides_().forEach(function (o) {
    var p = prods[o.pid]; if (!p || p.custom) return;
    p.hidden = !!o.hidden;
    if (o.items && o.items.length) { p.modified = true; if (o.title) p.title = o.title; p.serving = o.serving == null ? p.serving : o.serving; if (o.dsets) p.dsets = o.dsets; }
  });
  PL_ = prods;
  return PL_;
}
var CAT_ = null;
function loadCatalog_() {
  if (CAT_) return CAT_;
  CAT_ = loadCatalogRaw_();
  return CAT_;
}
function loadCatalogRaw_() {
  var P = readTable_('產品').map(function (r) {
    return { pid: str_(r['產品編號']), sem: str_(r['學期']), course: str_(r['來源課程']), cls: '',
             title: str_(r['實習項目']), serving: str_(r['份量說明']), note: str_(r['備註']), dsets: num_(r['預設組數']) || 1 };
  });
  var I = readTable_('配方明細').map(function (r) {
    // 顯示、印在申請單、技士加總，全部用統一後的「材料名稱」（舊版試算表叫「標準材料」，也認得）
    var name = str_(r['材料名稱'] || r['標準材料'] || r['原寫法']), orig = str_(r['原表寫法'] || r['原寫法']), note = str_(r['備註']);
    if (orig.indexOf('飾：') === 0 && note.indexOf('裝飾用') < 0) note = '裝飾用' + (note ? '；' + note : '');
    if (name === '奶油') name = '無鹽奶油';                                   // 統一名稱：只寫「奶油」的都當無鹽奶油
    return { id: str_(r['列ID']), pid: str_(r['產品編號']), raw: name, std: name,
             per: num_(r['每組數量']), unit: str_(r['單位']), sets: num_(r['預設組數']), total: num_(r['固定總量']),
             procure: str_(r['原表總量欄的採購寫法']), kind: str_(r['類型']), note: note };
  });
  var ptitle = {}; P.forEach(function (x) { ptitle[x.pid] = x.title; });
  var RENAME = [                                                                          // 統一成精確的材料名稱：[原名稱, 產品名稱要包含, 新名稱]（產品名稱 '' = 全部產品）
    ['蔥', '', '青蔥'], ['鮮奶油', '', '動物性鮮奶油'],
    ['轉化糖漿', '黑糖米果', '中點轉化糖漿'], ['轉化糖漿', '指形小西餅', '西點轉化糖漿'],
    ['紅豆餡', '紅豆餡甜麵包', '紅豆粒餡'], ['紅豆餡', '山形、紅豆', '紅豆粒餡'], ['紅豆餡', '銅鑼燒', '紅豆粒餡'], ['紅豆餡', '發糕', '含油紅豆餡']
  ];
  var SAME = {                                                                            // 同一種材料的不同寫法，統一成一個名稱（統計才不會分成兩個）
    '絞肉': '豬絞肉', '背脂': '豬背脂', '花生': '生花生', '醋': '白醋', '蔥(支)': '青蔥', '蔥花': '青蔥',
    '紅蘿蔔(絲)': '紅蘿蔔', '蘋果 (富士)': '蘋果', '蘋果(富士)': '蘋果', '黃豆(乾重)': '黃豆',
    '中筋粉': '中筋麵粉', '中粉': '中筋麵粉', '低筋粉': '低筋麵粉', '低粉': '低筋麵粉', '高粉': '高筋麵粉',
    '酵母': '即溶酵母', '乾酵母': '即溶酵母', '快發酵母': '即溶酵母', '快速酵母': '即溶酵母',
    '砂糖': '細砂糖', '水麥芽糖': '水麥芽', '麥芽糖': '水麥芽', '蛋': '全蛋', '雞蛋': '全蛋',
    '蛋白(液蛋白)': '蛋白', '蛋黃(液蛋)': '蛋黃', '蛋黃(液蛋黃)': '蛋黃', '食鹽': '鹽', '白胡椒': '白胡椒粉',
    '黑胡椒': '黑胡椒粉', '粗黑胡椒粉': '黑胡椒粉', '胡椒粉': '黑胡椒粉', '小蘇打': '小蘇打粉', '小蘇打(配鹼水用)': '小蘇打粉',
    '檸檬酸(食品級)': '檸檬酸', '生白芝麻': '白芝麻', '玉米粉': '玉米澱粉', '磷酸鹽': '聚合磷酸鹽', '空罐': '空罐含蓋',
    '碎核桃': '核桃', '牛奶': '鮮奶', '果醬': '草莓果醬', '玻璃罐裝草莓果醬': '草莓果醬'
  };
  I.forEach(function (it) { var k = String(it.std || '').trim(); if (SAME[k]) it.raw = it.std = SAME[k]; });
  I.forEach(function (it) {
    for (var q = 0; q < RENAME.length; q++) {
      var rn = RENAME[q];
      if (it.std === rn[0] && (!rn[1] || String(ptitle[it.pid] || '').indexOf(rn[1]) >= 0)) { it.raw = it.std = rn[2]; break; }
    }
  });
  var T = readTable_('器具').map(function (r) {
    return { pid: str_(r['產品編號']), who: str_(r['對象']), name: str_(r['器具']), qty: str_(r['數量（原文）']) };
  });
  readCustom_().forEach(function (cu) {
    var x = L_customToCatalog(cu);
    P.push(x.product); x.items.forEach(function (it) { I.push(it); }); x.tools.forEach(function (t) { T.push(t); });
  });
  var cat = L_buildCatalog(P, I, T);
  L_applyTemplateOverrides(cat, readOverrides_());
  cat.classes = classes_();
  cat.courses = courses_();
  cat.nameMap = nameMap_();
  cat.categories = categories_();
  cat.gradeNames = gradeNames_();
  var cm = readCatMap_();
  Object.keys(cat.products).forEach(function (id) { var v = cm[id]; cat.products[id].category = v && (cat.categories.indexOf(v) >= 0 || GRADE_CATS.indexOf(v) >= 0) ? v : ''; });
  return cat;
}

function setting_(key, fallback) {
  var rows = readTable_('設定');
  for (var i = 0; i < rows.length; i++) if (rows[i]['項目'] === key && rows[i]['值'] !== null) return rows[i]['值'] instanceof Date ? Utilities.formatDate(rows[i]['值'], TZ, 'yyyy-MM-dd') : str_(rows[i]['值']);
  return fallback;
}

/* 寫一個「設定」值（沒有就新增一列） */
function setSetting_(key, value) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = ss_().getSheetByName('設定');
    if (!sh) throw new Error('試算表裡找不到分頁「設定」');
    var values = sh.getDataRange().getValues(), done = false;
    for (var i = 1; i < values.length; i++) {
      if (str_(values[i][0]) === key) { sh.getRange(i + 1, 2, 1, 1).setValues([[value]]); done = true; break; }
    }
    if (!done) sh.getRange(values.length + 1, 1, 1, 2).setValues([[key, value]]);
    rtClear_();
  } finally { rtClear_(); lock.releaseLock(); }
}

/* 後台切換學年學期（例如 115-1 → 115-2）。舊學期的排課紀錄都留著，只是老師打開來是新學期的空白。 */
function apiSetTerm(term) {
  requireAdmin_();
  var t = String(term || '').trim();
  if (!/^\d{3}-[12]$/.test(t)) throw new Error('學年學期的格式是「民國年-學期」，例如 115-2。');
  setSetting_('目前學年學期', t);
  return { term: t };
}

/* 班級清單放在「設定」分頁（日間部班級、夜間部班級），沒填就用預設 */
function classes_() {
  var out = {};
  ['日間部', '夜間部'].forEach(function (d) {
    var v = setting_(d + '班級', ''), list = v ? v.split(/[、,，\s]+/).filter(Boolean) : [];
    out[d] = list.length ? list : L_DEFAULT_CLASSES[d];
  });
  return out;
}
/* 班級名稱：國中技藝班一週可能有好幾個國中，每個國中一個班（用學校名稱）。技士、科主任、管理者可以直接新增、刪掉不用的。 */
function apiClassAdd(dept, name) {
  requireAdmin_();
  if (['日間部', '夜間部'].indexOf(dept) < 0) throw new Error('請選日間部或夜間部。');
  name = L_safeText(name, 10);
  if (!name) throw new Error('請填班級名稱，例如學校名稱：大村國中。');
  var cl = classes_();
  if (cl['日間部'].indexOf(name) >= 0 || cl['夜間部'].indexOf(name) >= 0) throw new Error('「' + name + '」已經有了。');
  setSetting_(dept + '班級', cl[dept].concat([name]).join('、'));
  return { classes: classes_() };
}
function apiClassRemove(dept, name) {
  requireAdmin_();
  if (['日間部', '夜間部'].indexOf(dept) < 0) throw new Error('請選日間部或夜間部。');
  name = String(name || '');
  var cl = classes_();
  if (cl[dept].indexOf(name) < 0) throw new Error('找不到這個班級。');
  if (requiredAll_().some(function (e) { return e.classes.some(function (x) { return x.cls === name; }); })) throw new Error('「' + name + '」還在「每學期要有哪些進度表」的清單裡，請先從清單拿掉。');
  var used = readTable_('教學進度表').some(function (r) { return jparse_(r['班級'], []).some(function (x) { return x.cls === name; }); }) || readPlans_().some(function (e) { return e.cls === name; });
  if (used) throw new Error('已經有進度表或材料單用過「' + name + '」，不能刪掉。');
  setSetting_(dept + '班級', cl[dept].filter(function (x) { return x !== name; }).join('、'));
  return { classes: classes_() };
}
/* 課程清單放在「設定」分頁：日間部課程、夜間部課程（沒填就用預設）。舊版那一列「課程」不再使用，可以刪掉。 */
function courses_() {
  var out = {};
  ['日間部', '夜間部'].forEach(function (d) {
    var v = setting_(d + '課程', ''), list = v ? v.split(/[、,，\s]+/).filter(Boolean) : [];
    out[d] = list.length ? list : L_DEFAULT_COURSES[d];
  });
  return out;
}
/* 自創材料單的材料名稱，盡量對到標準名稱，技士加總才不會分成兩行 */
function nameMap_() {
  var m = {};
  try { readTable_('名稱對照').forEach(function (r) { if (r['原寫法'] && r['標準名稱']) m[str_(r['原寫法'])] = str_(r['標準名稱']); }); } catch (e) {}
  return m;
}

/* ---------------- 自創材料單 ---------------- */
var CUSTOM_HEAD = ['自創ID', '老師信箱', '名稱', '份量說明', '預設組數', '材料', '器具', '共用', '已刪除', '更新時間'];
function customSheet_() {
  var sh = ss_().getSheetByName('自創材料單');
  if (!sh) { sh = ss_().insertSheet('自創材料單'); sh.getRange(1, 1, 1, CUSTOM_HEAD.length).setValues([CUSTOM_HEAD]); }
  return sh;
}
function readCustom_() {
  var rows0; try { rows0 = readTable_('自創材料單'); } catch (e) { return []; }                // 分頁不存在就當沒有（有快取時完全不碰試算表）
  var names = teacherNames_();
  return rows0.map(function (r) {
    var items = [], tools = [];
    try { items = JSON.parse(r['材料'] || '[]'); } catch (e) {}
    try { tools = JSON.parse(r['器具'] || '[]'); } catch (e) {}
    var del = r['已刪除'];
    var owner = str_(r['老師信箱']).toLowerCase();
    return { pid: str_(r['自創ID']), owner: owner, ownerName: names[owner] || owner.split('@')[0], shared: str_(r['共用']) === '是', title: str_(r['名稱']), serving: str_(r['份量說明']),
             dsets: num_(r['預設組數']) || 4, items: items, tools: tools, deleted: del === true || str_(del) === '是' || str_(del).toUpperCase() === 'TRUE' };
  });
}

/* ---------------- 預設材料單的修改（管理者） ---------------- */
var OVR_HEAD = ['產品編號', '名稱', '份量說明', '預設組數', '材料', '器具', '停用', '更新者', '更新時間'];
function ovrSheet_() {
  var sh = ss_().getSheetByName('預設材料單修改');
  if (!sh) { sh = ss_().insertSheet('預設材料單修改'); sh.getRange(1, 1, 1, OVR_HEAD.length).setValues([OVR_HEAD]); }
  return sh;
}
function readOverrides_() {
  var rows0; try { rows0 = readTable_('預設材料單修改'); } catch (e) { return []; }
  return rows0.map(function (r) {
    var items = [], tools = [];
    try { items = JSON.parse(r['材料'] || '[]'); } catch (e) {}
    try { tools = JSON.parse(r['器具'] || '[]'); } catch (e) {}
    return { pid: str_(r['產品編號']), title: str_(r['名稱']), serving: str_(r['份量說明']), dsets: num_(r['預設組數']), items: items, tools: tools,
             hidden: str_(r['停用']) === '是' };
  });
}
function requireAdmin_() {
  var u = whoami_();
  if (!isStaff_(u)) throw new Error('只有技士、科主任或管理者可以使用後台。');
  return u;
}
/* 寫入（新增或更新）某張預設材料單的修改，保留沒傳的欄位 */
function writeOverride_(me, pid, patch) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = ovrSheet_(), values = sh.getDataRange().getValues(), idx = -1;
    for (var i = 1; i < values.length; i++) if (str_(values[i][0]) === pid) { idx = i; break; }
    var cur = idx >= 0 ? values[idx] : [pid, '', '', '', '', '', '', '', ''];
    var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
    var row = [pid,
      patch.title !== undefined ? patch.title : cur[1], patch.serving !== undefined ? patch.serving : cur[2], patch.dsets !== undefined ? patch.dsets : cur[3],
      patch.items !== undefined ? JSON.stringify(patch.items) : cur[4], patch.tools !== undefined ? JSON.stringify(patch.tools) : cur[5],
      patch.hidden !== undefined ? (patch.hidden ? '是' : '') : cur[6], me.email, now];
    if (idx < 0) idx = Math.max(values.length, 1);
    sh.getRange(idx + 1, 1, 1, OVR_HEAD.length).setValues([row]);
  } finally { rtClear_(); lock.releaseLock(); }
}

var PLAN_HEAD = ['排課ID', '學年學期', '老師信箱', '產品編號', '上課日期', '部別', '班級', '課程', '組數', '份量倍率', '原本每組', '改成每組', '份量單位', '調整', '器具', '增加材料', '刪除材料', '產品名稱', '不加總改數量', '進度表', '組別', '待確認', '建立時間', '最後修改', '草稿內容'];

/* 排課的「器具」欄：空的 = 用模板的；有內容 = 老師改過的（JSON） */
function toolsCell_(v) {
  if (!v) return null;
  try { var t = JSON.parse(v); return Array.isArray(t) ? t : null; } catch (e) { return null; }
}

/* 「不加總改數量」欄：{材料列ID: {mode, per/total/text, unit}}（JSON） */
function convCell_(v) {
  if (!v) return {};
  try { var o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
}
/* 技士、科主任、管理者看到的、匯出的，都只算老師「確認送出」的（進度表排好但老師還沒確認的不算） */
function readSent_() { return readPlans_().filter(function (e) { return !e.draft; }); }
function readPlans_() {
  return readTable_('排課').map(function (r) {
    var ov = {};
    try { ov = r['調整'] ? JSON.parse(r['調整']) : {}; } catch (e) { ov = {}; }
    var old = str_(r['儲存時間']);                                   // 舊版試算表只有「儲存時間」這一欄
    return { id: str_(r['排課ID']), term: str_(r['學年學期']), teacher: str_(r['老師信箱']).toLowerCase(), pid: str_(r['產品編號']),
             date: dateStr_(r['上課日期']), dept: str_(r['部別']) || '日間部', cls: str_(r['班級']), course: str_(r['課程']), sets: num_(r['組數']) || 1,
             scale: num_(r['份量倍率']) || 1, yFrom: num_(r['原本每組']), yTo: num_(r['改成每組']), yUnit: str_(r['份量單位']), tools: toolsCell_(r['器具']), extra: toolsCell_(r['增加材料']) || [], omit: toolsCell_(r['刪除材料']) || [], title: str_(r['產品名稱']), conv: convCell_(r['不加總改數量']), sid: str_(r['進度表']), group: str_(r['組別']), draft: str_(r['待確認']) === '是', ov: ov,
             pending: jparse_(r['草稿內容'], null), created: str_(r['建立時間']) || old, updated: str_(r['最後修改']) || old };
  });
}

/* 一堂課的內容「指紋」：內容沒變就不算修改 */
function planSig_(e) {
  var ov = e.ov || {}, ovp = Object.keys(ov).sort().map(function (k) { return [k, ov[k]]; });
  return JSON.stringify([e.pid, e.date, e.dept, e.cls, e.course, Number(e.sets), Number(e.scale) || 1, e.yFrom || null, e.yTo || null, e.yUnit || '', ovp, e.tools || null, e.extra || [], (e.omit || []).slice().sort(), e.title || '', Object.keys(e.conv || {}).sort().map(function (k) { return [k, e.conv[k]]; })]);
}
function planRow_(e, created, updated) {
  return [e.id, e.term, e.teacher, e.pid, e.date, e.dept, e.cls, e.course, e.sets, e.scale || 1, e.yFrom === null || e.yFrom === undefined ? '' : e.yFrom,
          e.yTo === null || e.yTo === undefined ? '' : e.yTo, e.yUnit || '', JSON.stringify(e.ov || {}), e.tools ? JSON.stringify(e.tools) : '', (e.extra && e.extra.length) ? JSON.stringify(e.extra) : '', (e.omit && e.omit.length) ? JSON.stringify(e.omit) : '', e.title || '', Object.keys(e.conv || {}).length ? JSON.stringify(e.conv) : '', e.sid || '', e.group || '', e.draft ? '是' : '', created, updated, e.pending ? JSON.stringify(e.pending) : ''];
}

/* 只換掉「這位老師、這個學期」的資料，別人的不動。內容有變的課，「最後修改」才會更新，技士看得到「已修改」。 */
function writePlans_(email, term, entries) {
  var sh = ss_().getSheetByName('排課');
  if (!sh) throw new Error('試算表裡找不到分頁「排課」');
  var plans = readPlans_(), oldById = {};
  var others = plans.filter(function (e) {
    var mine = e.teacher === email && e.term === term;
    if (mine) oldById[e.id] = e;
    return !mine;
  });
  var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  var rows = others.map(function (e) { return planRow_(e, e.created, e.updated); });
  entries.forEach(function (e) {
    var id = e.id || Utilities.getUuid().slice(0, 8), old = oldById[id];
    var full = { id: id, term: term, teacher: email, pid: e.pid, date: e.date, dept: e.dept, cls: e.cls, course: e.course, sets: e.sets, scale: e.scale,
                 yFrom: e.yFrom, yTo: e.yTo, yUnit: e.yUnit, ov: e.ov, tools: e.tools, extra: e.extra, omit: e.omit, title: e.title, conv: e.conv,
                 sid: e.sid || '', group: e.group || '', draft: !!e.draft, pending: e.pending || null };
    var created = old ? (old.created || old.updated || now) : now;
    var updated = old ? (planSig_(old) === planSig_(full) ? (old.updated || created) : now) : now;
    if (old && old.draft && !full.draft) { created = now; updated = now; }              // 進度表排的課第一次送出，算「新的」，不算「已修改」
    rows.push(planRow_(full, created, updated));
  });
  flushPlanRows_(sh, rows);
}
function flushPlanRows_(sh, rows) {
  sh.getRange(1, 1, 1, PLAN_HEAD.length).setValues([PLAN_HEAD]);      // 標題列補齊（舊版試算表會自動升級）
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, PLAN_HEAD.length).clearContent();
  if (rows.length) {
    sh.getRange(2, 5, rows.length, 1).setNumberFormat('@');          // 日期當文字存，避免被轉成日期格式
    sh.getRange(2, 1, rows.length, PLAN_HEAD.length).setValues(rows);
  }
  rtClear_(['排課']);
}


/* ---------------- 誰在用 ---------------- */
function whoami_() {
  var email = curEmail_();
  if (!email) throw new Error('抓不到你的帳號。請重新用 Google 登入。');
  var users = readTable_('使用者'), me = null;
  users.forEach(function (u) { if (str_(u['信箱']).toLowerCase().trim() === email) me = u; });
  // 沒有被編進「使用者」分頁的帳號，一律不能用
  if (!me) throw new Error('這個帳號（' + email + '）還沒有被加入系統，不能使用。請改用學校帳號登入，或請管理者在「後台 → 使用者」把你的信箱加進來。');
  var rawRole = str_(me['角色']).trim();
  if (rawRole === '主任') rawRole = '科主任';                       // 寫「主任」也可以，一樣當科主任
  var role = ['老師', '技士', '科主任', '管理者'].indexOf(rawRole) >= 0 ? rawRole : '老師';
  var self = { email: email, name: me['姓名'] ? str_(me['姓名']) : email.split('@')[0], role: role };
  /* 技士可以「代為操作」任何一位老師：之後所有動作都用那位老師的身分做（排課、確認、匯出…），但不受「老師送單已關閉」限制；管理功能用不了。 */
  if (REQ_AS_ && role === '技士' && REQ_AS_ !== email) {
    var tgt = null; users.forEach(function (u) { if (str_(u['信箱']).toLowerCase().trim() === REQ_AS_) tgt = u; });
    if (tgt) return { email: REQ_AS_, name: tgt['姓名'] ? str_(tgt['姓名']) : REQ_AS_.split('@')[0], role: '老師', actBy: email, actByName: self.name };
  }
  return self;
}

/* 網頁一打開先問這個：判斷是不是學校帳號、有沒有被編進系統，不是的話網頁會出現「切換帳號」按鈕。只回答自己的帳號，不洩漏其他資料。 */
function apiHello() {
  var email = curEmail_(), url = SITE_URL_, listed = false;
  if (email) readTable_('使用者').forEach(function (u) { if (str_(u['信箱']).toLowerCase().trim() === email) listed = true; });
  return { email: email, listed: listed, appUrl: url };
}

/* 管理權限：技士、科主任、管理者 —— 看每週總量、後台（改預設材料單、共用材料單、換學期）、刪除老師開錯的課。
 * 三個身分也都能像老師一樣排課備料。 */
function isStaff_(u) { return u.role === '技士' || u.role === '科主任' || u.role === '管理者'; }
function requireStaff_() {
  var u = whoami_();
  if (!isStaff_(u)) throw new Error('只有技士、科主任或管理者可以使用。');
  return u;
}

/* ---------------- 給網頁呼叫的函式 ---------------- */
/* 老師自己看到的是「工作中的版本」：匯出過的課，之後改了但還沒匯出的部分（草稿內容）會疊上去，標 pend。
 * 技士、科主任、管理者看到的、匯出的，永遠是最後一次匯出的那一版。 */
var PEND_FIELDS = ['date', 'sets', 'scale', 'yFrom', 'yTo', 'yUnit', 'ov', 'tools', 'extra', 'omit', 'title', 'conv'];
var PEND_FIELDS_FREE = PEND_FIELDS.concat(['pid', 'dept', 'cls', 'course']);
function pickPending_(e) { var o = {}; (e.sid ? PEND_FIELDS : PEND_FIELDS_FREE).forEach(function (k) { o[k] = e[k]; }); return o; }
function workingCopies_(list) {
  var out = [];
  list.forEach(function (e) {
    if (!e.pending) { out.push(e); return; }
    if (e.pending.del) return;
    var w = Object.assign({}, e); (e.sid ? PEND_FIELDS : PEND_FIELDS_FREE).forEach(function (k) { if (e.pending[k] !== undefined) w[k] = e.pending[k]; });
    w.pend = true; out.push(w);
  });
  return out;
}
function apiBootstrap(asEmail) {
  var me = whoami_();
  if (asEmail && isStaff_(me)) me = { email: String(asEmail).toLowerCase().trim(), role: '老師', name: teacherNames_()[String(asEmail).toLowerCase().trim()] || String(asEmail).split('@')[0] };      // 老師模式（預覽）：看那位老師的材料單
  var term = setting_('目前學年學期', ''), cat = loadCatalog_();
  var all = readPlans_(), mine = all.filter(function (e) { return e.teacher === me.email && e.term === term; });
  var admin = isStaff_(me), hist = {};
  all.forEach(function (e) { if (e.teacher === me.email && e.term !== term && !e.draft && L_customized(e)) hist[e.pid] = (hist[e.pid] || 0) + 1; });
  return { user: me, term: term, catalog: L_catalogForClient(cat, me.email, mine.map(function (e) { return e.pid; }), admin), entries: workingCopies_(mine), hist: hist,
           adminUrl: '', open: submissionOpen_(), openMe: !teacherLocked_(me), openList: openTeachers_(), openNote: setting_('開放老師送單更新', ''), extraOpen: extraOpen_(), extraNote: setting_('開放額外材料單更新', ''), trial: (ss_(), TRIAL_) };
}

/* mode：'draft' = 只存草稿（技士看不到）；'sched' = 匯出教學進度表的課；'extra' = 匯出額外材料單；不給 = 全部匯出。
 * 只有「匯出」才算送給技士；沒匯出的，不管做到哪裡，技士都看不到、也不會算進總量。 */
function apiSavePlan(entries, mode) {
  var me = whoami_(), term = setting_('目前學年學期', ''), cat = loadCatalog_();
  if (teacherLocked_(me)) throw new Error('目前已關閉老師送出材料單，不能新增或修改。需要修改請聯絡技士、科主任或管理者。');
  if (!entries || entries.length > 800) throw new Error('一次最多 800 堂課。');
  var lock = LockService.getScriptLock(), clean = [];
  lock.waitLock(30000);
  try {
    var mineOld = {};
    readPlans_().forEach(function (e) { if (e.teacher === me.email && e.term === term) mineOld[e.id] = e; });
    var seen = {};
    entries.forEach(function (raw) {
      var old = raw && raw.id ? mineOld[raw.id] : null;
      if (old && old.sid) {                                       // 進度表排的課：產品、班級、組別跟著進度表，其他（日期、組數、材料…）老師可以改
        var e = L_cleanEntry(Object.assign({}, raw, { pid: old.pid, cls: old.cls, course: old.course, sid: old.sid, dept: old.dept || raw.dept }), cat);
        e.id = old.id; e.sid = old.sid; e.group = old.group; seen[old.id] = 1; clean.push(e);
      } else { var e2 = L_cleanEntry(Object.assign({}, raw, { id: old ? raw.id : '' }), cat, true); e2.sid = ''; e2.group = ''; clean.push(e2); }     // 額外材料單：課程名稱（活動名稱）自己填、班級可以不填
    });
    Object.keys(mineOld).forEach(function (id) {                   // 進度表排的課，畫面上沒帶到的（例如剛排好、網頁還沒更新）不會被刪掉
      var o = mineOld[id];
      if (o.sid && !seen[id]) clean.push({ id: o.id, _keep: true, sid: o.sid });
    });
    if (me.role === '老師' && !me.actBy && !extraOpen_()) {                                   // 額外材料單平常不開放：老師不能新增、修改、刪除
      var oldSig = {}, changed = false, cnt = 0;
      Object.keys(mineOld).forEach(function (id) { var w = !mineOld[id].sid ? workingCopies_([mineOld[id]])[0] : null; if (w) { oldSig[id] = planSig_(w); cnt++; } });          // 跟「工作中的版本」比
      clean.forEach(function (e) { if (!e.sid && !e._keep) { cnt--; if (!e.id || oldSig[e.id] === undefined || oldSig[e.id] !== planSig_(e)) changed = true; } });
      if (changed || cnt !== 0) throw new Error('目前沒有開放「額外材料單」。臨時有活動要送材料單，請聯絡技士、科主任或管理者開放。');
    }
    var commit = mode !== 'draft', inScope = function (e) { return !mode || (mode === 'sched' && !!e.sid) || (mode === 'extra' && !e.sid); };
    var out = [], committed = [], inClean = {};
    clean.forEach(function (e) {
      var old = e.id ? mineOld[e.id] : null;
      if (!e._keep && !e.id) e.id = Utilities.getUuid().slice(0, 8);
      inClean[e.id] = 1;
      if (e._keep) { out.push(old); return; }                                                // 網頁還沒帶到的進度表課（剛排好）：原樣留著
      if (commit && inScope(e)) { e.draft = false; e.pending = null; out.push(e); committed.push(e); return; }
      if (!old || old.draft) { e.draft = true; e.pending = null; out.push(e); return; }      // 沒匯出過的：技士看不到，內容存在自己的草稿
      out.push(Object.assign({}, old, { pending: planSig_(old) === planSig_(e) ? null : pickPending_(e) }));   // 匯出過的：技士看到的維持原樣，改的部分先放草稿
    });
    Object.keys(mineOld).forEach(function (id) {                                            // 畫面上拿掉的額外材料單
      var o = mineOld[id]; if (inClean[id] || o.sid) return;
      if (commit && inScope(o)) return;                                                     // 匯出的時候一起拿掉
      if (o.draft) return;                                                                  // 從沒匯出過：直接不見
      out.push(Object.assign({}, o, { pending: { del: true } }));                           // 匯出過的：匯出之前，技士還是看得到
    });
    writePlans_(me.email, term, out);
  } finally { rtClear_(['排課']); lock.releaseLock(); }
  var dates = committed.map(function (e) { return e.date; }).sort();
  return { saved: committed.length, at: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'), first: dates[0] || '', last: dates[dates.length - 1] || '', unexported: out.filter(function (e) { return e.draft || e.pending; }).length,
           ids: clean.slice(0, entries.length).map(function (e) { return e.id; }),                                      // 新增的課，系統給的編號（跟送來的順序一樣）
           flags: out.map(function (e) { return { id: e.id, draft: !!e.draft, pend: !!(e.pending && !e.pending.del) }; }) };
}

/* 新增或修改自創材料單。管理者可以把材料單「共用」，所有老師都能選；也可以修改、刪除共用的。 */
function apiSaveCustom(rec) {
  var me = whoami_(), clean = L_cleanCustom(rec || {}, nameMap_()), admin = isStaff_(me);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = customSheet_(), values = sh.getDataRange().getValues(), idx = -1, shared = '';
    if (clean.pid) {
      for (var i = 1; i < values.length; i++) if (str_(values[i][0]) === clean.pid) { idx = i; break; }
      if (idx < 0) throw new Error('找不到這張材料單。');
      var wasShared = str_(values[idx][7]) === '是';
      if (!(str_(values[idx][1]).toLowerCase() === me.email || (admin && wasShared))) throw new Error('這張材料單不是你建立的，不能修改。');
      shared = admin ? (rec.shared ? '是' : '') : (wasShared ? '是' : '');
    } else {
      clean.pid = '自-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
      idx = Math.max(values.length, 1);
      shared = admin && rec.shared ? '是' : '';
    }
    var owner = idx < values.length ? str_(values[idx][1]).toLowerCase() : me.email;
    L_assignRowIds(clean.pid, clean.items);
    var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
    sh.getRange(idx + 1, 1, 1, CUSTOM_HEAD.length).setValues([[clean.pid, owner, clean.title, clean.serving, clean.dsets,
      JSON.stringify(clean.items), JSON.stringify(clean.tools), shared, '', now]]);
    var names = teacherNames_();
    var x = L_customToCatalog({ pid: clean.pid, owner: owner, ownerName: names[owner] || owner.split('@')[0], shared: shared === '是', title: clean.title,
      serving: clean.serving, dsets: clean.dsets, items: clean.items, tools: clean.tools });
    return { product: x.product, items: x.items, tools: x.tools };
  } finally { rtClear_(); lock.releaseLock(); }
}

/* 刪掉（其實是隱藏，排過的課還是看得到）。自己的，或管理者刪共用的。 */
function apiDeleteCustom(pid) {
  var me = whoami_(), lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = customSheet_(), values = sh.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (str_(values[i][0]) !== str_(pid)) continue;
      var shared = str_(values[i][7]) === '是';
      if (!(str_(values[i][1]).toLowerCase() === me.email || (isStaff_(me) && shared))) throw new Error('這張材料單不是你建立的，不能刪。');
      sh.getRange(i + 1, 9, 1, 1).setValues([['是']]);
      return { deleted: true };
    }
  } finally { rtClear_(); lock.releaseLock(); }
  throw new Error('找不到這張材料單。');
}

/* 後台：改預設材料單（蓋在原本上，原本的資料不會被動到） */
function apiSaveTemplate(pid, rec) {
  var me = requireAdmin_(), cat = loadCatalog_(), p = cat.products[str_(pid)];
  if (!p || p.custom) throw new Error('找不到這張預設材料單。');
  var clean = L_cleanCustom(Object.assign({}, rec || {}, { pid: p.pid }), nameMap_());
  L_assignRowIds(p.pid, clean.items);
  writeOverride_(me, p.pid, { title: clean.title, serving: clean.serving, dsets: clean.dsets, items: clean.items, tools: clean.tools });
  rtClear_(); var fresh = loadCatalog_();
  return { product: fresh.products[p.pid], items: fresh.items[p.pid], tools: fresh.tools[p.pid] };
}
/* 隱藏或恢復（老師的選單看不到，排過的課不受影響） */
function apiSetTemplateHidden(pid, hidden) {
  var me = requireAdmin_(), cat = loadCatalog_(), p = cat.products[str_(pid)];
  if (!p || p.custom) throw new Error('找不到這張預設材料單。');
  writeOverride_(me, p.pid, { hidden: !!hidden });
  return { hidden: !!hidden };
}
/* 還原成原本的樣子（刪掉這張的修改紀錄） */
function apiRevertTemplate(pid) {
  requireAdmin_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = ovrSheet_(), values = sh.getDataRange().getValues(), keep = [values[0]];
    for (var i = 1; i < values.length; i++) if (str_(values[i][0]) !== str_(pid)) keep.push(values[i]);
    sh.getRange(1, 1, values.length, OVR_HEAD.length).clearContent();
    sh.getRange(1, 1, keep.length, OVR_HEAD.length).setValues(keep);
  } finally { rtClear_(); lock.releaseLock(); }
  rtClear_(); var fresh = loadCatalog_(), p = fresh.products[str_(pid)];
  return { product: p, items: fresh.items[str_(pid)], tools: fresh.tools[str_(pid)] };
}

/* scope：'sched' = 教學進度表排的課（第一頁是進度表）；'extra' = 額外材料單（不在進度表裡的臨時活動）；不給 = 全部 */
/* what：'all' = 教學進度表（有的話）+ 每一堂課的材料申請單（預設）；'schedule' = 只有教學進度表。老師「只匯出」（不下載檔案）就不會呼叫這裡。 */
function ordNorm_(o) { return o === 'class' ? 'class' : o === 'course' ? 'course' : 'date'; }
function apiExportRequisition(scope, what, order, fmt) {
  var me = whoami_(), term = setting_('目前學年學期', ''), cat = loadCatalog_();
  var mine = readSent_().filter(function (e) { return e.teacher === me.email && e.term === term && (scope === 'sched' ? !!e.sid : scope === 'extra' ? !e.sid : true); });
  if (!mine.length) throw new Error(scope === 'extra' ? '還沒有送出的額外材料單可以匯出。' : '還沒有送出的排課可以匯出。');
  var docs = [];
  if (scope !== 'extra') {
    var ids = {};
    mine.forEach(function (e) { if (e.sid) ids[e.sid.split('|')[0]] = 1; });
    schedCells_().forEach(function (x) { if (x.cell.kind === 'lesson' && x.cell.groups.some(function (g) { return g.teacher === me.email; })) ids[x.tableId] = 1; });
    docs = schedDocs_(Object.keys(ids), me.email);                                             // 第一頁：教學進度表
  }
  if (what === 'schedule') {
    if (!docs.length) throw new Error('沒有教學進度表可以下載（額外材料單沒有進度表，或學期的開學日還沒設定）。');
    return buildXlsx_('教學進度表_' + me.name + '_' + term, docs, fmt);
  }
  return buildXlsx_((scope === 'extra' ? '額外材料單_' : '材料申請單_') + me.name + '_' + term, docs.concat(L_docRequisition(mine, cat, { teacherName: me.name, order: ordNorm_(order) })),fmt, ordNorm_(order));
}

function teacherNames_() {
  var names = {};
  readTable_('使用者').forEach(function (u) { if (u['姓名']) names[str_(u['信箱']).toLowerCase()] = str_(u['姓名']); });
  return names;
}

/* 刪掉的課都留一筆紀錄（誰刪的、什麼時候、刪掉前的樣子） */
function logDelete_(byLabel, e) {
  var log = ss_().getSheetByName('排課刪除紀錄');
  var head = ['刪除時間', '刪除者', '老師信箱', '學年學期', '產品編號', '上課日期', '班級', '課程', '內容'];
  if (!log) { log = ss_().insertSheet('排課刪除紀錄'); log.getRange(1, 1, 1, head.length).setValues([head]); }
  var n = Math.max(log.getLastRow(), 1) + 1;
  log.getRange(n, 6, 1, 1).setNumberFormat('@');
  log.getRange(n, 1, 1, head.length).setValues([[Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'), byLabel, e.teacher, e.term, e.pid, e.date, e.cls, e.course, JSON.stringify(e)]]);
}

/* ---------------- 教學進度表 ----------------
 * 「教學進度表」分頁：一張表一列（哪個部、哪門課、哪幾個班、星期幾上、要不要分組）
 * 「教學進度內容」分頁：每一格一列（第幾週、哪個班）。老師在格子裡排好產品和開單的老師，
 * 系統就把那些課放進那位老師的「排課備料」（待確認），老師確認重量、送出後技士才看得到。 */
var SCHED_TABLE_HEAD = ['表ID', '學年學期', '部別', '課程', '班級', '組別', '標題', '建立者', '建立時間', '最後修改', '額外日期', '授課老師'];
var SCHED_CELL_HEAD = ['表ID', '週次', '班級', '內容', '更新者', '更新時間', '星期'];
/* 讀取用：這張分頁「確定有、標題也是最新的」記在快取裡（1 小時），不用每次都去試算表檢查 */
var ENS_ = {};
function ensKnown_(name, head) {
  var key = 'ens|' + name + '|' + head.join(',');
  if (ENS_[key]) return true;
  try { if (CacheService.getScriptCache().get(key)) { ENS_[key] = 1; return true; } } catch (e) {}
  return false;
}
function ensureSheetFast_(name, head) {
  if (ensKnown_(name, head)) return;
  ensureSheet_(name, head);
  var key = 'ens|' + name + '|' + head.join(',');
  ENS_[key] = 1; try { CacheService.getScriptCache().put(key, '1', 3600); } catch (e) {}
}
function ensureSheet_(name, head) {
  var sh = ss_().getSheetByName(name);
  if (!sh) { sh = ss_().insertSheet(name); sh.getRange(1, 1, 1, head.length).setValues([head]); return sh; }
  var cur = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  if (head.some(function (h, i) { return cur[i] !== h; })) sh.getRange(1, 1, 1, head.length).setValues([head]);      // 舊的分頁補上新欄位（新欄位都放在最後面）
  return sh;
}
function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function jparse_(v, d) { try { var x = JSON.parse(v); return x === null || x === undefined ? d : x; } catch (e) { return d; } }
function schedTables_(term) {
  ensureSheetFast_('教學進度表', SCHED_TABLE_HEAD);
  return readTable_('教學進度表').filter(function (r) { return str_(r['學年學期']) === term; }).map(function (r) {
    var cl = L_sortClasses(jparse_(r['班級'], []).map(function (x) { return clT_(x, L_classDays(x)); }));      // 班級依星期排，星期一的放前面
    return { id: str_(r['表ID']), term: str_(r['學年學期']), dept: str_(r['部別']), course: str_(r['課程']), classes: cl, groups: str_(r['組別']) ? str_(r['組別']).split(/[、,，\s]+/).filter(Boolean) : [],
             title: str_(r['標題']), creator: str_(r['建立者']).toLowerCase(), updated: str_(r['最後修改']), ext: extOf_(jparse_(r['額外日期'], null)), teachers: teachersOf_(r['授課老師']) };
  });
}
/* 每個學期各自有自己的進度表；歷年的進度表都還留在試算表裡，可以叫出來看、複製 */
function tableFromRow_(r) {
  return { id: str_(r['表ID']), term: str_(r['學年學期']), dept: str_(r['部別']), course: str_(r['課程']),
           classes: L_sortClasses(jparse_(r['班級'], []).map(function (x) { return clT_(x, L_classDays(x)); })),
           groups: str_(r['組別']) ? str_(r['組別']).split(/[、,，\s]+/).filter(Boolean) : [], ext: extOf_(jparse_(r['額外日期'], null)), teachers: teachersOf_(r['授課老師']) };
}
function tableWeeksOf_(t) { var s = setting_('開學日 ' + t.term, ''), e = setting_('結業式 ' + t.term, ''); return L_weeksTable(t, s, e, t.ext); }     // 那個學期自己的開學日、結業式
function apiScheduleHistory() {
  whoami_(); ensureSheetFast_('教學進度表', SCHED_TABLE_HEAD);
  var cur = setting_('目前學年學期', ''), byTerm = {};
  readTable_('教學進度表').forEach(function (r) {
    var t = tableFromRow_(r); if (!t.id || t.term === cur) return;
    (byTerm[t.term] = byTerm[t.term] || []).push({ id: t.id, dept: t.dept, course: t.course, classes: t.classes, groups: t.groups });
  });
  var cells = schedCells_(), has = {}; cells.forEach(function (x) { has[x.tableId] = (has[x.tableId] || 0) + 1; });
  var terms = Object.keys(byTerm).sort().reverse().map(function (k) {
    return { term: k, tables: byTerm[k].filter(function (t) { return has[t.id]; }).sort(function (a, b) { return (a.dept + a.course) < (b.dept + b.course) ? -1 : 1; }) };      // 沒排過內容的不用列
  }).filter(function (x) { return x.tables.length; });
  return { current: cur, terms: terms };
}
/* 以前學期的全部資料（只有技士、科主任、管理者能看）：有哪些學期；選了學期就回傳那學期的每一門課、班級、授課老師、送單堂數 */
function apiTermArchive(term) {
  requireStaff_(); ensureSheetFast_('教學進度表', SCHED_TABLE_HEAD);
  var cur = setting_('目前學年學期', ''), seen = {};
  readTable_('教學進度表').forEach(function (r) { var t = str_(r['學年學期']); if (t) seen[t] = 1; });
  readPlans_().forEach(function (e) { if (e.term) seen[e.term] = 1; });
  var terms = Object.keys(seen).filter(function (t) { return t !== cur; }).sort().reverse();
  term = String(term || '');
  if (!term) return { current: cur, terms: terms };
  if (term === cur) throw new Error('這是目前的學期，請直接看「教學進度表管理」。');
  var nm = teacherNames_(), plans = readPlans_().filter(function (e) { return e.term === term; }), cnt = {};
  plans.forEach(function (e) { var k = e.dept + '|' + e.course; var c = cnt[k] || (cnt[k] = { total: 0, sent: 0, extra: 0 }); c.total++; if (!e.draft) c.sent++; if (!e.sid) c.extra++; });
  var cells = schedCells_(), has = {}; cells.forEach(function (x) { has[x.tableId] = (has[x.tableId] || 0) + 1; });
  var tables = schedTables_(term).map(function (t) {
    var c = cnt[t.dept + '|' + t.course] || { total: 0, sent: 0, extra: 0 };
    return { id: t.id, dept: t.dept, course: t.course, groups: t.groups, cells: has[t.id] || 0, lessons: c.total, sent: c.sent,
             classes: t.classes.map(function (k) { return { cls: k.cls, teachers: (k.teachers && k.teachers.length ? k.teachers : t.teachers || []).map(function (em) { return nm[em] || em.split('@')[0]; }) }; }) };
  }).sort(function (a, b) { return (a.dept + a.course) < (b.dept + b.course) ? -1 : 1; });
  var extra = 0; plans.forEach(function (e) { if (!e.sid && !e.draft) extra++; });
  return { term: term, start: setting_('開學日 ' + term, ''), end: setting_('結業式 ' + term, ''), tables: tables, plans: plans.length, extra: extra, terms: terms };
}
function apiScheduleHistoryTable(id) {
  whoami_(); ensureSheetFast_('教學進度表', SCHED_TABLE_HEAD);
  var row = readTable_('教學進度表').filter(function (r) { return str_(r['表ID']) === String(id); })[0];
  if (!row) throw new Error('找不到這張進度表。');
  var t = tableFromRow_(row);
  return { table: t, weeks: tableWeeksOf_(t), cells: schedCells_().filter(function (x) { return x.tableId === t.id; }) };
}
/* 這學期這門課的授課老師（信箱清單）。進度表只能排這幾位，也只會出現在這幾位老師的教學進度表；還沒指定的（空的）就是所有老師都可以。 */
/* 班級物件：每個班可以有自己的授課老師（teachers 是信箱清單） */
function clT_(x, d) { var o = { cls: x.cls, wd: d[0], days: d }; if (Array.isArray(x.teachers)) o.teachers = x.teachers.map(function (e) { return String(e).toLowerCase().trim(); }).filter(Boolean); return o; }
function unionT_(classes) { var u = []; (classes || []).forEach(function (c) { (c.teachers || []).forEach(function (e) { if (u.indexOf(e) < 0) u.push(e); }); }); return u; }
function teachersOf_(v) { return str_(v) ? str_(v).split(/[、,，\s]+/).map(function (x) { return x.toLowerCase(); }).filter(Boolean) : []; }
function tablePids_(tableId) {                                                        // 這張進度表已經在用的材料單（別人自創的，留著沒問題）
  var seen = {}; schedCells_().forEach(function (x) { if (x.tableId === tableId && x.cell.kind === 'lesson') x.cell.groups.forEach(function (g) { g.pids.forEach(function (p) { seen[p] = 1; }); }); });
  return Object.keys(seen);
}
/* 進度表只有被指定的授課老師才看得到、改得了；還沒指定授課老師的，只有技士、科主任、管理者能動 */
function canSeeTable_(me, t) { return isStaff_(me) || (t.teachers.length > 0 && t.teachers.indexOf(me.email) >= 0); }
function isTeacherOf_(me, t) { return me.role === '技士' || (t.teachers || []).indexOf(me.email) >= 0; }       // 技士可以編輯所有進度表
function assertCanEditTable_(me, t) { if (!isTeacherOf_(me, t)) throw new Error('這張進度表你不是授課老師，只能看，不能編輯。'); }
function extOf_(v) { return v && L_parseDate(v.from) && L_parseDate(v.to) && v.to >= v.from ? { from: String(v.from), to: String(v.to) } : null; }
function semDates_() { var term = setting_('目前學年學期', ''); return { start: setting_('開學日 ' + term, ''), end: setting_('結業式 ' + term, '') }; }
function tableWeeks_(t) { var d = semDates_(); return L_weeksTable(t, d.start, d.end, t.ext); }        // 這張進度表的每一週：學期的週 + 寒暑假加課的週
function schedCells_() {
  ensureSheetFast_('教學進度內容', SCHED_CELL_HEAD);
  return readTable_('教學進度內容').map(function (r) { return { tableId: str_(r['表ID']), week: num_(r['週次']), cls: str_(r['班級']), day: num_(r['星期']) || 0, cell: jparse_(r['內容'], {}), by: str_(r['更新者']), at: str_(r['更新時間']) }; });
}
function cellRow_(x) { return [x.tableId, x.week, x.cls, JSON.stringify(x.cell), x.by, x.at, x.day || 0]; }
function writeSched_(name, head, rows) {
  var sh = ensureSheet_(name, head), last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, head.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  rtClear_([name]);
}
function tableRow_(t, created) { return [t.id, t.term, t.dept, t.course, JSON.stringify(t.classes), t.groups.join('、'), t.title || '', t.creator, created || nowStr_(), nowStr_(), t.ext ? JSON.stringify(t.ext) : '', (t.teachers || []).join('、')]; }
function allTableRows_() {
  ensureSheetFast_('教學進度表', SCHED_TABLE_HEAD);
  return readTable_('教學進度表').map(function (r) { return [str_(r['表ID']), str_(r['學年學期']), str_(r['部別']), str_(r['課程']), str_(r['班級']), str_(r['組別']), str_(r['標題']), str_(r['建立者']), str_(r['建立時間']), str_(r['最後修改']), str_(r['額外日期']), str_(r['授課老師'])]; });
}
function schedEmails_() { return readTable_('使用者').map(function (u) { return str_(u['信箱']).toLowerCase().trim(); }).filter(Boolean); }

/* ---------------- 每學期應該有哪些進度表（常態清單，不用每學期重設） ----------------
 * 「應有進度表」分頁：每列一門課（哪個部、哪門課、哪幾個班、上學期／下學期／每學期都要）。
 * 每學期直接用這份清單對照「教學進度表」，就知道哪些課還沒建進度表、哪些還沒送單。 */
var REQ_HEAD = ['編號', '部別', '課程', '班級', '學期別', '備註', '建立者', '建立時間', '最後修改', '組別', '授課老師'];
function reqClasses_(v) {                                  // 班級欄：舊的寫法是班級名稱的清單，新的是 [{cls, days}]；依星期排
  return L_sortClasses((Array.isArray(v) ? v : []).map(function (x) { var cls = typeof x === 'string' ? x : x && x.cls; if (!cls) return null; var o = { cls: cls, days: L_classDays(typeof x === 'string' ? {} : x) }; if (typeof x !== 'string' && Array.isArray(x.teachers)) o.teachers = x.teachers.map(function (e) { return String(e).toLowerCase().trim(); }).filter(Boolean); return o; }).filter(Boolean));
}
function requiredAll_() {
  var fresh = !ensKnown_('應有進度表', REQ_HEAD) && !ss_().getSheetByName('應有進度表');
  ensureSheetFast_('應有進度表', REQ_HEAD);
  if (fresh) writeRequired_(L_REQUIRED_DEFAULTS.map(function (e) { return { id: e.id, dept: e.dept, course: e.course, classes: e.classes.map(function (c) { return { cls: c.cls, days: c.days.slice() }; }), groups: e.groups.slice(), half: e.half, note: e.note }; }), '系統預設');   // 第一次用：放進預設的清單
  return readTable_('應有進度表').map(function (r) {
    return { id: str_(r['編號']), dept: str_(r['部別']), course: str_(r['課程']), classes: reqClasses_(jparse_(r['班級'], [])), groups: str_(r['組別']) ? str_(r['組別']).split(/[、,，\s]+/).filter(Boolean) : [], half: str_(r['學期別']) || '每', note: str_(r['備註']), teachers: teachersOf_(r['授課老師']) };
  });
}
function requiredSkips_(term) { return setting_('本學期不開 ' + term, '').split(/[、,\s]+/).filter(Boolean); }
function requiredForTerm_(term) {
  var half = L_termHalf(term), skips = requiredSkips_(term);
  return requiredAll_().filter(function (e) { return e.half === '每' || e.half === '假' || e.half === half; }).map(function (e) { e.skip = skips.indexOf(e.id) >= 0; return e; });
}
function writeRequired_(list, by) {
  var old = {}; readTable_('應有進度表').forEach(function (r) { old[str_(r['編號'])] = r; });
  writeSched_('應有進度表', REQ_HEAD, list.map(function (e) {
    var o = old[e.id]; return [e.id, e.dept, e.course, JSON.stringify(e.classes), e.half, e.note || '', o ? str_(o['建立者']) : by, o ? str_(o['建立時間']) : nowStr_(), nowStr_(), (e.groups || []).join('、'), (e.teachers || []).join('、')];
  }));
}
/* 清單改了（例如國中技藝班加了幾個國中），這學期已經建好的那張進度表也跟著改：新的班加進去；拿掉的班，沒有內容才拿掉（有內容的留著） */
function reconcileTables_(oldE, e) {
  var term = setting_('目前學年學期', ''), names = {};
  (oldE ? oldE.classes : []).concat(e.classes).forEach(function (c) { names[c.cls] = 1; });
  var mine = schedTables_(term).filter(function (t) { return t.dept === e.dept && t.course === e.course && t.classes.some(function (c) { return names[c.cls]; }); });
  if (!mine.length) return;
  var t = mine[0], cells = schedCells_().filter(function (x) { return x.tableId === t.id; });
  var cls = e.classes.map(function (c) { var ex = t.classes.filter(function (x) { return x.cls === c.cls; })[0], d = L_classDays(c); var o = ex ? { cls: ex.cls, wd: ex.wd, days: ex.days } : { cls: c.cls, wd: d[0], days: d }; if (c.teachers) o.teachers = c.teachers; else if (ex && ex.teachers) o.teachers = ex.teachers; return o; });
  t.classes.forEach(function (x) { if (!e.classes.some(function (c) { return c.cls === x.cls; }) && cells.some(function (k) { return k.cls === x.cls; })) cls.push(x); });
  if (cls.length > 1) cls = cls.map(function (x) { return x.days.length > 1 ? (function () { var o = { cls: x.cls, wd: x.days[0], days: [x.days[0]] }; if (x.teachers) o.teachers = x.teachers; return o; })() : x; });      // 好幾個班的進度表，每個班一天
  cls = L_sortClasses(cls);
  var groups = cells.some(function (k) { return k.cell.kind === 'lesson' && k.cell.mode === 'split'; }) ? t.groups : (e.groups || []);
  var old = readTable_('教學進度表').filter(function (r) { return str_(r['表ID']) === t.id; })[0];
  var rows = allTableRows_().filter(function (r) { return r[0] !== t.id; });
  rows.push(tableRow_(Object.assign({}, t, { classes: cls, groups: groups }), old ? str_(old['建立時間']) : ''));
  writeSched_('教學進度表', SCHED_TABLE_HEAD, rows);
  var keepCls = {}; cls.forEach(function (x) { keepCls[x.cls] = 1; });
  var all = schedCells_(), kept = all.filter(function (x) { return x.tableId !== t.id || keepCls[x.cls]; });
  if (kept.length !== all.length) writeSched_('教學進度內容', SCHED_CELL_HEAD, kept.map(cellRow_));
  syncSchedule_(t.id);
}
/* 清單裡設的授課老師，同步到這學期已經建好的那張進度表 */
function applyReqTeachers_(e) {
  var term = setting_('目前學年學期', ''), names = {}; e.classes.forEach(function (c) { names[c.cls] = 1; });
  var mine = schedTables_(term).filter(function (t) { return t.dept === e.dept && t.course === e.course && t.classes.some(function (c) { return names[c.cls]; }); });
  if (!mine.length) return;
  var t = mine[0], ct = {}; e.classes.forEach(function (c) { if (c.teachers) ct[c.cls] = c.teachers; });
  var ncl = t.classes.map(function (c) { var o = { cls: c.cls, wd: c.wd, days: c.days }; if (ct[c.cls]) o.teachers = ct[c.cls]; else if (c.teachers && !Object.keys(ct).length) o.teachers = c.teachers; return o; });
  if ((t.teachers || []).join('、') === (e.teachers || []).join('、') && JSON.stringify(ncl) === JSON.stringify(t.classes)) return;
  var old = readTable_('教學進度表').filter(function (r) { return str_(r['表ID']) === t.id; })[0];
  var rows = allTableRows_().filter(function (r) { return r[0] !== t.id; });
  rows.push(tableRow_(Object.assign({}, t, { teachers: e.teachers || [], classes: ncl }), old ? str_(old['建立時間']) : ''));
  writeSched_('教學進度表', SCHED_TABLE_HEAD, rows);
}
function apiRequiredSave(rec) {
  var me = requireAdmin_(); rec = rec || {};
  var dept = String(rec.dept || ''), classes = classes_(), course = L_safeText(rec.course, 20), half = String(rec.half || '每');
  if (['日間部', '夜間部'].indexOf(dept) < 0) throw new Error('請選日間部或夜間部。');
  if (!course) throw new Error('請選課程。');
  if (['每', '上', '下', '假'].indexOf(half) < 0) throw new Error('請選哪個學期要有（每學期、上學期、下學期、只有寒暑假）。');
  var oldClsOk = {};
  requiredAll_().forEach(function (o) { if (o.id === String(rec.id || '') && o.dept === dept) o.classes.forEach(function (c) { oldClsOk[c.cls] = 1; }); });      // 這一筆原本就有的班，清單裡沒有也讓它存（例如「技藝競賽選手」）
  var cl = [];
  (Array.isArray(rec.classes) ? rec.classes : []).forEach(function (x) {
    var name = L_safeText(typeof x === 'string' ? x : x && x.cls, 10); if (!name || cl.some(function (c) { return c.cls === name; })) return;
    if ((classes[dept] || []).indexOf(name) < 0 && !oldClsOk[name]) throw new Error('「' + name + '」不在' + dept + '的班級清單裡。');
    cl.push({ cls: name, days: L_classDays(typeof x === 'string' ? {} : x), teachers: (typeof x === 'object' && x && Array.isArray(x.teachers)) ? x.teachers : null });
  });
  if (!cl.length) throw new Error('請選這門課有哪些班。');
  if (cl.length > 1 && cl.some(function (c) { return c.days.length > 1; })) throw new Error('每天上課（一週好幾天）的班，一門課只能設這一個班。');
  var groups = (Array.isArray(rec.groups) ? rec.groups.join('、') : String(rec.groups || '')).split(/[、,，\s]+/).map(function (g) { return L_safeText(g, 6); }).filter(Boolean);
  if (groups.length === 1 || groups.length > 3) throw new Error('分組要填 2 到 3 組，例如：單數組、雙數組。');
  if (dept === '夜間部' && groups.length) throw new Error('夜間部的實習課只有一位老師，不能分組。');
  var known = schedEmails_(), teachers = [];
  (Array.isArray(rec.teachers) ? rec.teachers : String(rec.teachers || '').split(/[、,，\s]+/)).forEach(function (x) {
    x = String(x).toLowerCase().trim(); if (!x || teachers.indexOf(x) >= 0) return;
    if (known.indexOf(x) < 0) throw new Error('找不到這位老師：' + x);
    teachers.push(x);
  });
  var anyCT = cl.some(function (c) { return c.teachers; });
  cl.forEach(function (c) {
    if (!c.teachers) { if (anyCT) c.teachers = []; else delete c.teachers; return; }
    var u = []; c.teachers.forEach(function (x) { x = String(x).toLowerCase().trim(); if (!x || u.indexOf(x) >= 0) return; if (known.indexOf(x) < 0) throw new Error('找不到這位老師：' + x); u.push(x); }); c.teachers = u;
  });
  if (anyCT) teachers = unionT_(cl);
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var list = requiredAll_(), id = String(rec.id || '');
    if (id && !list.some(function (e) { return e.id === id; })) throw new Error('找不到這一筆。');
    if (!id) id = Utilities.getUuid().slice(0, 8);
    list.forEach(function (o) {                                                                     // 同一門課、同一班，一個學期只能有一張進度表（大家共同編輯那一張）
      if (o.id === id || o.dept !== dept || o.course !== course) return;
      if (!(o.half === '每' || half === '每' || o.half === '假' || half === '假' || o.half === half)) return;
      cl.forEach(function (c) { if (o.classes.some(function (x) { return x.cls === c.cls; })) throw new Error('「' + dept + '・' + course + '」的「' + c.cls + '」已經有了。同一門課同一班只能有一張進度表，大家共同編輯那一張。'); });
    });
    var e = { id: id, dept: dept, course: course, classes: cl, groups: groups, half: half, note: L_safeText(rec.note, 30), teachers: teachers };
    var oldE = list.filter(function (x) { return x.id === id; })[0] || null;
    list = list.filter(function (x) { return x.id !== id; }); list.push(e);
    writeRequired_(list, me.email);
    var shp = function (l) { return JSON.stringify(l.map(function (c) { return [c.cls, c.days]; })); };
    var sameShape = oldE && shp(oldE.classes) === shp(e.classes) && oldE.groups.join('、') === e.groups.join('、');
    if (oldE && !sameShape) reconcileTables_(oldE, e);
    applyReqTeachers_(e);
  } finally { rtClear_(['應有進度表', '教學進度表', '教學進度內容', '排課']); lock.releaseLock(); }
  return apiScheduleGet();
}
function apiRequiredDelete(id) {
  requireAdmin_();
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var list = requiredAll_(), n = list.length;
    list = list.filter(function (x) { return x.id !== String(id); });
    if (list.length === n) throw new Error('找不到這一筆。');
    writeRequired_(list, '');
  } finally { rtClear_(); lock.releaseLock(); }
  return apiScheduleGet();
}
/* 這個學期不開這門課（只有這個學期，下個學期照舊要有） */
function apiRequiredSkip(id, skip) {
  requireAdmin_();
  var term = setting_('目前學年學期', ''), all = requiredAll_();
  if (!all.some(function (x) { return x.id === String(id); })) throw new Error('找不到這一筆。');
  var l = requiredSkips_(term).filter(function (x) { return x !== String(id); });
  if (skip === true || skip === '是') l.push(String(id));
  setSetting_('本學期不開 ' + term, l.join('、'));
  return apiScheduleGet();
}
function requiredStatus_(term, tables, cells, weeks) {
  var ids = {}; tables.forEach(function (t) { ids[t.id] = 1; });
  return L_requiredStatus(requiredForTerm_(term), tables, cells.filter(function (x) { return ids[x.tableId]; }), weeks, readPlans_().filter(function (e) { return e.term === term; }), loadProductsLite_(), tableWeeks_);
}

/* 這學期要有的進度表（技士、科主任、管理者設定的清單），還沒有的自動建好。老師不能自己新增進度表，只能在裡面排課、共同編輯。 */
function ensureTables_() {
  var term = setting_('目前學年學期', '');
  var need = function () {
    var tables = schedTables_(term);
    return requiredForTerm_(term).filter(function (r) { return !r.skip && !tables.some(function (t) { return t.dept === r.dept && t.course === r.course && r.classes.some(function (c) { return t.classes.some(function (tc) { return tc.cls === c.cls; }); }); }); });
  };
  if (!need().length) return;
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var rows = allTableRows_();
    var lastTeachers = function (dept, course) {                                                  // 這門課上一次指定的授課老師，先帶過來（每學期可以再改）
      var best = null; rows.forEach(function (x) { if (x[2] === dept && x[3] === course && x[1] < term && x[10] !== undefined && x[11] && (!best || x[1] > best[1])) best = x; }); return best ? teachersOf_(best[11]) : [];
    };
    need().forEach(function (r) {
      var t = { id: Utilities.getUuid().slice(0, 8), term: term, dept: r.dept, course: r.course, classes: r.classes.map(function (c) { return clT_(c, L_classDays(c)); }), groups: r.groups || [], title: '', creator: '系統', teachers: (r.teachers && r.teachers.length) ? r.teachers : lastTeachers(r.dept, r.course) };
      rows.push(tableRow_(t, ''));
    });
    writeSched_('教學進度表', SCHED_TABLE_HEAD, rows);
  } finally { rtClear_(); lock.releaseLock(); }
}
function apiScheduleGet(asEmail) {
  ensureTables_();
  var me = whoami_(), real = me;
  /* 技士、科主任、管理者的「老師模式」：看某位老師會看到的進度表（只能看，不會改到任何東西） */
  if (asEmail && isStaff_(real)) me = { email: String(asEmail).toLowerCase().trim(), role: '老師' };
  var term = setting_('目前學年學期', ''), start = setting_('開學日 ' + term, ''), end = setting_('結業式 ' + term, '');
  var tables = schedTables_(term), ids = {}, visible = tables.filter(function (t) { return canSeeTable_(me, t); });      // 老師只看得到自己是授課老師的（或還沒指定授課老師的）進度表
  visible.forEach(function (t) { ids[t.id] = 1; });
  var allCells = schedCells_(), weeks = L_weeks(start, end);
  return { term: term, half: L_termHalf(term), start: start, end: end, weeks: weeks, tables: visible.map(function (t) { return Object.assign({}, t, { weeks: tableWeeks_(t), canEdit: isTeacherOf_(me, t) }); }), cells: allCells.filter(function (x) { return ids[x.tableId]; }),
           required: isStaff_(me) ? requiredStatus_(term, tables, allCells, weeks) : [], requiredAll: isStaff_(me) ? requiredAll_() : [],       // 有沒有建進度表，只有技士、科主任、管理者看得到
           users: readTable_('使用者').map(function (u) { return { email: str_(u['信箱']).toLowerCase().trim(), name: str_(u['姓名']) || str_(u['信箱']).split('@')[0] }; }).filter(function (u) { return u.email; }),
           canConfig: isStaff_(me), me: me.email, cellProducts: cellProducts_(allCells.filter(function (x) { return ids[x.tableId]; })), athRows: athRowsOf_(ids) };
}
/* 進度表格子裡用到的材料單名稱（別人自創的，這邊的目錄裡沒有，也要能顯示名稱） */
function cellProducts_(cells) {
  var prods = loadProductsLite_(), out = {};
  cells.forEach(function (x) { if (x.cell.kind === 'lesson') x.cell.groups.forEach(function (g) { g.pids.forEach(function (p) { if (!out[p] && prods[p]) out[p] = { title: prods[p].title, serving: prods[p].serving || '', custom: !!prods[p].custom }; }); }); });
  return out;
}
/* 把以前自己開的「額外材料單」（沒有掛進度表的）依日期、班級、課程帶進進度表格子，並跟材料單連動。apply 不是 true 時只試算，不寫入。 */
function apiAdoptExtras(apply) {
  var me = requireAdmin_(), term = setting_('目前學年學期', ''), cat = loadCatalog_(), users = schedEmails_();
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  var adopted = 0, skipped = [], byTeacher = {};
  try {
    var tables = schedTables_(term), plans = readPlans_(), all = schedCells_();
    var have = {}; all.forEach(function (x) { have[x.tableId + '|' + x.week + '|' + x.cls + '|' + (x.day || 0)] = x; });
    var changedPlans = {}, touched = {}, newCells = {};
    plans.filter(function (e) { return e.term === term && !e.sid && !e.draft && e.date && e.pid; }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }).forEach(function (e) {
      var tag = e.date + ' ' + e.cls + ' ' + e.course + ' ' + e.pid, fail = function (why) { skipped.push(tag + '：' + why); };
      var t = tables.filter(function (x) { return x.dept === e.dept && x.course === e.course && x.classes.some(function (c) { return c.cls === e.cls; }); })[0];
      if (!t) return fail('找不到對應的進度表（部別／課程／班級）');
      var wk = tableWeeks_(t).filter(function (w) { return w.mon === L_weekStart(e.date); })[0];
      if (!wk) return fail('這個日期不在進度表的週次裡');
      var tc = t.classes.filter(function (c) { return c.cls === e.cls; })[0], days = L_classDays(tc), multi = days.length > 1;
      var wd = new Date(e.date + 'T00:00:00Z').getUTCDay() || 7, day = 0;
      if (multi) { if (days.indexOf(wd) < 0) return fail('不是這個班的上課日'); day = wd; }
      else if (wd !== days[0]) { if (t.classes.length !== 1) return fail('不是這個班的上課日（週' + '日一二三四五六日'.charAt(wd) + '）'); day = wd; }
      var key = t.id + '|' + wk.n + '|' + e.cls + '|' + day, cur = newCells[key] || have[key], cell = cur ? JSON.parse(JSON.stringify(cur.cell)) : { kind: 'lesson', mode: 'joint', label: '', groups: [{ label: '', teacher: '', pids: [] }] };
      if (cell.kind !== 'lesson') return fail('那一格是備註，不是上課');
      var g = cell.groups.filter(function (x) { return x.teacher === e.teacher; })[0] || cell.groups.filter(function (x) { return !x.pids.length; })[0];
      if (!g) return fail('那一格已經有別的老師的內容');
      if (!g.teacher) g.teacher = e.teacher;
      if (g.pids.indexOf(e.pid) < 0) g.pids.push(e.pid);
      var clean; try { clean = L_cleanCell(cell, t, cat.products, users, me.email, [e.pid].concat.apply([], cell.groups.map(function (x) { return x.pids; }))); } catch (er) { return fail(er.message); }
      newCells[key] = { tableId: t.id, week: wk.n, cls: e.cls, day: day, cell: clean, by: (cur && cur.by) || e.teacher, at: nowStr_() };
      touched[t.id] = 1;
      var sp = L_scheduleDerive(t, wk, e.cls, clean, cat.products, day).filter(function (x) { return x.pid === e.pid && x.teacher === e.teacher; })[0];
      if (!sp) return fail('算不出對應的格子');
      changedPlans[e.id] = { sid: sp.sid, group: sp.group, dept: sp.dept, course: sp.course, cls: sp.cls };
      adopted++; byTeacher[e.teacher] = (byTeacher[e.teacher] || 0) + 1;
    });
    if (apply === true && adopted) {
      var merged = all.filter(function (x) { return !newCells[x.tableId + '|' + x.week + '|' + x.cls + '|' + (x.day || 0)]; }).concat(Object.keys(newCells).map(function (k) { return newCells[k]; }));
      writeSched_('教學進度內容', SCHED_CELL_HEAD, merged.map(cellRow_));
      var out = plans.map(function (e) { var c = changedPlans[e.id]; if (c) { e.sid = c.sid; e.group = c.group; e.dept = c.dept; e.course = c.course; e.cls = c.cls; } return e; });
      flushPlanRows_(ss_().getSheetByName('排課'), out.map(function (e) { return planRow_(e, e.created, e.updated); }));
    }
  } finally { rtClear_(); lock.releaseLock(); }
  return { applied: apply === true, adopted: adopted, byTeacher: byTeacher, skipped: skipped };
}
/* 技士、科主任、管理者設定這個學期的開學日和結業式，進度表的每一週就是從這裡排出來的 */
function apiScheduleSetDates(start, end) {
  requireAdmin_();
  if (!L_parseDate(start) || !L_parseDate(end)) throw new Error('請選開學日和結業式的日期。');
  var s = L_weekStart(start);
  if (end <= s) throw new Error('結業式要在開學日之後。');
  if ((L_parseDate(end).t - L_parseDate(s).t) / 86400000 / 7 > 40) throw new Error('學期最多 40 週。');
  var term = setting_('目前學年學期', '');
  setSetting_('開學日 ' + term, s); setSetting_('結業式 ' + term, end);
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try { syncSchedule_(null); } finally { rtClear_(); lock.releaseLock(); }
  return { start: s, end: end, weeks: L_weeks(s, end) };
}
function schedGuard_(me) {
  if (teacherLocked_(me)) throw new Error('目前已關閉老師送出材料單，不能新增或修改進度表。需要修改請聯絡技士、科主任或管理者。');
}
/* 改一張進度表的每週上課日、分組。技士、科主任、管理者都能改；老師只能改「只有一個班」的進度表的上課日（例如技藝競賽選手選週幾到週幾），分組要請管理的人改。 */
function apiScheduleSaveTable(rec) {
  var me = whoami_(), mgr = isStaff_(me); rec = rec || {};
  if (!mgr) schedGuard_(me);
  var term = setting_('目前學年學期', ''), id = String(rec.id || '');
  if (!id) throw new Error('進度表是依「每學期要有哪些進度表」自動建立的，不能自己新增。要新增請到清單裡設定。');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var t = schedTables_(term).filter(function (x) { return x.id === id; })[0];
    if (!t) throw new Error('找不到這張進度表。');
    if (!mgr) assertCanEditTable_(me, t);
    if (!mgr) {
      if (rec.teachers !== undefined && rec.teachers !== null && (Array.isArray(rec.teachers) ? rec.teachers : String(rec.teachers).split(/[、,，\s]+/)).map(function (x) { return String(x).toLowerCase().trim(); }).filter(Boolean).join('、') !== t.teachers.join('、')) throw new Error('授課老師要請技士、科主任或管理者設定。');
      if (t.classes.length !== 1) throw new Error('這張進度表有好幾個班，上課日要請技士、科主任或管理者改。');
      if (rec.groups != null && (Array.isArray(rec.groups) ? rec.groups.join('、') : String(rec.groups)).replace(/[\s,，、]+/g, '、').replace(/^、|、$/g, '') !== t.groups.join('、')) throw new Error('分組要請技士、科主任或管理者改。');
    }
    var inc = Array.isArray(rec.classes) ? rec.classes : [];
    var classes = L_sortClasses(t.classes.map(function (tc) { var x = inc.filter(function (i) { return i && i.cls === tc.cls; })[0], d = L_classDays(x || tc); return clT_({ cls: tc.cls, teachers: tc.teachers }, d); }));
    if (classes.length > 1 && classes.some(function (c) { return c.days.length > 1; })) throw new Error('每天上課（一週好幾天）的班，一張進度表只能有這一個班。');
    var groups = (Array.isArray(rec.groups) ? rec.groups.join('、') : String(rec.groups == null ? t.groups.join('、') : rec.groups)).split(/[、,，\s]+/).map(function (g) { return L_safeText(g, 6); }).filter(Boolean);
    if (groups.length === 1 || groups.length > 3) throw new Error('分組要填 2 到 3 組，例如：單數組、雙數組。');
    if (t.dept === '夜間部' && groups.length) throw new Error('夜間部的實習課只有一位老師，不能分組。');
    var cells = schedCells_();
    if (t.groups.join('、') !== groups.join('、') && cells.some(function (x) { return x.tableId === id && x.cell.kind === 'lesson' && x.cell.mode === 'split'; })) throw new Error('已經有排「分組上課」的格子，不能改分組。請先把那些格子改成全班一起上，或清除。');
    var teachers = t.teachers;
    if (rec.teachers !== undefined && rec.teachers !== null) {
      var want = (Array.isArray(rec.teachers) ? rec.teachers : String(rec.teachers).split(/[、,，\s]+/)).map(function (x) { return String(x).toLowerCase().trim(); }).filter(Boolean), uniq = [];
      want.forEach(function (x) { if (uniq.indexOf(x) < 0) uniq.push(x); });
      if (uniq.join('、') !== t.teachers.join('、')) {
        if (!mgr) throw new Error('授課老師要請技士、科主任或管理者設定。');
        var known = schedEmails_(); uniq.forEach(function (x) { if (known.indexOf(x) < 0) throw new Error('找不到這位老師：' + x); });
        teachers = uniq;
      }
    }
    var rows = allTableRows_().filter(function (r) { return r[0] !== id; }), old = readTable_('教學進度表').filter(function (r) { return str_(r['表ID']) === id; })[0];
    rows.push(tableRow_({ id: id, term: term, dept: t.dept, course: t.course, classes: classes, groups: groups, title: t.title, creator: t.creator, ext: t.ext, teachers: teachers }, old ? str_(old['建立時間']) : ''));
    writeSched_('教學進度表', SCHED_TABLE_HEAD, rows);
    var oldDays = {}; t.classes.forEach(function (o) { oldDays[o.cls] = o.days; });
    var keep = [];
    cells.forEach(function (x) {                                                               // 上課日改了：不再上課的那幾天的格子拿掉；加練的日子留著
      if (x.tableId !== id) { keep.push(x); return; }
      var cl = classes.filter(function (cc) { return cc.cls === x.cls; })[0]; if (!cl) return;
      var od = oldDays[x.cls] || [], multi = cl.days.length > 1, d = x.day || 0;
      if (multi) { if (!d || (od.indexOf(d) >= 0 && cl.days.indexOf(d) < 0)) return; }
      else if (d) { if (d === cl.days[0]) x.day = 0; else if (od.indexOf(d) >= 0) return; }
      keep.push(x);
    });
    writeSched_('教學進度內容', SCHED_CELL_HEAD, keep.map(cellRow_));
    syncSchedule_(id, undefined, undefined, undefined, true);                                   // 上課日改了，日期跟著改
    var stray = 0; if (teachers.length) schedCells_().forEach(function (x) { if (x.tableId === id && x.cell.kind === 'lesson' && x.cell.groups.some(function (g) { return g.teacher && teachers.indexOf(g.teacher) < 0; })) stray++; });
  } finally { rtClear_(['應有進度表', '教學進度表', '教學進度內容', '排課']); lock.releaseLock(); }
  var res = apiScheduleGet();
  if (stray) res.notice = '有 ' + stray + ' 格還排給不在授課名單裡的老師，請改掉。他們已經有的材料單還在，但這張進度表不會再出現在他們那裡。';
  return res;
}
/* 寒暑假也要上課（例如技藝競賽選手）：在這張進度表另外加一段日期，那幾週排在學期的後面（或前面）。誰都可以加；已經排了課的週不能縮掉。 */
function apiScheduleSetExtra(tableId, from, to) {
  var me = whoami_(); schedGuard_(me);
  var term = setting_('目前學年學期', ''), d = semDates_();
  var t = schedTables_(term).filter(function (x) { return x.id === String(tableId); })[0];
  if (!t) throw new Error('找不到這張進度表。');
  assertCanEditTable_(me, t);
  from = String(from || ''); to = String(to || '');
  var ext = null;
  if (from || to) {
    if (!L_parseDate(from) || !L_parseDate(to) || to < from) throw new Error('請選寒暑假要排課的起訖日期（結束日不能比開始日早）。');
    if ((L_parseDate(L_weekStart(to)).t - L_parseDate(L_weekStart(from)).t) / 86400000 / 7 + 1 > 30) throw new Error('一次最多加 30 週。');
    ext = { from: from, to: to };
  }
  var oldW = tableWeeks_(t), keep = {}; L_weeksTable(t, d.start, d.end, ext).forEach(function (w) { keep[w.n] = 1; });
  var bad = {}; schedCells_().forEach(function (x) { if (x.tableId === t.id && !keep[x.week]) bad[x.week] = 1; });
  var badList = oldW.filter(function (w) { return bad[w.n]; }).map(function (w) { return w.label; });
  if (badList.length) throw new Error('這幾週已經排了課，不能縮掉：' + badList.join('、') + '。要縮短，請先清除那幾週的格子。');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var old = readTable_('教學進度表').filter(function (r) { return str_(r['表ID']) === t.id; })[0];
    var rows = allTableRows_().filter(function (r) { return r[0] !== t.id; });
    rows.push(tableRow_(Object.assign({}, t, { ext: ext }), old ? str_(old['建立時間']) : ''));
    writeSched_('教學進度表', SCHED_TABLE_HEAD, rows);
  } finally { rtClear_(); lock.releaseLock(); }
  return apiScheduleGet();
}
/* 把以前（或這學期別張）進度表的格子複製過來，不一定放在同一週。pairs：[{fw, fc, fd, tw, tc, td}] = 來源第幾週、哪個班、哪一天 → 貼到這張進度表的第幾週、哪個班、哪一天。
 * 已經有內容的格子，overwrite 不是 true 就跳過；老師不在名單、材料單已經不存在的，跳過並說明原因。 */
function apiScheduleImport(targetId, sourceId, pairs, overwrite, stageOnly) {
  var me = whoami_(); schedGuard_(me);
  var term = setting_('目前學年學期', '');
  var t = schedTables_(term).filter(function (x) { return x.id === String(targetId); })[0];
  if (!t) throw new Error('找不到這張進度表。');
  assertCanEditTable_(me, t);
  var srow = readTable_('教學進度表').filter(function (r) { return str_(r['表ID']) === String(sourceId); })[0];
  if (!srow) throw new Error('找不到要複製的那張進度表。');
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('沒有要複製的格子。');
  if (pairs.length > 600) throw new Error('一次最多複製 600 格。');
  var weeks = tableWeeks_(t), wok = {}; weeks.forEach(function (w) { wok[w.n] = w; });
  var users = schedEmails_(), products = loadCatalog_().products;
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  var copied = 0, skipped = [];
  try {
    var all = schedCells_(), src = all.filter(function (x) { return x.tableId === String(sourceId); }), mine = all.filter(function (x) { return x.tableId === t.id; });
    var keyOf = function (w, cl, d) { return w + '|' + cl + '|' + (d || 0); };
    var have = {}; mine.forEach(function (x) { have[keyOf(x.week, x.cls, x.day)] = x; });
    var srcMap = {}; src.forEach(function (x) { srcMap[keyOf(x.week, x.cls, x.day)] = x; });
    var put = {};
    pairs.forEach(function (p) {
      var s = srcMap[keyOf(Number(p.fw), String(p.fc), Number(p.fd) || 0)]; if (!s) return;
      var where = String(p.tc) + ' ' + (wok[Number(p.tw)] ? wok[Number(p.tw)].label : '第' + p.tw + '週');
      var tc = t.classes.filter(function (c) { return c.cls === String(p.tc); })[0];
      if (!tc) { skipped.push(where + '：這張進度表沒有這個班'); return; }
      if (!wok[Number(p.tw)]) { skipped.push(where + '：這一週不在這張進度表裡'); return; }
      var days = L_classDays(tc), multi = days.length > 1, day = Number(p.td) || 0;
      if (day < 0 || day > 7) { skipped.push(where + '：這一天不在一週裡'); return; }
      if (multi && !day) { skipped.push(where + '：這個班每天上課，要指定是哪一天'); return; }
      if (!multi && day === days[0]) day = 0;
      if (day > 0 && days.indexOf(day) < 0 && t.classes.length !== 1) { skipped.push(where + '：加練只有一個班的進度表才能用'); return; }
      var k = keyOf(Number(p.tw), tc.cls, day);
      if (have[k] && overwrite !== true) { skipped.push(where + '：已經有內容，沒有換掉'); return; }
      var clean; try { clean = L_cleanCell(s.cell, t, products, users, me.email, null); } catch (e) { skipped.push(where + '：' + e.message); return; }
      put[k] = { tableId: t.id, week: Number(p.tw), cls: tc.cls, day: day, cell: clean, by: me.email, at: nowStr_() };
    });
    Object.keys(put).forEach(function (k) { have[k] = put[k]; copied++; });
    if (stageOnly === true) return { copied: copied, skipped: skipped, staged: Object.keys(put).map(function (k) { return { week: put[k].week, cls: put[k].cls, day: put[k].day, cell: put[k].cell }; }) };      // 只整理好要貼的內容，還沒寫進去（等按「儲存」）
    if (copied) {
      writeSched_('教學進度內容', SCHED_CELL_HEAD, all.filter(function (x) { return x.tableId !== t.id; }).concat(Object.keys(have).map(function (k) { return have[k]; })).map(cellRow_));
      syncSchedule_(t.id);
    }
  } finally { rtClear_(); lock.releaseLock(); }
  return { copied: copied, skipped: skipped, data: apiScheduleGet() };
}
function apiScheduleDeleteTable(id) {
  requireAdmin_();
  var term = setting_('目前學年學期', '');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var rows = allTableRows_(), n = rows.length;
    rows = rows.filter(function (r) { return !(r[0] === String(id) && r[1] === term); });
    if (rows.length === n) throw new Error('找不到這張進度表。');
    writeSched_('教學進度表', SCHED_TABLE_HEAD, rows);
    writeSched_('教學進度內容', SCHED_CELL_HEAD, schedCells_().filter(function (x) { return x.tableId !== String(id); }).map(cellRow_));
    syncSchedule_(null);
  } finally { rtClear_(); lock.releaseLock(); }
  return apiScheduleGet();
}
/* 進度表改完，一次儲存（按「儲存」或「下一步」才生效）：changes = [{week, cls, day, cell（null = 清除）}]。
 * 在畫面上改的時候都還沒寫進去，所以老師看材料單的時候，不會因為別人正在編輯進度表就突然多出一張；按了儲存才會排給開單的老師。 */
function apiScheduleSaveCells(tableId, changes, force) {
  var me = whoami_(), term = setting_('目前學年學期', ''); schedGuard_(me);
  var t = schedTables_(term).filter(function (x) { return x.id === String(tableId); })[0];
  if (!t) throw new Error('找不到這張進度表。');
  assertCanEditTable_(me, t);
  if (!Array.isArray(changes) || !changes.length) throw new Error('沒有要儲存的格子。');
  if (changes.length > 800) throw new Error('一次最多儲存 800 格。');
  var weeks = tableWeeks_(t), wok = {}; weeks.forEach(function (w) { wok[w.n] = w; });
  var users = schedEmails_(), products = loadCatalog_().products, okPids = tablePids_(t.id), norm = [], keyOf = function (w, cl, d) { return w + '|' + cl + '|' + (d || 0); };
  changes.forEach(function (ch) {
    var w = Number(ch.week), cls = String(ch.cls), tc = t.classes.filter(function (c) { return c.cls === cls; })[0];
    var where = cls + ' ' + (wok[w] ? wok[w].label : '第 ' + w + ' 週');
    if (!wok[w]) throw new Error(where + '：這一週不在這張進度表裡。');
    if (!tc) throw new Error('這張進度表沒有「' + cls + '」。');
    var days = L_classDays(tc), multi = days.length > 1, day = Number(ch.day) || 0;
    if (day < 0 || day > 7) throw new Error(where + '：這一天不在一週裡。');
    if (multi && !day) throw new Error(where + '：這個班每天上課，要指定是哪一天。');
    if (!multi && day === days[0]) day = 0;
    if (day > 0 && days.indexOf(day) < 0 && t.classes.length !== 1) throw new Error(where + '：加練只有在這張進度表只有一個班的時候才能用。');
    var clean = null; if (ch.cell) { try { clean = L_cleanCell(ch.cell, t, products, users, me.email, okPids); } catch (e) { throw new Error(where + '：' + e.message); } }
    norm.push({ w: w, cls: cls, day: day, clean: clean, base: ch.base });
  });
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var all = schedCells_(), hit = {}; norm.forEach(function (n) { hit[keyOf(n.w, n.cls, n.day)] = 1; });
    if (force !== true) {                                                                       // 大家一起編輯：你打開之後，如果別人先改了同一格，先讓你知道，不要默默蓋掉
      var cur = {}; all.forEach(function (x) { if (x.tableId === t.id) cur[keyOf(x.week, x.cls, x.day)] = x; });
      var names = teacherNames_(), conflicts = [];
      norm.forEach(function (n) {
        var x = cur[keyOf(n.w, n.cls, n.day)], base = n.base;
        if (base === undefined || base === null) return;
        if ((x ? x.at : '') !== String(base)) conflicts.push({ week: n.w, cls: n.cls, day: n.day, where: n.cls + ' ' + (wok[n.w] ? wok[n.w].label : ''), by: x ? (names[x.by] || x.by) : '', at: x ? x.at : '', now: x ? L_cellSummary(x.cell, products, names) : '（已被清除）' });
      });
      if (conflicts.length) return { saved: 0, conflicts: conflicts };
    }
    var rows = all.filter(function (x) { return !(x.tableId === t.id && hit[keyOf(x.week, x.cls, x.day)]); }).map(cellRow_);
    norm.forEach(function (n) { if (n.clean) rows.push(cellRow_({ tableId: t.id, week: n.w, cls: n.cls, day: n.day, cell: n.clean, by: me.email, at: nowStr_() })); });
    writeSched_('教學進度內容', SCHED_CELL_HEAD, rows);
    syncSchedule_(t.id);
  } finally { rtClear_(['教學進度內容', '排課']); lock.releaseLock(); }
  return { saved: norm.length };
}
/* 存一格（cell 給 null = 清掉這格）。存好之後，這格的課會出現在開單老師的「排課備料」裡（待確認） */
function apiScheduleSaveCell(tableId, week, cls, cell, day) {
  var me = whoami_(), term = setting_('目前學年學期', ''); schedGuard_(me);
  var tables = schedTables_(term), t = tables.filter(function (x) { return x.id === String(tableId); })[0];
  if (!t) throw new Error('找不到這張進度表。');
  var weeks = tableWeeks_(t), w = Number(week);
  if (!weeks.some(function (x) { return x.n === w; })) throw new Error('這一週不在學期裡。請先設定開學日和結業式。要排寒暑假，先在進度表按「加寒暑假的週」。');
  assertCanEditTable_(me, t);
  var tc = t.classes.filter(function (c) { return c.cls === cls; })[0];
  if (!tc) throw new Error('這張進度表沒有「' + cls + '」。');
  var days = L_classDays(tc), multi = days.length > 1; day = Number(day) || 0;
  if (day < 0 || day > 7) throw new Error('這一天不在一週裡。');
  if (multi && !day) throw new Error('這一天不是「' + cls + '」的上課日。');
  if (!multi && day === days[0]) day = 0;                                                       // 只有一天上課的班，平常那一天的格子存成 0
  if (day > 0 && days.indexOf(day) < 0 && t.classes.length !== 1) throw new Error('加練（平常上課日以外的一天）只有在這張進度表只有一個班的時候才能用。');
  var clean = cell ? L_cleanCell(cell, t, loadCatalog_().products, schedEmails_(), me.email, tablePids_(t.id)) : null;
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var rows = schedCells_().filter(function (x) { return !(x.tableId === t.id && x.week === w && x.cls === cls && (x.day || 0) === day); }).map(cellRow_);
    if (clean) rows.push(cellRow_({ tableId: t.id, week: w, cls: cls, day: day, cell: clean, by: me.email, at: nowStr_() }));
    writeSched_('教學進度內容', SCHED_CELL_HEAD, rows);
    syncSchedule_(t.id, w, cls, day);
  } finally { rtClear_(['教學進度內容', '排課']); lock.releaseLock(); }
  return { saved: true };
}
/* 把進度表排的課，同步成每位老師的排課（待確認）。tableId／weekN／cls 給了就只處理那一部分。呼叫的人要先拿到鎖。 */
function syncSchedule_(tableId, weekN, cls, day, force) {
  var term = setting_('目前學年學期', ''), cat = loadCatalog_();
  var scoped = day !== undefined && day !== null;                                        // 只同步某一天的格子（0 = 一般上課日，1~7 = 每天上課的班的那一天或加練的一天）
  var tables = schedTables_(term), cells = schedCells_(), specs = {};
  tables.filter(function (t) { return !tableId || t.id === tableId; }).forEach(function (t) {
    var wmap = {}; tableWeeks_(t).forEach(function (w) { wmap[w.n] = w; });
    cells.forEach(function (x) {
      if (x.tableId !== t.id || (weekN !== undefined && weekN !== null && x.week !== weekN) || (cls && x.cls !== cls) || (scoped && (x.day || 0) !== day)) return;
      var w = wmap[x.week]; if (!w || x.cell.kind !== 'lesson') return;
      L_scheduleDerive(t, w, x.cls, x.cell, cat.products, x.day || 0).forEach(function (sp) { specs[sp.sid] = sp; });
    });
  });
  var prefix = tableId ? tableId + '|' + (weekN !== undefined && weekN !== null ? weekN + '|' + (cls ? cls + '|' : '') : '') : '';
  var plans = readPlans_(), out = [], have = {}, now = nowStr_();
  plans.forEach(function (e) {
    var inScope = e.term === term && e.sid && (tableId ? e.sid.indexOf(prefix) === 0 : true) && (!scoped || (day > 0 ? e.sid.slice(-('|d' + day).length) === '|d' + day : e.sid.split('|').length === 5));
    if (!inScope) { out.push(e); return; }
    var sp = specs[e.sid];
    if (!sp || sp.teacher !== e.teacher) { logDelete_('教學進度表（進度表改了）', e); return; }
    e.dept = sp.dept; e.course = sp.course; e.cls = sp.cls; e.group = sp.group;
    if (force || sp.day || L_weekStart(e.date) !== L_weekStart(sp.date)) e.date = sp.date;                 // 老師自己挪到同一週的別天，不動他（每天上課的班，日期跟著進度表）
    have[e.sid] = 1; out.push(e);
  });
  Object.keys(specs).forEach(function (sid) {
    if (have[sid]) return;
    var sp = specs[sid], p = cat.products[sp.pid];
    out.push({ id: Utilities.getUuid().slice(0, 8), term: term, teacher: sp.teacher, pid: sp.pid, date: sp.date, dept: sp.dept, cls: sp.cls, course: sp.course, sets: p.dsets || 4, scale: 1,
               yFrom: null, yTo: null, yUnit: '', tools: null, extra: [], omit: [], title: '', conv: {}, ov: {}, sid: sid, group: sp.group, draft: true, created: now, updated: now });
  });
  flushPlanRows_(ss_().getSheetByName('排課'), out.map(function (e) { return planRow_(e, e.created, e.updated); }));
}
/* 教學進度表文件（匯出材料單的第一頁）。highlight = 要用螢光筆標出來的老師（他自己上的格子） */
/* 教學進度表先匯出列印（拿去跟老師們討論）：不用送給技士，也不用先儲存——畫面上還沒儲存的修改（overlay）也會印進去。
 * tableIds：要哪幾張（不給 = 你看得到的全部）；overlay：{表ID: [{week, cls, day, cell（null = 清除）}]}；mine = true 就把「你開單」的格子標黃色；
 * blank = true：印空白的格式（週次、日期、班級、分組都在，格子是空的、列高比較高），拿去用紙本討論、手寫。 */
function apiExportScheduleTables(tableIds, overlay, mine, blank, a5, a6) {
  var opts = a6 === undefined ? null : a5, fmt = a6 === undefined ? a5 : a6;       // 技藝競賽選手可以多帶 {from, to, per}（選哪幾週、一頁幾週）
  var me = whoami_(), term = setting_('目前學年學期', ''), want = Array.isArray(tableIds) ? tableIds.map(String) : [];
  var tables = schedTables_(term).filter(function (t) { return canSeeTable_(me, t) && (!want.length || want.indexOf(t.id) >= 0) && tableWeeks_(t).length; })
    .sort(function (a, b) { return (a.dept + a.course) < (b.dept + b.course) ? -1 : (a.dept + a.course) > (b.dept + b.course) ? 1 : 0; });
  if (!tables.length) throw new Error('沒有可以匯出的進度表（學期的開學日還沒設定，或沒有你能看的進度表）。');
  var cells = schedCells_(), names = teacherNames_(), cat = loadCatalog_(), users = schedEmails_(), printed = Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd');
  overlay = overlay || {};
  var docs = tables.map(function (t, i) {
    var map = {}, wk = {}; tableWeeks_(t).forEach(function (w) { wk[w.n] = 1; });
    if (blank !== true) cells.forEach(function (x) { if (x.tableId === t.id) map[L_cellKey(x.week, x.cls, x.day || 0)] = x.cell; });
    (blank !== true && Array.isArray(overlay[t.id]) ? overlay[t.id] : []).forEach(function (ch) {                    // 還沒儲存的修改疊上去；不合規則的略過
      var w = Number(ch && ch.week), cls = String(ch && ch.cls || ''), tc = t.classes.filter(function (c) { return c.cls === cls; })[0], day = Number(ch && ch.day) || 0;
      if (!wk[w] || !tc || day < 0 || day > 7) return;
      var days = L_classDays(tc); if (days.length === 1 && day === days[0]) day = 0; if (days.length > 1 && !day) return;
      var key = L_cellKey(w, cls, day);
      if (!ch.cell) { delete map[key]; return; }
      try { map[key] = L_cleanCell(ch.cell, t, cat.products, users, me.email, tablePids_(t.id)); } catch (e) { /* 這格的內容有問題，不印 */ }
    });
    return L_docSchedule(t, tableWeeks_(t), map, { term: term, names: names, products: cat.products, highlight: blank !== true && mine === true ? me.email : '', printed: printed, rowH: blank === true ? 44 : 0, n: tables.length > 1 ? String(i + 1) : '', athRows: athRowsOf_((function (o) { o[t.id] = 1; return o; })({}))[t.id], from: opts && opts.from, to: opts && opts.to, per: opts && opts.per });
  });
  docs = [].concat.apply([], docs);
  return buildXlsx_((blank === true ? '教學進度表（空白格式）_' : '教學進度表（討論用）_') + term, docs, fmt);
}
function schedDocs_(tableIds, highlight) {
  var term = setting_('目前學年學期', '');
  var tables = schedTables_(term).filter(function (t) { return tableIds.indexOf(t.id) >= 0 && tableWeeks_(t).length; }), cells = schedCells_(), names = teacherNames_(), cat = loadCatalog_();
  var printed = Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd');
  if (!tables.length) return [];
  var out = tables.map(function (t, i) {
    var map = {};
    cells.forEach(function (x) { if (x.tableId === t.id) map[L_cellKey(x.week, x.cls, x.day || 0)] = x.cell; });
    return L_docSchedule(t, tableWeeks_(t), map, { term: term, names: names, products: cat.products, highlight: highlight, printed: printed, n: tables.length > 1 ? String(i + 1) : '', athRows: athRowsOf_((function (o) { o[t.id] = 1; return o; })({}))[t.id] });
  });
  return [].concat.apply([], out);
}

/* 教學進度表每一堂課，現在是「已送出」、「待確認」（排給老師了、老師還沒確認送出）還是「沒有人」（排課被刪掉了）。
 * start、end 都給空字串 = 整個學期。技士、科主任、管理者用來看同一門課哪些老師還沒送。 */
function apiScheduleStatus(start, end) {
  requireStaff_();
  start = String(start || ''); end = String(end || '');
  if ((start || end) && (!L_parseDate(start) || !L_parseDate(end) || end < start)) throw new Error('日期不正確。');
  var term = setting_('目前學年學期', ''), weeks = L_weeks(setting_('開學日 ' + term, ''), setting_('結業式 ' + term, '')), tables = schedTables_(term), ids = {};
  tables.forEach(function (t) { ids[t.id] = 1; });
  var plans = readPlans_().filter(function (e) { return e.term === term; });
  var allCells = schedCells_();
  return { term: term, start: start, end: end, items: L_scheduleStatus(tables, allCells.filter(function (x) { return ids[x.tableId]; }), weeks, plans, loadCatalog_().products, teacherNames_(), start, end, tableWeeks_), required: requiredStatus_(term, tables, allCells, weeks),
           tinfo: tables.map(function (t) { return { id: t.id, teachers: (t.teachers || []).map(function (em) { var nm = teacherNames_(); return { email: em, name: nm[em] || em.split('@')[0] }; }) }; }) };
}
/* 進度表有排、但排課不見了（例如被刪掉）的課，重新補給開單的老師（待確認） */
function apiScheduleRepair() {
  requireAdmin_();
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try { syncSchedule_(null); } finally { rtClear_(); lock.releaseLock(); }
  return apiScheduleStatus('', '');
}

/* ---------------- 叫出以前的紀錄 ---------------- */
/* 這位老師以前（不管哪個學期）這個產品改過的紀錄，最新的在前面；老師可以挑一筆，沿用到這一堂 */
function apiHistory(pid) {
  var me = whoami_(), list = readPlans_().filter(function (e) { return e.teacher === me.email && e.pid === String(pid) && !e.draft && L_customized(e); });
  list.sort(function (a, b) { return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0; });
  return list.slice(0, 12).map(function (e) {
    return { id: e.id, term: e.term, date: e.date, cls: e.cls, course: e.course, group: e.group, title: e.title, sets: e.sets, scale: e.scale, yFrom: e.yFrom, yTo: e.yTo, yUnit: e.yUnit,
             ov: e.ov, extra: e.extra, omit: e.omit, conv: e.conv, tools: e.tools, updated: e.updated };
  });
}

/* ---------------- 額外材料單（不在教學進度表裡的臨時活動）：平常關閉，技士要開放，老師才能送 ---------------- */
function extraOpen_() { return setting_('開放額外材料單', '否') === '是'; }
function apiSetExtraOpen(open) {
  var me = requireAdmin_(), on = open === true || open === '是';
  setSetting_('開放額外材料單', on ? '是' : '否');
  var note = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss') + ' ' + me.name + (on ? ' 開放' : ' 關閉');
  setSetting_('開放額外材料單更新', note);
  return { open: on, note: note };
}

/* ---------------- 開啟／關閉「老師送材料單」 ---------------- */
function submissionOpen_() { return setting_('開放老師送單', '是') !== '否'; }
/* 總開關關閉時，可以「單獨開放」某幾位老師：他們還是能新增、修改、送單 */
function openTeachers_() { return String(setting_('單獨開放老師', '') || '').split(/[,;\s]+/).map(function (x) { return x.toLowerCase().trim(); }).filter(Boolean); }
function teacherLocked_(me) { return me.role === '老師' && !me.actBy && !submissionOpen_() && openTeachers_().indexOf(me.email) < 0; }
function apiSetTeacherOpen(email, on) {
  var me = requireAdmin_(), em = String(email || '').toLowerCase().trim();
  if (!em) throw new Error('請選一位老師。');
  var list = openTeachers_().filter(function (x) { return x !== em; });
  if (on === true || on === '是') list.push(em);
  setSetting_('單獨開放老師', list.join(','));
  setSetting_('開放老師送單更新', Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss') + ' ' + me.name + (on ? ' 單獨開放 ' : ' 取消單獨開放 ') + (teacherNames_()[em] || em));
  return { list: list, note: setting_('開放老師送單更新', '') };
}
/* 關閉之後老師不能新增、修改、送出（還是可以下載已送出的材料單）；技士、科主任、管理者不受影響。 */
function apiSetSubmissionOpen(open) {
  var me = requireAdmin_(), on = open === true || open === '是';
  setSetting_('開放老師送單', on ? '是' : '否');
  var note = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss') + ' ' + me.name + (on ? ' 開啟' : ' 關閉');
  setSetting_('開放老師送單更新', note);
  return { open: on, note: note };
}

/* ---------------- 材料單分類（除了一、二、三年級，可以自己加分類） ---------------- */
var BUILTIN_CATS = ['一年級', '二年級', '三年級', '共用', '自創'];
var GRADE_CATS = ['一年級', '二年級', '三年級'];   // 材料單也可以被移到別的年級，或把新增的產品放進年級
var GRADE_KEYS = ['一', '二', '三'];
/* 一、二、三年級的顯示名稱可以在後台改（例如改成「基礎班」）；沒改就是原本的名字 */
function gradeNames_() {
  var out = {};
  GRADE_KEYS.forEach(function (g) { out[g] = setting_(g + '年級名稱', '') || (g + '年級'); });
  return out;
}
function catName_(v) { return L_safeText(v, 10).replace(/[、,，]/g, ''); }
function categories_() {
  var v = setting_('自訂分類', ''), out = [];
  v.split(/[、,，\s]+/).filter(Boolean).forEach(function (n) { if (out.indexOf(n) < 0 && BUILTIN_CATS.indexOf(n) < 0) out.push(n); });
  return out;
}
function catSheet_() {
  var sh = ss_().getSheetByName('材料單分類指定');
  if (!sh) { sh = ss_().insertSheet('材料單分類指定'); sh.getRange(1, 1, 1, 2).setValues([['產品編號', '分類']]); }
  return sh;
}
function readCatMap_() {
  var out = {};
  var rows0; try { rows0 = readTable_('材料單分類指定'); } catch (e) { return out; }
  rows0.forEach(function (r) { if (str_(r['產品編號'])) out[str_(r['產品編號'])] = str_(r['分類']); });
  return out;
}
function writeCatMap_(map) {
  var sh = catSheet_(), ids = Object.keys(map).filter(function (k) { return map[k]; });
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 2).clearContent();
  if (ids.length) sh.getRange(2, 1, ids.length, 2).setValues(ids.map(function (k) { return [k, map[k]]; }));
}
function apiAddCategory(name) {
  requireAdmin_();
  var n = catName_(name);
  if (!n) throw new Error('請填分類名稱。');
  if (BUILTIN_CATS.indexOf(n) >= 0) throw new Error('「' + n + '」已經有了。');
  var gn = gradeNames_();
  GRADE_KEYS.forEach(function (k) { if (gn[k] === n) throw new Error('「' + n + '」已經有了。'); });
  var list = categories_();
  if (list.indexOf(n) >= 0) throw new Error('「' + n + '」已經有了。');
  if (list.length >= 12) throw new Error('分類最多 12 個。');
  list.push(n); setSetting_('自訂分類', list.join('、'));
  return { categories: list };
}
/* 改名：分類、年級都可以。年級只是改顯示的名字，裡面的材料單不變。 */
function apiRenameCategory(oldName, newName) {
  requireAdmin_();
  var o = String(oldName || ''), n = catName_(newName), list = categories_();
  if (list.indexOf(o) < 0) throw new Error('找不到分類「' + o + '」。');
  if (!n) throw new Error('請填分類名稱。');
  if (n === o) return { categories: list };
  if (BUILTIN_CATS.indexOf(n) >= 0 || list.indexOf(n) >= 0) throw new Error('「' + n + '」已經有了。');
  var gn = gradeNames_();
  GRADE_KEYS.forEach(function (k) { if (gn[k] === n) throw new Error('「' + n + '」已經有了。'); });
  list = list.map(function (x) { return x === o ? n : x; });
  setSetting_('自訂分類', list.join('、'));
  var map = readCatMap_(); Object.keys(map).forEach(function (k) { if (map[k] === o) map[k] = n; });
  writeCatMap_(map);
  return { categories: list };
}
function apiRenameGrade(key, name) {
  requireAdmin_();
  var g = String(key || '');
  if (GRADE_KEYS.indexOf(g) < 0) throw new Error('找不到這個年級。');
  var n = catName_(name), cur = gradeNames_(), cats = categories_();
  if (n) {
    if (n === '共用' || n === '自創' || cats.indexOf(n) >= 0) throw new Error('「' + n + '」已經有了。');
    GRADE_KEYS.forEach(function (k) { if (k !== g && (cur[k] === n || (k + '年級') === n)) throw new Error('「' + n + '」已經有了。'); });
  }
  setSetting_(g + '年級名稱', n === (g + '年級') ? '' : n);            // 空白 = 用原本的名字
  return { gradeNames: gradeNames_() };
}
/* 刪掉分類：原本放在裡面的材料單會回到原本的年級（或共用），材料單本身不會不見。 */
function apiRemoveCategory(name) {
  requireAdmin_();
  var n = String(name || ''), list = categories_();
  if (list.indexOf(n) < 0) throw new Error('找不到分類「' + n + '」。');
  list = list.filter(function (x) { return x !== n; });
  setSetting_('自訂分類', list.join('、'));
  var map = readCatMap_(); Object.keys(map).forEach(function (k) { if (map[k] === n) delete map[k]; });
  writeCatMap_(map);
  return { categories: list };
}
/* 把某張材料單放進某個分類；category 給空字串 = 放回原本的地方 */
function apiSetCategory(pid, category) {
  requireAdmin_();
  var cat = loadCatalog_(), p = cat.products[str_(pid)], n = String(category || '');
  if (!p) throw new Error('找不到這張材料單。');
  if (p.custom && !p.shared) throw new Error('私人自創的材料單不能放進分類（要先設成共用）。');
  if (n && categories_().indexOf(n) < 0 && GRADE_CATS.indexOf(n) < 0) throw new Error('找不到分類「' + n + '」。');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { var map = readCatMap_(); if (n) map[p.pid] = n; else delete map[p.pid]; writeCatMap_(map); } finally { rtClear_(); lock.releaseLock(); }
  return { pid: p.pid, category: n };
}

/* ---------------- 誰送單了 ---------------- */
function apiSubmissions(start, end) {
  requireStaff_(); rangeCheck_(start, end);
  var users = readTable_('使用者').map(function (u) {
    var r = str_(u['角色']).trim(); if (r === '主任') r = '科主任';
    return { email: str_(u['信箱']).toLowerCase().trim(), name: str_(u['姓名']), role: ['老師', '技士', '科主任', '管理者'].indexOf(r) >= 0 ? r : '老師' };
  }).filter(function (u) { return u.email; });
  return { term: setting_('目前學年學期', ''), rows: L_submissionStatus(readPlans_(), users, setting_('目前學年學期', ''), start, end) };
}

function rangeCheck_(start, end) {
  var a = L_parseDate(start), b = L_parseDate(end);
  if (!a || !b) throw new Error('日期不正確。');
  if (b.t < a.t) throw new Error('結束日期不能比開始日期早。');
}

/* 技士、科主任、管理者看任何一段日期：統計 + 逐堂課的材料單。teacherEmail 不填就是全部老師。 */
function apiTechRange(start, end, teacherEmail, filter, order) {
  requireStaff_(); rangeCheck_(start, end);
  return L_rangeAggregate(readSent_(), loadCatalog_(), start, end, teacherNames_(), String(teacherEmail || '').toLowerCase(), filter, ordNorm_(order));
}
function apiTechWeek(anyDateInWeek, teacherEmail) {                      // 舊版相容：一週
  var ws = L_weekStart(anyDateInWeek); return apiTechRange(ws, L_addDays(ws, 6), teacherEmail);
}

/* 匯出這段日期的總表（統計） */
function apiExportRange(start, end, teacherEmail, filter, order, fmt) {
  var agg = apiTechRange(start, end, teacherEmail, filter, order);
  if (!agg.classes.length) throw new Error('這段日期沒有排課。');
  return buildXlsx_('備料總表_' + agg.start + '_' + agg.end, L_docWeek(agg), fmt);
}
function apiExportWeek(anyDateInWeek, teacherEmail) { var ws = L_weekStart(anyDateInWeek); return apiExportRange(ws, L_addDays(ws, 6), teacherEmail); }

/* 匯出這段日期每一堂課的材料申請單（跟老師匯出的一樣，A4 一堂課一張） */
function apiExportRangeSheets(start, end, teacherEmail, filter, order, fmt) {
  requireStaff_(); rangeCheck_(start, end);
  var names = teacherNames_(), only = String(teacherEmail || '').toLowerCase(), cat = loadCatalog_(), f = L_cleanFilter(filter);
  var list = readSent_().filter(function (e) { return e.date >= start && e.date <= end && (!only || e.teacher === only) && L_entryMatches(e, f, cat); })
    .map(function (e) { e.teacherName = names[e.teacher] || e.teacher; return e; });
  if (!list.length) throw new Error('這段日期沒有排課。');
  var ids = {};
  list.forEach(function (e) { if (e.sid) ids[e.sid.split('|')[0]] = 1; });
  return buildXlsx_((L_hasFilter(f) ? '材料申請單（部分）_' : '材料申請單_') + start + '_' + end, (L_hasFilter(f) ? [] : schedDocs_(Object.keys(ids), '')).concat(L_docRequisition(list, cat, { order: ordNorm_(order) })),fmt, ordNorm_(order));      // 只匯出某一部分的時候，不放教學進度表那一頁
}
/* 整個學期、所有老師：進度表 + 每一堂課的材料申請單（跟老師匯出的格式一樣）。技士、科主任、管理者用。只有老師已經送出的課。 */
function apiExportTerm(order, fmt) {
  requireStaff_();
  var d = semDates_();
  if (!d.start || !d.end) throw new Error('學期的開學日、結業式還沒設定，請先到「教學進度表」設定日期。');
  return apiExportRangeSheets(d.start, d.end, '', null, order, fmt);
}
/* 匯出指定學期（以前的學期也可以）整學期、全部老師的材料單 */
function apiExportTermOf(term, order, fmt) {
  requireStaff_();
  term = String(term || '');
  if (!/^\d{3}-[12]$/.test(term)) throw new Error('學期不正確。');
  var st = setting_('開學日 ' + term, ''), en = setting_('結業式 ' + term, '');
  if (!st || !en) throw new Error(term + ' 沒有設定開學日、結業式，請改用「每週材料總量」自己選日期範圍匯出。');
  return apiExportRangeSheets(st, en, '', null, order, fmt);
}
/* 匯出估價單：rec = { date: 送貨日期, purpose: 用途備註, items: [{name, qty, unit, note}] } */
function apiExportQuote(rec, fmt) {
  requireStaff_(); rec = rec || {};
  if (!L_parseDate(rec.date)) throw new Error('請選送貨日期。');
  var items = (Array.isArray(rec.items) ? rec.items : []).map(function (x) {
    var uses = (x && Array.isArray(x.uses) ? x.uses : []).map(function (u) { return { date: String(u && u.date || ''), teacher: L_safeText(u && u.teacher, 20), titles: (Array.isArray(u && u.titles) ? u.titles : []).slice(0, 12).map(function (t) { return L_safeText(t, 30); }), qty: Number(u && u.qty) }; });
    return { name: L_safeText(x && x.name, 40), qty: Number(x && x.qty), unit: L_safeText(x && x.unit, 8), note: L_safeText(x && x.note, 30), uses: uses };
  }).filter(function (x) { return x.name && isFinite(x.qty) && x.qty > 0; });
  if (!items.length) throw new Error('請至少勾一項要請購的，數量要大於 0。');
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var doc = L_docQuote({ date: rec.date, today: today, purpose: L_safeText(rec.purpose, 30), items: items });
  var out = buildXlsx_('估價單_' + String(rec.date).replace(/-/g, ''), [doc], fmt);
  var model = L_splitModel(items);
  if (!model.length || (rec.both && fmt === 'pdf')) return out;       // 兩種格式都要時，分配單只在第一次（xlsx）附上
  var sname = '分配單_' + String(rec.date).replace(/-/g, '');         // 附給廠商的分配單（Word）：每個上課日期一張表
  var blobs = L_docxSplitFiles(model).map(function (f) { return Utilities.newBlob(f.xml, 'application/xml', f.name); });
  var dx = { name: sname + '.docx', base64: Utilities.base64Encode(Utilities.zip(blobs, sname + '.docx').getBytes()) };
  return { files: (out.files || [out]).concat([dx]) };
}
function apiExportWeekSheets(anyDateInWeek, teacherEmail, order) { var ws = L_weekStart(anyDateInWeek); return apiExportRangeSheets(ws, L_addDays(ws, 6), teacherEmail, null, order); }

/* 刪除老師開錯的課。技士、科主任、管理者都可以；會留一筆紀錄在「排課刪除紀錄」分頁。 */
function apiDeletePlanEntry(id) {
  var me = requireAdmin_(), lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = ss_().getSheetByName('排課');
    if (!sh) throw new Error('試算表裡找不到分頁「排課」');
    var plans = readPlans_(), gone = null, keep = [];
    plans.forEach(function (e) { if (!gone && e.id === str_(id)) gone = e; else keep.push(e); });
    if (!gone) throw new Error('找不到這堂課（可能已經被刪掉了）。');
    flushPlanRows_(sh, keep.map(function (e) { return planRow_(e, e.created, e.updated); }));
    logDelete_(me.email, gone);
    return { deleted: true, teacher: gone.teacher, date: gone.date };
  } finally { rtClear_(); lock.releaseLock(); }
}

/* ---------------- 做出 xlsx 檔（自己組，A4 直印，跟原本的申請單一樣） ---------------- */
/* 匯出一個檔案；依課程排序時（order = 'class'），每一門課各自一個檔（Excel 活頁簿或 PDF），進度表放在該課程那份的最前面 */
function buildXlsx_(name, docs, fmt, order) {
  if (order === 'class' || order === 'course') {
    var keys = [], by = {};
    docs.forEach(function (d) { var k = d.group || ''; if (!by[k]) { by[k] = []; keys.push(k); } by[k].push(d); });
    if (keys.length > 1) return { files: keys.map(function (k) { return buildOne_(name + '_' + String(k).replace(/[\\\/:*?"<>|]/g, ''), by[k], fmt); }) };
  }
  return buildOne_(name, docs, fmt);
}
function buildOne_(name, docs, fmt) {
  if (fmt === 'pdf') return { name: name + '.pdf', html: L_docsToHtml(docs) };   // PDF 由使用者的瀏覽器轉（用電腦上的標楷體；Google 伺服器沒有標楷體）
  var files = L_xlsxFiles(docs);
  var blobs = files.map(function (f) { return f.b64 ? Utilities.newBlob(Utilities.base64Decode(f.b64), 'image/jpeg', f.name) : Utilities.newBlob(f.xml, 'application/xml', f.name); });
  var zip = Utilities.zip(blobs, name + '.xlsx');
  return { name: name + '.xlsx', base64: Utilities.base64Encode(zip.getBytes()) };
}


/* ---------------- 後台：使用者管理（技士、科主任、管理者） ---------------- */
var USER_HEAD_ = ['信箱', '姓名', '角色'];
var ROLES_ = ['老師', '技士', '科主任', '管理者'];
function usersSheet_() {
  var sh = ss_().getSheetByName('使用者');
  if (!sh) { sh = ss_().insertSheet('使用者'); sh.getRange(1, 1, 1, 3).setValues([USER_HEAD_]); }
  return sh;
}
function normRole_(r) { r = str_(r).trim(); if (r === '主任') r = '科主任'; return ROLES_.indexOf(r) >= 0 ? r : '老師'; }
function validEmail_(e) { return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e); }
/* 誰可以指派什麼角色：技士只能新增、修改老師和技士；科主任、管理者可以指派所有角色 */
function canGrant_(me, role) { return role === '老師' || role === '技士' || me.role === '科主任' || me.role === '管理者'; }
function userRows_() {
  var sh = usersSheet_(), vals = sh.getDataRange().getValues(), head = (vals[0] || []).map(String);
  var ci = head.indexOf('信箱') < 0 ? 0 : head.indexOf('信箱'), cn = head.indexOf('姓名') < 0 ? 1 : head.indexOf('姓名'), cr = head.indexOf('角色') < 0 ? 2 : head.indexOf('角色');
  var out = [];
  for (var i = 1; i < vals.length; i++) {
    var em = str_(vals[i][ci]).toLowerCase().trim();
    if (em) out.push({ row: i + 1, email: em, name: str_(vals[i][cn]).trim(), role: normRole_(vals[i][cr]) });
  }
  return { sh: sh, rows: out, ci: ci + 1, cn: cn + 1, cr: cr + 1 };
}
function apiUsersList() {
  requireStaff_();
  return userRows_().rows.map(function (u) { return { email: u.email, name: u.name, role: u.role }; })
    .sort(function (a, b) { return ROLES_.indexOf(b.role) - ROLES_.indexOf(a.role) || a.name.localeCompare(b.name, 'zh-Hant'); });
}
/* 新增或修改一位使用者。oldEmail 有給就是修改那一位（信箱也可以改）。 */
function apiUserSave(u, oldEmail) {
  var me = requireStaff_();
  var email = str_(u && u.email).toLowerCase().trim(), name = str_(u && u.name).trim(), role = normRole_(u && u.role);
  if (!validEmail_(email)) throw new Error('信箱格式不對：' + email);
  if (!name) throw new Error('請填姓名。');
  if (name.length > 20) throw new Error('姓名太長了。');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var t = userRows_(), old = oldEmail ? String(oldEmail).toLowerCase().trim() : '', cur = null, dup = null;
    t.rows.forEach(function (r) { if (r.email === old) cur = r; if (r.email === email && r.email !== old) dup = r; });
    if (dup) throw new Error(email + ' 已經在名單裡了（' + dup.name + '）。');
    if (old && !cur) throw new Error('找不到要修改的那一位，請重新整理。');
    if (!canGrant_(me, role) || (cur && !canGrant_(me, cur.role))) throw new Error('只有科主任或管理者可以新增、修改科主任和管理者。');
    if (cur) {
      if (cur.email === me.email && role !== me.role && !canGrant_(me, role)) throw new Error('不能改自己的角色。');
      if (cur.role === '管理者' && role !== '管理者' && t.rows.filter(function (r) { return r.role === '管理者'; }).length <= 1) throw new Error('至少要留一位管理者。');
      t.sh.getRange(cur.row, t.ci, 1, 3).setValues([[email, name, role]]);
    } else {
      t.sh.appendRow([email, name, role]);
    }
  } finally { rtClear_(); lock.releaseLock(); }
  return apiUsersList();
}
function apiUserDelete(email) {
  var me = requireStaff_();
  email = String(email || '').toLowerCase().trim();
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var t = userRows_(), cur = null;
    t.rows.forEach(function (r) { if (r.email === email) cur = r; });
    if (!cur) throw new Error('名單裡沒有這個信箱，請重新整理。');
    if (cur.email === me.email) throw new Error('不能刪掉自己。');
    if (!canGrant_(me, cur.role)) throw new Error('只有科主任或管理者可以刪除科主任和管理者。');
    if (cur.role === '管理者' && t.rows.filter(function (r) { return r.role === '管理者'; }).length <= 1) throw new Error('至少要留一位管理者。');
    t.sh.deleteRow(cur.row);
  } finally { rtClear_(); lock.releaseLock(); }
  return apiUsersList();
}
/* 一次貼上很多位：每行「姓名 信箱 角色」，用逗號、空白或 Tab 隔開，角色不寫就是老師。已經在名單裡的信箱會略過。 */
function apiUsersBulkAdd(text) {
  var me = requireStaff_();
  var lines = String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  if (!lines.length) throw new Error('請先貼上名單。');
  if (lines.length > 200) throw new Error('一次最多 200 行。');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  var added = 0, skipped = [], bad = [];
  try {
    var t = userRows_(), have = {}; t.rows.forEach(function (r) { have[r.email] = 1; });
    var add = [];
    lines.forEach(function (l) {
      var parts = l.split(/[,\t，、\s]+/).filter(Boolean), email = '', name = '', role = '老師';
      parts.forEach(function (p) {
        if (p.indexOf('@') >= 0) email = p.toLowerCase();
        else if (ROLES_.indexOf(p) >= 0 || p === '主任') role = normRole_(p);
        else if (!name) name = p;
      });
      if (!validEmail_(email) || !name) { bad.push(l); return; }
      if (have[email]) { skipped.push(email); return; }
      if (!canGrant_(me, role)) { bad.push(l + '（你不能指派這個角色）'); return; }
      have[email] = 1; add.push([email, name, role]);
    });
    if (add.length) { var r0 = Math.max(t.sh.getLastRow(), 1) + 1; t.sh.getRange(r0, 1, add.length, 3).setValues(add); added = add.length; }
  } finally { rtClear_(); lock.releaseLock(); }
  return { users: apiUsersList(), added: added, skipped: skipped, bad: bad };
}


/* ---------------- 後台：刪除本學期所有資料（測試完要重來用） ---------------- */
/* 技士、科主任、管理者都可以用（老師不行）。刪掉：本學期所有老師的排課／送出的材料單／草稿、教學進度表格子裡排的內容。
 * 保留：使用者名單、材料單與分類、設定、「每學期要有哪些進度表」的課程和班級（授課老師會清掉）。刪之前先把內容存一份到「刪除前備份」分頁，保留 30 天，這段時間內可以在後台按「還原」。 */
function apiResetTerm(confirmText) {
  var me = requireStaff_();
  if (String(confirmText || '') !== '刪除本學期資料') throw new Error('請輸入「刪除本學期資料」才能刪除。');
  var term = setting_('目前學年學期', '');
  if (!term) throw new Error('找不到目前的學年學期。');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var book = ss_(), now = nowStr_(), backup = [], counts = { plans: 0, cells: 0 };
    try { resetPurge_(book.getSheetByName('刪除前備份')); } catch (e) {}
    function pick_(sheetName, test) {
      var sh = book.getSheetByName(sheetName);
      if (!sh || sh.getLastRow() < 2) return [];
      var vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues(), rows = [];
      for (var i = 1; i < vals.length; i++) if (test(vals[i], vals[0])) rows.push(i + 1);
      rows.forEach(function (r) { backup.push([now, me.email, term, sheetName, JSON.stringify(vals[r - 1].map(function (v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss') : v; }))]); });
      return rows;
    }
    function del_(sheetName, rows) {
      var sh = book.getSheetByName(sheetName);
      for (var k = rows.length - 1; k >= 0; ) {            // 從最後面往前刪，連續的一次刪掉
        var end = rows[k], start = end; k--;
        while (k >= 0 && rows[k] === start - 1) { start = rows[k]; k--; }
        sh.deleteRows(start, end - start + 1);
      }
    }
    var tableIds = {}; schedTables_(term).forEach(function (t) { tableIds[t.id] = 1; });
    var planRows = pick_('排課', function (r, h) { return str_(r[h.indexOf('學年學期')]) === term; });
    var cellRows = pick_('教學進度內容', function (r, h) { return !!tableIds[str_(r[h.indexOf('表ID')])]; });
    var tchCleared = 0;
    ['應有進度表', '教學進度表'].forEach(function (name) {          // 授課老師也一起清掉（讓管理者重新選）；原本的那一列先備份，還原時會放回去
      var sh = book.getSheetByName(name);
      if (!sh || sh.getLastRow() < 2) return;
      var rng = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()), vals = rng.getValues(), h = vals[0], ci = h.indexOf('班級'), ti = h.indexOf('授課老師'), ki = h.indexOf('學年學期'), changed = false;
      for (var i = 1; i < vals.length; i++) {
        if (name === '教學進度表' && ki >= 0 && str_(vals[i][ki]) !== term) continue;
        var cl = ci >= 0 ? jparse_(vals[i][ci], null) : null, had = ti >= 0 && str_(vals[i][ti]) !== '';
        if (Array.isArray(cl)) cl.forEach(function (c) { if (c && c.teachers && c.teachers.length) had = true; });
        if (!had) continue;
        backup.push([now, me.email, term, name, JSON.stringify(vals[i].map(function (v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss') : v; }))]);
        if (Array.isArray(cl)) { cl.forEach(function (c) { if (c) delete c.teachers; }); vals[i][ci] = JSON.stringify(cl); }
        if (ti >= 0) vals[i][ti] = '';
        changed = true; tchCleared++;
      }
      if (changed) rng.setValues(vals);
    });
    if (backup.length) {
      var bk = book.getSheetByName('刪除前備份');
      if (!bk) { bk = book.insertSheet('刪除前備份'); bk.getRange(1, 1, 1, 5).setValues([['備份時間', '刪除者', '學年學期', '來源分頁', '那一列的內容（JSON）']]); }
      bk.getRange(Math.max(bk.getLastRow(), 1) + 1, 1, backup.length, 5).setNumberFormat('@').setValues(backup);
    }
    if (planRows.length) del_('排課', planRows);
    if (cellRows.length) del_('教學進度內容', cellRows);
    counts.plans = planRows.length; counts.cells = cellRows.length; counts.teachers = tchCleared;
    try { CacheService.getScriptCache().removeAll([]); } catch (e) {}
    return { term: term, plans: counts.plans, cells: counts.cells, teachers: counts.teachers };
  } finally { rtClear_(); lock.releaseLock(); }
}

/* 刪除前備份：保留 30 天，這段時間內可以還原。超過 30 天的備份在下次列出或刪除時自動清掉。 */
var RESET_KEEP_DAYS_ = 30;
function bkStamp_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss') : String(v); }
function resetPurge_(bk) {
  if (!bk || bk.getLastRow() < 2) return;
  var cut = Utilities.formatDate(new Date(Date.now() - RESET_KEEP_DAYS_ * 86400000), TZ, 'yyyy-MM-dd HH:mm:ss');
  var vals = bk.getRange(2, 1, bk.getLastRow() - 1, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) if (bkStamp_(vals[i][0]) < cut) bk.deleteRow(i + 2);
}
function apiResetBackups() {
  requireStaff_();
  var bk = ss_().getSheetByName('刪除前備份');
  if (!bk || bk.getLastRow() < 2) return [];
  resetPurge_(bk);
  if (bk.getLastRow() < 2) return [];
  var vals = bk.getRange(2, 1, bk.getLastRow() - 1, 5).getValues(), g = {}, out = [];
  vals.forEach(function (r) {
    var k = bkStamp_(r[0]), x = g[k];
    if (!x) { x = g[k] = { stamp: k, by: String(r[1]), term: String(r[2]), plans: 0, cells: 0 }; out.push(x); }
    if (r[3] === '排課') x.plans++; else if (r[3] === '教學進度內容') x.cells++; else x.tch = (x.tch || 0) + 1;
  });
  var now = Date.now();
  out.forEach(function (x) { x.daysLeft = Math.max(0, RESET_KEEP_DAYS_ - Math.floor((now - new Date(x.stamp.replace(' ', 'T') + '+08:00').getTime()) / 86400000)); });
  return out.reverse();
}
/* 還原：mode='fill'＝只補回現在還是空的（同一堂課、同一格、已經重新選好的授課老師都不動）；mode='replace'＝先清掉這學期現有的排課和進度表內容，整份換回刪除前的樣子 */
function resetPlan_(stamp, mode) {
  var book = ss_(), bk = book.getSheetByName('刪除前備份');
  if (!bk || bk.getLastRow() < 2) throw new Error('找不到這份備份（可能已超過 30 天被清掉）。');
  var vals = bk.getRange(2, 1, bk.getLastRow() - 1, 5).getValues(), mine = [];
  for (var i = 0; i < vals.length; i++) if (bkStamp_(vals[i][0]) === stamp) mine.push({ row: i + 2, sheet: String(vals[i][3]), data: jparse_(vals[i][4], null) });
  if (!mine.length) throw new Error('找不到這份備份（可能已超過 30 天被清掉）。');
  var term = String(vals[mine[0].row - 2][2]), plan = { mine: mine, term: term, bk: bk, add: { '排課': [], '教學進度內容': [] }, tch: [], skip: { plans: 0, cells: 0, teachers: 0 } };
  function cur_(name) {
    var sh = book.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return { sh: sh, head: sh ? sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0] : [], rows: [] };
    var all = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    return { sh: sh, head: all[0], rows: all.slice(1) };
  }
  var keyOf = {
    '排課': function (r, h) { return [r[h.indexOf('老師信箱')], r[h.indexOf('產品編號')], bkStamp_(r[h.indexOf('上課日期')]).slice(0, 10), r[h.indexOf('班級')], r[h.indexOf('課程')]].join('|'); },
    '教學進度內容': function (r, h) { return [r[h.indexOf('表ID')], r[h.indexOf('週次')], r[h.indexOf('班級')], r[h.indexOf('星期')]].join('|'); }
  };
  ['排課', '教學進度內容'].forEach(function (name) {
    var c = cur_(name); if (!c.sh) return;
    var have = {}, ids = {};
    c.rows.forEach(function (r) {
      if (name === '排課' && mode === 'replace' && String(r[c.head.indexOf('學年學期')]) === term) return;
      if (name === '教學進度內容' && mode === 'replace') return;
      have[keyOf[name](r, c.head)] = 1; ids[String(r[0])] = 1;
    });
    mine.filter(function (m) { return m.sheet === name && m.data; }).forEach(function (m) {
      var k = keyOf[name](m.data, c.head);
      if (have[k] || (name === '排課' && ids[String(m.data[0])])) { plan.skip[name === '排課' ? 'plans' : 'cells']++; return; }
      have[k] = 1; plan.add[name].push(m.data);
    });
  });
  ['應有進度表', '教學進度表'].forEach(function (name) {
    var c = cur_(name); if (!c.sh) return;
    var ti = c.head.indexOf('授課老師'), pos = {};
    c.rows.forEach(function (r, i) { pos[String(r[0])] = { row: i + 2, has: ti >= 0 && String(r[ti]) !== '' }; });
    mine.filter(function (m) { return m.sheet === name && m.data; }).forEach(function (m) {
      var x = pos[String(m.data[0])]; if (!x) return;
      if (x.has && mode !== 'replace') { plan.skip.teachers++; return; }
      plan.tch.push({ sh: c.sh, row: x.row, data: m.data });
    });
  });
  return plan;
}
function apiResetRestoreCheck(stamp) {
  requireStaff_();
  var p = resetPlan_(String(stamp || ''), 'fill');
  return { term: p.term, skipPlans: p.skip.plans, skipCells: p.skip.cells, skipTeachers: p.skip.teachers, conflict: p.skip.plans + p.skip.cells + p.skip.teachers > 0 };
}
function apiResetRestore(stamp, mode) {
  requireStaff_();
  mode = mode === 'replace' ? 'replace' : 'fill';
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var book = ss_(), p = resetPlan_(String(stamp || ''), mode), counts = { plans: 0, cells: 0, teachers: 0 };
    if (mode === 'replace') {                                       // 整個換回舊的：先清掉這學期現有的排課和進度表內容
      var sp = book.getSheetByName('排課');
      if (sp && sp.getLastRow() >= 2) { var pv = sp.getRange(1, 1, sp.getLastRow(), sp.getLastColumn()).getValues(), ti = pv[0].indexOf('學年學期'); for (var i = pv.length - 1; i >= 1; i--) if (String(pv[i][ti]) === p.term) sp.deleteRow(i + 1); }
      var tbl = {}; schedTables_(p.term).forEach(function (t) { tbl[t.id] = 1; });
      var sc = book.getSheetByName('教學進度內容');
      if (sc && sc.getLastRow() >= 2) { var cv = sc.getRange(1, 1, sc.getLastRow(), sc.getLastColumn()).getValues(); for (var k = cv.length - 1; k >= 1; k--) if (tbl[String(cv[k][0])]) sc.deleteRow(k + 1); }
    }
    ['排課', '教學進度內容'].forEach(function (name) {
      var sh = book.getSheetByName(name), add = p.add[name]; if (!sh || !add.length) return;
      var cols = sh.getLastColumn();
      var rows = add.map(function (d) { d = d.slice(0, cols); while (d.length < cols) d.push(''); return d; });
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, cols).setValues(rows);
      counts[name === '排課' ? 'plans' : 'cells'] = rows.length;
    });
    p.tch.forEach(function (t) { var cols = t.sh.getLastColumn(), d = t.data.slice(0, cols); while (d.length < cols) d.push(''); t.sh.getRange(t.row, 1, 1, cols).setValues([d]); counts.teachers++; });
    for (var m = p.mine.length - 1; m >= 0; m--) p.bk.deleteRow(p.mine[m].row);   // 由下往上刪，列號才不會跑掉
    try { CacheService.getScriptCache().removeAll([]); } catch (e) {}
    return { term: p.term, plans: counts.plans, cells: counts.cells, teachers: counts.teachers, skipPlans: p.skip.plans, skipCells: p.skip.cells, skipTeachers: p.skip.teachers };
  } finally { rtClear_(); lock.releaseLock(); }
}

/* ---------------- 代老師匯入紙本（只有技士、科主任、管理者）----------------
 * 把以前紙本的材料申請單「用老師的名義」補進系統：進度表格子填好（授課老師要先設定好）、材料單已送出。
 * rec.items[i] = { teacher(信箱), dept, course, cls, date, sets, pid | custom:{title,serving,dsets,rows:[{raw,per,unit}]}, ov, omit, extra, tools, title }
 * dry = true：只檢查（找得到進度表、週次、老師），不寫入。 */
function apiPaperImport(rec) {
  var me = requireStaff_(); rec = rec || {};
  var items = Array.isArray(rec.items) ? rec.items : [], dry = !!rec.dry;
  if (!items.length || items.length > 60) throw new Error('一次匯入 1 到 60 張。');
  var term = setting_('目前學年學期', ''), emails = schedEmails_(), log = [];
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    items.forEach(function (it, ix) {
      var tag = '第 ' + (ix + 1) + ' 張（' + (it.date || '') + ' ' + (it.cls || '') + '）：';
      var teacher = String(it.teacher || '').toLowerCase().trim();
      if (emails.indexOf(teacher) < 0) throw new Error(tag + '找不到老師 ' + teacher);
      var t = schedTables_(term).filter(function (x) { return x.dept === it.dept && x.course === it.course && x.classes.some(function (c) { return c.cls === it.cls; }); })[0];
      if (!t) throw new Error(tag + '找不到「' + it.dept + ' ' + it.course + ' ' + it.cls + '」的進度表（請先在送單狀況新增）。');
      if ((t.teachers || []).indexOf(teacher) < 0) throw new Error(tag + '這位老師還不是這門課的授課老師，請先在送單狀況設定。');
      var d = L_parseDate(it.date); if (!d) throw new Error(tag + '日期不正確');
      var wk = tableWeeks_(t).filter(function (w) { return it.date >= w.mon && it.date <= L_addDays(w.mon, 6); })[0];
      if (!wk) throw new Error(tag + '這個日期不在這張進度表的週次裡（學期 ' + semDates_().start + ' ~ ' + semDates_().end + '）。');
      var tc = t.classes.filter(function (c) { return c.cls === it.cls; })[0], days = L_classDays(tc), wd = d.t.getUTCDay() || 7, day = 0;
      if (days.length > 1) day = wd; else if (days[0] !== wd) { if (t.classes.length === 1) day = wd; else throw new Error(tag + '這個班的上課日是週' + L_WD[days[0] % 7] + '，但這張紙是週' + L_WD[wd % 7] + '。'); }
      log.push({ ix: ix, table: t.id, week: wk.n, day: day, weekLabel: wk.label });
      it._t = t; it._wk = wk; it._day = day; it._teacher = teacher;
    });
    if (dry) return { ok: true, log: log };
    var cat = loadCatalog_(), done = [];
    items.forEach(function (it, ix) {
      var t = it._t, pid = String(it.pid || '');
      if (!pid && it.custom) {                                                           // 目錄裡沒有的產品：用這位老師的名義建一張自創材料單
        var c = it.custom, sh = customSheet_(), vals = sh.getDataRange().getValues(), found = '';
        for (var i = 1; i < vals.length; i++) if (str_(vals[i][1]).toLowerCase() === it._teacher && str_(vals[i][2]) === String(c.title) && str_(vals[i][8]) !== '是') { found = str_(vals[i][0]); break; }
        if (!found) {
          var clean = L_cleanCustom({ title: c.title, serving: c.serving, dsets: c.dsets, rows: (c.rows || []).map(function (r) { return { raw: r.raw, per: r.per, unit: r.unit || 'g', mode: 'per' }; }) }, nameMap_());
          clean.pid = '自-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
          L_assignRowIds(clean.pid, clean.items);
          sh.getRange(Math.max(vals.length, 1) + 1, 1, 1, CUSTOM_HEAD.length).setValues([[clean.pid, it._teacher, clean.title, clean.serving || String(c.serving || ''), clean.dsets, JSON.stringify(clean.items), JSON.stringify(clean.tools || []), '', '', nowStr_()]]);
          found = clean.pid; rtClear_(); CAT_ = null; cat = loadCatalog_();
        }
        pid = found;
      }
      if (!cat.products[pid]) throw new Error('第 ' + (ix + 1) + ' 張：找不到材料單 ' + pid);
      var cells = schedCells_(), ex = cells.filter(function (x) { return x.tableId === t.id && x.week === it._wk.n && x.cls === it.cls && (x.day || 0) === it._day; })[0];
      var raw = ex && ex.cell.kind === 'lesson' ? JSON.parse(JSON.stringify(ex.cell)) : { kind: 'lesson', mode: 'joint', groups: [{ teacher: it._teacher, pids: [] }] };
      if (raw.mode !== 'joint') throw new Error('第 ' + (ix + 1) + ' 張：這一格是分組的，請手動處理。');
      if (raw.groups[0].teacher && raw.groups[0].teacher !== it._teacher) throw new Error('第 ' + (ix + 1) + ' 張：這一格已經有別的老師開單。');
      raw.groups[0].teacher = it._teacher;
      if (it.dropPid) raw.groups[0].pids = raw.groups[0].pids.filter(function (x) { return x !== it.dropPid; });
      if (raw.groups[0].pids.indexOf(pid) < 0) raw.groups[0].pids.push(pid);
      var cell = L_cleanCell(raw, t, cat.products, emails, it._teacher, tablePids_(t.id));
      var rows = schedCells_().filter(function (x) { return !(x.tableId === t.id && x.week === it._wk.n && x.cls === it.cls && (x.day || 0) === it._day); }).map(cellRow_);
      rows.push(cellRow_({ tableId: t.id, week: it._wk.n, cls: it.cls, day: it._day, cell: cell, by: it._teacher, at: nowStr_() }));
      writeSched_('教學進度內容', SCHED_CELL_HEAD, rows);
      syncSchedule_(t.id, it._wk.n, it.cls, it._day);
      rtClear_(['教學進度內容', '排課']);
      var plans = readPlans_(), pre = t.id + '|' + it._wk.n + '|' + it.cls + '|', now = nowStr_(), hit = null;
      plans.forEach(function (e) { if (!hit && e.term === term && e.sid && e.sid.indexOf(pre) === 0 && e.pid === pid && e.teacher === it._teacher) hit = e; });
      if (!hit) throw new Error('第 ' + (ix + 1) + ' 張：進度表格子填好了，但沒有產生對應的排課。');
      var cl = L_cleanEntry({ id: hit.id, sid: hit.sid, dept: hit.dept, pid: pid, date: hit.date, cls: hit.cls, course: hit.course, sets: it.sets || hit.sets, ov: it.ov || {}, omit: it.omit || [], extra: it.extra || [], tools: Array.isArray(it.tools) ? it.tools : null, title: it.title || '', yFrom: it.yFrom, yTo: it.yTo, yUnit: it.yUnit }, cat);
      ['sets', 'scale', 'yFrom', 'yTo', 'yUnit', 'ov', 'omit', 'extra', 'tools', 'title', 'conv'].forEach(function (k) { hit[k] = cl[k]; });
      hit.draft = false; hit.pending = null; hit.updated = now;
      flushPlanRows_(ss_().getSheetByName('排課'), plans.map(function (e) { return planRow_(e, e.created, e.updated); }));
      done.push({ date: it.date, cls: it.cls, pid: pid, id: hit.id });
    });
    return { ok: true, done: done };
  } finally { rtClear_(); lock.releaseLock(); }
}

/* 照紙本進度表一次填好很多格子，並把產生的材料單照預設直接送出（管理者用）。
 * rec.items = [{table, week, cls, cell}]，cell 格式跟進度表格子一樣（kind note / lesson）；rec.send = true 就把這些格子產生的材料單直接送出。 */
function apiScheduleBulk(rec) {
  var me = requireStaff_(); rec = rec || {};
  var items = Array.isArray(rec.items) ? rec.items : [];
  if (!items.length || items.length > 200) throw new Error('一次填 1 到 200 格。');
  var term = setting_('目前學年學期', ''), emails = schedEmails_(), cat = loadCatalog_();
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var tables = schedTables_(term), done = {}, keys = {}, newRows = [], now = nowStr_();
    items.forEach(function (it, ix) {
      var tag = '第 ' + (ix + 1) + ' 格：';
      var t = tables.filter(function (x) { return x.id === it.table; })[0]; if (!t) throw new Error(tag + '找不到進度表');
      var tc = t.classes.filter(function (c) { return c.cls === it.cls; })[0]; if (!tc) throw new Error(tag + '找不到班級 ' + it.cls);
      var wk = tableWeeks_(t).filter(function (w) { return w.n === Number(it.week); })[0]; if (!wk) throw new Error(tag + '沒有第 ' + it.week + ' 週');
      var cell = L_cleanCell(it.cell, t, cat.products, emails, '', tablePids_(t.id));
      var day = L_classDays(tc).length > 1 ? Number(it.day || 0) : 0;
      keys[t.id + '|' + wk.n + '|' + it.cls + '|' + day] = 1; done[t.id] = 1;
      newRows.push({ tableId: t.id, week: wk.n, cls: it.cls, day: day, cell: cell, by: me.email || 'import', at: now });
    });
    var keep = schedCells_().filter(function (x) { return !keys[x.tableId + '|' + x.week + '|' + x.cls + '|' + (x.day || 0)]; });
    writeSched_('教學進度內容', SCHED_CELL_HEAD, keep.map(cellRow_).concat(newRows.map(cellRow_)));
    rtClear_(['教學進度內容', '排課']);
    Object.keys(done).forEach(function (id) { syncSchedule_(id); });
    var sent = 0;
    if (rec.send) {
      var plans = readPlans_(), want = {};
      newRows.forEach(function (r) { want[r.tableId + '|' + r.week + '|' + r.cls + '|'] = 1; });
      plans.forEach(function (e) {
        if (e.term !== term || !e.sid || !e.draft) return;
        var q = e.sid.split('|'); if (!want[q[0] + '|' + q[1] + '|' + q[2] + '|']) return;
        e.draft = false; e.pending = null; e.updated = now; sent++;
      });
      flushPlanRows_(ss_().getSheetByName('排課'), plans.map(function (e) { return planRow_(e, e.created, e.updated); }));
    }
    return { ok: true, cells: newRows.length, sent: sent };
  } finally { rtClear_(); lock.releaseLock(); }
}

/* 試用頁面開關（技士、科主任、管理者）。on = true 開（所有人都改用試用資料）、false 關（回到正式資料）；
 * reset = true 重新從正式資料複製一份新的試用資料。正式資料永遠不會被動到。 */
function apiTrialSet(on, mode) {
  requireStaff_();
  mode = mode === 'blank' ? 'blank' : (mode === 'copy' || mode === true ? 'copy' : '');
  var pr = PropertiesService.getScriptProperties(), id = pr.getProperty('TRIAL_ID');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    if (on && (!id || mode)) {
      var real = SpreadsheetApp.getActiveSpreadsheet();
      var cp = real.copy('員林農工材料單系統（試用資料）');
      try { cp.setSpreadsheetTimeZone(TZ); } catch (e) {}
      if (mode === 'blank') {                                                          // 空白：留下材料單目錄、使用者名單、設定、課程清單；老師排的課、進度表、備份全部清空
        ['排課', '教學進度表', '教學進度內容', '刪除前備份', '刪除紀錄'].forEach(function (n) {
          var sh = cp.getSheetByName(n); if (sh && sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
        });
      }
      if (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e2) {} }
      id = cp.getId(); pr.setProperty('TRIAL_ID', id);
    }
    pr.setProperty('TRIAL_ON', on ? '1' : '0');
    try { CacheService.getScriptCache().put('rtver', String(Date.now()), 21600); } catch (e3) {}
  } finally { lock.releaseLock(); }
  return { ok: true, trial: !!on };
}
/* 量一下各分頁讀取要多久（找哪裡慢）。只有技士、科主任、管理者能呼叫。 */
function apiProfile() {
  requireAdmin_();
  var out = { sheets: [], phases: [] }, t0;
  ss_().getSheets().forEach(function (sh) {
    t0 = Date.now(); var v = sh.getDataRange().getValues(); out.sheets.push({ name: sh.getName(), rows: v.length, cols: sh.getLastColumn(), ms: Date.now() - t0 });
  });
  var ph = function (name, f) { var t = Date.now(); try { f(); } catch (e) { name += ' ERR ' + e.message; } out.phases.push({ name: name, ms: Date.now() - t }); };
  rtClear_();
  var term = '';
  ph('setting_', function () { term = setting_('目前學年學期', ''); });
  ph('whoami_', function () { whoami_(); });
  ph('ensureTables_', function () { ensureTables_(); });
  ph('schedTables_', function () { schedTables_(term); });
  ph('schedCells_', function () { schedCells_(); });
  ph('requiredAll_', function () { requiredAll_(); });
  ph('readPlans_', function () { readPlans_(); });
  ph('loadProductsLite_', function () { loadProductsLite_(); });
  ph('requiredStatus_', function () { var tb = schedTables_(term), ce = schedCells_(); requiredStatus_(term, tb, ce, L_weeks(setting_('開學日 ' + term, ''), setting_('結業式 ' + term, ''))); });
  ph('cellProducts_', function () { cellProducts_(schedCells_()); });
  ph('apiScheduleGet', function () { rtClear_(); apiScheduleGet(); });
  apiBootstrap(); apiScheduleGet();                                                       // 先各跑一次把快取填滿，再量「有快取」的時間
  ph('【有快取】apiBootstrap', function () { RT_ = {}; SS_ = null; ENS_ = {}; CAT_ = null; PL_ = null; apiBootstrap(); });
  ph('【有快取】apiScheduleGet', function () { RT_ = {}; SS_ = null; ENS_ = {}; CAT_ = null; PL_ = null; apiScheduleGet(); });
  return out;
}

/* ---------------- 選手進度表（技藝競賽選手的訓練時段表，一週一格，產品後面可寫數量） ---------------- */
var ATH_HEAD = ['編號', '擁有者', '名稱', '內容', '更新'];
function athSheet_() {
  var sh = ss_().getSheetByName('選手進度表');
  if (!sh) { sh = ss_().insertSheet('選手進度表'); sh.getRange(1, 1, 1, ATH_HEAD.length).setValues([ATH_HEAD]); }
  return sh;
}
function athRows_() {
  var sh = athSheet_(), v = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < v.length; i++) if (str_(v[i][0])) out.push({ row: i + 1, id: str_(v[i][0]), owner: str_(v[i][1]).toLowerCase(), name: str_(v[i][2]), json: str_(v[i][3]), at: str_(v[i][4]) });
  return out;
}
/* 自己的選手進度表；技士、科主任、管理者看得到所有人的 */
function apiAthList() {
  var me = whoami_();
  return athRows_().filter(function (r) { return r.owner === me.email || isStaff_(me); }).map(function (r) {
    var d = {}; try { d = JSON.parse(r.json || '{}'); } catch (e) {}
    return { id: r.id, owner: r.owner, ownerName: teacherNames_()[r.owner] || r.owner.split('@')[0], name: r.name, data: d, at: r.at };
  });
}
function apiAthSave(rec) {
  var me = whoami_(); rec = rec || {};
  var name = L_safeText(rec.name, 60) || '選手進度表', json = JSON.stringify(rec.data || {});
  if (json.length > 48000) throw new Error('這份進度表內容太多，存不下（超過 48000 字）。請把已經排完的週另存成一份新的進度表。');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var sh = athSheet_(), rows = athRows_(), hit = null, id = str_(rec.id);
    rows.forEach(function (r) { if (id && r.id === id) hit = r; });
    if (hit && hit.owner !== me.email && !isStaff_(me)) throw new Error('這份選手進度表是別人的，不能修改。');
    var at = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
    if (hit) { sh.getRange(hit.row, 3, 1, 3).setValues([[name, json, at]]); return { id: hit.id, at: at }; }
    id = Utilities.getUuid().slice(0, 8);
    sh.getRange(sh.getLastRow() + 1, 1, 1, 5).setValues([[id, me.email, name, json, at]]);
    return { id: id, at: at };
  } finally { lock.releaseLock(); }
}
function apiAthDelete(id) {
  var me = whoami_(), lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var hit = null; athRows_().forEach(function (r) { if (r.id === str_(id)) hit = r; });
    if (!hit) return { ok: true };
    if (hit.owner !== me.email && !isStaff_(me)) throw new Error('這份選手進度表是別人的，不能刪除。');
    athSheet_().deleteRow(hit.row);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/* 選手進度表的時間列（每一週可以不一樣）：{def:[{id,t,bg}], w:{週次:[…]}}，存在「設定」分頁 */
function athRowsOf_(ids) {
  var out = {};
  Object.keys(ids).forEach(function (id) { var v = setting_('選手時段 ' + id, ''); if (v) { try { out[id] = JSON.parse(v); } catch (e) {} } });
  return out;
}
function apiAthRowsSave(tableId, rows) {
  var me = whoami_(); schedGuard_(me);
  var term = setting_('目前學年學期', ''), t = schedTables_(term).filter(function (x) { return x.id === String(tableId); })[0];
  if (!t) throw new Error('找不到這張進度表。');
  assertCanEditTable_(me, t);
  var clean = function (l) { return (Array.isArray(l) ? l : []).slice(0, 10).map(function (r) { return { id: L_safeText(r && r.id, 10) || Utilities.getUuid().slice(0, 6), t: L_safeText(r && r.t, 20), bg: ['pk', 'gr', 'bl'].indexOf(r && r.bg) >= 0 ? r.bg : '' }; }); };
  var out = { def: clean(rows && rows.def), w: {} };
  Object.keys((rows && rows.w) || {}).slice(0, 60).forEach(function (k) { out.w[String(Number(k) || k)] = clean(rows.w[k]); });
  var json = JSON.stringify(out);
  if (json.length > 40000) throw new Error('時間列太多，存不下。');
  setSetting_('選手時段 ' + t.id, json);
  rtClear_(['設定']);
  return out;
}
