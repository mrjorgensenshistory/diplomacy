/* ============================================================
 * DIPLOMACY — Standard map data (1901 Europe)
 * Plain JS: loads in browser (<script>), Node (require), and
 * Google Apps Script (paste as its own .gs file).
 *
 * Conventions:
 *  - Province keys are 3-letter lowercase: 'par', 'nth', 'stp'
 *  - A fleet LOCATION is either a province key ('bre') or a
 *    province+coast ('stp/nc', 'spa/sc', 'bul/ec').
 *  - armyAdj: province -> provinces an ARMY can walk to.
 *  - fleetAdj: location -> locations a FLEET can sail to.
 *    (Both are symmetric; validateMapData() checks this.)
 * ============================================================ */

var DIPLOMACY_MAP = (function () {

  var POWERS = ['ENGLAND', 'FRANCE', 'GERMANY', 'ITALY', 'AUSTRIA', 'RUSSIA', 'TURKEY'];

  /* color = units/dots, light = owned supply centers,
     pale = the rest of the national homeland (so kids always see
     "all of this is Italy" even where there's no supply center) */
  var POWER_INFO = {
    ENGLAND: { name: 'England', color: '#1f4f8f', light: '#a9c2ea', pale: '#d4dff2' },
    FRANCE:  { name: 'France',  color: '#58a8d6', light: '#bfe0f2', pale: '#def0f9' },
    GERMANY: { name: 'Germany', color: '#4a4a4a', light: '#c2c2c2', pale: '#dededb' },
    ITALY:   { name: 'Italy',   color: '#2e8b57', light: '#b2dcc4', pale: '#d9eee1' },
    AUSTRIA: { name: 'Austria', color: '#c0392b', light: '#eebbb4', pale: '#f6dcd8' },
    RUSSIA:  { name: 'Russia',  color: '#7d3c98', light: '#d4b9e0', pale: '#eadcf0' },
    TURKEY:  { name: 'Turkey',  color: '#c9a227', light: '#ecdda4', pale: '#f4ecce' }
  };

  /* national territory in 1901 — every province inside a power's border,
     supply center or not (Piedmont is Italy, Ruhr is Germany, ...) */
  var NATION = {
    cly: 'ENGLAND', edi: 'ENGLAND', lvp: 'ENGLAND', yor: 'ENGLAND', wal: 'ENGLAND', lon: 'ENGLAND',
    bre: 'FRANCE', pic: 'FRANCE', par: 'FRANCE', bur: 'FRANCE', gas: 'FRANCE', mar: 'FRANCE',
    kie: 'GERMANY', ber: 'GERMANY', pru: 'GERMANY', ruh: 'GERMANY', mun: 'GERMANY', sil: 'GERMANY',
    pie: 'ITALY', ven: 'ITALY', tus: 'ITALY', rom: 'ITALY', apu: 'ITALY', nap: 'ITALY',
    tyr: 'AUSTRIA', boh: 'AUSTRIA', vie: 'AUSTRIA', gal: 'AUSTRIA', bud: 'AUSTRIA', tri: 'AUSTRIA',
    stp: 'RUSSIA', mos: 'RUSSIA', war: 'RUSSIA', lvn: 'RUSSIA', ukr: 'RUSSIA', sev: 'RUSSIA', fin: 'RUSSIA',
    con: 'TURKEY', ank: 'TURKEY', smy: 'TURKEY', arm: 'TURKEY', syr: 'TURKEY'
  };

  /* type: 'sea' | 'land' (inland) | 'coast' (land touching water)
   * sc: supply center?  home: home power for build purposes
   * coasts: listed only for the three split-coast provinces      */
  var PROVINCES = {
    // --- Seas (19) ---
    adr: { name: 'Adriatic Sea',     type: 'sea' },
    aeg: { name: 'Aegean Sea',       type: 'sea' },
    bal: { name: 'Baltic Sea',       type: 'sea' },
    bar: { name: 'Barents Sea',      type: 'sea' },
    bla: { name: 'Black Sea',        type: 'sea' },
    bot: { name: 'Gulf of Bothnia',  type: 'sea' },
    eas: { name: 'Eastern Mediterranean', type: 'sea' },
    eng: { name: 'English Channel',  type: 'sea' },
    gol: { name: 'Gulf of Lyon',     type: 'sea' },
    hel: { name: 'Helgoland Bight',  type: 'sea' },
    ion: { name: 'Ionian Sea',       type: 'sea' },
    iri: { name: 'Irish Sea',        type: 'sea' },
    mao: { name: 'Mid-Atlantic Ocean', type: 'sea' },
    nao: { name: 'North Atlantic Ocean', type: 'sea' },
    nth: { name: 'North Sea',        type: 'sea' },
    nwg: { name: 'Norwegian Sea',    type: 'sea' },
    ska: { name: 'Skagerrak',        type: 'sea' },
    tys: { name: 'Tyrrhenian Sea',   type: 'sea' },
    wes: { name: 'Western Mediterranean', type: 'sea' },

    // --- England ---
    cly: { name: 'Clyde',      type: 'coast' },
    edi: { name: 'Edinburgh',  type: 'coast', sc: true, home: 'ENGLAND' },
    lvp: { name: 'Liverpool',  type: 'coast', sc: true, home: 'ENGLAND' },
    yor: { name: 'Yorkshire',  type: 'coast' },
    wal: { name: 'Wales',      type: 'coast' },
    lon: { name: 'London',     type: 'coast', sc: true, home: 'ENGLAND' },

    // --- France ---
    bre: { name: 'Brest',      type: 'coast', sc: true, home: 'FRANCE' },
    pic: { name: 'Picardy',    type: 'coast' },
    par: { name: 'Paris',      type: 'land',  sc: true, home: 'FRANCE' },
    bur: { name: 'Burgundy',   type: 'land' },
    gas: { name: 'Gascony',    type: 'coast' },
    mar: { name: 'Marseilles', type: 'coast', sc: true, home: 'FRANCE' },

    // --- Germany ---
    kie: { name: 'Kiel',       type: 'coast', sc: true, home: 'GERMANY' },
    ber: { name: 'Berlin',     type: 'coast', sc: true, home: 'GERMANY' },
    pru: { name: 'Prussia',    type: 'coast' },
    ruh: { name: 'Ruhr',       type: 'land' },
    mun: { name: 'Munich',     type: 'land',  sc: true, home: 'GERMANY' },
    sil: { name: 'Silesia',    type: 'land' },

    // --- Italy ---
    pie: { name: 'Piedmont',   type: 'coast' },
    ven: { name: 'Venice',     type: 'coast', sc: true, home: 'ITALY' },
    tus: { name: 'Tuscany',    type: 'coast' },
    rom: { name: 'Rome',       type: 'coast', sc: true, home: 'ITALY' },
    apu: { name: 'Apulia',     type: 'coast' },
    nap: { name: 'Naples',     type: 'coast', sc: true, home: 'ITALY' },

    // --- Austria ---
    tyr: { name: 'Tyrolia',    type: 'land' },
    boh: { name: 'Bohemia',    type: 'land' },
    vie: { name: 'Vienna',     type: 'land',  sc: true, home: 'AUSTRIA' },
    gal: { name: 'Galicia',    type: 'land' },
    bud: { name: 'Budapest',   type: 'land',  sc: true, home: 'AUSTRIA' },
    tri: { name: 'Trieste',    type: 'coast', sc: true, home: 'AUSTRIA' },

    // --- Russia ---
    stp: { name: 'St Petersburg', type: 'coast', sc: true, home: 'RUSSIA', coasts: ['nc', 'sc'] },
    mos: { name: 'Moscow',     type: 'land',  sc: true, home: 'RUSSIA' },
    war: { name: 'Warsaw',     type: 'land',  sc: true, home: 'RUSSIA' },
    lvn: { name: 'Livonia',    type: 'coast' },
    ukr: { name: 'Ukraine',    type: 'land' },
    sev: { name: 'Sevastopol', type: 'coast', sc: true, home: 'RUSSIA' },
    fin: { name: 'Finland',    type: 'coast' },

    // --- Turkey ---
    con: { name: 'Constantinople', type: 'coast', sc: true, home: 'TURKEY' },
    ank: { name: 'Ankara',     type: 'coast', sc: true, home: 'TURKEY' },
    smy: { name: 'Smyrna',     type: 'coast', sc: true, home: 'TURKEY' },
    arm: { name: 'Armenia',    type: 'coast' },
    syr: { name: 'Syria',      type: 'coast' },

    // --- Neutrals ---
    nwy: { name: 'Norway',     type: 'coast', sc: true },
    swe: { name: 'Sweden',     type: 'coast', sc: true },
    den: { name: 'Denmark',    type: 'coast', sc: true },
    hol: { name: 'Holland',    type: 'coast', sc: true },
    bel: { name: 'Belgium',    type: 'coast', sc: true },
    spa: { name: 'Spain',      type: 'coast', sc: true, coasts: ['nc', 'sc'] },
    por: { name: 'Portugal',   type: 'coast', sc: true },
    naf: { name: 'North Africa', type: 'coast' },
    tun: { name: 'Tunis',      type: 'coast', sc: true },
    ser: { name: 'Serbia',     type: 'land',  sc: true },
    rum: { name: 'Rumania',    type: 'coast', sc: true },
    bul: { name: 'Bulgaria',   type: 'coast', sc: true, coasts: ['ec', 'sc'] },
    gre: { name: 'Greece',     type: 'coast', sc: true },
    alb: { name: 'Albania',    type: 'coast' }
  };

  /* ---- Army adjacency (symmetric; land + coastal provinces only) ---- */
  var armyAdj = {
    cly: ['edi', 'lvp'],
    edi: ['cly', 'lvp', 'yor'],
    lvp: ['cly', 'edi', 'yor', 'wal'],
    yor: ['edi', 'lvp', 'wal', 'lon'],
    wal: ['lvp', 'yor', 'lon'],
    lon: ['yor', 'wal'],

    bre: ['pic', 'par', 'gas'],
    pic: ['bre', 'par', 'bur', 'bel'],
    par: ['bre', 'pic', 'bur', 'gas'],
    bur: ['par', 'pic', 'bel', 'ruh', 'mun', 'mar', 'gas'],
    gas: ['bre', 'par', 'bur', 'mar', 'spa'],
    mar: ['gas', 'bur', 'pie', 'spa'],

    kie: ['den', 'hol', 'ruh', 'mun', 'ber'],
    ber: ['kie', 'pru', 'sil', 'mun'],
    pru: ['ber', 'sil', 'war', 'lvn'],
    ruh: ['bel', 'hol', 'kie', 'mun', 'bur'],
    mun: ['bur', 'ruh', 'kie', 'ber', 'sil', 'boh', 'tyr'],
    sil: ['mun', 'ber', 'pru', 'war', 'gal', 'boh'],

    pie: ['mar', 'tyr', 'ven', 'tus'],
    ven: ['pie', 'tyr', 'tri', 'apu', 'rom', 'tus'],
    tus: ['pie', 'ven', 'rom'],
    rom: ['tus', 'ven', 'apu', 'nap'],
    apu: ['ven', 'rom', 'nap'],
    nap: ['rom', 'apu'],

    tyr: ['mun', 'boh', 'vie', 'tri', 'ven', 'pie'],
    boh: ['mun', 'sil', 'gal', 'vie', 'tyr'],
    vie: ['boh', 'gal', 'bud', 'tri', 'tyr'],
    gal: ['boh', 'sil', 'war', 'ukr', 'rum', 'bud', 'vie'],
    bud: ['vie', 'gal', 'rum', 'ser', 'tri'],
    tri: ['tyr', 'vie', 'bud', 'ser', 'alb', 'ven'],

    stp: ['nwy', 'fin', 'lvn', 'mos'],
    mos: ['stp', 'lvn', 'war', 'ukr', 'sev'],
    war: ['pru', 'sil', 'gal', 'ukr', 'mos', 'lvn'],
    lvn: ['pru', 'war', 'mos', 'stp'],
    ukr: ['mos', 'war', 'gal', 'rum', 'sev'],
    sev: ['mos', 'ukr', 'rum', 'arm'],
    fin: ['nwy', 'swe', 'stp'],

    con: ['bul', 'ank', 'smy'],
    ank: ['con', 'arm', 'smy'],
    smy: ['con', 'ank', 'arm', 'syr'],
    arm: ['sev', 'ank', 'smy', 'syr'],
    syr: ['arm', 'smy'],

    nwy: ['swe', 'fin', 'stp'],
    swe: ['nwy', 'fin', 'den'],
    den: ['kie', 'swe'],
    hol: ['bel', 'kie', 'ruh'],
    bel: ['hol', 'pic', 'bur', 'ruh'],
    spa: ['por', 'gas', 'mar'],
    por: ['spa'],
    naf: ['tun'],
    tun: ['naf'],
    ser: ['tri', 'bud', 'rum', 'bul', 'gre', 'alb'],
    rum: ['ser', 'bul', 'sev', 'ukr', 'gal', 'bud'],
    bul: ['gre', 'ser', 'rum', 'con'],
    gre: ['alb', 'ser', 'bul'],
    alb: ['tri', 'ser', 'gre']
  };

  /* ---- Fleet adjacency (symmetric; locations) ---- */
  var fleetAdj = {
    // Seas
    nao: ['nwg', 'cly', 'lvp', 'iri', 'mao'],
    nwg: ['nao', 'bar', 'nwy', 'nth', 'edi', 'cly'],
    bar: ['nwg', 'nwy', 'stp/nc'],
    nth: ['nwg', 'edi', 'yor', 'lon', 'eng', 'bel', 'hol', 'hel', 'den', 'ska', 'nwy'],
    ska: ['nth', 'nwy', 'swe', 'den'],
    hel: ['nth', 'den', 'kie', 'hol'],
    bal: ['den', 'swe', 'bot', 'lvn', 'pru', 'ber', 'kie'],
    bot: ['swe', 'fin', 'stp/sc', 'lvn', 'bal'],
    iri: ['nao', 'lvp', 'wal', 'eng', 'mao'],
    eng: ['iri', 'wal', 'lon', 'nth', 'bel', 'pic', 'bre', 'mao'],
    mao: ['nao', 'iri', 'eng', 'bre', 'gas', 'spa/nc', 'por', 'spa/sc', 'naf', 'wes'],
    wes: ['mao', 'spa/sc', 'gol', 'tys', 'tun', 'naf'],
    gol: ['spa/sc', 'mar', 'pie', 'tus', 'tys', 'wes'],
    tys: ['gol', 'tus', 'rom', 'nap', 'ion', 'tun', 'wes'],
    ion: ['tys', 'nap', 'apu', 'adr', 'alb', 'gre', 'aeg', 'eas', 'tun'],
    adr: ['ven', 'tri', 'alb', 'ion', 'apu'],
    aeg: ['gre', 'bul/sc', 'con', 'smy', 'eas', 'ion'],
    eas: ['aeg', 'smy', 'syr', 'ion'],
    bla: ['sev', 'arm', 'ank', 'con', 'bul/ec', 'rum'],

    // England
    cly: ['nao', 'nwg', 'edi', 'lvp'],
    edi: ['nwg', 'nth', 'yor', 'cly'],
    lvp: ['nao', 'iri', 'wal', 'cly'],
    yor: ['nth', 'lon', 'edi'],
    wal: ['iri', 'eng', 'lon', 'lvp'],
    lon: ['nth', 'eng', 'wal', 'yor'],

    // France
    bre: ['eng', 'mao', 'gas', 'pic'],
    pic: ['eng', 'bel', 'bre'],
    gas: ['mao', 'bre', 'spa/nc'],
    mar: ['gol', 'pie', 'spa/sc'],

    // Germany (Kiel is a canal: one coast touching both seas)
    kie: ['hel', 'bal', 'den', 'hol', 'ber'],
    ber: ['bal', 'kie', 'pru'],
    pru: ['bal', 'ber', 'lvn'],

    // Italy
    pie: ['gol', 'mar', 'tus'],
    ven: ['adr', 'tri', 'apu'],
    tus: ['gol', 'tys', 'rom', 'pie'],
    rom: ['tys', 'tus', 'nap'],
    apu: ['adr', 'ion', 'nap', 'ven'],
    nap: ['tys', 'ion', 'rom', 'apu'],

    // Austria
    tri: ['adr', 'alb', 'ven'],

    // Russia
    'stp/nc': ['bar', 'nwy'],
    'stp/sc': ['bot', 'fin', 'lvn'],
    lvn: ['bal', 'bot', 'pru', 'stp/sc'],
    sev: ['bla', 'rum', 'arm'],
    fin: ['bot', 'swe', 'stp/sc'],

    // Turkey (Constantinople is a canal)
    con: ['bla', 'aeg', 'bul/ec', 'bul/sc', 'ank', 'smy'],
    ank: ['bla', 'con', 'arm'],
    smy: ['aeg', 'eas', 'con', 'syr'],
    arm: ['bla', 'sev', 'ank'],
    syr: ['eas', 'smy'],

    // Neutrals
    nwy: ['nwg', 'bar', 'nth', 'ska', 'swe', 'stp/nc'],
    swe: ['ska', 'bal', 'bot', 'nwy', 'fin', 'den'],
    den: ['nth', 'ska', 'bal', 'hel', 'kie', 'swe'],
    hol: ['nth', 'hel', 'bel', 'kie'],
    bel: ['eng', 'nth', 'pic', 'hol'],
    'spa/nc': ['mao', 'gas', 'por'],
    'spa/sc': ['mao', 'por', 'wes', 'gol', 'mar'],
    por: ['mao', 'spa/nc', 'spa/sc'],
    naf: ['mao', 'wes', 'tun'],
    tun: ['wes', 'tys', 'ion', 'naf'],
    rum: ['bla', 'sev', 'bul/ec'],
    'bul/ec': ['bla', 'con', 'rum'],
    'bul/sc': ['aeg', 'gre', 'con'],
    gre: ['ion', 'aeg', 'alb', 'bul/sc'],
    alb: ['adr', 'ion', 'tri', 'gre']
  };

  /* ---- Starting position, Spring 1901 ---- */
  var START_UNITS = [
    { power: 'ENGLAND', type: 'F', loc: 'lon' },
    { power: 'ENGLAND', type: 'F', loc: 'edi' },
    { power: 'ENGLAND', type: 'A', loc: 'lvp' },
    { power: 'FRANCE',  type: 'A', loc: 'par' },
    { power: 'FRANCE',  type: 'A', loc: 'mar' },
    { power: 'FRANCE',  type: 'F', loc: 'bre' },
    { power: 'GERMANY', type: 'A', loc: 'ber' },
    { power: 'GERMANY', type: 'A', loc: 'mun' },
    { power: 'GERMANY', type: 'F', loc: 'kie' },
    { power: 'ITALY',   type: 'A', loc: 'rom' },
    { power: 'ITALY',   type: 'A', loc: 'ven' },
    { power: 'ITALY',   type: 'F', loc: 'nap' },
    { power: 'AUSTRIA', type: 'A', loc: 'vie' },
    { power: 'AUSTRIA', type: 'A', loc: 'bud' },
    { power: 'AUSTRIA', type: 'F', loc: 'tri' },
    { power: 'RUSSIA',  type: 'A', loc: 'mos' },
    { power: 'RUSSIA',  type: 'A', loc: 'war' },
    { power: 'RUSSIA',  type: 'F', loc: 'sev' },
    { power: 'RUSSIA',  type: 'F', loc: 'stp', coast: 'sc' },
    { power: 'TURKEY',  type: 'A', loc: 'con' },
    { power: 'TURKEY',  type: 'A', loc: 'smy' },
    { power: 'TURKEY',  type: 'F', loc: 'ank' }
  ];

  /* ---------- helpers ---------- */

  function isSea(p) { return PROVINCES[p] && PROVINCES[p].type === 'sea'; }
  function isCoast(p) { return PROVINCES[p] && PROVINCES[p].type === 'coast'; }
  function isLand(p) { return PROVINCES[p] && PROVINCES[p].type !== 'sea'; }
  function isSC(p) { return !!(PROVINCES[p] && PROVINCES[p].sc); }

  function homeCenters(power) {
    var out = [];
    for (var p in PROVINCES) if (PROVINCES[p].home === power) out.push(p);
    return out;
  }

  function allSCs() {
    var out = [];
    for (var p in PROVINCES) if (PROVINCES[p].sc) out.push(p);
    return out;
  }

  /* location string for a fleet: 'stp/sc' or plain 'bre' */
  function fleetLoc(prov, coast) {
    return coast ? prov + '/' + coast : prov;
  }

  /* split 'stp/sc' -> {prov:'stp', coast:'sc'} */
  function splitLoc(loc) {
    var i = loc.indexOf('/');
    if (i === -1) return { prov: loc, coast: null };
    return { prov: loc.slice(0, i), coast: loc.slice(i + 1) };
  }

  /* All fleet locations for a province ('spa' -> ['spa/nc','spa/sc']) */
  function fleetLocsOf(prov) {
    var info = PROVINCES[prov];
    if (!info) return [];
    if (info.coasts) return info.coasts.map(function (c) { return prov + '/' + c; });
    if (fleetAdj[prov]) return [prov];
    return []; // pure inland: no fleet locations
  }

  /* Can a unit (type, at prov/coast) move to dest(/destCoast) without convoy? */
  function canMoveDirect(type, prov, coast, dest, destCoast) {
    if (type === 'A') {
      var adj = armyAdj[prov];
      return !!adj && adj.indexOf(dest) !== -1;
    }
    var from = fleetLoc(prov, coast);
    var adjF = fleetAdj[from];
    if (!adjF) return false;
    if (destCoast) return adjF.indexOf(fleetLoc(dest, destCoast)) !== -1;
    // no coast given: any coast of dest reachable counts
    var locs = fleetLocsOf(dest);
    for (var i = 0; i < locs.length; i++) {
      if (adjF.indexOf(locs[i]) !== -1) return true;
    }
    return false;
  }

  /* Coasts of dest reachable by a fleet at prov/coast (for UI + validation) */
  function reachableCoasts(prov, coast, dest) {
    var from = fleetLoc(prov, coast);
    var adjF = fleetAdj[from] || [];
    var out = [];
    fleetLocsOf(dest).forEach(function (l) {
      if (adjF.indexOf(l) !== -1) out.push(splitLoc(l).coast);
    });
    return out;
  }

  /* Symmetry / sanity self-check; returns array of problem strings */
  function validateMapData() {
    var errs = [];
    function locValid(l) {
      var s = splitLoc(l);
      if (!PROVINCES[s.prov]) return false;
      if (s.coast) {
        var c = PROVINCES[s.prov].coasts;
        return !!c && c.indexOf(s.coast) !== -1;
      }
      return true;
    }
    var k, i, adj;
    for (k in armyAdj) {
      if (!PROVINCES[k]) errs.push('armyAdj key unknown: ' + k);
      else if (PROVINCES[k].type === 'sea') errs.push('armyAdj on sea: ' + k);
      adj = armyAdj[k];
      for (i = 0; i < adj.length; i++) {
        if (!armyAdj[adj[i]] || armyAdj[adj[i]].indexOf(k) === -1) {
          errs.push('armyAdj asymmetric: ' + k + ' -> ' + adj[i]);
        }
      }
    }
    for (k in fleetAdj) {
      if (!locValid(k)) errs.push('fleetAdj key invalid: ' + k);
      adj = fleetAdj[k];
      for (i = 0; i < adj.length; i++) {
        if (!locValid(adj[i])) errs.push('fleetAdj target invalid: ' + k + ' -> ' + adj[i]);
        else if (!fleetAdj[adj[i]] || fleetAdj[adj[i]].indexOf(k) === -1) {
          errs.push('fleetAdj asymmetric: ' + k + ' -> ' + adj[i]);
        }
      }
    }
    // split-coast provinces must not appear as bare fleet locations
    ['stp', 'spa', 'bul'].forEach(function (p) {
      if (fleetAdj[p]) errs.push('split-coast province has bare fleet entry: ' + p);
    });
    if (allSCs().length !== 34) errs.push('SC count is ' + allSCs().length + ', expected 34');
    if (Object.keys(PROVINCES).length !== 75) errs.push('province count is ' + Object.keys(PROVINCES).length + ', expected 75');
    return errs;
  }

  return {
    POWERS: POWERS,
    POWER_INFO: POWER_INFO,
    NATION: NATION,
    PROVINCES: PROVINCES,
    armyAdj: armyAdj,
    fleetAdj: fleetAdj,
    START_UNITS: START_UNITS,
    isSea: isSea, isCoast: isCoast, isLand: isLand, isSC: isSC,
    homeCenters: homeCenters, allSCs: allSCs,
    fleetLoc: fleetLoc, splitLoc: splitLoc, fleetLocsOf: fleetLocsOf,
    canMoveDirect: canMoveDirect, reachableCoasts: reachableCoasts,
    validateMapData: validateMapData
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DIPLOMACY_MAP;
}
