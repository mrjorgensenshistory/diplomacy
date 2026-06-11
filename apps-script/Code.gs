/* ============================================================
 * DIPLOMACY — Google Apps Script backend
 *
 * SETUP (one time — see README.md for the illustrated version):
 *  1. Create a Google Sheet (any name). Extensions → Apps Script.
 *  2. Paste this file as Code.gs.
 *  3. Add three more script files and paste in:
 *       map-data.js  (from shared/map-data.js)
 *       engine.js    (from shared/engine.js)
 *       bot.js       (from shared/bot.js — the computer players)
 *  4. Change TEACHER_KEY below to your own secret.
 *  5. Run the setup() function once (authorize when asked).
 *  6. Deploy → New deployment → Web app:
 *       Execute as: Me        Who has access: Anyone
 *  7. Copy the web app URL into js/config.js on your site.
 * ============================================================ */

var TEACHER_KEY = 'CHANGE-ME-PLEASE';   // <<< change this before deploying!

/* ---------------- plumbing ---------------- */

function doGet() {
  return json_({ ok: true, service: 'diplomacy', time: new Date().toISOString() });
}

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request' });
  }
  var mutating = ['orders', 'message', 'tcreate', 'tresolve', 'tlock', 'tregen',
                  'tundo', 'tsettings', 'tdelete', 'tschedule'].indexOf(payload.action) !== -1;
  var lock = null;
  try {
    if (mutating) {
      lock = LockService.getScriptLock();
      lock.waitLock(15000);
    }
    var res = route_(payload);
    return json_(res);
  } catch (err) {
    return json_({ ok: false, error: 'Server error: ' + err });
  } finally {
    if (lock) lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function setup() {
  sheet_('Games', ['id', 'name', 'created', 'locked', 'codesJSON', 'settingsJSON', 'version']);
  sheet_('State', ['gameId', 'stateJSON']);
  sheet_('Orders', ['gameId', 'power', 'ordersJSON', 'submitted', 'updated']);
  sheet_('History', ['gameId', 'idx', 'label', 'stateBeforeJSON', 'ordersJSON', 'resultsJSON', 'ts']);
  sheet_('Messages', ['gameId', 'ts', 'from', 'to', 'text', 'turn']);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SCHEDULE')) {
    props.setProperty('SCHEDULE', JSON.stringify({
      enforce: true, days: [1, 2, 3, 4, 5], start: '07:30', end: '16:00'
    }));
  }
  Logger.log('Setup complete. Now deploy as a web app (see README).');
}

function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function rows_(name) {
  var sh = sheet_(name, ['x']);
  var vals = sh.getDataRange().getValues();
  var headers = vals[0];
  var out = [];
  for (var i = 1; i < vals.length; i++) {
    var o = { _row: i + 1 };
    for (var j = 0; j < headers.length; j++) o[headers[j]] = vals[i][j];
    out.push(o);
  }
  return out;
}

/* ---------------- game storage ---------------- */

function loadGame_(gameId) {
  var g = null;
  rows_('Games').forEach(function (r) { if (String(r.id) === String(gameId)) g = r; });
  if (!g) return null;
  var stateRow = null;
  rows_('State').forEach(function (r) { if (String(r.gameId) === String(gameId)) stateRow = r; });
  var orders = {};
  rows_('Orders').forEach(function (r) {
    if (String(r.gameId) === String(gameId)) {
      orders[r.power] = { list: JSON.parse(r.ordersJSON || '[]'), submitted: r.submitted === true || r.submitted === 'TRUE', _row: r._row };
    }
  });
  return {
    id: String(g.id), name: g.name, locked: g.locked === true || g.locked === 'TRUE',
    codes: JSON.parse(g.codesJSON || '{}'),
    settings: JSON.parse(g.settingsJSON || '{}'),
    version: Number(g.version) || 1,
    state: stateRow ? JSON.parse(stateRow.stateJSON) : null,
    orders: orders,
    _gameRow: g._row, _stateRow: stateRow ? stateRow._row : null
  };
}

function saveGameMeta_(g) {
  var sh = sheet_('Games', []);
  sh.getRange(g._gameRow, 1, 1, 7).setValues([[
    g.id, g.name, sh.getRange(g._gameRow, 3).getValue(), g.locked,
    JSON.stringify(g.codes), JSON.stringify(g.settings), g.version
  ]]);
}

function saveState_(g) {
  var sh = sheet_('State', []);
  if (g._stateRow) sh.getRange(g._stateRow, 2).setValue(JSON.stringify(g.state));
  else sh.appendRow([g.id, JSON.stringify(g.state)]);
}

function clearOrders_(gameId) {
  var sh = sheet_('Orders', []);
  var vals = sh.getDataRange().getValues();
  for (var i = vals.length - 1; i >= 1; i--) {
    if (String(vals[i][0]) === String(gameId)) sh.deleteRow(i + 1);
  }
}

function saveOrders_(gameId, power, list, submitted) {
  var sh = sheet_('Orders', []);
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(gameId) && vals[i][1] === power) {
      sh.getRange(i + 1, 3, 1, 3).setValues([[JSON.stringify(list), submitted, new Date().toISOString()]]);
      return;
    }
  }
  sh.appendRow([gameId, power, JSON.stringify(list), submitted, new Date().toISOString()]);
}

/* ---------------- helpers ---------------- */

function genCode_(power) {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return power.slice(0, 3) + '-' + s;
}

/* codes must be unique across ALL games (several boards run at once) */
function uniqueCode_(power) {
  var code;
  do { code = genCode_(power); } while (findByCode_(code));
  return code;
}

function findByCode_(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return null;
  var games = rows_('Games');
  for (var i = 0; i < games.length; i++) {
    var codes = JSON.parse(games[i].codesJSON || '{}');
    for (var p in codes) {
      if (String(codes[p]).toUpperCase() === code) {
        return { gameId: String(games[i].id), power: p };
      }
    }
  }
  return null;
}

/* effective lock: manual flag OR an expired unlock timer */
function effLocked_(g) {
  if (g.locked) return true;
  if (g.settings && g.settings.unlockUntil && new Date().getTime() > g.settings.unlockUntil) return true;
  return false;
}

function phaseLabel_(state) {
  var s = { SPRING: 'Spring', FALL: 'Fall', WINTER: 'Winter' }[state.season] || state.season;
  var p = { MOVE: 'Orders', RETREAT: 'Retreats', BUILD: 'Builds', DONE: 'Game Over' }[state.phase] || state.phase;
  return s + ' ' + state.year + ' — ' + p;
}

function withinSchedule_() {
  var props = PropertiesService.getScriptProperties();
  var sched;
  try { sched = JSON.parse(props.getProperty('SCHEDULE') || '{}'); } catch (e) { sched = {}; }
  if (!sched.enforce) return true;
  var now = new Date();
  var day = now.getDay(); // 0 = Sunday
  if ((sched.days || [1, 2, 3, 4, 5]).indexOf(day) === -1) return false;
  var hm = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm');
  return hm >= (sched.start || '07:30') && hm <= (sched.end || '16:00');
}

function lastHistory_(gameId) {
  var rows = rows_('History').filter(function (r) { return String(r.gameId) === String(gameId); });
  if (!rows.length) return null;
  rows.sort(function (a, b) { return Number(a.idx) - Number(b.idx); });
  return rows[rows.length - 1];
}

function messagesFor_(gameId, power) {
  return rows_('Messages').filter(function (r) {
    if (String(r.gameId) !== String(gameId)) return false;
    return !power || r.from === power || r.to === power;
  }).map(function (r) {
    return { ts: r.ts, from: r.from, to: r.to, text: r.text, turn: r.turn };
  });
}

function playerView_(g, power) {
  var mine = g.orders[power] || { list: [], submitted: false };
  var bots = (g.settings && g.settings.bots) || [];
  var submittedBy = {};
  DIPLOMACY_MAP.POWERS.forEach(function (p) {
    submittedBy[p] = bots.indexOf(p) !== -1 || !!(g.orders[p] && g.orders[p].submitted);
  });
  var last = lastHistory_(g.id);
  return {
    ok: true, changed: true, power: power, gameId: g.id, gameName: g.name,
    locked: effLocked_(g), version: g.version, settings: g.settings,
    phaseLabel: phaseLabel_(g.state),
    state: g.state, orders: mine.list, submitted: mine.submitted,
    submittedBy: submittedBy,
    lastTurn: last ? { label: last.label, orders: JSON.parse(last.resultsJSON || '[]') } : null,
    messages: messagesFor_(g.id, power)
  };
}

function sanitizeOrders_(state, power, orders) {
  var ENG = DIPLOMACY_ENGINE;
  var out = [];
  (orders || []).slice(0, 40).forEach(function (o) {
    if (!o || typeof o !== 'object') return;
    if (state.phase === 'MOVE') {
      var v = ENG.validateOrder(state, power, o);
      if (v.ok) out.push(o);
    } else if (state.phase === 'RETREAT') {
      if ((o.type === 'retreat' || o.type === 'disband') &&
          state.dislodged[o.unit] && state.dislodged[o.unit].power === power) out.push(o);
    } else if (state.phase === 'BUILD') {
      if (o.type === 'build' || o.type === 'remove' || o.type === 'waive') out.push(o);
    }
  });
  return out;
}

function doResolve_(g) {
  var ENG = DIPLOMACY_ENGINE;
  var ordersByPower = {};
  for (var p in g.orders) ordersByPower[p] = g.orders[p].list || [];
  // the AI writes its orders at the last possible moment, server-side
  ((g.settings && g.settings.bots) || []).forEach(function (bp) {
    ordersByPower[bp] = DIPLOMACY_BOT.ordersFor(g.state, bp);
  });
  var label = phaseLabel_(g.state);
  var stateBefore = JSON.stringify(g.state);
  var r = ENG.resolveTurn(g.state, ordersByPower);
  var hist = rows_('History').filter(function (h) { return String(h.gameId) === String(g.id); });
  sheet_('History', []).appendRow([
    g.id, hist.length + 1, label, stateBefore,
    JSON.stringify(ordersByPower), JSON.stringify(r.results), new Date().toISOString()
  ]);
  var prevState = JSON.parse(stateBefore);
  g.state = r.newState;
  g.version++;
  saveState_(g);
  clearOrders_(g.id);
  saveGameMeta_(g);
  // the AI leaders write their poison-pen letters after the guns fall silent
  if (prevState.phase === 'MOVE' && !g.state.winner) {
    var bots = (g.settings && g.settings.bots) || [];
    var humans = DIPLOMACY_MAP.POWERS.filter(function (p) {
      return bots.indexOf(p) === -1 &&
        (ENG.unitCount(g.state, p) > 0 || ENG.scCount(g.state, p) > 0);
    });
    bots.forEach(function (bp) {
      if (ENG.unitCount(g.state, bp) === 0 && ENG.scCount(g.state, bp) === 0) return;
      DIPLOMACY_BOT.chatter(prevState, g.state, bp, humans).forEach(function (m) {
        sheet_('Messages', []).appendRow([
          g.id, new Date().toISOString(), bp, m.to, m.text, label
        ]);
      });
    });
  }
  return r;
}

function allSubmitted_(g) {
  var ENG = DIPLOMACY_ENGINE;
  var bots = (g.settings && g.settings.bots) || [];
  var all = true;
  DIPLOMACY_MAP.POWERS.forEach(function (p) {
    if (bots.indexOf(p) !== -1) return;
    if (ENG.unitCount(g.state, p) > 0 && !(g.orders[p] && g.orders[p].submitted)) all = false;
  });
  return all;
}

/* ---------------- router ---------------- */

function route_(payload) {
  var a = payload.action;

  /* ----- student ----- */
  if (a === 'join' || a === 'state') {
    var f = findByCode_(payload.code);
    if (!f) return { ok: false, error: 'Code not recognized. Check with your teacher.' };
    var g = loadGame_(f.gameId);
    if (((g.settings && g.settings.bots) || []).indexOf(f.power) !== -1) {
      return { ok: false, error: 'The computer plays this country now. Ask your teacher for a seat.' };
    }
    if (effLocked_(g) && !g.settings.allowViewLocked) {
      return { ok: false, error: 'This game is locked right now. It opens during class.', locked: true };
    }
    if (a === 'state' && payload.version === g.version) return { ok: true, changed: false };
    return playerView_(g, f.power);
  }

  if (a === 'orders') {
    var f2 = findByCode_(payload.code);
    if (!f2) return { ok: false, error: 'Code not recognized.' };
    var g2 = loadGame_(f2.gameId);
    if (((g2.settings && g2.settings.bots) || []).indexOf(f2.power) !== -1) return { ok: false, error: 'The computer plays this country now.' };
    if (effLocked_(g2)) return { ok: false, error: 'Game is locked — orders can only be entered during class.', locked: true };
    if (!withinSchedule_()) return { ok: false, error: 'Outside school hours — the game opens during class.', locked: true };
    if (g2.state.winner) return { ok: false, error: 'The game is over.' };
    var clean = sanitizeOrders_(g2.state, f2.power, payload.orders || []);
    saveOrders_(g2.id, f2.power, clean, !!payload.submitted);
    g2.version++;
    saveGameMeta_(g2);
    if (g2.settings.autoResolve) {
      g2 = loadGame_(g2.id);
      if (allSubmitted_(g2)) doResolve_(g2);
    }
    return { ok: true, version: loadGame_(g2.id).version };
  }

  if (a === 'message') {
    var f3 = findByCode_(payload.code);
    if (!f3) return { ok: false, error: 'Code not recognized.' };
    var g3 = loadGame_(f3.gameId);
    if (((g3.settings && g3.settings.bots) || []).indexOf(f3.power) !== -1) return { ok: false, error: 'The computer plays this country now.' };
    if (effLocked_(g3)) return { ok: false, error: 'Game is locked — messages can only be sent during class.', locked: true };
    if (!withinSchedule_()) return { ok: false, error: 'Outside school hours.', locked: true };
    var to = String(payload.to || '').toUpperCase();
    if (DIPLOMACY_MAP.POWERS.indexOf(to) === -1 || to === f3.power) return { ok: false, error: 'Pick another country.' };
    var text = String(payload.text || '').slice(0, 500);
    if (!text.trim()) return { ok: false, error: 'Empty message.' };
    sheet_('Messages', []).appendRow([
      g3.id, new Date().toISOString(), f3.power, to, text, phaseLabel_(g3.state)
    ]);
    // AI courts always answer their mail
    if (((g3.settings && g3.settings.bots) || []).indexOf(to) !== -1) {
      sheet_('Messages', []).appendRow([
        g3.id, new Date().toISOString(), to, f3.power, DIPLOMACY_BOT.replyTo(to), phaseLabel_(g3.state)
      ]);
    }
    g3.version++;
    saveGameMeta_(g3);
    return { ok: true, version: g3.version };
  }

  /* ----- teacher ----- */
  if (a && a.charAt(0) === 't') {
    if (String(payload.tkey || '') !== TEACHER_KEY) {
      return { ok: false, error: 'Wrong teacher key.' };
    }
  }

  if (a === 'tcreate') {
    var codes = {};
    DIPLOMACY_MAP.POWERS.forEach(function (p) { codes[p] = uniqueCode_(p); });
    var settings = payload.settings || {};
    var clean2 = {
      victorySCs: settings.victorySCs || 12,
      endYear: settings.endYear || null,
      allowViewLocked: !!settings.allowViewLocked,
      autoResolve: !!settings.autoResolve,
      mapStyle: settings.mapStyle === 'terrain' ? 'terrain' : 'empire',
      bots: (settings.bots || []).filter(function (p) {
        return DIPLOMACY_MAP.POWERS.indexOf(p) !== -1;
      })
    };
    var id = 'G' + new Date().getTime();
    sheet_('Games', []).appendRow([
      id, payload.name || 'New Game', new Date().toISOString(), true,
      JSON.stringify(codes), JSON.stringify(clean2), 1
    ]);
    sheet_('State', []).appendRow([
      id, JSON.stringify(DIPLOMACY_ENGINE.initialState({
        victorySCs: clean2.victorySCs, endYear: clean2.endYear
      }))
    ]);
    return { ok: true, gameId: id, codes: codes };
  }

  if (a === 'tlist') {
    var out = [];
    rows_('Games').forEach(function (r) {
      var gg = loadGame_(r.id);
      if (!gg || !gg.state) return;
      var bots2 = (gg.settings && gg.settings.bots) || [];
      var subs = 0, total = 0;
      DIPLOMACY_MAP.POWERS.forEach(function (p) {
        if (bots2.indexOf(p) !== -1) return;       // bots never owe orders
        if (DIPLOMACY_ENGINE.unitCount(gg.state, p) > 0 || gg.state.phase === 'BUILD') total++;
        if (gg.orders[p] && gg.orders[p].submitted) subs++;
      });
      out.push({
        gameId: gg.id, name: gg.name, locked: effLocked_(gg),
        unlockUntil: gg.settings.unlockUntil || null,
        phaseLabel: phaseLabel_(gg.state), winner: gg.state.winner || null,
        submitted: subs, expected: total, version: gg.version
      });
    });
    return { ok: true, games: out };
  }

  if (a === 'tgame') {
    var tg = loadGame_(payload.gameId);
    if (!tg) return { ok: false, error: 'No such game' };
    var last2 = lastHistory_(tg.id);
    return {
      ok: true, gameId: tg.id, name: tg.name, locked: effLocked_(tg),
      codes: tg.codes, settings: tg.settings, version: tg.version,
      phaseLabel: phaseLabel_(tg.state), state: tg.state,
      orders: tg.orders, messages: messagesFor_(tg.id, null),
      lastTurn: last2 ? { label: last2.label, orders: JSON.parse(last2.resultsJSON || '[]') } : null,
      historyCount: rows_('History').filter(function (h) { return String(h.gameId) === String(tg.id); }).length
    };
  }

  if (a === 'tresolve') {
    var rg = loadGame_(payload.gameId);
    if (!rg) return { ok: false, error: 'No such game' };
    if (rg.state.winner) return { ok: false, error: 'Game is already over.' };
    var rr = doResolve_(rg);
    return { ok: true, results: rr.results, version: rg.version };
  }

  if (a === 'tlock') {
    var games2 = rows_('Games');
    games2.forEach(function (r) {
      if (payload.gameId === 'all' || String(r.id) === String(payload.gameId)) {
        var gl = loadGame_(r.id);
        gl.locked = !!payload.locked;
        // optional auto-relock: unlock expires after N minutes
        gl.settings.unlockUntil = (!payload.locked && payload.minutes)
          ? new Date().getTime() + payload.minutes * 60000 : null;
        gl.version++;
        saveGameMeta_(gl);
      }
    });
    return { ok: true };
  }

  if (a === 'tbot') {
    var bg2 = loadGame_(payload.gameId);
    if (!bg2) return { ok: false, error: 'No such game' };
    if (DIPLOMACY_MAP.POWERS.indexOf(payload.power) === -1) return { ok: false, error: 'Unknown power' };
    var blist = bg2.settings.bots = bg2.settings.bots || [];
    var bidx = blist.indexOf(payload.power);
    if (payload.isBot && bidx === -1) blist.push(payload.power);
    if (!payload.isBot && bidx !== -1) {
      blist.splice(bidx, 1);
      bg2.codes[payload.power] = uniqueCode_(payload.power);  // fresh code for the returning human
    }
    saveOrders_(bg2.id, payload.power, [], false);   // stale orders are void either way
    bg2.version++;
    saveGameMeta_(bg2);
    return { ok: true, bots: blist, code: bg2.codes[payload.power] };
  }

  if (a === 'tregen') {
    var rgame = loadGame_(payload.gameId);
    if (!rgame) return { ok: false, error: 'No such game' };
    rgame.codes[payload.power] = uniqueCode_(payload.power);
    rgame.version++;
    saveGameMeta_(rgame);
    return { ok: true, code: rgame.codes[payload.power] };
  }

  if (a === 'tundo') {
    var ug = loadGame_(payload.gameId);
    if (!ug) return { ok: false, error: 'No such game' };
    var last3 = lastHistory_(ug.id);
    if (!last3) return { ok: false, error: 'Nothing to undo.' };
    ug.state = JSON.parse(last3.stateBeforeJSON);
    sheet_('History', []).deleteRow(last3._row);
    clearOrders_(ug.id);
    ug.version++;
    saveState_(ug);
    saveGameMeta_(ug);
    return { ok: true };
  }

  if (a === 'tsettings') {
    var sg = loadGame_(payload.gameId);
    if (!sg) return { ok: false, error: 'No such game' };
    var s2 = payload.settings || {};
    ['victorySCs', 'endYear', 'allowViewLocked', 'autoResolve', 'mapStyle'].forEach(function (k) {
      if (s2[k] !== undefined) sg.settings[k] = s2[k];
    });
    sg.state.victorySCs = sg.settings.victorySCs;
    sg.state.endYear = sg.settings.endYear;
    sg.version++;
    saveState_(sg);
    saveGameMeta_(sg);
    return { ok: true };
  }

  if (a === 'tdelete') {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    ['Games', 'State', 'Orders', 'History', 'Messages'].forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh) return;
      var vals = sh.getDataRange().getValues();
      for (var i = vals.length - 1; i >= 1; i--) {
        if (String(vals[i][0]) === String(payload.gameId)) sh.deleteRow(i + 1);
      }
    });
    return { ok: true };
  }

  if (a === 'tschedule') {
    if (payload.schedule) {
      PropertiesService.getScriptProperties().setProperty('SCHEDULE', JSON.stringify(payload.schedule));
    }
    return { ok: true, note: 'Schedule saved ✓ (server time zone: ' + Session.getScriptTimeZone() + ')' };
  }

  return { ok: false, error: 'Unknown action: ' + a };
}
