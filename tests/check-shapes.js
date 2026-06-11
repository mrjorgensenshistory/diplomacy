/* Geometry vs rulebook check.
 * Rasterizes the board polygons and verifies:
 *  1. every data-adjacent province pair actually touches on the board
 *  2. provinces that touch on the board are data-adjacent (warn if not)
 *  3. label/unit anchors sit inside their own polygon
 *  4. no two polygons overlap
 * Run: node tests/check-shapes.js
 */

var MAP = require('../shared/map-data.js');
var SHAPES = require('../shared/map-shapes.js');

var STEP = 2;

function pip(x, y, poly) {
  var inside = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

var keys = Object.keys(SHAPES.provinces);
var missingShapes = [];
Object.keys(MAP.PROVINCES).forEach(function (p) {
  if (!SHAPES.provinces[p]) missingShapes.push(p);
});
if (missingShapes.length) {
  console.log('MISSING SHAPES: ' + missingShapes.join(', '));
  process.exit(1);
}

// rasterize (sample at cell centers, offset by 1 to avoid edge ties)
var W = Math.ceil(SHAPES.width / STEP), H = Math.ceil(SHAPES.height / STEP);
var grid = new Array(W * H).fill(null);
var overlaps = {};
keys.forEach(function (p) {
  var poly = SHAPES.provinces[p].poly;
  var xs = poly.map(function (v) { return v[0]; });
  var ys = poly.map(function (v) { return v[1]; });
  var x0 = Math.floor(Math.min.apply(null, xs) / STEP), x1 = Math.ceil(Math.max.apply(null, xs) / STEP);
  var y0 = Math.floor(Math.min.apply(null, ys) / STEP), y1 = Math.ceil(Math.max.apply(null, ys) / STEP);
  for (var gy = y0; gy <= y1 && gy < H; gy++) {
    for (var gx = x0; gx <= x1 && gx < W; gx++) {
      if (gx < 0 || gy < 0) continue;
      var px = gx * STEP + 1, py = gy * STEP + 1;
      if (pip(px, py, poly)) {
        var cur = grid[gy * W + gx];
        if (cur && cur !== p) {
          var k = cur < p ? cur + '+' + p : p + '+' + cur;
          overlaps[k] = (overlaps[k] || 0) + 1;
        }
        grid[gy * W + gx] = p;
      }
    }
  }
});

// geometric contacts
var contact = {};
function touch(a, b) {
  if (!a || !b || a === b) return;
  var k = a < b ? a + '|' + b : b + '|' + a;
  contact[k] = (contact[k] || 0) + 1;
}
for (var y = 0; y < H; y++) {
  for (var x = 0; x < W; x++) {
    var c = grid[y * W + x];
    if (!c) continue;
    if (x + 1 < W) touch(c, grid[y * W + x + 1]);
    if (y + 1 < H) touch(c, grid[(y + 1) * W + x]);
    // diagonal-only contact does not count as touching
  }
}

// data adjacency at province level
var dataAdj = {};
function addAdj(a, b) {
  var k = a < b ? a + '|' + b : b + '|' + a;
  dataAdj[k] = true;
}
var k;
for (k in MAP.armyAdj) MAP.armyAdj[k].forEach(function (n) { addAdj(k, n); });
for (k in MAP.fleetAdj) {
  var a = MAP.splitLoc(k).prov;
  MAP.fleetAdj[k].forEach(function (n) { addAdj(a, MAP.splitLoc(n).prov); });
}

var problems = 0;

console.log('--- overlapping polygons (must be none) ---');
Object.keys(overlaps).forEach(function (o) {
  console.log('  OVERLAP ' + o + ' cells=' + overlaps[o]);
  problems++;
});

console.log('--- data-adjacent pairs that never touch on the board ---');
Object.keys(dataAdj).sort().forEach(function (pair) {
  if (!contact[pair] || contact[pair] < 3) {
    console.log('  NO TOUCH ' + pair + ' (contact cells: ' + (contact[pair] || 0) + ')');
    problems++;
  }
});

console.log('--- board contacts with no rulebook adjacency (false affordances) ---');
Object.keys(contact).sort().forEach(function (pair) {
  if (!dataAdj[pair] && contact[pair] >= 3) {
    console.log('  FALSE ' + pair + ' (contact cells: ' + contact[pair] + ')');
    problems++;
  }
});

console.log('--- anchors outside their province ---');
keys.forEach(function (p) {
  var s = SHAPES.provinces[p];
  [['label', s.label], ['unit', s.unit]].forEach(function (a) {
    if (!pip(a[1][0], a[1][1], s.poly)) { console.log('  ANCHOR ' + p + '.' + a[0] + ' outside'); problems++; }
  });
  if (s.coastAnchors) {
    Object.keys(s.coastAnchors).forEach(function (c) {
      var pt = s.coastAnchors[c];
      if (!pip(pt[0], pt[1], s.poly)) { console.log('  ANCHOR ' + p + '/' + c + ' outside'); problems++; }
    });
  }
});

console.log('\n' + (problems ? problems + ' problem(s).' : 'Board geometry matches the rulebook. ✓'));
process.exit(problems ? 1 : 0);
