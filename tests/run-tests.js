/* Diplomacy engine test suite.
 * Run: node tests/run-tests.js
 * Covers map integrity + DATC-style adjudication cases + retreats/builds.
 *
 * Order notation:
 *   "A par H"                hold
 *   "A par - bur"            move      ("VC" suffix = via convoy)
 *   "F mao - spa/sc"         move to a specific coast
 *   "A par S A bre"          support hold
 *   "A par S A bre - pic"    support move
 *   "F nth C A lon - bel"    convoy
 */

var MAP = require('../shared/map-data.js');
var ENG = require('../shared/engine.js');

var passed = 0, failed = 0, failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); }
}

/* ---------- parsing helpers ---------- */

function parseUnit(s) {
  var t = s.trim().split(/\s+/);
  var loc = t[1].split('/');
  return { type: t[0], prov: loc[0], coast: loc[1] || null };
}

function parseOrder(s) {
  var t = s.replace(/\s+/g, ' ').trim().split(' ');
  var unit = t[1].split('/')[0];
  if (t[2] === 'H' || t[2] === 'h') return { type: 'hold', unit: unit };
  if (t[2] === '-') {
    var d = t[3].split('/');
    return { type: 'move', unit: unit, dest: d[0], destCoast: d[1] || null, viaConvoy: t[4] === 'VC' };
  }
  if (t[2] === 'S') {
    var from = t[4].split('/')[0];
    if (t[5] === '-') return { type: 'support', unit: unit, from: from, to: t[6].split('/')[0] };
    return { type: 'support', unit: unit, from: from, to: null };
  }
  if (t[2] === 'C') {
    return { type: 'convoy', unit: unit, from: t[4].split('/')[0], to: t[6].split('/')[0] };
  }
  throw new Error('Cannot parse order: ' + s);
}

function makeState(unitsSpec, opts) {
  opts = opts || {};
  var state = ENG.initialState({ victorySCs: opts.victorySCs, endYear: opts.endYear });
  state.units = {};
  for (var power in unitsSpec) {
    unitsSpec[power].forEach(function (us) {
      var u = parseUnit(us);
      state.units[u.prov] = { power: power, type: u.type, coast: u.coast };
    });
  }
  if (opts.scOwners) state.scOwners = opts.scOwners;
  if (opts.season) state.season = opts.season;
  return state;
}

function mapOrders(spec) {
  var out = {};
  for (var power in spec) out[power] = spec[power].map(parseOrder);
  return out;
}

/* movement-phase test */
function T(name, spec) {
  var state = makeState(spec.units, spec.opts);
  var r;
  try {
    r = ENG.resolveMovement(state, mapOrders(spec.orders));
  } catch (e) {
    check(name, false, 'threw: ' + (e && e.stack || e));
    return null;
  }
  var byUnit = {};
  r.results.forEach(function (res) { byUnit[res.order.unit] = res; });

  (spec.ok || []).forEach(function (p) {
    check(name + ' [' + p + ' ok]', byUnit[p] && byUnit[p].success === true,
      byUnit[p] ? 'got fail (' + (byUnit[p].note || '') + ')' : 'no result');
  });
  (spec.fail || []).forEach(function (p) {
    check(name + ' [' + p + ' fails]', byUnit[p] && byUnit[p].success === false,
      byUnit[p] ? 'got success' : 'no result');
  });
  (spec.invalid || []).forEach(function (p) {
    check(name + ' [' + p + ' invalid->hold]',
      byUnit[p] && byUnit[p].order.type === 'hold' && !!byUnit[p].note,
      byUnit[p] ? JSON.stringify(byUnit[p]) : 'no result');
  });
  if (spec.dislodged) {
    var got = r.dislodgedAt.slice().sort().join(',');
    var want = spec.dislodged.slice().sort().join(',');
    check(name + ' [dislodged ' + (want || 'none') + ']', got === want, 'got: ' + (got || 'none'));
  }
  if (spec.unitAt) {
    for (var p2 in spec.unitAt) {
      var want2 = spec.unitAt[p2]; // 'FRANCE A' or null
      var u2 = r.newState.units[p2];
      if (want2 === null) {
        check(name + ' [' + p2 + ' empty]', !u2, 'found ' + JSON.stringify(u2));
      } else {
        var w = want2.split(' ');
        check(name + ' [' + p2 + '=' + want2 + ']', u2 && u2.power === w[0] && u2.type === w[1],
          'found ' + JSON.stringify(u2));
      }
    }
  }
  if (spec.contested) {
    var gc = r.newState.contested.slice().sort().join(',');
    check(name + ' [contested]', gc === spec.contested.slice().sort().join(','), 'got: ' + gc);
  }
  if (spec.phase) check(name + ' [phase ' + spec.phase + ']', r.newState.phase === spec.phase, 'got ' + r.newState.phase);
  return r;
}

/* =========================================================
 * 0. Map integrity
 * ========================================================= */
var mapErrs = MAP.validateMapData();
check('map: validateMapData clean', mapErrs.length === 0, mapErrs.join(' | '));
check('map: 7 powers x home centers', MAP.POWERS.every(function (p) {
  return MAP.homeCenters(p).length === (p === 'RUSSIA' ? 4 : 3);
}));
check('map: start units 22', MAP.START_UNITS.length === 22);

/* =========================================================
 * 1. Basic legality (DATC 6.A)
 * ========================================================= */
T('6.A.1 move to non-adjacent sea', {
  units: { ENGLAND: ['F nth'] }, orders: { ENGLAND: ['F nth - pic'] },
  invalid: ['nth']
});
T('6.A.2 army to sea', {
  units: { ENGLAND: ['A lvp'] }, orders: { ENGLAND: ['A lvp - iri'] },
  invalid: ['lvp']
});
T('6.A.3 fleet to inland', {
  units: { GERMANY: ['F kie'] }, orders: { GERMANY: ['F kie - mun'] },
  invalid: ['kie']
});
T('6.A.11 move to own province', {
  units: { AUSTRIA: ['A vie'] }, orders: { AUSTRIA: ['A vie - vie'] },
  invalid: ['vie']
});
T('6.A non-adjacent army, no convoy chain', {
  units: { AUSTRIA: ['A vie'] }, orders: { AUSTRIA: ['A vie - war'] },
  invalid: ['vie']
});
T('basic move succeeds', {
  units: { FRANCE: ['A par'] }, orders: { FRANCE: ['A par - bur'] },
  ok: ['par'], unitAt: { bur: 'FRANCE A', par: null }
});
T('basic bounce, both fail, province contested', {
  units: { FRANCE: ['A par'], GERMANY: ['A mun'] },
  orders: { FRANCE: ['A par - bur'], GERMANY: ['A mun - bur'] },
  fail: ['par', 'mun'], unitAt: { bur: null }, contested: ['bur'], dislodged: []
});
T('self-standoff: own units bounce too', {
  units: { FRANCE: ['A par', 'A gas'] },
  orders: { FRANCE: ['A par - bur', 'A gas - bur'] },
  fail: ['par', 'gas'], unitAt: { bur: null }, contested: ['bur']
});
T('supported attack dislodges', {
  units: { FRANCE: ['A par', 'A gas'], GERMANY: ['A bur'] },
  orders: { FRANCE: ['A par - bur', 'A gas S A par - bur'], GERMANY: ['A bur H'] },
  ok: ['par', 'gas'], dislodged: ['bur'], unitAt: { bur: 'FRANCE A' }, phase: 'RETREAT'
});

/* =========================================================
 * 2. Coasts (DATC 6.B)
 * ========================================================= */
T('6.B.1 ambiguous coast is illegal', {
  units: { FRANCE: ['F por'] }, orders: { FRANCE: ['F por - spa'] },
  invalid: ['por']
});
T('6.B unreachable coast is illegal', {
  units: { FRANCE: ['F gas'] }, orders: { FRANCE: ['F gas - spa/sc'] },
  invalid: ['gas']
});
T('single reachable coast is auto-selected', {
  units: { FRANCE: ['F gas'] }, orders: { FRANCE: ['F gas - spa'] },
  ok: ['gas'], unitAt: { spa: 'FRANCE F' }
});
T('6.B support into split-coast province (province level)', {
  units: { FRANCE: ['F gas', 'F mar'], ITALY: ['F wes'] },
  orders: {
    FRANCE: ['F gas - spa/nc', 'F mar S F gas - spa'],
    ITALY: ['F wes - spa/sc']
  },
  ok: ['gas', 'mar'], fail: ['wes'], unitAt: { spa: 'FRANCE F' }
});
T('6.B.13 coastal crawl bounces (bul)', {
  units: { TURKEY: ['F bul/sc', 'F con'] },
  orders: { TURKEY: ['F bul/sc - con', 'F con - bul/ec'] },
  fail: ['bul', 'con']
});
T('fleet retains coast on move (mao -> spa/nc)', {
  units: { FRANCE: ['F mao'] }, orders: { FRANCE: ['F mao - spa/nc'] },
  ok: ['mao']
});

/* =========================================================
 * 3. Circular movement (DATC 6.C)
 * ========================================================= */
T('6.C.1 three-unit rotation succeeds', {
  units: { TURKEY: ['F ank', 'A con', 'A smy'] },
  orders: { TURKEY: ['F ank - con', 'A con - smy', 'A smy - ank'] },
  ok: ['ank', 'con', 'smy'],
  unitAt: { con: 'TURKEY F', smy: 'TURKEY A', ank: 'TURKEY A' }
});
T('6.C.3 disrupted rotation all fail', {
  units: { TURKEY: ['F ank', 'A con', 'A smy'], RUSSIA: ['A bul'] },
  orders: {
    TURKEY: ['F ank - con', 'A con - smy', 'A smy - ank'],
    RUSSIA: ['A bul - con']
  },
  fail: ['ank', 'con', 'smy', 'bul']
});

/* =========================================================
 * 4. Supports and cuts (DATC 6.D)
 * ========================================================= */
T('6.D.1 supported hold survives supported attack', {
  units: { GERMANY: ['A ber', 'A kie'], RUSSIA: ['A pru', 'A sil'] },
  orders: {
    GERMANY: ['A ber H', 'A kie S A ber'],
    RUSSIA: ['A pru - ber', 'A sil S A pru - ber']
  },
  fail: ['pru'], ok: ['kie', 'sil'], dislodged: [], unitAt: { ber: 'GERMANY A' }
});
T('6.D.2 move cuts support', {
  units: { GERMANY: ['A ber', 'A sil'], RUSSIA: ['A pru', 'A war'] },
  orders: {
    GERMANY: ['A ber - pru', 'A sil S A ber - pru'],
    RUSSIA: ['A pru H', 'A war - sil']
  },
  fail: ['ber', 'sil', 'war'], dislodged: [], unitAt: { pru: 'RUSSIA A' }
});
T('6.D.4 support-hold on a moving unit is void', {
  units: { AUSTRIA: ['A tri', 'A vie'], ITALY: ['A tyr', 'A ven'] },
  orders: {
    AUSTRIA: ['A tri - ven', 'A vie S A tri'],
    ITALY: ['A tyr - tri', 'A ven S A tyr - tri']
  },
  ok: ['tyr', 'ven'], fail: ['tri', 'vie'], dislodged: ['tri'],
  unitAt: { tri: 'ITALY A', ven: 'ITALY A' }
});
T('6.D.10 no self-dislodgement', {
  units: { GERMANY: ['A ber', 'A kie', 'A mun'] },
  orders: { GERMANY: ['A ber H', 'A kie - ber', 'A mun S A kie - ber'] },
  fail: ['kie'], dislodged: [], unitAt: { ber: 'GERMANY A' }
});
T('6.D.12 own support cannot help dislodge own unit', {
  units: { GERMANY: ['A ber', 'A sil'], RUSSIA: ['A pru'] },
  orders: {
    GERMANY: ['A ber H', 'A sil S A pru - ber'],
    RUSSIA: ['A pru - ber']
  },
  fail: ['pru'], dislodged: [], unitAt: { ber: 'GERMANY A' }
});
T('6.D.17 dislodgement cuts support', {
  units: { RUSSIA: ['F con', 'F bla'], TURKEY: ['F ank', 'A smy'] },
  orders: {
    RUSSIA: ['F bla - ank', 'F con S F bla - ank'],
    TURKEY: ['F ank - con', 'A smy S F ank - con']
  },
  ok: ['bla', 'ank', 'smy'], fail: ['con'], dislodged: ['con'],
  unitAt: { ank: 'RUSSIA F', con: 'TURKEY F' }
});
T('beleaguered garrison survives two equal supported attacks', {
  units: { ENGLAND: ['F nth'], GERMANY: ['F ska', 'F hel'], FRANCE: ['F eng', 'F bel'] },
  orders: {
    ENGLAND: ['F nth H'],
    GERMANY: ['F ska - nth', 'F hel S F ska - nth'],
    FRANCE: ['F eng - nth', 'F bel S F eng - nth']
  },
  fail: ['ska', 'eng'], dislodged: [], unitAt: { nth: 'ENGLAND F' }
});
T('support cut only by attack, not by mere adjacency of enemy', {
  units: { FRANCE: ['A bur', 'A tyr'], GERMANY: ['A mun', 'A ruh'] },
  orders: {
    FRANCE: ['A bur - mun', 'A tyr S A bur - mun'],
    GERMANY: ['A mun H', 'A ruh H']
  },
  ok: ['bur', 'tyr'], dislodged: ['mun'], unitAt: { mun: 'FRANCE A' }
});

/* =========================================================
 * 5. Head-to-head (DATC 6.E)
 * ========================================================= */
T('6.E.1 dislodged unit has no effect on attacker area', {
  units: { GERMANY: ['A ber', 'F kie', 'A sil'], RUSSIA: ['A pru'] },
  orders: {
    GERMANY: ['A ber - pru', 'F kie - ber', 'A sil S A ber - pru'],
    RUSSIA: ['A pru - ber']
  },
  ok: ['ber', 'kie', 'sil'], fail: ['pru'], dislodged: ['pru'],
  unitAt: { pru: 'GERMANY A', ber: 'GERMANY F' }
});
T('plain head-to-head bounces', {
  units: { FRANCE: ['A bur'], GERMANY: ['A mun'] },
  orders: { FRANCE: ['A bur - mun'], GERMANY: ['A mun - bur'] },
  fail: ['bur', 'mun'], dislodged: []
});
T('supported head-to-head wins and dislodges', {
  units: { FRANCE: ['A bur', 'A ruh'], GERMANY: ['A mun'] },
  orders: {
    FRANCE: ['A bur - mun', 'A ruh S A bur - mun'],
    GERMANY: ['A mun - bur']
  },
  ok: ['bur', 'ruh'], fail: ['mun'], dislodged: ['mun'], unitAt: { mun: 'FRANCE A' }
});

/* =========================================================
 * 6. Convoys (DATC 6.F / 6.G)
 * ========================================================= */
T('6.F.1 simple convoy', {
  units: { ENGLAND: ['A lon', 'F nth'] },
  orders: { ENGLAND: ['A lon - bel', 'F nth C A lon - bel'] },
  ok: ['lon', 'nth'], unitAt: { bel: 'ENGLAND A', lon: null }
});
T('convoy disrupted by dislodged fleet', {
  units: { ENGLAND: ['A lon', 'F nth'], FRANCE: ['F eng', 'F bel'] },
  orders: {
    ENGLAND: ['A lon - bel', 'F nth C A lon - bel'],
    FRANCE: ['F eng - nth', 'F bel S F eng - nth']
  },
  ok: ['eng', 'bel'], fail: ['lon', 'nth'], dislodged: ['nth'],
  unitAt: { lon: 'ENGLAND A' }
});
T('multi-route convoy survives losing one route', {
  units: { ENGLAND: ['A lon', 'F nth', 'F eng'], FRANCE: ['F bre', 'F mao'] },
  orders: {
    ENGLAND: ['A lon - bel', 'F nth C A lon - bel', 'F eng C A lon - bel'],
    FRANCE: ['F bre - eng', 'F mao S F bre - eng']
  },
  ok: ['lon', 'nth', 'bre', 'mao'], fail: ['eng'], dislodged: ['eng'],
  unitAt: { bel: 'ENGLAND A' }
});
T('convoy paradox resolved by Szykman (convoyed move fails)', {
  units: { ENGLAND: ['A lon', 'F nth'], FRANCE: ['F eng', 'F bel'] },
  orders: {
    ENGLAND: ['A lon - bel', 'F nth C A lon - bel'],
    FRANCE: ['F eng - nth', 'F bel S F eng - nth']
  },
  // same as disruption case: support at bel must NOT be cut by the
  // convoyed army whose own convoy is under attack
  ok: ['eng', 'bel'], fail: ['lon'], dislodged: ['nth']
});
T('6.G.1 swap via convoy succeeds', {
  units: { ENGLAND: ['A nwy', 'F ska'], RUSSIA: ['A swe'] },
  orders: {
    ENGLAND: ['A nwy - swe VC', 'F ska C A nwy - swe'],
    RUSSIA: ['A swe - nwy']
  },
  ok: ['nwy', 'swe', 'ska'],
  unitAt: { swe: 'ENGLAND A', nwy: 'RUSSIA A' }
});
T('same swap without convoy bounces (head-to-head)', {
  units: { ENGLAND: ['A nwy'], RUSSIA: ['A swe'] },
  orders: { ENGLAND: ['A nwy - swe'], RUSSIA: ['A swe - nwy'] },
  fail: ['nwy', 'swe']
});
T('army move flagged via convoy with no fleet fails', {
  units: { ENGLAND: ['A nwy'], RUSSIA: ['A swe'] },
  orders: { ENGLAND: ['A nwy - swe VC'], RUSSIA: ['A swe H'] },
  fail: ['nwy'], unitAt: { swe: 'RUSSIA A' }
});
T('long convoy chain works', {
  units: { ENGLAND: ['A lon', 'F eng', 'F mao', 'F wes'] },
  orders: {
    ENGLAND: ['A lon - tun', 'F eng C A lon - tun', 'F mao C A lon - tun', 'F wes C A lon - tun']
  },
  ok: ['lon'], unitAt: { tun: 'ENGLAND A' }
});

/* =========================================================
 * 7. Retreats
 * ========================================================= */
(function retreatTests() {
  function dislodgeMun() {
    var state = makeState({ FRANCE: ['A bur', 'A ruh'], GERMANY: ['A mun'] });
    var r = ENG.resolveMovement(state, mapOrders({
      FRANCE: ['A bur - mun', 'A ruh S A bur - mun'],
      GERMANY: ['A mun H']
    }));
    return r.newState;
  }
  var s1 = dislodgeMun();
  check('retreat: phase is RETREAT', s1.phase === 'RETREAT');
  check('retreat: attacker origin excluded from options',
    s1.dislodged.mun && s1.dislodged.mun.options.indexOf('bur') === -1,
    JSON.stringify(s1.dislodged));
  check('retreat: boh is a legal option',
    s1.dislodged.mun && s1.dislodged.mun.options.indexOf('boh') !== -1);

  var r2 = ENG.resolveRetreats(s1, { GERMANY: [{ type: 'retreat', unit: 'mun', dest: 'boh' }] });
  check('retreat: unit lands in boh', r2.newState.units.boh && r2.newState.units.boh.power === 'GERMANY');
  check('retreat: spring->fall after retreat', r2.newState.season === 'FALL' && r2.newState.phase === 'MOVE');

  var s3 = dislodgeMun();
  var r3 = ENG.resolveRetreats(s3, { GERMANY: [{ type: 'retreat', unit: 'mun', dest: 'bur' }] });
  check('retreat: retreat to attacker origin disbands', !r3.newState.units.bur || r3.newState.units.bur.power === 'FRANCE');
  check('retreat: disband note recorded', r3.results.some(function (x) { return (x.note || '').indexOf('disband') !== -1 || x.order.type === 'disband'; }));

  // two retreats to the same province -> both disband
  var s4 = makeState({
    FRANCE: ['A bur', 'A tyr', 'A bel', 'A hol'],
    GERMANY: ['A mun', 'A ruh']
  });
  var r4 = ENG.resolveMovement(s4, mapOrders({
    FRANCE: ['A bur - mun', 'A tyr S A bur - mun', 'A bel - ruh', 'A hol S A bel - ruh'],
    GERMANY: ['A mun H', 'A ruh H']
  }));
  check('retreat: two dislodged', Object.keys(r4.newState.dislodged).length === 2, JSON.stringify(r4.dislodgedAt));
  var r5 = ENG.resolveRetreats(r4.newState, {
    GERMANY: [
      { type: 'retreat', unit: 'mun', dest: 'kie' },
      { type: 'retreat', unit: 'ruh', dest: 'kie' }
    ]
  });
  check('retreat: both retreats to same space disband', !r5.newState.units.kie, JSON.stringify(r5.newState.units.kie));

  // standoff province is not a legal retreat
  var s6 = makeState({
    FRANCE: ['A par', 'A bel', 'A hol'],
    GERMANY: ['A mun', 'A ruh']
  });
  var r6 = ENG.resolveMovement(s6, mapOrders({
    FRANCE: ['A par - bur', 'A bel - ruh', 'A hol S A bel - ruh'],
    GERMANY: ['A mun - bur', 'A ruh H']
  }));
  check('retreat: bur contested after bounce', r6.newState.contested.indexOf('bur') !== -1, JSON.stringify(r6.newState.contested));
  check('retreat: contested bur not in ruh options',
    r6.newState.dislodged.ruh && r6.newState.dislodged.ruh.options.indexOf('bur') === -1,
    JSON.stringify(r6.newState.dislodged));
})();

/* =========================================================
 * 8. Supply centers, builds, removals, victory
 * ========================================================= */
(function buildTests() {
  // Fall capture flips ownership and grants a build
  var s = makeState({ FRANCE: ['A pic'] }, { season: 'FALL', scOwners: { par: 'FRANCE' } });
  var r = ENG.resolveMovement(s, mapOrders({ FRANCE: ['A pic - bel'] }));
  check('build: fall capture flips SC', r.newState.scOwners.bel === 'FRANCE');
  check('build: winter build phase reached', r.newState.phase === 'BUILD' && r.newState.season === 'WINTER',
    r.newState.season + '/' + r.newState.phase);
  var rb = ENG.resolveBuilds(r.newState, { FRANCE: [{ type: 'build', loc: 'par', unitType: 'A' }] });
  check('build: army built in paris', rb.newState.units.par && rb.newState.units.par.type === 'A');
  check('build: new year starts', rb.newState.year === 1902 && rb.newState.season === 'SPRING');

  // illegal build locations rejected
  var rb2 = ENG.resolveBuilds(r.newState, { FRANCE: [{ type: 'build', loc: 'mar', unitType: 'A' }] });
  check('build: cannot build in unowned home SC', !rb2.newState.units.mar,
    JSON.stringify(rb2.results));

  // no winter phase when nothing changes
  var s2 = makeState({ GERMANY: ['A mun'] }, { season: 'FALL', scOwners: { mun: 'GERMANY' } });
  var r2 = ENG.resolveMovement(s2, mapOrders({ GERMANY: ['A mun H'] }));
  check('build: skip winter when no adjustments', r2.newState.season === 'SPRING' && r2.newState.year === 1902,
    r2.newState.season + '/' + r2.newState.year);

  // auto-removal: farthest from home; fleets first on distance ties
  // (sil and bal are both distance 1 from German homes; bal is the fleet)
  var s3 = makeState({ GERMANY: ['F bal', 'A sil', 'A ber'] },
    { season: 'FALL', scOwners: { kie: 'GERMANY', ber: 'GERMANY' } });
  var r3 = ENG.resolveMovement(s3, mapOrders({ GERMANY: ['F bal H', 'A sil H', 'A ber H'] }));
  check('build: removal phase reached', r3.newState.phase === 'BUILD',
    r3.newState.season + '/' + r3.newState.phase);
  var rb3 = ENG.resolveBuilds(r3.newState, {});
  check('build: civil disorder removes fleet first on tie', !rb3.newState.units.bal && rb3.newState.units.sil && rb3.newState.units.ber,
    JSON.stringify(rb3.newState.units));

  // victory
  var s4 = makeState({ FRANCE: ['A pic'] }, { season: 'FALL', scOwners: { par: 'FRANCE' }, victorySCs: 2 });
  var r4 = ENG.resolveMovement(s4, mapOrders({ FRANCE: ['A pic - bel'] }));
  check('victory: winner declared at target', r4.newState.winner === 'FRANCE' && r4.newState.phase === 'DONE',
    r4.newState.winner + '/' + r4.newState.phase);

  // STP fleet build requires a coast
  var s5 = makeState({ RUSSIA: ['A mos', 'A war'] },
    { season: 'FALL', scOwners: { stp: 'RUSSIA', mos: 'RUSSIA', war: 'RUSSIA' } });
  var r5 = ENG.resolveMovement(s5, mapOrders({ RUSSIA: ['A mos H', 'A war H'] }));
  check('build: russia owed a build', r5.newState.phase === 'BUILD');
  var rb5a = ENG.resolveBuilds(r5.newState, { RUSSIA: [{ type: 'build', loc: 'stp', unitType: 'F' }] });
  check('build: stp fleet without coast rejected', !rb5a.newState.units.stp, JSON.stringify(rb5a.results));
  var rb5b = ENG.resolveBuilds(r5.newState, { RUSSIA: [{ type: 'build', loc: 'stp', unitType: 'F', coast: 'sc' }] });
  check('build: stp fleet with coast ok', rb5b.newState.units.stp && rb5b.newState.units.stp.coast === 'sc',
    JSON.stringify(rb5b.newState.units.stp));
})();

/* =========================================================
 * 9. Full-game smoke test: classic 1901 opening
 * ========================================================= */
(function smokeTest() {
  var s = ENG.initialState({});
  var r = ENG.resolveMovement(s, mapOrders({
    ENGLAND: ['F lon - nth', 'F edi - nwg', 'A lvp - yor'],
    FRANCE: ['A par - bur', 'A mar - spa', 'F bre - mao'],
    GERMANY: ['A ber - kie', 'A mun - ruh', 'F kie - den'],
    ITALY: ['A rom - apu', 'A ven H', 'F nap - ion'],
    AUSTRIA: ['A vie - gal', 'A bud - ser', 'F tri - alb'],
    RUSSIA: ['A mos - ukr', 'A war - gal', 'F sev - bla', 'F stp - bot'],
    TURKEY: ['A con - bul', 'A smy - con', 'F ank - bla']
  }));
  var ok = 0, failOnes = [];
  r.results.forEach(function (x) { if (x.success) ok++; else failOnes.push(x.order.unit); });
  // gal bounces (vie vs war), bla bounces (sev vs ank) -> 4 failures
  check('smoke: classic opening has exactly 4 bounced moves', failOnes.length === 4, failOnes.join(','));
  check('smoke: gal and bla empty', !r.newState.units.gal && !r.newState.units.bla);
  check('smoke: no dislodgements turn 1', r.dislodgedAt.length === 0);
  check('smoke: now fall 1901', r.newState.season === 'FALL' && r.newState.year === 1901);
  check('smoke: 22 units still on board', Object.keys(r.newState.units).length === 22);
})();

/* =========================================================
 * 10. Computer players
 * ========================================================= */
(function botTests() {
  var BOT = require('../shared/bot.js');

  // every power gets valid opening orders
  var s0 = ENG.initialState({});
  MAP.POWERS.forEach(function (p) {
    var orders = BOT.ordersFor(s0, p);
    var n = ENG.unitCount(s0, p);
    check('bot: ' + p + ' orders all its units', orders.length === n,
      orders.length + ' orders for ' + n + ' units');
    var allValid = orders.every(function (o) {
      return ENG.validateOrder(s0, p, o).ok;
    });
    check('bot: ' + p + ' opening orders are all legal', allValid, JSON.stringify(orders));
  });

  // leaders have voices
  MAP.POWERS.forEach(function (p) {
    check('bot: ' + p + ' has a leader', !!BOT.LEADERS[p] && !!BOT.LEADERS[p].name);
    check('bot: ' + p + ' replies in character', typeof BOT.replyTo(p) === 'string' && BOT.replyTo(p).length > 10);
  });

  // chatter produces well-formed mail
  var s1 = ENG.initialState({});
  var msgs = BOT.chatter(s1, s1, 'GERMANY', ['FRANCE', 'ENGLAND']);
  check('bot: chatter is an array of at most 2', Array.isArray(msgs) && msgs.length <= 2);
  check('bot: chatter addresses real powers', msgs.every(function (m) {
    return MAP.POWERS.indexOf(m.to) !== -1 && typeof m.text === 'string';
  }));

  // full bot-vs-bot war: must run to completion without a single error
  var st = ENG.initialState({ victorySCs: 12, endYear: 1912 });
  var phases = 0, crashed = null;
  try {
    while (st.phase !== 'DONE' && phases < 120) {
      var ordersByPower = {};
      MAP.POWERS.forEach(function (p) {
        ordersByPower[p] = BOT.ordersFor(st, p);
      });
      var r = ENG.resolveTurn(st, ordersByPower);
      st = r.newState;
      phases++;
    }
  } catch (e) {
    crashed = e && e.stack || String(e);
  }
  check('bot: full AI-vs-AI game runs without errors', !crashed, crashed);
  check('bot: game progresses past 1901', st.year > 1901, 'year ' + st.year);
  check('bot: game reaches a verdict by 1912', st.phase === 'DONE',
    st.year + ' ' + st.season + ' ' + st.phase + ' after ' + phases + ' phases');
  var totalSCs = 0;
  for (var p2 in st.scOwners) if (st.scOwners[p2]) totalSCs++;
  check('bot: supply centers stay consistent (<=34)', totalSCs <= 34, totalSCs);
  var unitTotal = Object.keys(st.units).length;
  check('bot: units never exceed owned centers', unitTotal <= totalSCs, unitTotal + ' units / ' + totalSCs + ' SCs');
})();

/* ---------- summary ---------- */
console.log('\n========================================');
console.log('PASSED: ' + passed + '   FAILED: ' + failed);
if (failed) {
  console.log('\nFailures:');
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
}
console.log('All tests green.');
