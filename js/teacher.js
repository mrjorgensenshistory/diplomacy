/* ============================================================
 * DIPLOMACY — teacher dashboard ("War Room")
 * ============================================================ */

(function () {
  var MAP = DIPLOMACY_MAP;
  var $ = function (id) { return document.getElementById(id); };
  var TKEY = 'diplomacy_tkey';

  var dBoard = null;
  var currentGame = null;   // gameId of open detail
  var detail = null;        // last tgame payload
  var showLast = false;

  function tkey() { return localStorage.getItem(TKEY) || ''; }

  async function tcall(payload) {
    payload.tkey = tkey();
    var r = await DiploAPI.call(payload);
    if (!r.ok && /teacher key/i.test(r.error || '')) {
      localStorage.removeItem(TKEY);
      showLogin('Wrong teacher key.');
    }
    return r;
  }

  /* ---------- login ---------- */

  function showLogin(msg) {
    $('tjoin').style.display = '';
    $('tmain').style.display = 'none';
    $('tkeyErr').textContent = msg || '';
  }

  async function enter() {
    var r = await tcall({ action: 'tlist' });
    if (!r.ok) { showLogin(r.error || 'Could not connect.'); return; }
    $('tjoin').style.display = 'none';
    $('tmain').style.display = '';
    $('modeBadge').textContent = DiploAPI.isMock() ? '🧪 Practice mode (this browser only)' : '🏫 Classroom mode';
    renderGames(r.games);
  }

  $('tkeyBtn').addEventListener('click', function () {
    localStorage.setItem(TKEY, $('tkeyInput').value.trim());
    enter();
  });
  $('tkeyInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { localStorage.setItem(TKEY, $('tkeyInput').value.trim()); enter(); }
  });
  $('tLogout').addEventListener('click', function () {
    localStorage.removeItem(TKEY);
    showLogin('');
  });

  /* ---------- game list ---------- */

  async function refresh() {
    var r = await tcall({ action: 'tlist' });
    if (r.ok) {
      renderGames(r.games);
      checkFanfare(r.games);
    }
    if (currentGame) openDetail(currentGame, true);
  }

  function renderGames(games) {
    var tb = $('gameRows');
    tb.innerHTML = '';
    if (!games || !games.length) {
      tb.innerHTML = '<tr><td colspan="5" class="muted">No games yet — create one below, then hand out the 7 codes.</td></tr>';
      return;
    }
    games.forEach(function (g) {
      var tr = document.createElement('tr');
      var openTxt = '🔓 Open';
      if (!g.locked && g.unlockUntil) {
        var mins = Math.max(0, Math.round((g.unlockUntil - Date.now()) / 60000));
        openTxt = '🔓 Open (' + mins + ' min left)';
      }
      var status = g.winner
        ? (g.winner === 'DRAW' ? '⚖️ Draw' : '👑 ' + MAP.POWER_INFO[g.winner].name + ' won')
        : (g.locked ? '🔒 Locked' : openTxt);
      tr.innerHTML =
        '<td><b>' + esc(g.name) + '</b></td>' +
        '<td>' + esc(g.phaseLabel) + '</td>' +
        '<td>' + g.submitted + ' / ' + g.expected + '</td>' +
        '<td>' + status + '</td>';
      var td = document.createElement('td');
      td.appendChild(actBtn('Open', '', function () { openDetail(g.gameId); }));
      td.appendChild(actBtn(g.locked ? '🔓 Unlock' : '🔒 Lock', 'ghost', async function () {
        var mins;
        if (g.locked) {
          mins = askUnlockMinutes();
          if (mins === null) return;
        }
        await tcall({ action: 'tlock', gameId: g.gameId, locked: !g.locked, minutes: mins || undefined });
        refresh();
      }));
      td.appendChild(actBtn('⚔ Resolve', 'good', async function () {
        var r = await tcall({ action: 'tresolve', gameId: g.gameId });
        if (!r.ok) alert(r.error);
        refresh();
      }));
      td.appendChild(actBtn('🗑', 'warn', async function () {
        if (!confirm('Delete "' + g.name + '" permanently? This cannot be undone.')) return;
        await tcall({ action: 'tdelete', gameId: g.gameId });
        if (currentGame === g.gameId) closeDetail();
        refresh();
      }));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
  }

  function actBtn(label, cls, fn) {
    var b = document.createElement('button');
    b.className = 'act ' + cls;
    b.style.marginRight = '4px';
    b.style.fontSize = '12.5px';
    b.style.padding = '4px 8px';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  $('refreshBtn').addEventListener('click', refresh);

  /* one switch for every board in the room — kids can't change it */
  $('allStyleBtn').addEventListener('click', async function () {
    var style = $('allStyle').value;
    var r = await tcall({ action: 'tlist' });
    if (!r.ok) { alert(r.error); return; }
    for (var i = 0; i < r.games.length; i++) {
      await tcall({ action: 'tsettings', gameId: r.games[i].gameId, settings: { mapStyle: style } });
    }
    $('allStyleBtn').textContent = '✓ Applied';
    setTimeout(function () { $('allStyleBtn').textContent = 'Apply'; }, 1500);
    if (currentGame) openDetail(currentGame, true);
  });

  function askUnlockMinutes() {
    var v = prompt('Auto-relock after how many minutes?\n(Enter for 75 — covers a class period. Type 0 to stay unlocked until you lock manually.)', '75');
    if (v === null) return null;           // cancelled
    var n = parseInt(v, 10);
    return isNaN(n) || n <= 0 ? 0 : Math.min(n, 480);
  }

  $('unlockAllBtn').addEventListener('click', async function () {
    var mins = askUnlockMinutes();
    if (mins === null) return;
    await tcall({ action: 'tlock', gameId: 'all', locked: false, minutes: mins || undefined });
    refresh();
  });
  $('lockAllBtn').addEventListener('click', async function () {
    await tcall({ action: 'tlock', gameId: 'all', locked: true });
    refresh();
  });

  /* humans get the friendlier countries first; the AI takes the rest */
  var HUMAN_PRIORITY = ['FRANCE', 'ENGLAND', 'TURKEY', 'GERMANY', 'RUSSIA', 'ITALY', 'AUSTRIA'];

  $('newGameBtn').addEventListener('click', async function () {
    var name = prompt('Name this game (e.g., "Period 3 — Board A"):');
    if (!name) return;
    var h = prompt('How many HUMAN players? (1–7 — the computer plays the rest)', '7');
    if (h === null) return;
    var humans = Math.max(1, Math.min(7, parseInt(h, 10) || 7));
    var v = prompt('Supply centers to win? (official 18; recommended for class: 12)', '12');
    var endYear = prompt('Optional end year (game stops after Fall of this year, most centers wins). Leave blank for none.', '');
    var r = await tcall({
      action: 'tcreate', name: name,
      settings: {
        victorySCs: Math.max(7, Math.min(18, parseInt(v, 10) || 12)),
        endYear: endYear ? parseInt(endYear, 10) : null,
        bots: HUMAN_PRIORITY.slice(humans)
      }
    });
    if (!r.ok) { alert(r.error); return; }
    await refresh();
    openDetail(r.gameId);
  });

  /* ---------- detail ---------- */

  async function openDetail(gameId, keepScroll) {
    var r = await tcall({ action: 'tgame', gameId: gameId });
    if (!r.ok) { alert(r.error); return; }
    currentGame = gameId;
    detail = r;
    $('detailPanel').style.display = '';
    $('dTitle').textContent = r.name;
    $('dPhase').textContent = r.phaseLabel;
    $('dLock').textContent = r.locked ? '🔒 Locked' : '🔓 Open';
    $('dLock').className = 'badge ' + (r.locked ? 'lock-on' : 'lock-off');
    $('dLockBtn').textContent = r.locked ? '🔓 Unlock this game' : '🔒 Lock this game';
    $('dWinner').innerHTML = r.state.winner
      ? '<div class="banner winner">' + (r.state.winner === 'DRAW' ? '⚖️ Ended in a draw.' : '👑 ' + MAP.POWER_INFO[r.state.winner].name + ' has won!') + '</div>'
      : '';

    // codes / AI seats
    var bots = (r.settings && r.settings.bots) || [];
    var cg = $('dCodes');
    cg.innerHTML = '';
    MAP.POWERS.forEach(function (p) {
      var isBot = bots.indexOf(p) !== -1;
      var card = document.createElement('div');
      card.className = 'codecard';
      card.style.borderTop = '4px solid ' + MAP.POWER_INFO[p].color;
      if (isBot) card.style.background = '#efe9da';
      card.innerHTML = '<div class="pname">' + MAP.POWER_INFO[p].name + '</div>' +
        (isBot ? '<div class="code">🤖 AI</div>' : '<div class="code">' + esc(r.codes[p]) + '</div>');
      if (!isBot) {
        card.appendChild(actBtn('↻ New code', 'ghost', async function () {
          if (!confirm('Replace ' + MAP.POWER_INFO[p].name + "'s code? The old one stops working immediately.")) return;
          var rr = await tcall({ action: 'tregen', gameId: gameId, power: p });
          if (rr.ok) openDetail(gameId, true);
        }));
        card.appendChild(actBtn('🤖 Make AI', 'ghost', async function () {
          if (!confirm('Let the computer play ' + MAP.POWER_INFO[p].name + ' from now on? Its code stops working.')) return;
          await tcall({ action: 'tbot', gameId: gameId, power: p, isBot: true });
          openDetail(gameId, true);
        }));
      } else {
        card.appendChild(actBtn('👤 Give to a student', 'ghost', async function () {
          await tcall({ action: 'tbot', gameId: gameId, power: p, isBot: false });
          openDetail(gameId, true);
        }));
      }
      cg.appendChild(card);
    });

    // board (drawn in the same style the kids see)
    if (!dBoard) dBoard = await DiploBoard.create($('dBoard'), {});
    dBoard.styleMode = (r.settings && r.settings.mapStyle) === 'terrain' ? 'terrain' : 'empire';
    dBoard.tintOwnership(r.state.scOwners);
    dBoard.drawSCs(r.state.scOwners);
    dBoard.drawUnits(r.state.units, r.state.phase === 'RETREAT' ? r.state.dislodged : null);
    drawDetailOrders();

    // orders
    var ol = $('dOrders');
    ol.innerHTML = '';
    MAP.POWERS.forEach(function (p) {
      var entry = r.orders[p];
      var li = document.createElement('li');
      var chip = '<span class="dot" style="background:' + MAP.POWER_INFO[p].color + '"></span><b>' + MAP.POWER_INFO[p].name + '</b>: ';
      if (bots.indexOf(p) !== -1) {
        li.innerHTML = chip + '🤖 <span class="muted">computer — writes its orders when you hit Resolve</span>';
      } else if (!entry || !entry.list || !entry.list.length) {
        li.innerHTML = chip + '<span class="muted">no orders yet' + (entry && entry.submitted ? ' (submitted empty)' : '') + '</span>';
      } else {
        li.innerHTML = chip + (entry.submitted ? '✅ ' : '✏️ ') +
          entry.list.map(function (o) { return esc(orderBrief(o)); }).join('; ');
      }
      ol.appendChild(li);
    });

    // messages
    function envoy(p) {
      if (bots.indexOf(p) !== -1 && typeof DIPLOMACY_BOT !== 'undefined') {
        return '🤖 ' + DIPLOMACY_BOT.LEADERS[p].name + ' (' + MAP.POWER_INFO[p].name + ')';
      }
      return MAP.POWER_INFO[p].name;
    }
    var ml = $('dMsgs');
    ml.innerHTML = '';
    (r.messages || []).slice().sort(function (a, b) { return a.ts < b.ts ? -1 : 1; }).forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'msg in';
      var kindIcon = { alliance: '🤝 ', peace: '🕊 ', threat: '⚔ ' }[m.kind] || '';
      div.innerHTML = '<div class="meta">' + kindIcon + esc(envoy(m.from)) + ' → ' +
        esc(envoy(m.to)) + ' · ' + esc(m.turn || '') + '</div>' + esc(m.text);
      ml.appendChild(div);
    });
    if (!(r.messages || []).length) ml.innerHTML = '<div class="muted small">No messages yet.</div>';
    ml.scrollTop = ml.scrollHeight;

    // AI attitudes (teacher's eyes only)
    var attHtml = '';
    if (bots.length && r.settings.relations) {
      attHtml = '<div class="small" style="border:1px dashed var(--gold);border-radius:5px;padding:6px 8px;margin-bottom:6px"><b>AI attitudes</b> (only you see this):<br>';
      bots.forEach(function (b) {
        var row = (r.settings.relations[b]) || {};
        var bits = [];
        MAP.POWERS.forEach(function (o) {
          if (o === b) return;
          var v = row[o] || 0;
          if (v === 0) return;
          var face = v >= 3 ? '🤝' : v > 0 ? '🙂' : v <= -3 ? '💀' : '😠';
          bits.push(face + ' ' + MAP.POWER_INFO[o].name + ' ' + (v > 0 ? '+' : '') + v);
        });
        attHtml += '🤖 <b>' + (typeof DIPLOMACY_BOT !== 'undefined' ? DIPLOMACY_BOT.LEADERS[b].short : b) + '</b>: ' +
          (bits.length ? bits.join(' · ') : 'neutral toward everyone') + '<br>';
      });
      attHtml += '</div>';
    }

    // settings
    var s = r.settings;
    $('dSettings').innerHTML = attHtml +
      '<label>Centers to win: <input id="setV" type="number" min="7" max="18" value="' + s.victorySCs + '" style="width:60px"></label>' +
      '<label>End year (blank = none): <input id="setEY" type="number" min="1902" max="1950" value="' + (s.endYear || '') + '" style="width:80px"></label>' +
      '<label>Map style the kids see: <select id="setStyle">' +
      '<option value="empire"' + (s.mapStyle !== 'terrain' ? ' selected' : '') + '>Empire (countries colored)</option>' +
      '<option value="terrain"' + (s.mapStyle === 'terrain' ? ' selected' : '') + '>Classic terrain (1976 look)</option>' +
      '</select></label>' +
      '<label><input id="setView" type="checkbox" ' + (s.allowViewLocked ? 'checked' : '') + '> Kids may VIEW the board while locked (read-only at home)</label>' +
      '<label><input id="setAuto" type="checkbox" ' + (s.autoResolve ? 'checked' : '') + '> Auto-resolve when all humans have submitted</label>' +
      '<button class="act" id="setSave" style="align-self:flex-start">Save settings</button>';
    $('setSave').addEventListener('click', async function () {
      var ey = $('setEY').value;
      await tcall({
        action: 'tsettings', gameId: gameId, settings: {
          victorySCs: parseInt($('setV').value, 10) || 12,
          endYear: ey ? parseInt(ey, 10) : null,
          mapStyle: $('setStyle').value,
          allowViewLocked: $('setView').checked,
          autoResolve: $('setAuto').checked
        }
      });
      openDetail(gameId, true);
    });

    if (!keepScroll) $('detailPanel').scrollIntoView({ behavior: 'smooth' });
  }

  function drawDetailOrders() {
    if (!detail) return;
    if (showLast && detail.lastTurn) {
      dBoard.drawOrders(detail.lastTurn.orders);
    } else {
      var entries = [];
      MAP.POWERS.forEach(function (p) {
        var e = detail.orders[p];
        (e && e.list || []).forEach(function (o) { entries.push({ power: p, order: o }); });
      });
      dBoard.drawOrders(entries);
    }
  }

  function orderBrief(o) {
    function P(x) { return x ? x.toUpperCase() : ''; }
    switch (o.type) {
      case 'hold': return P(o.unit) + ' H';
      case 'move': return P(o.unit) + '→' + P(o.dest) + (o.viaConvoy ? '(c)' : '');
      case 'support': return P(o.unit) + ' S ' + P(o.from) + (o.to ? '→' + P(o.to) : '');
      case 'convoy': return P(o.unit) + ' C ' + P(o.from) + '→' + P(o.to);
      case 'retreat': return P(o.unit) + ' retreat→' + P(o.dest);
      case 'disband': return P(o.unit) + ' disband';
      case 'build': return 'build ' + (o.unitType || 'A') + ' ' + P(o.loc);
      case 'remove': return 'remove ' + P(o.loc);
      case 'waive': return 'waive';
    }
    return '?';
  }

  $('dClose').addEventListener('click', closeDetail);
  function closeDetail() {
    $('detailPanel').style.display = 'none';
    currentGame = null;
    detail = null;
  }

  $('dResolve').addEventListener('click', async function () {
    if (!currentGame) return;
    var r = await tcall({ action: 'tresolve', gameId: currentGame });
    if (!r.ok) { alert(r.error); return; }
    showLast = true;
    $('dShowLast').textContent = "Show this turn's orders";
    await openDetail(currentGame, true);
    refresh();
  });

  $('dLockBtn').addEventListener('click', async function () {
    if (!currentGame || !detail) return;
    await tcall({ action: 'tlock', gameId: currentGame, locked: !detail.locked });
    openDetail(currentGame, true);
    refresh();
  });

  $('dUndo').addEventListener('click', async function () {
    if (!currentGame) return;
    if (!confirm('Undo the last resolved turn? The board rolls back and all current orders are cleared.')) return;
    var r = await tcall({ action: 'tundo', gameId: currentGame });
    if (!r.ok) alert(r.error);
    openDetail(currentGame, true);
    refresh();
  });

  $('dShowLast').addEventListener('click', function () {
    showLast = !showLast;
    $('dShowLast').textContent = showLast ? "Show this turn's orders" : "Show last turn's moves";
    drawDetailOrders();
  });

  /* ---------- schedule ---------- */

  $('schedSave').addEventListener('click', async function () {
    var r = await tcall({
      action: 'tschedule',
      schedule: {
        enforce: $('schedOn').checked,
        days: $('schedDays').value.split('').map(Number),
        start: $('schedStart').value,
        end: $('schedEnd').value
      }
    });
    $('schedStatus').textContent = r.ok ? (r.note || 'Saved ✓') : ('⚠️ ' + r.error);
  });

  /* ---------- war room music (this screen only) ---------- */

  /* "Over There mix": clean USAF Band instrumental loops; every third
     piece, the real 1917 recording with voices plays once, then back. */
  var OVERTHERE_MIX = {
    instrumental: 'audio/overthere-instrumental-usaf-band.mp3',
    vocal: 'audio/overthere-vocal-1917-restored.mp3',
    vocalEvery: 3
  };
  var MUSIC_TRACKS = [
    { label: '★ Over There mix — instrumental, with the 1917 voices now and then', mix: true },
    { label: 'Hero Down — sad piano (WW1 is a sad game)', file: 'audio/defeat-hero-down.mp3' },
    { label: 'Over There — USAF Band instrumental only', file: 'audio/overthere-instrumental-usaf-band.mp3' },
    { label: 'Over There — 1917 vocal, restored', file: 'audio/overthere-vocal-1917-restored.mp3' },
    { label: 'Over There — Enrico Caruso, 1918', file: 'audio/overthere-vocal-caruso-1918.mp3' },
    { label: 'Stormfront — epic orchestral war', file: 'audio/battle-stormfront.mp3' },
    { label: "It's a Long Way to Tipperary — 1914", file: 'audio/period-tipperary-imperial-quartet-1914.mp3' },
    { label: 'Pack Up Your Troubles — 1917', file: 'audio/period-pack-up-your-troubles-1917.mp3' },
    { label: 'Tipperary March — brass band, 1907', file: 'audio/period-tipperary-march-band-1907.mp3' },
    { label: 'Invariance — military snare march', file: 'audio/march-invariance.mp3' },
    { label: 'Dark Times — brooding strings', file: 'audio/warroom-dark-times.mp3' }
  ];
  var musicEl = new Audio();
  var fanfareEl = new Audio('audio/victory-fanfare-for-space.mp3');
  var musicPlaying = false;
  var mixCount = 0;

  function startTrack() {
    var t = MUSIC_TRACKS[Number($('musicSel').value)] || MUSIC_TRACKS[0];
    if (t.mix) {
      musicEl.loop = false;
      musicEl.src = (mixCount % OVERTHERE_MIX.vocalEvery === OVERTHERE_MIX.vocalEvery - 1)
        ? OVERTHERE_MIX.vocal : OVERTHERE_MIX.instrumental;
    } else {
      musicEl.loop = true;
      musicEl.src = t.file;
    }
    musicEl.play().catch(function () {});
  }

  (function initMusic() {
    var sel = $('musicSel');
    MUSIC_TRACKS.forEach(function (t, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = t.label;
      sel.appendChild(o);
    });
    sel.value = localStorage.getItem('diplomacy_music_track') || '0';
    if (!MUSIC_TRACKS[Number(sel.value)]) sel.value = '0';
    $('musicVol').value = localStorage.getItem('diplomacy_music_vol') || '60';
    musicEl.volume = Number($('musicVol').value) / 100;
    fanfareEl.volume = Math.min(1, musicEl.volume + 0.2);

    $('musicBtn').addEventListener('click', function () {
      if (musicPlaying) {
        musicEl.pause();
        musicPlaying = false;
        $('musicBtn').textContent = '▶ Play';
      } else {
        musicPlaying = true;
        $('musicBtn').textContent = '⏸ Pause';
        startTrack();
      }
    });
    sel.addEventListener('change', function () {
      localStorage.setItem('diplomacy_music_track', sel.value);
      mixCount = 0;
      if (musicPlaying) startTrack();
    });
    $('musicVol').addEventListener('input', function () {
      localStorage.setItem('diplomacy_music_vol', $('musicVol').value);
      musicEl.volume = Number($('musicVol').value) / 100;
      fanfareEl.volume = Math.min(1, musicEl.volume + 0.2);
    });
    musicEl.addEventListener('ended', function () {
      if (!musicPlaying) return;
      mixCount++;
      startTrack();         // only mix tracks end (others loop)
    });
    fanfareEl.addEventListener('ended', function () {
      if (musicPlaying) musicEl.play().catch(function () {});
    });
  })();

  /* a board just crowned a winner -> trumpets (ducks the main theme) */
  var knownWinners = {};
  function checkFanfare(games) {
    (games || []).forEach(function (g) {
      var had = knownWinners[g.gameId];
      if (g.winner && had === null) {
        if (musicPlaying) musicEl.pause();
        fanfareEl.currentTime = 0;
        fanfareEl.play().catch(function () {});
      }
      knownWinners[g.gameId] = g.winner || null;
    });
  }

  /* ---------- boot ---------- */

  if (tkey()) enter(); else showLogin('');
  setInterval(function () {
    if ($('tmain').style.display !== 'none') refresh();
  }, 15000);
})();
