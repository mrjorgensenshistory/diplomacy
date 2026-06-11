/* ============================================================
 * DIPLOMACY — student client
 * ============================================================ */

(function () {
  var MAP = DIPLOMACY_MAP, ENG = DIPLOMACY_ENGINE;
  var $ = function (id) { return document.getElementById(id); };

  var CODE_KEY = 'diplomacy_code';
  var model = null;        // last server view
  var board = null;
  var myOrders = [];       // working copy of my orders
  var mode = { step: 'idle' };
  var saving = false;
  var pollTimer = null;
  var showingLastTurn = false;

  /* ---------------- join flow ---------------- */

  function showJoin(msg) {
    $('join').style.display = '';
    $('game').style.display = 'none';
    $('joinErr').textContent = msg || '';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function tryJoin(code, silent) {
    var r = await DiploAPI.call({ action: 'join', code: code });
    if (!r.ok) {
      showJoin(r.error || 'Could not join.');
      return false;
    }
    localStorage.setItem(CODE_KEY, code.trim().toUpperCase());
    model = r;
    myOrders = (r.orders || []).slice();
    await enterGame();
    return true;
  }

  $('joinBtn').addEventListener('click', function () { tryJoin($('joinCode').value); });
  $('joinCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') tryJoin($('joinCode').value); });
  $('leaveBtn').addEventListener('click', function () {
    localStorage.removeItem(CODE_KEY);
    showJoin('');
  });

  /* ---------------- game screen ---------------- */

  async function enterGame() {
    $('join').style.display = 'none';
    $('game').style.display = '';
    if (!board) {
      board = await DiploBoard.create($('boardSvg'), { onProvinceClick: onProvinceClick });
    }
    mode = { step: 'idle' };
    renderAll();
    if (!pollTimer) pollTimer = setInterval(poll, (DIPLO_CONFIG.POLL_SECONDS || 10) * 1000);
  }

  async function poll() {
    if (!model || saving) return;
    var r = await DiploAPI.call({ action: 'state', code: localStorage.getItem(CODE_KEY), version: model.version });
    if (!r.ok) {
      if (r.locked) setBanner('locked', '🔒 ' + (r.error || 'Game locked.'));
      return;
    }
    if (!r.changed) return;
    var phaseBefore = model.phaseLabel;
    model = r;
    myOrders = (r.orders || []).slice();
    if (model.phaseLabel !== phaseBefore) { mode = { step: 'idle' }; showingLastTurn = false; }
    renderAll();
  }

  /* ---------------- rendering ---------------- */

  function setBanner(kind, html) {
    $('banners').innerHTML = html ? '<div class="banner ' + kind + '">' + html + '</div>' : '';
  }

  function renderAll() {
    if (!model) return;
    var st = model.state;
    var pinfo = MAP.POWER_INFO[model.power];

    $('gameName').textContent = model.gameName || '';
    $('phaseBadge').textContent = model.phaseLabel;
    $('powerBadge').textContent = pinfo.name;
    $('powerBadge').style.background = pinfo.color;
    $('scBadge').textContent = '★ ' + ENG.scCount(st, model.power) + ' / ' + (st.victorySCs || 18) + ' centers';
    var lockB = $('lockBadge');
    lockB.textContent = model.locked ? '🔒 Locked' : '🔓 Open';
    lockB.className = 'badge ' + (model.locked ? 'lock-on' : 'lock-off');

    // the teacher chooses the map style per game
    board.styleMode = (model.settings && model.settings.mapStyle) === 'terrain' ? 'terrain' : 'empire';
    board.tintOwnership(st.scOwners);
    board.drawSCs(st.scOwners);
    board.drawUnits(st.units, st.phase === 'RETREAT' ? st.dislodged : null);

    if (showingLastTurn && model.lastTurn) board.drawOrders(model.lastTurn.orders);
    else drawMyOrderArrows();

    // banners
    if (st.winner) {
      setBanner('winner', st.winner === 'DRAW'
        ? '⚖️ The game has ended in a draw.'
        : '👑 ' + MAP.POWER_INFO[st.winner].name + ' has won the game!');
    } else if (model.locked) {
      setBanner('locked', '🔒 The game is locked. You can look, but orders open during class.');
    } else {
      setBanner('', '');
    }

    renderActionBar();
    renderOrderList();
    renderWhoIsIn();
    renderMessages();
    renderLastTurn();
  }

  function drawMyOrderArrows() {
    board.drawOrders(myOrders.map(function (o) { return { power: model.power, order: o }; }));
  }

  function renderWhoIsIn() {
    var bits = MAP.POWERS.map(function (p) {
      var inGame = ENG.unitCount(model.state, p) > 0;
      if (!inGame) return '';
      var c = MAP.POWER_INFO[p].color;
      var done = model.submittedBy && model.submittedBy[p];
      return '<span title="' + MAP.POWER_INFO[p].name + (done ? ' — orders in' : ' — still planning') + '">' +
        '<span class="dot" style="background:' + (done ? c : 'transparent') + ';border:2px solid ' + c + '"></span></span>';
    }).join(' ');
    $('whoIsIn').innerHTML = 'Orders in: ' + bits;
  }

  /* ---------------- order list panel ---------------- */

  function orderText(o) {
    function P(x) { return x ? x.toUpperCase() : ''; }
    var u = model.state.units[o.unit] || (model.state.dislodged || {})[o.unit];
    var t = u ? (u.type === 'A' ? '★' : '⚓') : '';
    switch (o.type) {
      case 'hold': return t + ' ' + P(o.unit) + ' holds';
      case 'move': return t + ' ' + P(o.unit) + ' → ' + P(o.dest) + (o.destCoast ? '/' + o.destCoast : '') + (o.viaConvoy ? ' (by convoy)' : '');
      case 'support': return t + ' ' + P(o.unit) + ' supports ' + P(o.from) + (o.to ? ' → ' + P(o.to) : ' holding');
      case 'convoy': return t + ' ' + P(o.unit) + ' convoys ' + P(o.from) + ' → ' + P(o.to);
      case 'retreat': return t + ' ' + P(o.unit) + ' retreats → ' + P(o.dest) + (o.destCoast ? '/' + o.destCoast : '');
      case 'disband': return t + ' ' + P(o.unit) + ' disbands';
      case 'build': return 'Build ' + (o.unitType === 'F' ? '⚓ Fleet' : '★ Army') + ' in ' + P(o.loc) + (o.coast ? '/' + o.coast : '');
      case 'remove': return 'Remove unit in ' + P(o.loc);
      case 'waive': return 'Waive build';
    }
    return JSON.stringify(o);
  }

  function renderOrderList() {
    var ul = $('orderList');
    ul.innerHTML = '';
    if (!myOrders.length) {
      ul.innerHTML = '<li class="muted">No orders yet. Units without orders will hold.</li>';
    }
    myOrders.forEach(function (o, i) {
      var li = document.createElement('li');
      li.textContent = orderText(o);
      var del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Remove this order';
      del.addEventListener('click', function () {
        myOrders.splice(i, 1);
        saveOrders(false);
      });
      li.appendChild(del);
      ul.appendChild(li);
    });
    var canAct = !model.locked && !model.state.winner;
    $('submitBtn').style.display = model.submitted ? 'none' : '';
    $('unsubmitBtn').style.display = model.submitted ? '' : 'none';
    $('submitBtn').disabled = !canAct;
    $('unsubmitBtn').disabled = !canAct;
  }

  $('submitBtn').addEventListener('click', function () { saveOrders(true); });
  $('unsubmitBtn').addEventListener('click', function () { saveOrders(false); });

  async function saveOrders(submitted) {
    saving = true;
    var r = await DiploAPI.call({
      action: 'orders', code: localStorage.getItem(CODE_KEY),
      orders: myOrders, submitted: submitted
    });
    saving = false;
    if (!r.ok) {
      setBanner('locked', '⚠️ ' + (r.error || 'Could not save.'));
      return;
    }
    model.version = r.version;
    model.submitted = submitted;
    if (model.submittedBy) model.submittedBy[model.power] = submitted;
    mode = { step: 'idle' };
    renderAll();
  }

  /* ---------------- map interaction ---------------- */

  function onProvinceClick(prov) {
    if (!model || model.locked || model.state.winner) return;
    showingLastTurn = false;
    var st = model.state;
    if (st.phase === 'MOVE') moveClick(prov);
    else if (st.phase === 'RETREAT') retreatClick(prov);
    else if (st.phase === 'BUILD') buildClick(prov);
  }

  /* ----- MOVE phase ----- */

  function myUnitAt(prov) {
    var u = model.state.units[prov];
    return (u && u.power === model.power) ? u : null;
  }

  function setOrder(o) {
    // one order per unit
    myOrders = myOrders.filter(function (x) { return x.unit !== o.unit; });
    var v = ENG.validateOrder(model.state, model.power, o);
    if (!v.ok) { hint('⚠️ ' + v.error); mode = { step: 'idle' }; render(); return; }
    myOrders.push(o);
    saveOrders(false);
  }

  function moveClick(prov) {
    var st = model.state;
    if (mode.step === 'idle' || mode.step === 'action') {
      if (myUnitAt(prov)) {
        mode = { step: 'action', unit: prov };
        render();
      }
      return;
    }
    if (mode.step === 'move-target') {
      if (prov === mode.unit) { mode = { step: 'idle' }; render(); return; }
      var t = mode.targets[prov];
      if (!t) return;
      finishMove(mode.unit, prov, t);
      return;
    }
    if (mode.step === 'support-unit') {
      var u = st.units[prov];
      if (!u || prov === mode.unit) return;
      // step 2: where can that unit go that I can also reach?
      var supporter = st.units[mode.unit];
      var reach = directReach(mode.unit, supporter);
      var lt = ENG.legalTargets(st, prov) || { moves: [], convoyMoves: [] };
      var dests = {};
      lt.moves.concat(lt.convoyMoves || []).forEach(function (m) {
        if (reach[m.dest]) dests[m.dest] = true;
      });
      if (reach[prov]) dests[prov] = 'hold';
      if (!Object.keys(dests).length) { hint('⚠️ You cannot support that unit anywhere it can go.'); return; }
      mode = { step: 'support-dest', unit: mode.unit, supported: prov, dests: dests };
      render();
      return;
    }
    if (mode.step === 'support-dest') {
      if (!mode.dests[prov]) return;
      if (prov === mode.supported) setOrder({ type: 'support', unit: mode.unit, from: mode.supported, to: null });
      else setOrder({ type: 'support', unit: mode.unit, from: mode.supported, to: prov });
      return;
    }
    if (mode.step === 'convoy-army') {
      var au = st.units[prov];
      if (!au || au.type !== 'A' || !MAP.isCoast(prov)) return;
      mode = { step: 'convoy-dest', unit: mode.unit, army: prov };
      render();
      return;
    }
    if (mode.step === 'convoy-dest') {
      if (!MAP.isCoast(prov) || prov === mode.army) return;
      setOrder({ type: 'convoy', unit: mode.unit, from: mode.army, to: prov });
      return;
    }
  }

  function directReach(prov, u) {
    var out = {};
    if (u.type === 'A') {
      (MAP.armyAdj[prov] || []).forEach(function (p) { out[p] = true; });
    } else {
      (MAP.fleetAdj[MAP.fleetLoc(prov, u.coast)] || []).forEach(function (l) {
        out[MAP.splitLoc(l).prov] = true;
      });
    }
    return out;
  }

  function finishMove(unit, dest, targetInfo) {
    var st = model.state;
    var u = st.units[unit];
    if (u.type === 'A') {
      var direct = targetInfo.direct, convoy = targetInfo.convoy;
      if (direct && convoy) {
        choiceModal('March overland or convoy by sea?', [
          { label: '🥾 March (land)', value: 'land' },
          { label: '⚓ Convoy (sea)', value: 'sea' }
        ], function (v) {
          setOrder({ type: 'move', unit: unit, dest: dest, viaConvoy: v === 'sea' });
        });
      } else {
        setOrder({ type: 'move', unit: unit, dest: dest, viaConvoy: !direct });
      }
      return;
    }
    // fleet: handle coasts
    var coasts = MAP.PROVINCES[dest].coasts ? MAP.reachableCoasts(unit, u.coast, dest) : [];
    if (coasts.length > 1) {
      choiceModal('Which coast of ' + MAP.PROVINCES[dest].name + '?', coasts.map(function (c) {
        return { label: c.toUpperCase() + ' coast', value: c };
      }), function (c) {
        setOrder({ type: 'move', unit: unit, dest: dest, destCoast: c });
      });
    } else {
      setOrder({ type: 'move', unit: unit, dest: dest, destCoast: coasts[0] || null });
    }
  }

  /* ----- RETREAT phase ----- */

  function retreatClick(prov) {
    var st = model.state;
    var d = st.dislodged || {};
    if (mode.step === 'retreat-target') {
      var opts = mode.options.filter(function (l) { return MAP.splitLoc(l).prov === prov; });
      if (!opts.length) {
        if (d[prov] && d[prov].power === model.power) { selectRetreat(prov); }
        return;
      }
      if (opts.length > 1) {
        choiceModal('Which coast?', opts.map(function (l) {
          return { label: MAP.splitLoc(l).coast.toUpperCase() + ' coast', value: MAP.splitLoc(l).coast };
        }), function (c) {
          setRetreatOrder({ type: 'retreat', unit: mode.unit, dest: prov, destCoast: c });
        });
      } else {
        var s = MAP.splitLoc(opts[0]);
        setRetreatOrder({ type: 'retreat', unit: mode.unit, dest: prov, destCoast: s.coast });
      }
      return;
    }
    if (d[prov] && d[prov].power === model.power) selectRetreat(prov);
  }

  function selectRetreat(prov) {
    mode = { step: 'retreat-target', unit: prov, options: (model.state.dislodged[prov].options || []) };
    render();
  }

  function setRetreatOrder(o) {
    myOrders = myOrders.filter(function (x) { return x.unit !== o.unit; });
    myOrders.push(o);
    saveOrders(false);
  }

  /* ----- BUILD phase ----- */

  function buildClick(prov) {
    var st = model.state;
    var adj = ENG.adjustmentsFor(st)[model.power];
    if (adj.delta > 0) {
      if (adj.vacantHome.indexOf(prov) === -1) return;
      var planned = myOrders.filter(function (o) { return o.type === 'build'; });
      if (planned.some(function (o) { return o.loc === prov; })) return;
      if (planned.length >= adj.delta) { hint('⚠️ You only get ' + adj.delta + ' build(s). Remove one first.'); return; }
      var canFleet = MAP.fleetLocsOf(prov).length > 0;
      var choices = [{ label: '★ Army', value: 'A' }];
      if (canFleet) choices.push({ label: '⚓ Fleet', value: 'F' });
      choiceModal('Build what in ' + MAP.PROVINCES[prov].name + '?', choices, function (t) {
        if (t === 'F' && MAP.PROVINCES[prov].coasts) {
          choiceModal('Which coast?', MAP.PROVINCES[prov].coasts.map(function (c) {
            return { label: c.toUpperCase() + ' coast', value: c };
          }), function (c) {
            myOrders.push({ type: 'build', loc: prov, unitType: 'F', coast: c });
            saveOrders(false);
          });
        } else {
          myOrders.push({ type: 'build', loc: prov, unitType: t });
          saveOrders(false);
        }
      });
    } else if (adj.delta < 0) {
      if (!myUnitAt(prov)) return;
      if (myOrders.some(function (o) { return o.type === 'remove' && o.loc === prov; })) return;
      if (myOrders.filter(function (o) { return o.type === 'remove'; }).length >= -adj.delta) {
        hint('⚠️ You only need to remove ' + (-adj.delta) + '.');
        return;
      }
      myOrders.push({ type: 'remove', loc: prov });
      saveOrders(false);
    }
  }

  /* ---------------- action bar + highlights ---------------- */

  function hint(html) { $('orderHint').innerHTML = html; }

  function render() {
    renderActionBar();
    applyHighlights();
    drawMyOrderArrows();
  }

  function renderActionBar() {
    var bar = $('actionBar');
    bar.innerHTML = '';
    var st = model.state;
    var canAct = !model.locked && !st.winner;

    function btn(label, cls, fn, disabled) {
      var b = document.createElement('button');
      b.className = 'act ' + (cls || '');
      b.textContent = label;
      b.disabled = !!disabled;
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    }

    if (!canAct) {
      hint(model.locked ? 'The game is locked. Plot quietly until class.' : 'The game has ended.');
      applyHighlights();
      return;
    }

    if (st.phase === 'MOVE') {
      if (mode.step === 'idle') {
        hint('Click one of your units on the map to give it an order. Unordered units hold.');
      } else if (mode.step === 'action') {
        var u = st.units[mode.unit];
        hint('<b>' + (u.type === 'A' ? '★ Army' : '⚓ Fleet') + ' ' + mode.unit.toUpperCase() + '</b> — choose an order:');
        btn('Hold', 'ghost', function () { setOrder({ type: 'hold', unit: mode.unit }); });
        btn('Move', '', function () {
          var lt = ENG.legalTargets(st, mode.unit);
          var targets = {};
          lt.moves.forEach(function (m) { targets[m.dest] = { direct: true }; });
          (lt.convoyMoves || []).forEach(function (m) {
            targets[m.dest] = targets[m.dest] ? { direct: true, convoy: true } : { convoy: true };
          });
          mode = { step: 'move-target', unit: mode.unit, targets: targets };
          render();
        });
        btn('Support', '', function () { mode = { step: 'support-unit', unit: mode.unit }; render(); });
        if (u.type === 'F' && MAP.isSea(mode.unit)) {
          btn('Convoy', '', function () { mode = { step: 'convoy-army', unit: mode.unit }; render(); });
        }
        btn('Cancel', 'warn', function () { mode = { step: 'idle' }; render(); });
      } else if (mode.step === 'move-target') {
        hint('Click a highlighted province to move <b>' + mode.unit.toUpperCase() + '</b> there.');
        btn('Cancel', 'warn', function () { mode = { step: 'idle' }; render(); });
      } else if (mode.step === 'support-unit') {
        hint('Click the unit you want to <b>support</b> (any country’s).');
        btn('Cancel', 'warn', function () { mode = { step: 'idle' }; render(); });
      } else if (mode.step === 'support-dest') {
        hint('Click where you are supporting <b>' + mode.supported.toUpperCase() + '</b> to go. Click its own province to support it holding.');
        btn('Cancel', 'warn', function () { mode = { step: 'idle' }; render(); });
      } else if (mode.step === 'convoy-army') {
        hint('Click the <b>army</b> your fleet will convoy.');
        btn('Cancel', 'warn', function () { mode = { step: 'idle' }; render(); });
      } else if (mode.step === 'convoy-dest') {
        hint('Click the <b>destination</b> for the convoyed army at ' + mode.army.toUpperCase() + '.');
        btn('Cancel', 'warn', function () { mode = { step: 'idle' }; render(); });
      }
    } else if (st.phase === 'RETREAT') {
      var mine = Object.keys(st.dislodged || {}).filter(function (p) {
        return st.dislodged[p].power === model.power;
      });
      if (!mine.length) {
        hint('No retreats needed from you. Waiting for other players…');
      } else if (mode.step === 'retreat-target') {
        hint('Click a highlighted province to retreat <b>' + mode.unit.toUpperCase() + '</b>, or disband it.');
        btn('Disband instead', 'warn', function () {
          setRetreatOrder({ type: 'disband', unit: mode.unit });
        });
        btn('Cancel', 'ghost', function () { mode = { step: 'idle' }; render(); });
      } else {
        hint('💥 Your flashing unit(s) were dislodged! Click one to retreat it.');
      }
    } else if (st.phase === 'BUILD') {
      var adj2 = ENG.adjustmentsFor(st)[model.power];
      if (adj2.delta > 0) {
        var used = myOrders.filter(function (o) { return o.type === 'build'; }).length;
        hint('🏭 You may build <b>' + adj2.delta + '</b> new unit(s) (' + used + ' placed). Click a highlighted home center.');
        btn('Waive remaining builds', 'ghost', function () { saveOrders(true); });
      } else if (adj2.delta < 0) {
        var rem = myOrders.filter(function (o) { return o.type === 'remove'; }).length;
        hint('📉 You must remove <b>' + (-adj2.delta) + '</b> unit(s) (' + rem + ' chosen). Click your units to remove them.');
      } else {
        hint('No builds or removals for you this winter. Waiting for others…');
      }
    } else {
      hint('The game has ended.');
    }
  }

  function applyHighlights() {
    var marks = {};
    var st = model.state;
    if (st.phase === 'MOVE') {
      if (mode.step === 'action') marks[mode.unit] = 'sel';
      if (mode.step === 'move-target') {
        marks[mode.unit] = 'sel';
        Object.keys(mode.targets).forEach(function (p) { marks[p] = 'target'; });
      }
      if (mode.step === 'support-unit') {
        marks[mode.unit] = 'sel';
        Object.keys(st.units).forEach(function (p) { if (p !== mode.unit) marks[p] = 'target'; });
      }
      if (mode.step === 'support-dest') {
        marks[mode.unit] = 'sel'; marks[mode.supported] = 'warn';
        Object.keys(mode.dests).forEach(function (p) { marks[p] = 'target'; });
      }
      if (mode.step === 'convoy-army') {
        marks[mode.unit] = 'sel';
        Object.keys(st.units).forEach(function (p) {
          if (st.units[p].type === 'A' && MAP.isCoast(p)) marks[p] = 'target';
        });
      }
      if (mode.step === 'convoy-dest') {
        marks[mode.unit] = 'sel'; marks[mode.army] = 'warn';
        Object.keys(MAP.PROVINCES).forEach(function (p) {
          if (MAP.isCoast(p) && p !== mode.army) marks[p] = 'target';
        });
      }
    } else if (st.phase === 'RETREAT') {
      if (mode.step === 'retreat-target') {
        marks[mode.unit] = 'sel';
        mode.options.forEach(function (l) { marks[MAP.splitLoc(l).prov] = 'target'; });
      }
    } else if (st.phase === 'BUILD') {
      var adj = ENG.adjustmentsFor(st)[model.power];
      if (adj.delta > 0) adj.vacantHome.forEach(function (p) { marks[p] = 'target'; });
      if (adj.delta < 0) {
        Object.keys(st.units).forEach(function (p) {
          if (st.units[p].power === model.power) marks[p] = 'target';
        });
      }
    }
    board.highlight(marks);
  }

  /* ---------------- modals ---------------- */

  function choiceModal(title, choices, cb) {
    var host = $('modalHost');
    var back = document.createElement('div');
    back.className = 'modal-back';
    var m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = '<h3>' + title + '</h3>';
    var row = document.createElement('div');
    row.className = 'choices';
    choices.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'act';
      b.textContent = c.label;
      b.addEventListener('click', function () { host.innerHTML = ''; cb(c.value); });
      row.appendChild(b);
    });
    var cancel = document.createElement('button');
    cancel.className = 'act warn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () { host.innerHTML = ''; });
    row.appendChild(cancel);
    m.appendChild(row);
    back.appendChild(m);
    host.appendChild(back);
  }

  /* ---------------- tabs ---------------- */

  function showPane(which) {
    ['Orders', 'Msgs', 'Last'].forEach(function (k) {
      $('pane' + k).style.display = (k === which) ? '' : 'none';
      $('tab' + k).classList.toggle('active', k === which);
    });
    if (which === 'Msgs') {
      localStorage.setItem('diplomacy_msgseen_' + localStorage.getItem(CODE_KEY),
        String((model.messages || []).length));
      renderMessages();
    }
  }
  $('tabOrders').addEventListener('click', function () { showPane('Orders'); });
  $('tabMsgs').addEventListener('click', function () { showPane('Msgs'); });
  $('tabLast').addEventListener('click', function () { showPane('Last'); });

  /* ---------------- messages ---------------- */

  /* AI powers sign their mail as the real leaders of the era */
  function envoyName(p) {
    var bots = (model && model.settings && model.settings.bots) || [];
    if (bots.indexOf(p) !== -1 && typeof DIPLOMACY_BOT !== 'undefined') {
      return DIPLOMACY_BOT.LEADERS[p].name + ' (' + MAP.POWER_INFO[p].name + ')';
    }
    return MAP.POWER_INFO[p].name;
  }

  function renderMessages() {
    if (!model) return;
    var sel = $('msgTo');
    var keep = sel.value;
    sel.innerHTML = '';
    MAP.POWERS.forEach(function (p) {
      if (p === model.power) return;
      var o = document.createElement('option');
      o.value = p;
      o.textContent = '✉ To ' + envoyName(p);
      sel.appendChild(o);
    });
    if (keep) sel.value = keep;
    var list = $('msgList');
    list.innerHTML = '';
    var msgs = (model.messages || []).slice().sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
    msgs.forEach(function (m) {
      var div = document.createElement('div');
      var out = m.from === model.power;
      div.className = 'msg ' + (out ? 'out' : 'in');
      var who = out ? 'To ' + envoyName(m.to) : 'From ' + envoyName(m.from);
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = who + ' · ' + (m.turn || '');
      var body = document.createElement('div');
      body.textContent = m.text;
      div.appendChild(meta); div.appendChild(body);
      list.appendChild(div);
    });
    list.scrollTop = list.scrollHeight;
    var seen = parseInt(localStorage.getItem('diplomacy_msgseen_' + localStorage.getItem(CODE_KEY)) || '0', 10);
    var unread = Math.max(0, msgs.length - seen);
    $('msgCount').textContent = unread ? '(' + unread + ')' : '';
  }

  $('msgSend').addEventListener('click', async function () {
    var text = $('msgText').value.trim();
    if (!text) return;
    var r = await DiploAPI.call({
      action: 'message', code: localStorage.getItem(CODE_KEY),
      to: $('msgTo').value, text: text
    });
    if (!r.ok) { setBanner('locked', '⚠️ ' + (r.error || 'Could not send.')); return; }
    $('msgText').value = '';
    model.version = 0; // force refresh on next poll
    await poll();
    showPane('Msgs');
  });

  /* ---------------- last turn ---------------- */

  function renderLastTurn() {
    var lt = model.lastTurn;
    $('lastLabel').textContent = lt ? lt.label + ' — results' : 'No turns resolved yet';
    var ul = $('lastList');
    ul.innerHTML = '';
    if (!lt) return;
    lt.orders.forEach(function (e) {
      var li = document.createElement('li');
      var mark = document.createElement('span');
      mark.className = e.success ? 'res-ok' : 'res-fail';
      mark.textContent = e.success ? '✓' : '✕';
      li.appendChild(mark);
      var span = document.createElement('span');
      span.textContent = ' ' + MAP.POWER_INFO[e.power].name + ': ' + resultText(e.order);
      li.appendChild(span);
      if (e.note) {
        var n = document.createElement('span');
        n.className = 'note';
        n.textContent = ' (' + e.note + ')';
        li.appendChild(n);
      }
      ul.appendChild(li);
    });
  }

  function resultText(o) {
    function P(x) { return x ? x.toUpperCase() : ''; }
    switch (o.type) {
      case 'hold': return P(o.unit) + ' held';
      case 'move': return P(o.unit) + ' → ' + P(o.dest) + (o.viaConvoy ? ' (convoy)' : '');
      case 'support': return P(o.unit) + ' supported ' + P(o.from) + (o.to ? ' → ' + P(o.to) : '');
      case 'convoy': return P(o.unit) + ' convoyed ' + P(o.from) + ' → ' + P(o.to);
      case 'retreat': return P(o.unit) + ' retreated → ' + P(o.dest);
      case 'disband': return P(o.unit) + ' disbanded';
      case 'build': return 'built ' + (o.unitType === 'F' ? 'fleet' : 'army') + ' in ' + P(o.loc);
      case 'remove': return 'removed unit in ' + P(o.loc);
    }
    return '';
  }

  $('showArrowsBtn').addEventListener('click', function () {
    showingLastTurn = !showingLastTurn;
    $('showArrowsBtn').textContent = showingLastTurn ? 'Show my orders instead' : 'Show moves on map';
    if (showingLastTurn && model.lastTurn) board.drawOrders(model.lastTurn.orders);
    else drawMyOrderArrows();
  });

  /* ---------------- boot ---------------- */

  var saved = localStorage.getItem(CODE_KEY);
  if (saved) {
    tryJoin(saved).then(function (ok) { if (!ok) showJoin(''); });
  } else {
    showJoin('');
  }
})();
