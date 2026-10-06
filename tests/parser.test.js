// Parser tests: run with  node tests/parser.test.js
const path = require('path');
const P = require(path.join(__dirname, '..', 'extension', 'parser.js'));
const NAT = P.NATURAL;
const cases = [
  // [text sources, expected status, expected cotton]
  [['Composition: 100% Cotton'], 'pure', 100],
  [['Shell: Cotton 100%'], 'pure', 100],
  [['Cotton 60%, Polyester 40%'], 'blend', 60],
  [['COTTON 60% POLYESTER 40%'], 'blend', 60],
  [['60% cotton/40% polyester'], 'blend', 60],
  [['Body: 60% cotton, 40% polyester; Rib: 98% cotton, 2% elastane'], 'blend', 60],
  [['Shell: 100% cotton. Lining: 100% polyester'], 'pure-main', 100],
  [['100% organic pima cotton'], 'pure', 100],
  [['98% cotton, 2% elastane'], 'blend', 98],
  [['Organic 100% Cotton Denim Jean ... Fabric: 98% cotton, 2% spandex'], 'blend', 98],
  [['100% polyester'], 'none', 0],
  [['95% recycled polyester and 5% spandex'], 'none', 0],
  [['I wish this was 100% cotton. Great shirt.'], 'unknown', null],
  [['Save 30% on cotton tees today'], 'unknown', null],
  [['Material: Cotton'], 'likely', 100],
  [['Fabric type: Cotton blend'], 'blend', null],
  [['Material: Polyester'], 'none', 0],
  [['', '{"material":"100\\u0025 Cotton","name":"Tee"}'], 'pure', 100],
  [['', '{"composition":"<li>Shell: 52% cotton, 48% polyamide</li>"}'], 'blend', 52],
  [['Heather gray: 90% cotton, 10% polyester. All other colors: 100% cotton.'], 'varies', 100],
  [['Do not bleach, tumble dry. 100% cotton'], 'pure', 100],
  [['Main fabric 55% linen 45% cotton'], 'blend', 45],
  [['Outer: 100% nylon. Lining: 100% cotton'], 'none', 0],
  [['50% Cotton 50% Organic Cotton'], 'pure', 100],
  [['Fabric &amp; Care: 100&#37; Cotton&nbsp;jersey'], 'pure', 100],
  [['80% cotton 20% polyamide'], 'blend', 80],
  [['Made from 100% Supima® cotton'], 'pure', 100],
  [['Lyocell 70%, linen 30%'], 'none', 0],
  [['Shop our 100% cotton collection', 'Composition: 60% cotton 40% modal'], 'blend', 60],
  [['Menu: 100% Cotton Hip Pad Jeans', 'Sleeve : Long sleeve Fit : Loose fit, Oversize fit Cotton 100% Color : Black'], 'pure', 100],
  [['Sleeve : Long sleeve Fit : Normal fit Polyester 39%, Acrylic 35%, Nylon 20%, Wool 6% Color : Black'], 'none', 0],
  [['Body: 100% cotton. Sleeves: 100% polyester'], 'pure-main', 100],
  // other materials: [sources, status, pct, wanted]
  [['Composition: 100% linen'], 'pure', 100, ['linen']],
  [['Composition: 100% European flax linen'], 'pure', 100, ['linen']],
  [['Shell: Linen 55%, Cotton 45%'], 'blend', 55, ['linen']],
  [['Shell: Linen 55%, Cotton 45%'], 'pure', 100, ['linen', 'cotton']],
  [['100% mulberry silk'], 'pure', 100, ['silk']],
  [['Fabric: 70% wool, 30% cashmere'], 'pure', 100, NAT],
  [['Fabric: 70% wool, 30% cashmere'], 'blend', 70, ['wool']],
  [['Fabric: 80% extra fine merino wool, 20% nylon'], 'blend', 80, ['wool']],
  [['100% baby alpaca'], 'pure', 100, NAT],
  [['Shell: 100% wool. Lining: 100% polyester'], 'pure-main', 100, ['wool']],
  [['Main: 55% ramie, 45% cotton'], 'pure', 100, NAT],
  [['Material: Linen'], 'likely', 100, ['linen']],
  [['Material: Linen'], 'none', 0, ['cotton']],
  [['95% lyocell, 5% elastane'], 'blend', 95, ['lyocell']],
  [['Color: Camel\n Cotton 100%'], 'pure', 100, ['cotton']],
  [['100% polyester'], 'none', 0, NAT],
  // Amazon-style pages
  [['Product details Fabric type Solid:100% cotton(White not see-through);Striped and Grey:95% cotton + 5% spandex Care instructions Machine wash. Customers say: some appreciate the cotton material, others report it is not 100% cotton.'], 'varies', 100],
  [['Fabric type 60% Cotton, 40% Polyester. Amazon Essentials Women 100% Cotton Crewneck T-Shirt $12. Material feels great, 100% cotton!'], 'blend', 60],
  [['Great tee, the material is not 100% cotton though.'], 'unknown', null],
];
let fail = 0;
for (const [src, status, pct, wanted = ['cotton']] of cases) {
  const r = P.score(P.analyze(src), wanted);
  const ok = r.status === status && r.pct === pct;
  if (!ok) fail++;
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + (P.wantedName(wanted) + ': ' + JSON.stringify(src)).slice(0, 84).padEnd(86) + ' -> ' + r.status + ' ' + r.pct + ' [' + r.label + '] ' + r.summary);
}
console.log(fail ? fail + ' failures' : 'all passed');

// ---- preferences: avoid list, stretch allowance, origin ----
const prefCases = [
  // [sources, prefs, status, pct, label?]
  [['98% cotton, 2% elastane'], { fibers: ['cotton'], stretch: 5 }, 'pure', 100],
  [['92% cotton, 8% elastane'], { fibers: ['cotton'], stretch: 5 }, 'blend', 92],
  [['60% cotton, 40% polyester'], { fibers: ['cotton'], avoid: ['polyester'] }, 'blocked', 0, 'polyester'],
  [['98% cotton, 2% elastane'], { fibers: ['cotton'], avoid: ['elastane'], stretch: 0 }, 'blocked', 0, 'spandex'],
  [['98% cotton, 2% elastane'], { fibers: ['cotton'], avoid: ['elastane'], stretch: 2 }, 'pure', 100],
  [['Heather: 90% cotton, 10% polyester. Other colors: 100% cotton'], { fibers: ['cotton'], avoid: ['polyester'] }, 'pure', 100],
  [['Material: polyester'], { fibers: ['cotton'], avoid: ['polyester'] }, 'blocked', 0, 'polyester'],
  [['Shell: 100% cotton. Lining: 100% polyester'], { fibers: ['cotton'], avoid: ['polyester'] }, 'pure-main', 100],
];
for (const [src, prefs, status, pct, label] of prefCases) {
  const r = P.score(P.analyze(src), prefs);
  const ok = r.status === status && r.pct === pct && (!label || r.label === label);
  if (!ok) fail++;
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + (JSON.stringify(prefs) + ' ' + JSON.stringify(src)).slice(0, 84).padEnd(86) + ' -> ' + r.status + ' ' + r.pct + ' [' + r.label + '] stretch=' + r.stretch);
}
const originCases = [
  [['100% cotton. Made in USA.'], 'USA'],
  [['Made in the U.S.A. of imported fabric'], 'USA'],
  [['Made in USA or Imported'], 'USA or imported'],
  [['Knit in Portugal from 100% cotton'], 'Portugal'],
  [['Country of Origin: Imported'], 'Imported'],
  [['', '{"countryOfOrigin":"Korea"}'], 'Korea'],
  [['', '{"menu":["Made in USA shop"]}'], null],
  [['Made in small batches'], null],
];
for (const [src, want] of originCases) {
  const got = P.findOrigin(src);
  if (got !== want) fail++;
  console.log((got === want ? 'ok  ' : 'FAIL') + ' origin ' + JSON.stringify(src).padEnd(60) + ' -> ' + got);
}
console.log(fail ? fail + ' failures total' : 'all passed (incl. prefs + origin)');

if (fail) process.exit(1);
