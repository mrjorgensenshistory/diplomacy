/* ============================================================
 * DIPLOMACY — computer player ("normal" difficulty)
 *
 * A coordinated greedy strategist:
 *  - marches on the nearest supply centers it doesn't own
 *  - grabs adjacent open centers (extra urgency in Fall)
 *  - defends its own centers when enemies loom
 *  - pairs attacks with supports so captures actually land
 *  - never self-bounces two of its own units
 *  - retreats toward friendly ground, builds sensibly
 *
 * Pure function of (state, power): called server-side at resolve
 * time, so students can never see what the AI ordered.
 * Plain JS: browser, Node, and Google Apps Script.
 * ============================================================ */

var DIPLOMACY_BOT = (function () {

  var MAP = (typeof DIPLOMACY_MAP !== 'undefined') ? DIPLOMACY_MAP
          : (typeof require !== 'undefined') ? require('./map-data.js') : null;
  var ENG = (typeof DIPLOMACY_ENGINE !== 'undefined') ? DIPLOMACY_ENGINE
          : (typeof require !== 'undefined') ? require('./engine.js') : null;

  /* ---------- small helpers ---------- */

  function rnd() { return Math.random(); }

  /* province-level neighbor union (army + fleet), for threat checks */
  var provNbrCache = null;
  function provNeighbors(prov) {
    if (!provNbrCache) {
      provNbrCache = {};
      var k;
      function add(a, b) {
        if (!provNbrCache[a]) provNbrCache[a] = {};
        provNbrCache[a][b] = true;
      }
      for (k in MAP.armyAdj) MAP.armyAdj[k].forEach(function (n) { add(k, n); });
      for (k in MAP.fleetAdj) {
        var a = MAP.splitLoc(k).prov;
        MAP.fleetAdj[k].forEach(function (n) { add(a, MAP.splitLoc(n).prov); });
      }
    }
    return Object.keys(provNbrCache[prov] || {});
  }

  function enemiesAdjacent(state, prov, power) {
    var n = 0;
    provNeighbors(prov).forEach(function (p) {
      var u = state.units[p];
      if (u && u.power !== power) n++;
    });
    return n;
  }

  /* BFS distances for a unit type from a starting unit position.
     Armies walk armyAdj; fleets sail the fleet-location graph. */
  function bfsDistances(type, prov, coast) {
    var dist = {};
    if (type === 'A') {
      dist[prov] = 0;
      var q = [prov];
      while (q.length) {
        var cur = q.shift();
        (MAP.armyAdj[cur] || []).forEach(function (n) {
          if (dist[n] === undefined) { dist[n] = dist[cur] + 1; q.push(n); }
        });
      }
      return dist;
    }
    var ldist = {};
    var start = MAP.fleetLoc(prov, coast);
    ldist[start] = 0;
    var q2 = [start];
    while (q2.length) {
      var cur2 = q2.shift();
      (MAP.fleetAdj[cur2] || []).forEach(function (n) {
        if (ldist[n] === undefined) { ldist[n] = ldist[cur2] + 1; q2.push(n); }
      });
    }
    for (var loc in ldist) {
      var p = MAP.splitLoc(loc).prov;
      if (dist[p] === undefined || ldist[loc] < dist[p]) dist[p] = ldist[loc];
    }
    return dist;
  }

  /* supply centers this power wants (not currently its own) */
  function wantedSCs(state, power) {
    var out = [];
    MAP.allSCs().forEach(function (p) {
      if (state.scOwners[p] !== power) out.push(p);
    });
    return out;
  }

  /* ---------- movement phase ---------- */

  function moveOrders(state, power) {
    var myUnits = [];
    for (var p in state.units) {
      if (state.units[p].power === power) myUnits.push({ prov: p, u: state.units[p] });
    }
    var wanted = wantedSCs(state, power);
    var season = state.season;

    // candidate orders per unit, scored
    var unitCands = myUnits.map(function (me) {
      var dists = bfsDistances(me.u.type, me.prov, me.u.coast);
      var lt = ENG.legalTargets(state, me.prov) || { moves: [] };
      var onOwnSC = MAP.isSC(me.prov) && state.scOwners[me.prov] === power;
      var homeThreat = onOwnSC ? enemiesAdjacent(state, me.prov, power) : 0;

      var cands = [];
      lt.moves.forEach(function (m) {
        var t = m.dest;
        var occ = state.units[t];
        var s;
        if (occ && occ.power === power) {
          s = -6 + rnd();                                  // don't pile onto our own unit
        } else if (MAP.isSC(t) && state.scOwners[t] !== power) {
          s = occ ? 5.5 : 9;                               // capture! (harder if defended)
          if (season === 'FALL') s += 2;                   // fall captures stick
          if (!occ && !state.scOwners[t]) s += 0.5;        // virgin neutrals first
        } else {
          // progress toward the nearest wanted SC reachable from t
          var best = Infinity;
          var dt = bfsDistances(me.u.type, t, pickCoast(m) || null);
          wanted.forEach(function (w) {
            if (dt[w] !== undefined && dt[w] < best) best = dt[w];
          });
          s = best === Infinity ? 0.3 : Math.max(0.3, 5.5 - 1.6 * (best + 1));
          if (occ) s -= 1.2;                               // attacking non-SCs rarely worth it
        }
        if (homeThreat && season === 'FALL') s -= 3.5;     // don't abandon home in fall
        s += rnd() * 0.8;
        cands.push({ type: 'move', dest: t, destCoast: pickCoast(m), score: s });
      });

      // holding the fort
      var holdScore = homeThreat ? 6.5 + homeThreat : 1 + rnd();
      cands.push({ type: 'hold', score: holdScore });

      cands.sort(function (a, b) { return b.score - a.score; });
      return { me: me, cands: cands, dists: dists };
    });

    // strongest intentions claim destinations first (no self-bounces)
    unitCands.sort(function (a, b) { return b.cands[0].score - a.cands[0].score; });
    var claimed = {};      // dest -> prov of claimant
    var movedAway = {};    // prov -> true if its unit is leaving
    var assigned = {};     // prov -> chosen cand

    unitCands.forEach(function (uc) {
      var pick = null;
      for (var i = 0; i < uc.cands.length; i++) {
        var c = uc.cands[i];
        if (c.type === 'move') {
          if (claimed[c.dest]) continue;
          var occ = state.units[c.dest];
          if (occ && occ.power === power && !movedAway[c.dest]) continue;
          pick = c;
          claimed[c.dest] = uc.me.prov;
          movedAway[uc.me.prov] = true;
          break;
        }
        pick = c; // hold
        break;
      }
      assigned[uc.me.prov] = pick || { type: 'hold', score: 0 };
    });

    // support pass: idle/low-value units back up nearby attacks and defenses
    unitCands.forEach(function (uc) {
      var mine = assigned[uc.me.prov];
      if (!mine || mine.score >= 6 || mine.type !== 'hold') return;
      var bestSupport = null;
      unitCands.forEach(function (other) {
        if (other === uc) return;
        var oa = assigned[other.me.prov];
        if (!oa) return;
        if (oa.type === 'move') {
          var t = oa.dest;
          var occ = state.units[t];
          var contested = (occ && occ.power !== power) || enemiesAdjacent(state, t, power) > 0;
          if (!contested) return;
          if (!MAP.canMoveDirect(uc.me.u.type, uc.me.prov, uc.me.u.coast, t, null)) return;
          var val = (MAP.isSC(t) ? 6 : 3) + rnd();
          if (!bestSupport || val > bestSupport.val) {
            bestSupport = { val: val, order: { type: 'support', unit: uc.me.prov, from: other.me.prov, to: t } };
          }
        } else if (oa.type === 'hold') {
          var hp = other.me.prov;
          if (!MAP.isSC(hp) || state.scOwners[hp] !== power) return;
          if (!enemiesAdjacent(state, hp, power)) return;
          if (!MAP.canMoveDirect(uc.me.u.type, uc.me.prov, uc.me.u.coast, hp, null)) return;
          var val2 = 4.5 + rnd();
          if (!bestSupport || val2 > bestSupport.val) {
            bestSupport = { val: val2, order: { type: 'support', unit: uc.me.prov, from: hp, to: null } };
          }
        }
      });
      if (bestSupport) assigned[uc.me.prov] = { type: 'supportOrder', order: bestSupport.order };
    });

    // emit
    var orders = [];
    unitCands.forEach(function (uc) {
      var a = assigned[uc.me.prov];
      if (!a) return;
      if (a.type === 'move') {
        orders.push({ type: 'move', unit: uc.me.prov, dest: a.dest, destCoast: a.destCoast || null });
      } else if (a.type === 'supportOrder') {
        orders.push(a.order);
      } else {
        orders.push({ type: 'hold', unit: uc.me.prov });
      }
    });
    return orders;
  }

  function pickCoast(m) {
    if (!m.coasts || !m.coasts.length) return null;
    return m.coasts[Math.floor(rnd() * m.coasts.length)];
  }

  /* ---------- retreat phase ---------- */

  function retreatOrders(state, power) {
    var orders = [];
    for (var prov in (state.dislodged || {})) {
      var d = state.dislodged[prov];
      if (d.power !== power) continue;
      var opts = d.options || [];
      if (!opts.length) { orders.push({ type: 'disband', unit: prov }); continue; }
      var best = null, bestScore = -1;
      opts.forEach(function (loc) {
        var s = MAP.splitLoc(loc);
        var sc = 1 + rnd();
        if (MAP.isSC(s.prov) && state.scOwners[s.prov] === power) sc += 5;   // fall back to our center
        else if (MAP.isSC(s.prov)) sc += 2.5;
        sc -= enemiesAdjacent(state, s.prov, power) * 0.5;
        if (sc > bestScore) { bestScore = sc; best = s; }
      });
      orders.push({ type: 'retreat', unit: prov, dest: best.prov, destCoast: best.coast || null });
    }
    return orders;
  }

  /* ---------- winter phase ---------- */

  function buildOrders(state, power) {
    var adj = ENG.adjustmentsFor(state)[power];
    if (!adj || adj.delta <= 0) return [];   // removals: engine's civil-disorder default is already sensible
    var orders = [];
    var fleets = 0, armies = 0;
    for (var p in state.units) {
      if (state.units[p].power === power) {
        if (state.units[p].type === 'F') fleets++; else armies++;
      }
    }
    var spots = adj.vacantHome.slice();
    // build where the action is: most enemies nearby first
    spots.sort(function (a, b) {
      return enemiesAdjacent(state, b, power) - enemiesAdjacent(state, a, power);
    });
    for (var i = 0; i < adj.delta && i < spots.length; i++) {
      var loc = spots[i];
      var canFleet = MAP.fleetLocsOf(loc).length > 0;
      var wantFleet = canFleet && (power === 'ENGLAND' ? fleets <= armies + 1 : fleets < armies && rnd() < 0.55);
      if (wantFleet) {
        var coast = MAP.PROVINCES[loc].coasts ? 'sc' : null;   // STP: south coast faces the action
        orders.push({ type: 'build', loc: loc, unitType: 'F', coast: coast });
        fleets++;
      } else {
        orders.push({ type: 'build', loc: loc, unitType: 'A' });
        armies++;
      }
    }
    return orders;
  }

  /* ---------- entry point ---------- */

  function ordersFor(state, power) {
    try {
      if (state.phase === 'MOVE') return moveOrders(state, power);
      if (state.phase === 'RETREAT') return retreatOrders(state, power);
      if (state.phase === 'BUILD') return buildOrders(state, power);
    } catch (e) {
      // a confused AI just holds — the engine treats missing orders as holds
      return [];
    }
    return [];
  }

  /* ---------- the leaders of 1914 take their thrones ---------- */

  var LEADERS = {
    ENGLAND: { name: 'King George V', short: 'George V' },
    FRANCE:  { name: 'Georges Clemenceau', short: 'Clemenceau' },
    GERMANY: { name: 'Kaiser Wilhelm II', short: 'the Kaiser' },
    ITALY:   { name: 'King Victor Emmanuel III', short: 'Victor Emmanuel' },
    AUSTRIA: { name: 'Emperor Franz Joseph', short: 'Franz Joseph' },
    RUSSIA:  { name: 'Tsar Nicholas II', short: 'the Tsar' },
    TURKEY:  { name: 'Sultan Mehmed V', short: 'the Sultan' }
  };

  /* persona reply pools — used when a student writes to an AI power.
     None of it binds the AI to anything. That's Diplomacy. */
  var REPLIES = {
    ENGLAND: [
      'His Majesty has read your note with interest. Britannia keeps her own counsel.',
      'A gentleman honors his word. We shall see if you are a gentleman.',
      'The Royal Navy needs no permission to sail — but your friendship is noted.',
      'Quite. Let us speak again when the season has turned.',
      'England has no eternal allies, only eternal interests. Consider yours.'
    ],
    FRANCE: [
      'Ha! Pretty words. The Tiger judges claws, not promises.',
      'France agrees — provided France is not asked to trust you.',
      'War is too serious a matter to leave to promises, mon ami.',
      'You offer peace with one hand. What does the other hand hold?',
      'Very well. But cross our border and I will personally write your obituary.'
    ],
    GERMANY: [
      'The Kaiser smiles upon your proposal — today, at least.',
      'Germany demands her place in the sun. Stand aside or stand with us.',
      'Bold! I admire boldness. I crush it too, occasionally.',
      'Your message has reached Berlin. Berlin is considering. Berlin considers quickly.',
      'We are agreed, then. Naturally, agreements are such delicate things.'
    ],
    ITALY: [
      'Italy hears you. Italy hears everyone. It is our gift.',
      'An alliance? Perhaps. Italy prefers to choose the winning side — eventually.',
      'Rome was not built in a day, and neither is trust. But do go on.',
      'Your terms interest us. Improve them and they may even bind us.',
      'We are friends, of course. The question is for how many seasons.'
    ],
    AUSTRIA: [
      'The Habsburgs have outlasted a hundred such promises. Make yours a rare one.',
      'The Emperor is old, but his memory for betrayal is excellent.',
      'Vienna will consider it. Vienna has been considering things since 1273.',
      'Peace on our border would be... refreshing. See that it stays peaceful.',
      'You write kindly. Kind letters and quiet armies — let us have both.'
    ],
    RUSSIA: [
      'The Tsar of all the Russias does not bargain. He occasionally agrees.',
      'Russia is vast, patient, and watching. Proceed accordingly.',
      'God sees all treaties. Break this one and answer to both of us.',
      'Winter is our oldest ally. You may be our newest. Behave like it.',
      'Very well. But remember — the bear sleeps lightly.'
    ],
    TURKEY: [
      'The Sublime Porte acknowledges your message with measured delight.',
      'Patience is the key to paradise — and to Constantinople. We have both.',
      'Your proposal is honey. We shall check it for flies.',
      'The Sultan agrees to peace. The Sultan also keeps his powder dry.',
      'Friendship, like coffee, is best strong and without sediment. Prove yours.'
    ]
  };

  function replyTo(power) {
    var pool = REPLIES[power] || REPLIES.AUSTRIA;
    return pool[Math.floor(rnd() * pool.length)];
  }

  /* ---------- proactive scheming between turns ----------
   * Called after each resolution. The AI writes to human players:
   * revenge for lost centers, coalitions against the leader, border
   * sweet-talk (sincere or not — the orders never check the mail).
   */

  function chatter(stateBefore, stateAfter, power, humanPowers) {
    var out = [];
    if (!humanPowers || !humanPowers.length) return out;
    var name = LEADERS[power].short;

    // 1. revenge: who took one of my centers this turn?
    for (var p in stateBefore.scOwners) {
      if (stateBefore.scOwners[p] === power &&
          stateAfter.scOwners[p] && stateAfter.scOwners[p] !== power) {
        var thief = stateAfter.scOwners[p];
        if (humanPowers.indexOf(thief) !== -1 && rnd() < 0.85) {
          out.push({ to: thief, text: pick([
            'You will answer for ' + p.toUpperCase() + '. Not today, perhaps. But you will answer.',
            p.toUpperCase() + ' was a province. What you have purchased is a war.',
            'Enjoy ' + p.toUpperCase() + ' while you can. ' + cap(name) + ' forgets nothing.'
          ]) });
        }
      }
    }

    // 2. coalition: gang up on whoever is winning
    var best = null, bestN = 0;
    MAP.POWERS.forEach(function (q) {
      if (q === power) return;
      var n = ENG.scCount(stateAfter, q);
      if (n > bestN) { bestN = n; best = q; }
    });
    if (best && bestN >= 5 && rnd() < 0.5) {
      var allies = humanPowers.filter(function (h) { return h !== best && h !== power; });
      if (allies.length) {
        var ally = allies[Math.floor(rnd() * allies.length)];
        out.push({ to: ally, text: pick([
          MAP.POWER_INFO[best].name + ' grows fat — ' + bestN + ' centers already. Shall we put him on a diet?',
          'Every map needs balance. ' + MAP.POWER_INFO[best].name + ' has forgotten this. Remind him with me.',
          'I propose a quiet understanding against ' + MAP.POWER_INFO[best].name + '. Quiet understandings win wars.'
        ]) });
      }
    }

    // 3. border talk: sweet words for a neighbor (possibly hollow)
    if (out.length < 2 && rnd() < 0.45) {
      var neighbors = [];
      for (var prov in stateAfter.units) {
        var u = stateAfter.units[prov];
        if (u.power !== power) continue;
        provNeighbors(prov).forEach(function (nb) {
          var v = stateAfter.units[nb];
          if (v && v.power !== power && humanPowers.indexOf(v.power) !== -1 &&
              neighbors.indexOf(v.power) === -1) neighbors.push(v.power);
        });
      }
      if (neighbors.length) {
        var nb2 = neighbors[Math.floor(rnd() * neighbors.length)];
        out.push({ to: nb2, text: pick([
          'Our armies stand close enough to smell each other\'s coffee. Let us keep it at coffee.',
          'I have no designs on your lands this season. You may believe as much of that as you like.',
          'A quiet border between us frees us both to be dangerous elsewhere. Think on it.',
          'Your soldiers watch mine, mine watch yours. Wasteful. I propose we both look elsewhere.'
        ]) });
      }
    }

    return out.slice(0, 2);

    function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  }

  return { ordersFor: ordersFor, replyTo: replyTo, chatter: chatter, LEADERS: LEADERS };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DIPLOMACY_BOT;
}
