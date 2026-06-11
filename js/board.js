/* ============================================================
 * DIPLOMACY — SVG board renderer (student + teacher UIs)
 *
 * Renders the real standard-map artwork:
 *   assets/wikimedia-diplomacy.svg
 *   "Diplomacy.svg" by Martin Asal, Wikimedia Commons, CC BY-SA 3.0
 *   (adapted: recolored, unit markers replaced by live pieces)
 *
 * Requires: DIPLOMACY_MAP. Same API as before:
 *   DiploBoard.create(svgEl, opts) -> Promise<Board>
 *   board.drawSCs / tintOwnership / drawUnits / drawOrders / highlight
 * ============================================================ */

var DiploBoard = (function () {
  var MAP = DIPLOMACY_MAP;
  var NS = 'http://www.w3.org/2000/svg';

  var SEA_FILL = '#a5d3e8';        // Avalon Hill cyan
  var LAND_FILL = '#efe6c8';       // parchment (empire view)
  var NEUTRAL_SC_FILL = '#e3d5ab';
  var IMPASSABLE_FILL = '#c8c2b6';

  /* 1976-board terrain palette: yellow-green lowlands, browns for the
     mountainous provinces, desert tans in the south-east. Hand-assigned so
     no two neighbors share a shade. */
  var G1 = '#cede7e', G2 = '#aecf63', G3 = '#dde594', G4 = '#9cc456';
  var BR = '#bda06a', TA = '#d9c98c';
  var TERRAIN_FILL = {
    cly: G2, edi: G1, yor: G3, lvp: G1, wal: G2, lon: G1,
    bre: G1, pic: G3, par: G2, bur: G1, gas: G3, mar: G2,
    spa: TA, por: G2, naf: TA, tun: BR,
    kie: G3, ber: G1, pru: G3, ruh: G2, mun: G4, sil: G2,
    pie: G4, ven: G3, tus: G1, rom: G3, apu: G1, nap: G2,
    tyr: BR, boh: G2, vie: G1, gal: G3, bud: G3, tri: G2,
    ser: G2, alb: BR, gre: G1, bul: G3, rum: G2,
    nwy: BR, swe: G2, fin: G3, den: G1,
    stp: G3, mos: G1, war: G2, lvn: G3, ukr: G1, sev: G3,
    con: G2, ank: TA, smy: G3, arm: BR, syr: TA,
    hol: G1, bel: G2
  };

  /* their label id -> our province key (only the irregular one) */
  function keyOf(id) {
    var k = String(id).toLowerCase();
    if (k === 'lyo') return 'gol';
    return k;
  }

  /* unit positions for split coasts, in the 610x560 map space
     (tuned visually; nc/sc/ec as in the rules) */
  var COAST_ANCHORS = {
    'stp/nc': [468, 96],
    'stp/sc': [440, 156],
    'spa/nc': [96, 366],
    'spa/sc': [110, 442],
    'bul/ec': [392, 420],
    'bul/sc': [377, 448]
  };

  /* small per-province nudges where the text label sits awkwardly */
  var ANCHOR_TWEAKS = {
    mao: [0, -40], nao: [0, -30], stp: [30, -10], mos: [10, 0],
    sev: [10, -6], ukr: [0, -4], gal: [0, -2], naf: [30, -8],
    tun: [4, -10], apu: [6, -4], nap: [6, -8], ion: [0, -10],
    eas: [10, -8], smy: [10, -4], arm: [6, -4], syr: [4, -8],
    eng: [10, -4], iri: [0, -6], wal: [-2, -4], lon: [4, -2],
    yor: [4, -2], edi: [4, -2], cly: [-2, -2], lvp: [-4, -2],
    kie: [2, -2], ber: [4, -2], mun: [4, 0], boh: [4, -2],
    vie: [4, -2], bud: [6, -2], tri: [0, -2], ven: [0, -2],
    rom: [2, -4], tus: [-2, -2], pie: [-2, -2], mar: [0, -2],
    gas: [0, -2], par: [2, -2], bre: [-2, -2], pic: [0, -2],
    bur: [2, 0], bel: [0, -2], hol: [2, -2], ruh: [2, 0],
    den: [2, -2], swe: [2, 0], nwy: [0, -2], fin: [4, 0],
    lvn: [2, -2], war: [2, -2], pru: [2, -2], sil: [2, -2],
    rum: [6, -2], ser: [0, -2], bul: [-2, -2], gre: [0, -4],
    alb: [-2, -2], con: [2, -2], ank: [6, -2], spa: [10, 0],
    por: [-2, -2], bla: [10, -6], aeg: [0, -8], adr: [-4, -8],
    tys: [-2, -8], wes: [0, -10], gol: [-4, -8], bal: [2, -6],
    bot: [2, -8], nth: [4, -10], nwg: [10, -12], bar: [10, -10],
    ska: [0, -6], hel: [0, -6]
  };

  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  var svgTextCache = null;

  async function fetchSvgText() {
    if (svgTextCache) return svgTextCache;
    var res = await fetch('assets/wikimedia-diplomacy.svg');
    svgTextCache = await res.text();
    return svgTextCache;
  }

  function Board(svg, opts) {
    this.svg = svg;
    this.opts = opts || {};
    this.onProvinceClick = this.opts.onProvinceClick || function () {};
    this.paths = {};      // key -> [path elements]
    this.anchors = {};    // key -> [x, y]
    this.scDots = {};     // key -> [sc dot groups]
    this.baseFills = {};  // key -> current base fill
    this.styleMode = localStorage.getItem('diplomacy_mapstyle') || 'empire';
    this._scOwners = null;
  }

  /* base fill for a province under the current style */
  Board.prototype._fillFor = function (key) {
    var info = MAP.PROVINCES[key];
    if (info.type === 'sea') return SEA_FILL;
    if (this.styleMode === 'terrain') return TERRAIN_FILL[key] || G2;
    // empire view: owned centers in the strong tint, the rest of each
    // nation's homeland in a pale wash so the countries stay readable
    var owner = this._scOwners && this._scOwners[key];
    if (info.sc && owner) return MAP.POWER_INFO[owner].light;
    var nation = MAP.NATION && MAP.NATION[key];
    if (nation) return MAP.POWER_INFO[nation].pale;
    return info.sc ? NEUTRAL_SC_FILL : LAND_FILL;
  };

  Board.prototype._applyBase = function () {
    var self = this;
    Object.keys(this.paths).forEach(function (key) {
      var fill = self._fillFor(key);
      self.baseFills[key] = fill;
      self.paths[key].forEach(function (p) { p.setAttribute('fill', fill); });
    });
  };

  /* 'terrain' (classic 1976 look) or 'empire' (provinces tinted by owner) */
  Board.prototype.setStyle = function (mode) {
    this.styleMode = mode === 'empire' ? 'empire' : 'terrain';
    localStorage.setItem('diplomacy_mapstyle', this.styleMode);
    this._applyBase();
  };

  async function create(svg, opts) {
    var b = new Board(svg, opts);
    await b._build();
    return b;
  }

  Board.prototype._build = async function () {
    var self = this;
    var text = await fetchSvgText();
    var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    var src = doc.documentElement;

    var svg = this.svg;
    svg.setAttribute('viewBox', src.getAttribute('viewBox') || '0 0 610 560');
    svg.innerHTML = '';

    // defs: arrowheads
    var defs = el('defs', {}, svg);
    var marker = el('marker', { id: 'arrowhead', markerWidth: 8, markerHeight: 8, refX: 5.2, refY: 2.6, orient: 'auto', markerUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: 'M0,0 L6,2.6 L0,5.2 Z', fill: 'context-stroke' }, marker);
    var markerRed = el('marker', { id: 'arrowhead-fail', markerWidth: 8, markerHeight: 8, refX: 5.2, refY: 2.6, orient: 'auto', markerUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: 'M0,0 L6,2.6 L0,5.2 Z', fill: '#b3382c' }, markerRed);

    // copy artwork
    this.gMap = el('g', {}, svg);
    Array.prototype.slice.call(src.childNodes).forEach(function (n) {
      self.gMap.appendChild(document.importNode(n, true));
    });

    // strip the baked-in starting units (we draw live ones); the A/F id may
    // sit on the marker group itself or on a text inside it
    Array.prototype.slice.call(this.gMap.querySelectorAll('[id="A"], [id="F"]')).forEach(function (n) {
      var victim = (n.tagName === 'g') ? n
                 : (n.parentNode && n.parentNode.tagName === 'g' && !n.parentNode.querySelector('text[id]:not([id="A"]):not([id="F"])'))
                   ? n.parentNode : n;
      if (victim.parentNode) victim.parentNode.removeChild(victim);
    });

    // overlay layers
    this.gOrders = el('g', { 'pointer-events': 'none' }, svg);
    this.gUnits = el('g', { 'pointer-events': 'none' }, svg);

    // walk labeled groups
    Array.prototype.slice.call(this.gMap.querySelectorAll('text[id]')).forEach(function (t) {
      var rawId = t.getAttribute('id');
      if (rawId === 'sc' || rawId === 'A' || rawId === 'F') return;
      var key = keyOf(rawId);
      var g = t.parentNode;
      var isProvince = !!MAP.PROVINCES[key];

      // anchor from the label's transform
      var m = /matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(t.getAttribute('style') || '');
      var ax = m ? parseFloat(m[1]) : 0, ay = m ? parseFloat(m[2]) : 0;
      var tweak = ANCHOR_TWEAKS[key] || [0, 0];
      // label text starts at (ax, ay); center-ish point below it:
      self.anchors[key] = [ax + 13 + tweak[0], ay + 9 + tweak[1]];

      var paths = Array.prototype.slice.call(g.children).filter(function (c) {
        return c.tagName === 'path';
      });

      if (!isProvince) {
        // Switzerland (impassable): recolor, no interaction
        paths.forEach(function (p) {
          p.setAttribute('fill', IMPASSABLE_FILL);
          p.setAttribute('class', '');
        });
        styleLabel(t, true);
        return;
      }

      var info = MAP.PROVINCES[key];
      var fill = self._fillFor(key);
      self.baseFills[key] = fill;
      self.paths[key] = paths;
      paths.forEach(function (p) {
        p.setAttribute('class', 'prov');
        p.setAttribute('fill', fill);
        p.setAttribute('stroke', '#5d513c');
        p.setAttribute('stroke-width', '0.8');
        var title = el('title', {}, p);
        title.textContent = info.name + ' (' + key.toUpperCase() + ')' + (info.sc ? ' ★ supply center' : '');
        p.addEventListener('click', function () { self.onProvinceClick(key); });
      });

      // supply-center dot group(s) baked in the art
      Array.prototype.slice.call(g.querySelectorAll('g[id="sc"]')).forEach(function (sc) {
        if (!self.scDots[key]) self.scDots[key] = [];
        self.scDots[key].push(sc);
        sc.setAttribute('pointer-events', 'none');
      });

      styleLabel(t, info.type === 'sea');
    });

    // background -> open ocean, like the printed board
    var bg = this.gMap.querySelector('path[id="Layer 1"]');
    if (bg) bg.setAttribute('fill', SEA_FILL);
    this.svg.style.background = SEA_FILL;

    // Adopt orphan paths (multi-part provinces drawn outside their labeled
    // group — e.g. the Spanish and Russian interiors). Assign each to the
    // province whose anchor point lies inside it, else the nearest anchor.
    Array.prototype.slice.call(this.gMap.querySelectorAll('path')).forEach(function (p) {
      if (p.classList.contains('prov')) return;
      if (p.getAttribute('id') === 'Layer 1') return;
      if (p.closest('g[id="sc"]')) return;
      var cls = p.getAttribute('class') || '';
      if (cls !== 's1' && cls !== 's4') return;   // only sea/land artwork
      var key = null;
      // try point-in-fill with every province anchor
      for (var k in self.anchors) {
        if (!MAP.PROVINCES[k]) continue;
        try {
          var pt = self.svg.createSVGPoint();
          pt.x = self.anchors[k][0]; pt.y = self.anchors[k][1];
          if (p.isPointInFill(pt)) { key = k; break; }
        } catch (e) { break; }
      }
      if (!key) {
        // nearest anchor to the path's center
        var bb = p.getBBox();
        var cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
        var best = 1e9;
        for (var k2 in self.anchors) {
          if (!MAP.PROVINCES[k2]) continue;
          var dx = self.anchors[k2][0] - cx, dy = self.anchors[k2][1] - cy;
          var d = dx * dx + dy * dy;
          if (d < best) { best = d; key = k2; }
        }
      }
      if (!key) return;
      var info = MAP.PROVINCES[key];
      var fill = self.baseFills[key] || self._fillFor(key);
      p.setAttribute('class', 'prov');
      p.setAttribute('fill', fill);
      p.setAttribute('stroke', '#5d513c');
      p.setAttribute('stroke-width', '0.8');
      var title = el('title', {}, p);
      title.textContent = info.name + ' (' + key.toUpperCase() + ')' + (info.sc ? ' ★ supply center' : '');
      p.addEventListener('click', function () { self.onProvinceClick(key); });
      if (!self.paths[key]) self.paths[key] = [];
      self.paths[key].push(p);
    });

    // claim supply-center dot groups that sit outside their labeled group
    var claimed = [];
    for (var ck in this.scDots) claimed = claimed.concat(this.scDots[ck]);
    Array.prototype.slice.call(this.gMap.querySelectorAll('g[id="sc"]')).forEach(function (g) {
      if (claimed.indexOf(g) !== -1) return;
      var bb = g.getBBox();
      var cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
      var key = null;
      for (var k in self.paths) {
        if (!MAP.isSC(k)) continue;
        for (var i = 0; i < self.paths[k].length; i++) {
          try {
            var pt = self.svg.createSVGPoint();
            pt.x = cx; pt.y = cy;
            if (self.paths[k][i].isPointInFill(pt)) { key = k; break; }
          } catch (e) { break; }
        }
        if (key) break;
      }
      if (!key) {
        var best = 1e9;
        for (var k2 in self.anchors) {
          if (!MAP.isSC(k2)) continue;
          var dx = self.anchors[k2][0] - cx, dy = self.anchors[k2][1] - cy;
          var d = dx * dx + dy * dy;
          if (d < best) { best = d; key = k2; }
        }
      }
      if (key) {
        if (!self.scDots[key]) self.scDots[key] = [];
        self.scDots[key].push(g);
        g.setAttribute('pointer-events', 'none');
      }
    });

    function styleLabel(t, sea) {
      t.setAttribute('pointer-events', 'none');
      Array.prototype.slice.call(t.querySelectorAll('tspan')).forEach(function (ts) {
        ts.setAttribute('class', '');
        ts.setAttribute('style',
          'font: ' + (sea ? 'italic 400 8.5px' : '700 8.5px') + ' Georgia, serif; fill: ' +
          (sea ? '#3c5a74' : '#4d4232') + '; letter-spacing:.4px;');
      });
    }
  };

  Board.prototype.unitXY = function (prov, coast) {
    if (coast && COAST_ANCHORS[prov + '/' + coast]) return COAST_ANCHORS[prov + '/' + coast];
    return this.anchors[prov] || [0, 0];
  };

  /* recolor baked-in SC dots by owner */
  Board.prototype.drawSCs = function (scOwners) {
    var self = this;
    Object.keys(this.scDots).forEach(function (key) {
      var owner = scOwners ? scOwners[key] : null;
      var color = owner ? MAP.POWER_INFO[owner].color : '#6e6149';
      self.scDots[key].forEach(function (grp) {
        Array.prototype.slice.call(grp.querySelectorAll('path, circle, ellipse')).forEach(function (e) {
          e.setAttribute('class', '');             // the art's CSS classes would override fills
          e.style.fill = color;
          e.style.stroke = '#fffdf4';
          e.style.strokeWidth = '0.8';
        });
      });
    });
  };

  Board.prototype.tintOwnership = function (scOwners) {
    this._scOwners = scOwners || null;
    this._applyBase();
  };

  Board.prototype.drawUnits = function (units, dislodged) {
    var g = this.gUnits;
    var self = this;
    g.innerHTML = '';
    function drawOne(prov, u, isDislodged) {
      var xy = self.unitXY(prov, u.coast);
      var x = xy[0] + (isDislodged ? 9 : 0), y = xy[1] + (isDislodged ? -8 : 0);
      var color = MAP.POWER_INFO[u.power].color;
      var grp = el('g', { 'class': isDislodged ? 'unit dislodged' : 'unit' }, g);
      el('circle', { cx: x, cy: y, r: 7.2, fill: color, stroke: isDislodged ? '#d33' : '#fffdf4', 'stroke-width': isDislodged ? 1.6 : 1.1 }, grp);
      if (u.type === 'A') {
        el('path', {
          d: 'M0,-4.2 L1.15,-1.35 L4.2,-1.35 L1.8,0.6 L2.65,3.6 L0,1.8 L-2.65,3.6 L-1.8,0.6 L-4.2,-1.35 L-1.15,-1.35 Z',
          transform: 'translate(' + x + ',' + y + ')', fill: '#fff'
        }, grp);
      } else {
        el('path', {
          d: 'M0,-4.2 a1.3,1.3 0 1,0 0.01,0 M0,-1.6 L0,3.9 M-2.2,-0.6 L2.2,-0.6 M-3.3,1.5 a3.3,3.3 0 0,0 6.6,0',
          transform: 'translate(' + x + ',' + y + ')',
          fill: 'none', stroke: '#fff', 'stroke-width': 1.15, 'stroke-linecap': 'round'
        }, grp);
      }
      var t = el('title', {}, grp);
      t.textContent = (u.type === 'A' ? 'Army' : 'Fleet') + ' ' + MAP.POWER_INFO[u.power].name +
        (isDislodged ? ' (DISLODGED — must retreat)' : '');
    }
    Object.keys(units || {}).forEach(function (p) { drawOne(p, units[p], false); });
    Object.keys(dislodged || {}).forEach(function (p) { drawOne(p, dislodged[p], true); });
  };

  Board.prototype.drawOrders = function (entries) {
    var g = this.gOrders;
    var self = this;
    g.innerHTML = '';
    (entries || []).forEach(function (e) {
      var o = e.order || e;
      var failed = e.success === false;
      var color = MAP.POWER_INFO[e.power] ? MAP.POWER_INFO[e.power].color : '#333';
      var op = failed ? 0.55 : 0.95;
      var from, to;
      if (o.type === 'move') {
        from = self.unitXY(o.unit, null); to = self.unitXY(o.dest, o.destCoast);
        el('line', {
          x1: from[0], y1: from[1], x2: to[0], y2: to[1],
          stroke: failed ? '#b3382c' : color, 'stroke-width': 2, opacity: op,
          'marker-end': failed ? 'url(#arrowhead-fail)' : 'url(#arrowhead)',
          'stroke-dasharray': o.viaConvoy ? '6,3' : 'none'
        }, g);
        if (failed) {
          var mx = (from[0] + to[0]) / 2, my = (from[1] + to[1]) / 2;
          var x = el('text', { x: mx, y: my + 3, 'text-anchor': 'middle', 'class': 'failx' }, g);
          x.textContent = '✕';
        }
      } else if (o.type === 'support') {
        from = self.unitXY(o.unit, null); to = self.unitXY(o.to || o.from, null);
        el('line', {
          x1: from[0], y1: from[1], x2: to[0], y2: to[1],
          stroke: failed ? '#b3382c' : color, 'stroke-width': 1.4, opacity: op * 0.85,
          'stroke-dasharray': '3,3'
        }, g);
        el('circle', { cx: to[0], cy: to[1], r: 4, fill: 'none', stroke: color, 'stroke-width': 1.3, opacity: op * 0.85 }, g);
      } else if (o.type === 'convoy') {
        from = self.unitXY(o.unit, null); to = self.unitXY(o.to, null);
        el('line', {
          x1: from[0], y1: from[1], x2: to[0], y2: to[1],
          stroke: color, 'stroke-width': 1.3, opacity: op * 0.7, 'stroke-dasharray': '1.5,3.5'
        }, g);
      } else if (o.type === 'hold') {
        from = self.unitXY(o.unit, null);
        el('circle', { cx: from[0], cy: from[1], r: 10.5, fill: 'none', stroke: color, 'stroke-width': 1.4, opacity: op * 0.75 }, g);
      } else if (o.type === 'retreat') {
        from = self.unitXY(o.unit, null); to = self.unitXY(o.dest, o.destCoast);
        el('line', {
          x1: from[0], y1: from[1], x2: to[0], y2: to[1],
          stroke: failed ? '#b3382c' : color, 'stroke-width': 1.9, opacity: op,
          'stroke-dasharray': '5,2.5', 'marker-end': failed ? 'url(#arrowhead-fail)' : 'url(#arrowhead)'
        }, g);
      } else if (o.type === 'build') {
        from = self.unitXY(o.loc, o.coast);
        var b = el('text', { x: from[0], y: from[1] - 11, 'text-anchor': 'middle', 'class': 'buildmark' }, g);
        b.textContent = failed ? '✕' : '+' + (o.unitType === 'F' ? '⚓' : '★');
      } else if (o.type === 'remove' || o.type === 'disband') {
        from = self.unitXY(o.loc || o.unit, null);
        var d = el('text', { x: from[0], y: from[1] - 11, 'text-anchor': 'middle', 'class': 'removemark' }, g);
        d.textContent = '−✕';
      }
    });
  };

  Board.prototype.clearOrders = function () { this.gOrders.innerHTML = ''; };

  Board.prototype.highlight = function (marks) {
    var self = this;
    Object.keys(this.paths).forEach(function (key) {
      self.paths[key].forEach(function (p) {
        p.classList.remove('hl-sel', 'hl-target', 'hl-warn');
        p.setAttribute('fill', self.baseFills[key]);
        var m = marks && marks[key];
        if (m) p.classList.add('hl-' + m);
      });
    });
  };

  return { create: create };
})();
