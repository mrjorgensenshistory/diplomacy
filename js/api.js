/* ============================================================
 * DIPLOMACY — API client + built-in MOCK backend
 *
 * Real mode: POSTs JSON (as text/plain to avoid CORS preflight)
 * to the Apps Script web app.
 * Mock mode: the same API contract served from localStorage in
 * this browser, with the real engine resolving turns. Used for
 * practice games, demos, and testing before the backend exists.
 * ============================================================ */

var DiploAPI = (function () {
  var ENG = DIPLOMACY_ENGINE, MAP = DIPLOMACY_MAP;

  function isMock() { return DIPLO_CONFIG.API_URL === 'MOCK'; }

  async function call(payload) {
    if (isMock()) {
      try { return mockCall(payload); }
      catch (e) { return { ok: false, error: 'Mock error: ' + (e && e.message || e) }; }
    }
    try {
      var res = await fetch(DIPLO_CONFIG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow'
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: 'Could not reach the game server. Check your internet connection.', offline: true };
    }
  }

  /* ================= MOCK BACKEND ================= */

  var DB_KEY = 'diplomacy_mock_db_v1';

  function loadDB() {
    try { return JSON.parse(localStorage.getItem(DB_KEY)) || { games: {}, nextId: 1 }; }
    catch (e) { return { games: {}, nextId: 1 }; }
  }
  function saveDB(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }

  function genCode(power) {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var s = '';
    for (var i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return power.slice(0, 3) + '-' + s;
  }

  /* codes must be unique across ALL games (4 boards run at once) */
  function uniqueCode(db, power) {
    var code;
    do { code = genCode(power); } while (findByCode(db, code));
    return code;
  }

  function newGame(name, settings) {
    settings = settings || {};
    var codes = {};
    MAP.POWERS.forEach(function (p) { codes[p] = genCode(p); });
    return {
      name: name || 'New Game',
      created: new Date().toISOString(),
      locked: true,
      codes: codes,
      settings: {
        victorySCs: settings.victorySCs || 12,
        endYear: settings.endYear || null,
        allowViewLocked: !!settings.allowViewLocked,
        autoResolve: !!settings.autoResolve,
        mapStyle: settings.mapStyle === 'terrain' ? 'terrain' : 'empire',
        bots: (settings.bots || []).filter(function (p) { return MAP.POWERS.indexOf(p) !== -1; })
      },
      version: 1,
      state: ENG.initialState({ victorySCs: settings.victorySCs || 12, endYear: settings.endYear || null }),
      orders: {},      // power -> {list: [], submitted: bool}
      history: [],     // {label, stateBefore, orders, results, ts}
      messages: []     // {ts, from, to, text, turn}
    };
  }

  /* effective lock: manual flag OR an expired unlock timer */
  function effLocked(g) {
    if (g.locked) return true;
    if (g.settings && g.settings.unlockUntil && Date.now() > g.settings.unlockUntil) return true;
    return false;
  }

  function findByCode(db, code) {
    code = String(code || '').trim().toUpperCase();
    for (var id in db.games) {
      var g = db.games[id];
      for (var p in g.codes) {
        if (g.codes[p].toUpperCase() === code) return { gameId: id, power: p, game: g };
      }
    }
    return null;
  }

  function phaseLabel(state) {
    var s = { SPRING: 'Spring', FALL: 'Fall', WINTER: 'Winter' }[state.season] || state.season;
    var p = { MOVE: 'Orders', RETREAT: 'Retreats', BUILD: 'Builds', DONE: 'Game Over' }[state.phase] || state.phase;
    return s + ' ' + state.year + ' — ' + p;
  }

  function playerView(found) {
    var g = found.game;
    var mine = g.orders[found.power] || { list: [], submitted: false };
    var msgs = g.messages.filter(function (m) {
      return m.from === found.power || m.to === found.power;
    });
    var bots = (g.settings && g.settings.bots) || [];
    var submittedBy = {};
    MAP.POWERS.forEach(function (p) {
      submittedBy[p] = bots.indexOf(p) !== -1 || !!(g.orders[p] && g.orders[p].submitted);
    });
    return {
      ok: true, power: found.power, gameId: found.gameId, gameName: g.name,
      locked: g.locked, version: g.version, settings: g.settings,
      phaseLabel: phaseLabel(g.state),
      state: g.state, orders: mine.list, submitted: mine.submitted,
      submittedBy: submittedBy,
      lastTurn: g.history.length ? {
        label: g.history[g.history.length - 1].label,
        orders: g.history[g.history.length - 1].results
      } : null,
      messages: msgs
    };
  }

  function doResolve(g) {
    var ordersByPower = {};
    for (var p in g.orders) ordersByPower[p] = g.orders[p].list || [];
    // the AI writes its orders at the last possible moment, server-side
    ((g.settings && g.settings.bots) || []).forEach(function (bp) {
      ordersByPower[bp] = DIPLOMACY_BOT.ordersFor(g.state, bp);
    });
    var label = phaseLabel(g.state);
    var stateBefore = g.state;
    var r = ENG.resolveTurn(g.state, ordersByPower);
    g.history.push({
      label: label,
      stateBefore: stateBefore,
      orders: ordersByPower,
      results: r.results,
      ts: new Date().toISOString()
    });
    g.state = r.newState;
    g.orders = {};
    g.version++;
    // the AI leaders write their poison-pen letters after the guns fall silent
    if (stateBefore.phase === 'MOVE' && !g.state.winner) {
      var bots = (g.settings && g.settings.bots) || [];
      var humans = MAP.POWERS.filter(function (p) {
        return bots.indexOf(p) === -1 &&
          (ENG.unitCount(g.state, p) > 0 || ENG.scCount(g.state, p) > 0);
      });
      bots.forEach(function (bp) {
        if (ENG.unitCount(g.state, bp) === 0 && ENG.scCount(g.state, bp) === 0) return;
        DIPLOMACY_BOT.chatter(stateBefore, g.state, bp, humans).forEach(function (m) {
          g.messages.push({
            ts: new Date().toISOString(), from: bp, to: m.to,
            text: m.text, turn: label
          });
        });
      });
    }
    return r;
  }

  function mockCall(payload) {
    var db = loadDB();
    var a = payload.action;

    /* ---- student actions ---- */
    if (a === 'join' || a === 'state') {
      var found = findByCode(db, payload.code);
      if (!found) return { ok: false, error: 'Code not recognized. Check with your teacher.' };
      if ((found.game.settings.bots || []).indexOf(found.power) !== -1) {
        return { ok: false, error: 'The computer plays this country now. Ask your teacher for a seat.' };
      }
      if (effLocked(found.game) && !found.game.settings.allowViewLocked) {
        return { ok: false, error: 'This game is locked right now. It opens during class.', locked: true };
      }
      if (a === 'state' && payload.version === found.game.version) return { ok: true, changed: false };
      var view = playerView(found);
      view.locked = effLocked(found.game);
      view.changed = true;
      return view;
    }

    if (a === 'orders') {
      var f2 = findByCode(db, payload.code);
      if (!f2) return { ok: false, error: 'Code not recognized.' };
      if ((f2.game.settings.bots || []).indexOf(f2.power) !== -1) return { ok: false, error: 'The computer plays this country now.' };
      if (effLocked(f2.game)) return { ok: false, error: 'Game is locked — orders can only be entered during class.', locked: true };
      if (f2.game.state.winner) return { ok: false, error: 'The game is over.' };
      // server-side validation: only this power's units/dislodged/builds
      var g2 = f2.game;
      var clean = sanitizeOrders(g2.state, f2.power, payload.orders || []);
      g2.orders[f2.power] = { list: clean, submitted: !!payload.submitted };
      g2.version++;
      if (g2.settings.autoResolve && allSubmitted(g2)) doResolve(g2);
      saveDB(db);
      return { ok: true, version: g2.version };
    }

    if (a === 'message') {
      var f3 = findByCode(db, payload.code);
      if (!f3) return { ok: false, error: 'Code not recognized.' };
      if ((f3.game.settings.bots || []).indexOf(f3.power) !== -1) return { ok: false, error: 'The computer plays this country now.' };
      if (effLocked(f3.game)) return { ok: false, error: 'Game is locked — messages can only be sent during class.', locked: true };
      var to = String(payload.to || '').toUpperCase();
      if (MAP.POWERS.indexOf(to) === -1 || to === f3.power) return { ok: false, error: 'Pick another country to message.' };
      var text = String(payload.text || '').slice(0, 500);
      if (!text.trim()) return { ok: false, error: 'Empty message.' };
      f3.game.messages.push({
        ts: new Date().toISOString(), from: f3.power, to: to,
        text: text, turn: phaseLabel(f3.game.state)
      });
      // AI courts always answer their mail
      if (((f3.game.settings && f3.game.settings.bots) || []).indexOf(to) !== -1) {
        f3.game.messages.push({
          ts: new Date().toISOString(), from: to, to: f3.power,
          text: DIPLOMACY_BOT.replyTo(to), turn: phaseLabel(f3.game.state)
        });
      }
      f3.game.version++;
      saveDB(db);
      return { ok: true, version: f3.game.version };
    }

    /* ---- teacher actions (mock accepts any tkey) ---- */
    if (a === 'tcreate') {
      var id = 'G' + db.nextId++;
      var ng = newGame(payload.name, payload.settings);
      MAP.POWERS.forEach(function (p) { ng.codes[p] = uniqueCode(db, p); });
      db.games[id] = ng;
      saveDB(db);
      return { ok: true, gameId: id, codes: ng.codes };
    }
    if (a === 'tlist') {
      var out = [];
      for (var gid in db.games) {
        var gg = db.games[gid];
        var bots2 = (gg.settings && gg.settings.bots) || [];
        var subs = 0, total = 0;
        MAP.POWERS.forEach(function (p) {
          if (bots2.indexOf(p) !== -1) return;       // bots never owe orders
          if (ENG.unitCount(gg.state, p) > 0 || gg.state.phase === 'BUILD') total++;
          if (gg.orders[p] && gg.orders[p].submitted) subs++;
        });
        out.push({
          gameId: gid, name: gg.name, locked: effLocked(gg),
          unlockUntil: gg.settings.unlockUntil || null,
          phaseLabel: phaseLabel(gg.state), winner: gg.state.winner || null,
          submitted: subs, expected: total, version: gg.version
        });
      }
      return { ok: true, games: out };
    }
    if (a === 'tgame') {
      var tg = db.games[payload.gameId];
      if (!tg) return { ok: false, error: 'No such game' };
      return {
        ok: true, gameId: payload.gameId, name: tg.name, locked: effLocked(tg),
        codes: tg.codes, settings: tg.settings, version: tg.version,
        phaseLabel: phaseLabel(tg.state), state: tg.state,
        orders: tg.orders, messages: tg.messages,
        lastTurn: tg.history.length ? {
          label: tg.history[tg.history.length - 1].label,
          orders: tg.history[tg.history.length - 1].results
        } : null,
        historyCount: tg.history.length
      };
    }
    if (a === 'tresolve') {
      var rg = db.games[payload.gameId];
      if (!rg) return { ok: false, error: 'No such game' };
      if (rg.state.winner) return { ok: false, error: 'Game is already over.' };
      var rr = doResolve(rg);
      saveDB(db);
      return { ok: true, results: rr.results, version: rg.version };
    }
    if (a === 'tlock') {
      var ids = payload.gameId === 'all' ? Object.keys(db.games) : [payload.gameId];
      ids.forEach(function (i) {
        if (db.games[i]) {
          db.games[i].locked = !!payload.locked;
          // optional auto-relock: unlock expires after N minutes
          db.games[i].settings.unlockUntil = (!payload.locked && payload.minutes)
            ? Date.now() + payload.minutes * 60000 : null;
          db.games[i].version++;
        }
      });
      saveDB(db);
      return { ok: true };
    }
    if (a === 'tbot') {
      var bg2 = db.games[payload.gameId];
      if (!bg2) return { ok: false, error: 'No such game' };
      if (MAP.POWERS.indexOf(payload.power) === -1) return { ok: false, error: 'Unknown power' };
      var list = bg2.settings.bots = bg2.settings.bots || [];
      var idx = list.indexOf(payload.power);
      if (payload.isBot && idx === -1) list.push(payload.power);
      if (!payload.isBot && idx !== -1) {
        list.splice(idx, 1);
        bg2.codes[payload.power] = uniqueCode(db, payload.power);  // fresh code for the returning human
      }
      delete bg2.orders[payload.power];   // stale human/bot orders are void either way
      bg2.version++;
      saveDB(db);
      return { ok: true, bots: list, code: bg2.codes[payload.power] };
    }

    if (a === 'tregen') {
      var rgame = db.games[payload.gameId];
      if (!rgame) return { ok: false, error: 'No such game' };
      rgame.codes[payload.power] = uniqueCode(db, payload.power);
      rgame.version++;
      saveDB(db);
      return { ok: true, code: rgame.codes[payload.power] };
    }
    if (a === 'tundo') {
      var ug = db.games[payload.gameId];
      if (!ug) return { ok: false, error: 'No such game' };
      if (!ug.history.length) return { ok: false, error: 'Nothing to undo.' };
      var last = ug.history.pop();
      ug.state = last.stateBefore;
      ug.orders = {};
      ug.version++;
      saveDB(db);
      return { ok: true };
    }
    if (a === 'tsettings') {
      var sg = db.games[payload.gameId];
      if (!sg) return { ok: false, error: 'No such game' };
      var s = payload.settings || {};
      ['victorySCs', 'endYear', 'allowViewLocked', 'autoResolve', 'mapStyle'].forEach(function (k) {
        if (s[k] !== undefined) sg.settings[k] = s[k];
      });
      sg.state.victorySCs = sg.settings.victorySCs;
      sg.state.endYear = sg.settings.endYear;
      sg.version++;
      saveDB(db);
      return { ok: true };
    }
    if (a === 'tdelete') {
      delete db.games[payload.gameId];
      saveDB(db);
      return { ok: true };
    }
    if (a === 'tschedule') {
      return { ok: true, note: 'School-hours schedule applies in classroom (Apps Script) mode only.' };
    }
    return { ok: false, error: 'Unknown action: ' + a };
  }

  function allSubmitted(g) {
    var bots = (g.settings && g.settings.bots) || [];
    var all = true;
    MAP.POWERS.forEach(function (p) {
      if (bots.indexOf(p) !== -1) return;
      if (ENG.unitCount(g.state, p) > 0 && !(g.orders[p] && g.orders[p].submitted)) all = false;
    });
    return all;
  }

  /* keep only orders this power may legally give right now */
  function sanitizeOrders(state, power, orders) {
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

  return { call: call, isMock: isMock };
})();
