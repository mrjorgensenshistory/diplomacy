/* ============================================================
 * DIPLOMACY — Adjudication engine (full standard rules)
 *
 * Resolution algorithm: Lucas Kruijswijk's "guess and backup"
 * partial-information method (the same approach used by the
 * major online adjudicators), with the Szykman rule for convoy
 * paradoxes and all-succeed for circular movement.
 *
 * Plain JS: browser, Node, and Google Apps Script compatible.
 * Requires DIPLOMACY_MAP (map-data.js) to be loaded first.
 * ============================================================ */

var DIPLOMACY_ENGINE = (function () {

  var MAP = (typeof DIPLOMACY_MAP !== 'undefined') ? DIPLOMACY_MAP
          : (typeof require !== 'undefined') ? require('./map-data.js')
          : null;

  /* ---------------- state ---------------- */

  function initialState(settings) {
    settings = settings || {};
    var units = {};
    MAP.START_UNITS.forEach(function (u) {
      units[u.loc] = { power: u.power, type: u.type, coast: u.coast || null };
    });
    var scOwners = {};
    MAP.allSCs().forEach(function (p) {
      var home = MAP.PROVINCES[p].home;
      if (home) scOwners[p] = home;
    });
    return {
      year: 1901,
      season: 'SPRING',          // SPRING | FALL | WINTER
      phase: 'MOVE',             // MOVE | RETREAT | BUILD
      units: units,
      scOwners: scOwners,
      dislodged: {},             // prov -> {power,type,coast,from(attacker origin)|null, options:[locs]}
      contested: [],
      winner: null,
      victorySCs: settings.victorySCs || 18,
      endYear: settings.endYear || null
    };
  }

  function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

  function scCount(state, power) {
    var n = 0;
    for (var p in state.scOwners) if (state.scOwners[p] === power) n++;
    return n;
  }

  function unitCount(state, power) {
    var n = 0;
    for (var p in state.units) if (state.units[p].power === power) n++;
    return n;
  }

  /* ---------------- order validation ----------------
   * Order shapes (all provinces lowercase keys):
   *  {type:'hold',    unit}
   *  {type:'move',    unit, dest, destCoast?, viaConvoy?}
   *  {type:'support', unit, from, to}        // to===null -> support hold
   *  {type:'convoy',  unit, from, to}        // fleet convoys army from->to
   * Retreat phase: {type:'retreat', unit, dest, destCoast?} | {type:'disband', unit}
   * Build phase:   {type:'build', loc, unitType, coast?} | {type:'remove', loc} | {type:'waive'}
   */

  /* Could `army at prov` conceivably be convoyed to dest, given fleets
   * currently on the board (any power)? Used for validation + UI. */
  function convoyPossible(state, prov, dest) {
    if (prov === dest) return false;
    if (!MAP.isCoast(prov) || !MAP.isCoast(dest)) return false;
    var visited = {};
    var stack = [];
    seasTouching(prov).forEach(function (s) {
      if (state.units[s] && state.units[s].type === 'F') stack.push(s);
    });
    while (stack.length) {
      var s = stack.pop();
      if (visited[s]) continue;
      visited[s] = true;
      if (seaTouchesProv(s, dest)) return true;
      (MAP.fleetAdj[s] || []).forEach(function (n) {
        var np = MAP.splitLoc(n).prov;
        if (MAP.isSea(np) && !visited[np] && state.units[np] && state.units[np].type === 'F') stack.push(np);
      });
    }
    return false;
  }

  function seasTouching(prov) {
    var out = [];
    for (var s in MAP.fleetAdj) {
      var sp = MAP.splitLoc(s).prov;
      if (!MAP.isSea(sp)) continue;
      if (seaTouchesProv(sp, prov) && out.indexOf(sp) === -1) out.push(sp);
    }
    return out;
  }

  function seaTouchesProv(sea, prov) {
    var adj = MAP.fleetAdj[sea] || [];
    for (var i = 0; i < adj.length; i++) {
      if (MAP.splitLoc(adj[i]).prov === prov) return true;
    }
    return false;
  }

  /* Validate one movement-phase order. Returns {ok:true, order:normalized}
   * or {ok:false, error}. */
  function validateOrder(state, power, o) {
    if (!o || !o.type) return bad('No order type');
    var u = state.units[o.unit];
    if (!u) return bad('No unit at ' + o.unit);
    if (u.power !== power) return bad('Not your unit');

    if (o.type === 'hold') return ok({ type: 'hold', unit: o.unit });

    if (o.type === 'move') {
      if (!MAP.PROVINCES[o.dest]) return bad('Unknown destination');
      if (o.dest === o.unit) return bad('Cannot move to itself');
      if (u.type === 'A') {
        if (MAP.isSea(o.dest)) return bad('Armies cannot enter sea spaces');
        var direct = MAP.canMoveDirect('A', o.unit, null, o.dest, null);
        var via = !!o.viaConvoy || !direct;
        if (!direct && !convoyPossible(state, o.unit, o.dest)) {
          return bad('Not adjacent and no possible convoy route');
        }
        return ok({ type: 'move', unit: o.unit, dest: o.dest, destCoast: null, viaConvoy: via });
      }
      // fleet
      if (!MAP.isSea(o.dest) && !MAP.isCoast(o.dest)) return bad('Fleets cannot move inland');
      var coasts = MAP.PROVINCES[o.dest].coasts;
      var destCoast = o.destCoast || null;
      if (coasts) {
        var reach = MAP.reachableCoasts(o.unit, u.coast, o.dest);
        if (!reach.length) return bad('Fleet cannot reach ' + o.dest);
        if (destCoast) {
          if (reach.indexOf(destCoast) === -1) return bad('Cannot reach that coast');
        } else if (reach.length === 1) {
          destCoast = reach[0];
        } else {
          return bad('Must specify coast (nc/sc/ec)');
        }
      } else {
        if (!MAP.canMoveDirect('F', o.unit, u.coast, o.dest, null)) return bad('Fleet cannot reach ' + o.dest);
        destCoast = null;
      }
      return ok({ type: 'move', unit: o.unit, dest: o.dest, destCoast: destCoast, viaConvoy: false });
    }

    if (o.type === 'support') {
      var su = state.units[o.from];
      if (!su) return bad('No unit at ' + o.from + ' to support');
      var target = o.to || o.from;     // province support is given into
      if (!canReachForSupport(u, o.unit, target)) return bad('Your unit cannot reach ' + target);
      if (o.to && o.to === o.from) return bad('Invalid support');
      return ok({ type: 'support', unit: o.unit, from: o.from, to: o.to || null });
    }

    if (o.type === 'convoy') {
      if (u.type !== 'F') return bad('Only fleets convoy');
      if (!MAP.isSea(o.unit)) return bad('Fleets can only convoy from open sea');
      var au = state.units[o.from];
      if (!au || au.type !== 'A') return bad('No army at ' + o.from + ' to convoy');
      if (!MAP.isCoast(o.to)) return bad('Convoy destination must be coastal');
      return ok({ type: 'convoy', unit: o.unit, from: o.from, to: o.to });
    }

    return bad('Unknown order type');

    function ok(order) { order.power = power; return { ok: true, order: order }; }
    function bad(e) { return { ok: false, error: e }; }
  }

  /* Can `u` (at prov) give support into province target? (No convoyed support.) */
  function canReachForSupport(u, prov, target) {
    if (u.type === 'A') return MAP.canMoveDirect('A', prov, null, target, null);
    return MAP.canMoveDirect('F', prov, u.coast, target, null); // any coast counts
  }

  /* ---------------- movement adjudication ---------------- */

  var FAILS = 0, SUCCEEDS = 1;
  var UNRESOLVED = 0, GUESSING = 1, RESOLVED = 2;

  function resolveMovement(state, ordersByPower) {
    // 1. normalize: exactly one order per unit, invalid -> hold
    var orders = [];          // adjudicated orders
    var notes = {};           // prov -> validation error (shown to player)
    var unitOrderIdx = {};    // prov -> index in orders

    var prov, power;
    var submitted = {};       // prov -> raw order
    for (power in (ordersByPower || {})) {
      (ordersByPower[power] || []).forEach(function (o) {
        if (o && o.unit && state.units[o.unit] && state.units[o.unit].power === power) {
          submitted[o.unit] = { power: power, raw: o };
        }
      });
    }
    for (prov in state.units) {
      var u = state.units[prov];
      var entry = submitted[prov];
      var normalized = null;
      if (entry) {
        var v = validateOrder(state, entry.power, entry.raw);
        if (v.ok) normalized = v.order;
        else notes[prov] = v.error + ' — unit holds';
      }
      if (!normalized) normalized = { type: 'hold', unit: prov, power: u.power };
      normalized.index = orders.length;
      unitOrderIdx[prov] = orders.length;
      orders.push(normalized);
    }

    // mark void supports/convoys (no matching order) — they still exist as orders
    orders.forEach(function (o) {
      if (o.type === 'support' && o.to !== null) {
        var m = moveOrderAt(o.from);
        if (!m || m.dest !== o.to) o.void = true;
      } else if (o.type === 'support') {
        var t = orders[unitOrderIdx[o.from]];
        if (!t || t.type === 'move') o.void = true;   // can't support-hold a moving unit
      } else if (o.type === 'convoy') {
        var am = moveOrderAt(o.from);
        if (!am || am.dest !== o.to || !am.viaConvoy) o.void = true;
      }
    });

    function moveOrderAt(p) {
      var i = unitOrderIdx[p];
      if (i === undefined) return null;
      return orders[i].type === 'move' ? orders[i] : null;
    }

    /* --- Kruijswijk resolver --- */
    var resolution = [], rstate = [], depList = [];
    orders.forEach(function () { resolution.push(FAILS); rstate.push(UNRESOLVED); });

    function resolve(nr) {
      if (rstate[nr] === RESOLVED) return resolution[nr];
      if (rstate[nr] === GUESSING) {
        if (depList.indexOf(nr) === -1) depList.push(nr);
        return resolution[nr];
      }
      var oldLen = depList.length;
      rstate[nr] = GUESSING;
      resolution[nr] = FAILS;
      var first = adjudicate(nr);
      if (rstate[nr] === RESOLVED) return resolution[nr]; // settled by a backup rule mid-adjudication
      if (oldLen === depList.length) {
        if (rstate[nr] !== RESOLVED) { resolution[nr] = first; rstate[nr] = RESOLVED; }
        return first;
      }
      if (depList[oldLen] !== nr) {
        depList.push(nr);
        resolution[nr] = first;
        return first;
      }
      // nr is the root of a dependency cycle
      var i;
      for (i = oldLen; i < depList.length; i++) rstate[depList[i]] = UNRESOLVED;
      depList.length = oldLen;
      rstate[nr] = GUESSING;
      resolution[nr] = SUCCEEDS;
      var second = adjudicate(nr);
      if (rstate[nr] === RESOLVED) return resolution[nr];
      if (first === second) {
        for (i = oldLen; i < depList.length; i++) rstate[depList[i]] = UNRESOLVED;
        depList.length = oldLen;
        resolution[nr] = first;
        rstate[nr] = RESOLVED;
        return first;
      }
      backupRule(oldLen);
      return resolve(nr);
    }

    /* Cycle resolution. A cycle that runs through a CONVOY order is a
     * convoy paradox -> Szykman rule (the convoyed moves fail). A cycle
     * of move orders only — even convoyed ones — is circular movement:
     * everyone advances (convoyed swaps are legal). */
    function backupRule(oldLen) {
      var cycle = depList.slice(oldLen);
      var i, hasConvoy = false;
      for (i = 0; i < cycle.length; i++) {
        var o = orders[cycle[i]];
        if (o.type === 'convoy' && !o.void) hasConvoy = true;
      }
      if (hasConvoy) {
        // Szykman: every convoyed move tangled in the paradox fails.
        // A convoy order in the cycle implicates its army's move even if
        // that move itself never entered the dependency list.
        var failMoves = {};
        for (i = 0; i < cycle.length; i++) {
          var co = orders[cycle[i]];
          if (co.type === 'move' && co.viaConvoy) failMoves[co.index] = true;
          if (co.type === 'convoy' && !co.void) {
            var am = moveOrderAt(co.from);
            if (am && am.viaConvoy && am.dest === co.to) failMoves[am.index] = true;
          }
        }
        for (i = 0; i < cycle.length; i++) rstate[cycle[i]] = UNRESOLVED;
        for (var fm in failMoves) {
          resolution[fm] = FAILS; rstate[fm] = RESOLVED;
        }
      } else {
        var allMoves = true;
        for (i = 0; i < cycle.length; i++) {
          if (orders[cycle[i]].type !== 'move') allMoves = false;
        }
        for (i = 0; i < cycle.length; i++) {
          var ord = orders[cycle[i]];
          if (ord.type === 'move') {
            // circular movement succeeds; a mixed cycle (shouldn't occur in
            // practice) fails its moves so resolution always terminates
            resolution[cycle[i]] = allMoves ? SUCCEEDS : FAILS;
            rstate[cycle[i]] = RESOLVED;
          } else {
            rstate[cycle[i]] = UNRESOLVED;
          }
        }
      }
      depList.length = oldLen;
    }

    /* --- helper queries used by adjudicate --- */

    function movesInto(p) {
      var out = [];
      orders.forEach(function (o) { if (o.type === 'move' && o.dest === p) out.push(o); });
      return out;
    }

    function h2hOpponent(m) {
      if (m.viaConvoy) return null;
      var o = moveOrderAt(m.dest);
      if (o && !o.viaConvoy && o.dest === m.unit) return o;
      return null;
    }

    /* convoy path using only fleets whose convoy order RESOLVES (not dislodged) */
    function pathOK(m) {
      if (m.type !== 'move') return false;
      if (!m.viaConvoy) return true;          // adjacency already validated
      var visited = {};
      var stack = [];
      var fleets = orders.filter(function (o) {
        return o.type === 'convoy' && !o.void && o.from === m.unit && o.to === m.dest;
      });
      if (!fleets.length) return false;
      var byProv = {};
      fleets.forEach(function (f) { byProv[f.unit] = f; });
      seasTouching(m.unit).forEach(function (s) { if (byProv[s]) stack.push(s); });
      while (stack.length) {
        var s = stack.pop();
        if (visited[s]) continue;
        visited[s] = true;
        if (resolve(byProv[s].index) !== SUCCEEDS) continue;  // fleet dislodged
        if (seaTouchesProv(s, m.dest)) return true;
        (MAP.fleetAdj[s] || []).forEach(function (n) {
          var np = MAP.splitLoc(n).prov;
          if (byProv[np] && !visited[np]) stack.push(np);
        });
      }
      return false;
    }

    function supportsFor(m, excludePower) {
      var n = 0;
      orders.forEach(function (o) {
        if (o.type !== 'support' || o.void) return;
        if (o.from !== m.unit || o.to !== m.dest) return;
        if (excludePower && o.power === excludePower) return;
        if (resolve(o.index) === SUCCEEDS) n++;
      });
      return n;
    }

    function supportHoldsFor(p) {
      var n = 0;
      orders.forEach(function (o) {
        if (o.type !== 'support' || o.void) return;
        if (o.from !== p || o.to !== null) return;
        if (resolve(o.index) === SUCCEEDS) n++;
      });
      return n;
    }

    function holdStrength(p) {
      var u = state.units[p];
      if (!u) return 0;
      var mo = moveOrderAt(p);
      if (mo) return resolve(mo.index) === SUCCEEDS ? 0 : 1;
      return 1 + supportHoldsFor(p);
    }

    function attackStrength(m) {
      if (!pathOK(m)) return 0;
      var u = state.units[m.dest];
      if (!u) return 1 + supportsFor(m, null);
      var mo = moveOrderAt(m.dest);
      var leaves = mo && !h2hOpponent(m) && resolve(mo.index) === SUCCEEDS;
      if (leaves) return 1 + supportsFor(m, null);
      if (u.power === m.power) return 0;            // never dislodge own unit
      return 1 + supportsFor(m, u.power);           // defender's power can't help dislodge it
    }

    function defendStrength(m) { return 1 + supportsFor(m, null); }

    function preventStrength(m) {
      if (!pathOK(m)) return 0;
      var o = h2hOpponent(m);
      if (o && resolve(o.index) === SUCCEEDS) return 0;  // lost head-to-head: no standoff power
      return 1 + supportsFor(m, null);
    }

    /* --- the per-order decision --- */
    function adjudicate(nr) {
      var o = orders[nr];

      if (o.type === 'hold') return SUCCEEDS;

      if (o.type === 'convoy') {
        if (o.void) return FAILS;
        // succeeds iff this fleet is not dislodged
        var attacks = movesInto(o.unit);
        for (var i = 0; i < attacks.length; i++) {
          if (resolve(attacks[i].index) === SUCCEEDS) return FAILS;
        }
        return SUCCEEDS;
      }

      if (o.type === 'support') {
        if (o.void) return FAILS;
        var target = o.to || o.from;
        var atks = movesInto(o.unit);
        for (var j = 0; j < atks.length; j++) {
          var m = atks[j];
          if (m.power === o.power) continue;            // own units never cut own support
          if (m.viaConvoy) {
            // a convoyed move already settled as failed (Szykman) never lands
            if (rstate[m.index] === RESOLVED && resolution[m.index] === FAILS) continue;
            if (!pathOK(m)) continue;                   // convoy must land to cut
          }
          if (m.unit === target) {
            // attack from the province being supported into: cuts only by dislodging
            if (resolve(m.index) === SUCCEEDS) return FAILS;
          } else {
            return FAILS;                                // any other attack cuts
          }
        }
        return SUCCEEDS;
      }

      // move
      if (!pathOK(o)) return FAILS;
      var atk = attackStrength(o);
      var opp = h2hOpponent(o);
      if (opp) {
        if (atk <= defendStrength(opp)) return FAILS;
      } else {
        if (atk <= holdStrength(o.dest)) return FAILS;
      }
      var rivals = movesInto(o.dest);
      for (var k = 0; k < rivals.length; k++) {
        if (rivals[k] === o) continue;
        if (atk <= preventStrength(rivals[k])) return FAILS;
      }
      return SUCCEEDS;
    }

    // resolve everything
    orders.forEach(function (o) { resolve(o.index); });

    /* --- apply results --- */
    var newState = cloneState(state);
    var moved = {};        // prov(old) -> newLoc for successful moves
    var results = [];

    orders.forEach(function (o) {
      var success = resolution[o.index] === SUCCEEDS;
      results.push({
        power: o.power, order: stripOrder(o), success: success,
        note: notes[o.unit] || (o.void ? 'void (no matching order)' : null)
      });
      if (o.type === 'move' && success) moved[o.unit] = o;
    });

    // build the next unit layout
    var nextUnits = {};
    var dislodged = {};
    for (prov in state.units) {
      var unit = state.units[prov];
      if (moved[prov]) {
        var mo = moved[prov];
        nextUnits[mo.dest] = { power: unit.power, type: unit.type, coast: mo.destCoast || null };
      }
    }
    for (prov in state.units) {
      if (moved[prov]) continue;
      var stay = state.units[prov];
      // dislodged?
      var dis = null;
      movesInto(prov).forEach(function (m) {
        if (resolution[m.index] === SUCCEEDS) dis = m;
      });
      if (dis) {
        dislodged[prov] = {
          power: stay.power, type: stay.type, coast: stay.coast || null,
          from: dis.viaConvoy ? null : dis.unit
        };
      } else {
        nextUnits[prov] = stay;
      }
    }

    // contested: empty provinces where a path-valid move bounced (standoff)
    var contested = [];
    orders.forEach(function (o) {
      if (o.type !== 'move' || resolution[o.index] === SUCCEEDS) return;
      if (!pathOK(o)) return;
      if (nextUnits[o.dest] || dislodged[o.dest]) return;
      if (contested.indexOf(o.dest) === -1) contested.push(o.dest);
    });

    newState.units = nextUnits;
    newState.contested = contested;
    newState.dislodged = {};

    // retreat options; auto-disband units with nowhere to go
    var anyRetreats = false;
    for (prov in dislodged) {
      var d = dislodged[prov];
      var opts = retreatOptions(newState, prov, d, contested);
      if (opts.length) {
        d.options = opts;
        newState.dislodged[prov] = d;
        anyRetreats = true;
      }
      // no options -> destroyed immediately
    }

    if (anyRetreats) {
      newState.phase = 'RETREAT';
    } else {
      advanceAfterMoveOrRetreat(newState);
    }

    return { results: results, newState: newState, dislodgedAt: Object.keys(dislodged) };
  }

  function stripOrder(o) {
    var c = { type: o.type, unit: o.unit };
    if (o.type === 'move') { c.dest = o.dest; c.destCoast = o.destCoast; c.viaConvoy = o.viaConvoy; }
    if (o.type === 'support') { c.from = o.from; c.to = o.to; }
    if (o.type === 'convoy') { c.from = o.from; c.to = o.to; }
    return c;
  }

  /* legal retreat locations for a dislodged unit */
  function retreatOptions(stateAfterMoves, prov, d, contested) {
    var opts = [];
    if (d.type === 'A') {
      (MAP.armyAdj[prov] || []).forEach(function (p) {
        if (stateAfterMoves.units[p]) return;
        if (contested.indexOf(p) !== -1) return;
        if (d.from && p === d.from) return;
        opts.push(p);
      });
    } else {
      var from = MAP.fleetLoc(prov, d.coast);
      (MAP.fleetAdj[from] || []).forEach(function (l) {
        var s = MAP.splitLoc(l);
        if (stateAfterMoves.units[s.prov]) return;
        if (contested.indexOf(s.prov) !== -1) return;
        if (d.from && s.prov === d.from) return;
        opts.push(l);
      });
    }
    return opts;
  }

  /* ---------------- retreats ---------------- */

  function resolveRetreats(state, ordersByPower) {
    var results = [];
    var newState = cloneState(state);
    var wants = {};   // destProv -> [ {prov, d, destCoast} ]

    var orderByProv = {};
    for (var power in (ordersByPower || {})) {
      (ordersByPower[power] || []).forEach(function (o) {
        var d = state.dislodged[o.unit];
        if (d && d.power === power) orderByProv[o.unit] = o;
      });
    }

    for (var prov in state.dislodged) {
      var d = state.dislodged[prov];
      var o = orderByProv[prov];
      if (o && o.type === 'retreat' && o.dest) {
        var finalLoc = null;
        if (d.type === 'A') {
          if ((d.options || []).indexOf(o.dest) !== -1) finalLoc = o.dest;
        } else {
          var matches = (d.options || []).filter(function (l) {
            return MAP.splitLoc(l).prov === o.dest;
          });
          if (o.destCoast) {
            var want = MAP.fleetLoc(o.dest, o.destCoast);
            if (matches.indexOf(want) !== -1) finalLoc = want;
          } else if (matches.length === 1) {
            finalLoc = matches[0];
          }
        }
        if (finalLoc) {
          var s = MAP.splitLoc(finalLoc);
          if (!wants[s.prov]) wants[s.prov] = [];
          wants[s.prov].push({ prov: prov, d: d, coast: s.coast });
          continue;
        }
        results.push({ power: d.power, order: { type: 'disband', unit: prov }, success: true, note: 'illegal retreat — disbanded' });
        continue;
      }
      results.push({ power: d.power, order: { type: 'disband', unit: prov }, success: true, note: o ? null : 'no retreat order — disbanded' });
    }

    for (var dest in wants) {
      var claims = wants[dest];
      if (claims.length === 1) {
        var c = claims[0];
        newState.units[dest] = { power: c.d.power, type: c.d.type, coast: c.coast || null };
        results.push({ power: c.d.power, order: { type: 'retreat', unit: c.prov, dest: dest, destCoast: c.coast }, success: true, note: null });
      } else {
        claims.forEach(function (c2) {
          results.push({ power: c2.d.power, order: { type: 'retreat', unit: c2.prov, dest: dest, destCoast: c2.coast }, success: false, note: 'two units retreated to the same space — both disbanded' });
        });
      }
    }

    newState.dislodged = {};
    newState.contested = [];
    advanceAfterMoveOrRetreat(newState);
    return { results: results, newState: newState };
  }

  /* ---------------- phase / season sequencing ---------------- */

  function advanceAfterMoveOrRetreat(state) {
    if (state.season === 'SPRING') {
      state.season = 'FALL';
      state.phase = 'MOVE';
      return;
    }
    // end of FALL: update SC ownership, check victory, maybe build
    updateSCOwnership(state);
    checkVictory(state);
    if (state.winner) { state.phase = 'DONE'; return; }
    var adjust = adjustmentsFor(state);
    var needed = false;
    for (var p in adjust) if (adjust[p].delta !== 0) needed = true;
    if (needed) {
      state.season = 'WINTER';
      state.phase = 'BUILD';
    } else {
      startNewYear(state);
    }
  }

  function startNewYear(state) {
    state.year += 1;
    state.season = 'SPRING';
    state.phase = 'MOVE';
    if (state.endYear && state.year > state.endYear) {
      // time-limit game: most centers wins
      var best = null, bestN = -1, tie = false;
      MAP.POWERS.forEach(function (p) {
        var n = scCount(state, p);
        if (n > bestN) { best = p; bestN = n; tie = false; }
        else if (n === bestN) tie = true;
      });
      state.winner = tie ? 'DRAW' : best;
      state.phase = 'DONE';
    }
  }

  function updateSCOwnership(state) {
    for (var p in state.units) {
      if (MAP.isSC(p)) state.scOwners[p] = state.units[p].power;
    }
  }

  function checkVictory(state) {
    var target = state.victorySCs || 18;
    MAP.POWERS.forEach(function (p) {
      if (scCount(state, p) >= target) state.winner = p;
    });
  }

  /* ---------------- builds / removals ---------------- */

  function adjustmentsFor(state) {
    var out = {};
    MAP.POWERS.forEach(function (power) {
      var scs = scCount(state, power);
      var units = unitCount(state, power);
      var vacant = [];
      MAP.homeCenters(power).forEach(function (h) {
        if (state.scOwners[h] === power && !state.units[h]) vacant.push(h);
      });
      var delta = scs - units;
      if (delta > 0) delta = Math.min(delta, vacant.length);
      out[power] = { scs: scs, units: units, delta: delta, vacantHome: vacant };
    });
    return out;
  }

  function resolveBuilds(state, ordersByPower) {
    var results = [];
    var newState = cloneState(state);
    var adjust = adjustmentsFor(state);

    MAP.POWERS.forEach(function (power) {
      var a = adjust[power];
      var list = (ordersByPower && ordersByPower[power]) || [];
      if (a.delta > 0) {
        var built = 0;
        list.forEach(function (o) {
          if (built >= a.delta) return;
          if (!o || o.type !== 'build') return;
          var loc = o.loc;
          if (a.vacantHome.indexOf(loc) === -1 || newState.units[loc]) {
            results.push({ power: power, order: o, success: false, note: 'illegal build location' });
            return;
          }
          var t = o.unitType === 'F' ? 'F' : 'A';
          var coast = null;
          if (t === 'F') {
            if (!MAP.fleetLocsOf(loc).length) {
              results.push({ power: power, order: o, success: false, note: 'cannot build a fleet inland' });
              return;
            }
            if (MAP.PROVINCES[loc].coasts) {
              if (!o.coast || MAP.PROVINCES[loc].coasts.indexOf(o.coast) === -1) {
                results.push({ power: power, order: o, success: false, note: 'must pick a coast' });
                return;
              }
              coast = o.coast;
            }
          }
          newState.units[loc] = { power: power, type: t, coast: coast };
          built++;
          results.push({ power: power, order: o, success: true, note: null });
        });
        // unused builds are simply waived
      } else if (a.delta < 0) {
        var need = -a.delta;
        var removed = 0;
        list.forEach(function (o) {
          if (removed >= need) return;
          if (!o || o.type !== 'remove') return;
          var u2 = newState.units[o.loc];
          if (!u2 || u2.power !== power) {
            results.push({ power: power, order: o, success: false, note: 'no such unit' });
            return;
          }
          delete newState.units[o.loc];
          removed++;
          results.push({ power: power, order: o, success: true, note: null });
        });
        if (removed < need) {
          defaultDisbands(newState, power, need - removed).forEach(function (loc) {
            delete newState.units[loc];
            results.push({ power: power, order: { type: 'remove', loc: loc }, success: true, note: 'auto-removed (no order)' });
          });
        }
      }
    });

    startNewYear(newState);
    return { results: results, newState: newState };
  }

  /* Civil-disorder removal: farthest from home, fleets first, then alphabetical */
  function defaultDisbands(state, power, count) {
    var homes = MAP.homeCenters(power);
    var dist = bfsDistances(homes);
    var mine = [];
    for (var p in state.units) {
      if (state.units[p].power === power) {
        mine.push({ loc: p, type: state.units[p].type, d: dist[p] === undefined ? 99 : dist[p] });
      }
    }
    mine.sort(function (a, b) {
      if (b.d !== a.d) return b.d - a.d;
      if (a.type !== b.type) return a.type === 'F' ? -1 : 1;
      return a.loc < b.loc ? -1 : 1;
    });
    return mine.slice(0, count).map(function (m) { return m.loc; });
  }

  /* BFS over the union of army+fleet adjacency at province level */
  function bfsDistances(sources) {
    var adj = {};
    function add(a, b) {
      if (!adj[a]) adj[a] = {};
      adj[a][b] = true;
    }
    var k;
    for (k in MAP.armyAdj) MAP.armyAdj[k].forEach(function (n) { add(k, n); });
    for (k in MAP.fleetAdj) {
      var a = MAP.splitLoc(k).prov;
      MAP.fleetAdj[k].forEach(function (n) { add(a, MAP.splitLoc(n).prov); });
    }
    var dist = {}, queue = [];
    sources.forEach(function (s) { dist[s] = 0; queue.push(s); });
    while (queue.length) {
      var cur = queue.shift();
      for (var n in (adj[cur] || {})) {
        if (dist[n] === undefined) { dist[n] = dist[cur] + 1; queue.push(n); }
      }
    }
    return dist;
  }

  /* ---------------- one entry point for the server ---------------- */

  function resolveTurn(state, ordersByPower) {
    if (state.phase === 'MOVE') return resolveMovement(state, ordersByPower);
    if (state.phase === 'RETREAT') return resolveRetreats(state, ordersByPower);
    if (state.phase === 'BUILD') return resolveBuilds(state, ordersByPower);
    return { results: [], newState: cloneState(state), error: 'game over' };
  }

  /* ---------------- UI helper: legal targets for a unit ---------------- */

  function legalTargets(state, prov) {
    var u = state.units[prov];
    if (!u) return null;
    var out = { moves: [], convoyMoves: [], supports: [] };
    if (u.type === 'A') {
      (MAP.armyAdj[prov] || []).forEach(function (p) { out.moves.push({ dest: p }); });
      // convoy destinations (needs fleets at sea right now)
      if (MAP.isCoast(prov)) {
        for (var p2 in MAP.PROVINCES) {
          if (!MAP.isCoast(p2) || p2 === prov) continue;
          if ((MAP.armyAdj[prov] || []).indexOf(p2) !== -1) continue;
          if (convoyPossible(state, prov, p2)) out.convoyMoves.push({ dest: p2 });
        }
      }
    } else {
      var from = MAP.fleetLoc(prov, u.coast);
      (MAP.fleetAdj[from] || []).forEach(function (l) {
        var s = MAP.splitLoc(l);
        var found = null;
        out.moves.forEach(function (m) { if (m.dest === s.prov) found = m; });
        if (found) { if (s.coast) found.coasts.push(s.coast); }
        else out.moves.push({ dest: s.prov, coasts: s.coast ? [s.coast] : [] });
      });
    }
    return out;
  }

  return {
    initialState: initialState,
    cloneState: cloneState,
    validateOrder: validateOrder,
    resolveMovement: resolveMovement,
    resolveRetreats: resolveRetreats,
    resolveBuilds: resolveBuilds,
    resolveTurn: resolveTurn,
    adjustmentsFor: adjustmentsFor,
    legalTargets: legalTargets,
    convoyPossible: convoyPossible,
    scCount: scCount,
    unitCount: unitCount
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DIPLOMACY_ENGINE;
}
