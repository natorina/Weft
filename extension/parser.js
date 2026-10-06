/*
 * Weft: fabric composition parser.
 *
 * Reads page text (visible text and embedded JSON) and works out what a
 * garment is made of, e.g. "60% cotton, 40% polyester" or "Cotton 100%".
 */
(function (global) {
  'use strict';

  // Canonical fiber name -> spellings that mean it.
  const FIBERS = [
    ['cotton', 'cottons?|coton|algod[oó]n|baumwolle|cotone|katoen'],
    ['polyester', 'polyesters?|poly'],
    ['elastane', 'elastanes?|elasthan|elastan|spandex|lycra|elastomultiester|elastodiene'],
    ['nylon', 'nylons?|polyamides?|polyamid'],
    ['viscose', 'viscose|rayon|viscosa'],
    ['modal', 'modal'],
    ['lyocell', 'lyocell|tencel'],
    ['linen', 'linen|flax'],
    ['wool', 'wools?|merino|lambswool'],
    ['cashmere', 'cashmere'],
    ['silk', 'silk'],
    ['acrylic', 'acrylics?|polyacrylic'],
    ['hemp', 'hemp'],
    ['ramie', 'ramie'],
    ['camel', 'camel hair|camelhair|camel'],
    ['yak', 'yak'],
    ['alpaca', 'alpaca'],
    ['mohair', 'mohair'],
    ['angora', 'angora'],
    ['cupro', 'cupro'],
    ['bamboo', 'bamboo'],
    ['leather', 'leather'],
    ['polyurethane', 'polyurethane'],
    ['polypropylene', 'polypropylene'],
    ['acetate', 'triacetate|acetate'],
    ['rubber', 'rubber|latex'],
    ['metallic', 'metallic|metallised|metallized|lurex'],
    ['other', 'other fib(?:er|re)s?|other materials?|others'],
  ];

  const FIBER_ALT = FIBERS.map(([, src]) => src).join('|');
  const FIBER_MATCHERS = FIBERS.map(([name, src]) => [name, new RegExp('^(?:' + src + ')$')]);

  // Words that can sit between a percentage and a fiber: "100% organic pima cotton".
  const QUAL =
    'organic|recycled|pima|supima|egyptian|combed|ring[- ]?spun|bci|better|regenerative|' +
    'certified|conventional|virgin|transitional|in[- ]conversion|sustainable|sustainably sourced|' +
    'responsibly sourced|responsible|traceable|american|us[- ]grown|usa[- ]grown|peruvian|turkish|' +
    'long[- ]staple|extra[- ]long[- ]staple|brushed|mercerized|mercerised|gots[- ]certified|gots|' +
    'fair ?trade|post[- ]consumer|pre[- ]consumer|reclaimed|repreve|ecovero|lenzing|bio|premium|' +
    'soft|heavyweight|lightweight|slub|french terry|jersey|twill|denim|canvas|poplin|oxford|' +
    'mulberry|european|french|belgian|irish|italian|mongolian|inner mongolian|australian|japanese|' +
    'washed|stonewashed|baby|royal|extra[- ]?fine|superfine|fine|grade[- ]a|pure|natural|non[- ]mulesed|mulesing[- ]free';

  // One token is either a percentage ("60%", "60 percent") or a fiber word.
  const TOKEN_RE = new RegExp(
    '(?<![\\d.,])(\\d{1,3}(?:[.,]\\d{1,2})?)\\s*(?:%|percent(?![a-z])|pct(?![a-z]))' +
      '|(?<![a-z])(' + FIBER_ALT + ')[™®]?(?![a-z])',
    'g'
  );

  // What may separate tokens inside one composition list.
  const GAP_RE = new RegExp('^(?:[\\s,;/&+:\\-–—|()*•·.™®]|and|with|(?:' + QUAL + '))*$');

  // Labels that appear just before a composition.
  const LABEL_RE = new RegExp(
    '(?<![a-z])(?:' +
      '(?<part>lining fabric|fabric lining|hood lining|sleeve lining|interlining|linings?|knit trim|trims?|' +
      'ribbing|rib|cuffs?|collar|pocketing|pockets?|contrast|panels?|inserts?|' +
      '(?<!(?:long|short|cap|puff|raglan|half|bell|balloon|flutter|bishop|dolman|3/4)[\\s-])sleeves?|filling|fill|padding|' +
      'wadding|insulation|embroidery|lace|waistband|binding|gusset|yoke|appliqu[eé]|mesh|facing|sole|' +
      'drawcord|drawstring|other parts|fringe|hood)' +
      '|(?<main>outer shell|outer fabric|shell|outer|outside|body|main fabric|main material|main|self|' +
      'exterior|upper|face|front|base)' +
      '|(?<hint>composition|materials?|fabrication|fabric content|fabric type|fabric|content|' +
      'made (?:of|from|with)|fib(?:er|re)s?|textile|care & content|details|colou?rs?|colorways?)' +
      ')(?![a-z])',
    'g'
  );

  const NEGATION_RE =
    /(?<![a-z])(?:not|isn'?t|wasn'?t|aren'?t|no longer|wish|instead of|rather than|unlike|would be|should be|hoping|hoped|expected|thought it was|if it were|if only|not even)(?![a-z])[^.!?]{0,20}$/;

  // "Fabric: Cotton" with no percentage given.
  const NO_PCT_RE = new RegExp(
    '(?<![a-z])(?:composition|materials?|fabrication|fabric content|fabric type|fabric|made (?:of|from)|shell|body|outer)' +
      '(?![a-z])[\\s"\':=\\-–]{0,6}((?:(?:' + QUAL + ')[™®]?\\s+){0,3}(?:' + FIBER_ALT + ')[™®]?(?![a-z])[^.;|"<>\\n{}\\[\\]]{0,40})',
    'g'
  );

  function canonicalFiber(word) {
    for (const [name, re] of FIBER_MATCHERS) if (re.test(word)) return name;
    return 'other';
  }

  /** Lowercase, decode escapes and entities so "100% Cotton" reads as "100% cotton". */
  function normalize(text) {
    return String(text || '')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\[/"]/g, (m) => m[1])
      .replace(/\\[nrt]/g, ' ')
      .replace(/&#0*37;|&#x0*25;|&percnt;/gi, '%')
      .replace(/&nbsp;|&#160;| | | /gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/<[^<>]{0,300}>/g, ' ')
      .toLowerCase();
  }

  function tokenize(text) {
    const tokens = [];
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(text))) {
      if (m[1] !== undefined) {
        const pct = parseFloat(m[1].replace(',', '.'));
        if (pct > 0 && pct <= 100) tokens.push({ kind: 'P', pct, start: m.index, end: m.index + m[0].length });
      } else {
        tokens.push({ kind: 'F', fiber: canonicalFiber(m[2]), start: m.index, end: m.index + m[0].length });
      }
    }
    return tokens;
  }

  function gapOk(text, a, b) {
    if (b - a > 40) return false;
    return GAP_RE.test(text.slice(a, b));
  }

  /** Split a run of tokens into consecutive runs separated only by connective text. */
  function runsOf(text, tokens) {
    const runs = [];
    let cur = [];
    for (const t of tokens) {
      if (cur.length && !gapOk(text, cur[cur.length - 1].end, t.start)) {
        runs.push(cur);
        cur = [];
      }
      cur.push(t);
    }
    if (cur.length) runs.push(cur);
    return runs;
  }

  function pairRun(run, forward) {
    const pairs = [];
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i];
      const b = run[i + 1];
      const p = forward ? a : b;
      const f = forward ? b : a;
      if (p.kind === 'P' && f.kind === 'F') {
        pairs.push({ pct: p.pct, fiber: f.fiber, start: a.start, end: b.end });
        i++;
      }
    }
    return pairs;
  }

  function splitGroups(pairs) {
    const groups = [];
    let cur = [];
    let sum = 0;
    const close = (complete) => {
      if (cur.length) groups.push({ pairs: cur, complete });
      cur = [];
      sum = 0;
    };
    for (const p of pairs) {
      if (sum + p.pct > 100.5) close(false);
      cur.push(p);
      sum += p.pct;
      if (Math.abs(sum - 100) <= 0.5) close(true);
    }
    close(false);
    return groups;
  }

  function scoreGroups(groups) {
    let s = 0;
    for (const g of groups) s += g.pairs.length * (g.complete ? 10 : 1);
    return s;
  }

  function finishGroup(text, g, prevEnd) {
    const fibers = {};
    for (const p of g.pairs) fibers[p.fiber] = (fibers[p.fiber] || 0) + p.pct;
    const start = g.pairs[0].start;
    const end = g.pairs[g.pairs.length - 1].end;

    // Look just before the list for a label such as "Lining:" or "Composition".
    const windowStart = Math.max(prevEnd, start - 50);
    const before = text.slice(windowStart, start);
    let role = null;
    let labeled = false;
    let labelEnd = -1;
    LABEL_RE.lastIndex = 0;
    let m;
    while ((m = LABEL_RE.exec(before))) {
      labeled = true;
      labelEnd = m.index + m[0].length;
      if (m.groups.part) role = 'part';
      else if (m.groups.main) role = 'main';
      else role = role || 'main';
    }
    // "Exact": the list comes straight after its label ("Fabric type: 100% cotton", "Heather grey: 90% cotton").
    const colon = /:\s*$/.test(before);
    const exact = colon || (labelEnd >= 0 && /^[\s"'=:\-–|>]{0,14}$/.test(before.slice(labelEnd)));
    if (colon) labeled = true;
    const negated = !exact && NEGATION_RE.test(text.slice(Math.max(0, start - 40), start));
    return {
      fibers,
      cotton: Math.round(fibers.cotton || 0),
      complete: g.complete,
      role: role || 'main',
      strong: labeled || Object.keys(fibers).length > 1,
      exact,
      negated,
      start,
      end,
    };
  }

  /** Find every composition list in a piece of text. */
  function findGroups(rawText) {
    const text = normalize(rawText);
    const tokens = tokenize(text);
    const out = [];
    let prevEnd = 0;
    for (const run of runsOf(text, tokens)) {
      if (!run.some((t) => t.kind === 'P') || !run.some((t) => t.kind === 'F')) continue;
      const fwd = splitGroups(pairRun(run, true));
      const rev = splitGroups(pairRun(run, false));
      const groups = scoreGroups(rev) > scoreGroups(fwd) ? rev : fwd;
      for (const g of groups) {
        const fg = finishGroup(text, g, prevEnd);
        prevEnd = fg.end;
        if (!fg.negated) out.push(fg);
      }
    }
    return out;
  }

  /** "Fabric: cotton" style mentions without percentages. */
  function findMentions(rawText) {
    const text = normalize(rawText);
    const out = [];
    NO_PCT_RE.lastIndex = 0;
    let m;
    while ((m = NO_PCT_RE.exec(text))) {
      const phrase = m[1];
      if (/\d\s*%/.test(phrase)) continue; // handled by the percentage parser
      const fibers = new Set(tokenize(phrase).filter((t) => t.kind === 'F').map((t) => t.fiber));
      if (!fibers.size) continue;
      const blend = /(?<![a-z])(?:blend|mix|blended)(?![a-z])/.test(phrase);
      out.push({ fibers: [...fibers], blend, phrase: phrase.trim() });
    }
    return out;
  }

  const FIBER_LABELS = { elastane: 'spandex', other: 'other fibers' };

  function describe(fibers) {
    return Object.entries(fibers)
      .sort((a, b) => b[1] - a[1])
      .map(([f, pct]) => `${Math.round(pct * 10) / 10}% ${FIBER_LABELS[f] || f}`)
      .join(', ');
  }

  function signature(g) {
    return Object.entries(g.fibers)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([f, p]) => f + ':' + p)
      .join('|');
  }

  function dedupe(groups) {
    const seen = new Map();
    for (const g of groups) {
      const key = g.role + '#' + signature(g);
      if (!seen.has(key)) seen.set(key, g);
    }
    return [...seen.values()];
  }

  /**
   * Work out what a product is made of.
   * `sources` are texts in priority order (visible page text first, then embedded data).
   *
   * Returns one of:
   *   { kind: 'pct', main: [{cotton: 60, polyester: 40}, ...], parts: [...], confidence }
   *       main = main-fabric compositions (more than one when it varies by color)
   *       parts = lining, trim, rib, etc.
   *   { kind: 'mention', fibers: ['cotton'], blend: false, phrase, confidence: 'low' }   no percentages given
   *   { kind: 'unknown', confidence: 'none' }
   */
  function analyze(sources) {
    const result = analyzeFabric(sources);
    result.origin = findOrigin(sources);
    return result;
  }

  function analyzeFabric(sources) {
    const parsed = sources.map((s) => findGroups(s));
    const tiers = [
      (g) => g.complete && g.exact,
      (g) => g.complete && g.strong,
      (g) => g.complete,
    ];
    let chosen = [];
    let confidence = 'high';
    outer: for (let t = 0; t < tiers.length; t++) {
      for (const groups of parsed) {
        const hit = groups.filter(tiers[t]);
        if (hit.length) {
          chosen = hit;
          confidence = t < 2 ? 'high' : 'medium';
          break outer;
        }
      }
    }

    if (chosen.length) {
      chosen = dedupe(chosen);
      let main = chosen.filter((g) => g.role === 'main');
      const parts = chosen.filter((g) => g.role === 'part');
      if (!main.length) main = parts.splice(0);
      return {
        kind: 'pct',
        main: main.slice(0, 4).map((g) => g.fibers),
        parts: parts.slice(0, 3).map((g) => g.fibers),
        confidence,
      };
    }

    for (const src of sources) {
      const m = findMentions(src)[0];
      if (m) return { kind: 'mention', fibers: m.fibers, blend: m.blend, phrase: m.phrase, confidence: 'low' };
    }

    return { kind: 'unknown', confidence: 'none' };
  }

  // Materials people can search for. "Natural" is the plant and animal fibers.
  const NATURAL = ['cotton', 'linen', 'wool', 'cashmere', 'silk', 'hemp', 'alpaca', 'mohair', 'angora', 'ramie', 'camel', 'yak'];
  const MATERIALS = ['cotton', 'linen', 'wool', 'cashmere', 'silk', 'hemp', 'alpaca', 'mohair', 'lyocell', 'modal', 'viscose'];

  /** Short name for a set of wanted materials: "cotton", "cotton/linen", "natural fiber". */
  function wantedName(wanted) {
    const w = [...new Set(wanted)];
    if (w.length === NATURAL.length && NATURAL.every((f) => w.includes(f))) return 'natural fiber';
    if (w.length <= 2) return w.map((f) => FIBER_LABELS[f] || f).join('/');
    return 'chosen materials';
  }

  const SYNTHETIC = ['polyester', 'nylon', 'acrylic', 'elastane', 'polyurethane', 'polypropylene', 'metallic', 'rubber'];
  const AVOIDABLE = ['polyester', 'nylon', 'acrylic', 'elastane', 'viscose'];
  const SEMI_SYNTHETIC = ['lyocell', 'modal', 'viscose', 'cupro', 'bamboo', 'acetate'];

  function fiberKind(f) {
    if (NATURAL.includes(f) || f === 'leather') return 'natural';
    if (SEMI_SYNTHETIC.includes(f)) return 'semi';
    if (SYNTHETIC.includes(f)) return 'synthetic';
    return 'other';
  }

  // Short notes shown in the fiber guide.
  const FIBER_INFO = {
    cotton: 'Natural plant fiber. Breathable, soft and absorbent; can shrink and wrinkle.',
    linen: 'Made from flax. Very breathable and cool, softens with every wash; wrinkles easily.',
    wool: 'Animal fiber. Warm even when damp, resists odor, naturally springy.',
    cashmere: 'Fine goat hair. Very soft and warm for its weight; can pill.',
    silk: 'Natural protein fiber. Smooth, light and strong; delicate to wash.',
    hemp: 'Plant fiber. Strong and breathable, softens over time; easy on the land to grow.',
    alpaca: 'Animal fiber. Warm, soft and light; usually less itchy than sheep wool.',
    mohair: 'Angora goat hair. Fluffy, lustrous and warm.',
    angora: 'Rabbit hair. Very soft and fluffy; sheds.',
    ramie: 'Plant fiber from the nettle family. Linen-like, crisp and strong.',
    camel: 'Camel hair. Soft, warm and lightweight.',
    yak: 'Yak down. Soft and warm, similar to cashmere.',
    lyocell: 'Made from wood pulp in a closed-loop process (often sold as Tencel). Smooth, breathable, drapes well.',
    modal: 'Made from beech wood pulp. Very soft and smooth; resists shrinking.',
    viscose: 'Made from wood pulp (also called rayon). Silky and breathable; weak when wet.',
    cupro: 'Made from cotton waste. Silky and breathable.',
    bamboo: 'Usually bamboo viscose. Soft and silky.',
    acetate: 'Made from wood pulp. Shiny and silky; common in linings.',
    polyester: 'Plastic-based synthetic. Durable and wrinkle-resistant, but traps heat and holds odor.',
    nylon: 'Plastic-based synthetic. Strong and stretchy; not very breathable.',
    acrylic: 'Plastic-based wool substitute. Warm and cheap; pills and holds odor.',
    elastane: 'Stretch fiber (spandex, Lycra). A few percent adds stretch and helps clothes keep their shape.',
    polyurethane: 'Plastic coating or fiber, e.g. faux leather.',
    polypropylene: 'Plastic fiber. Light and water-repellent.',
    leather: 'Animal hide.',
    rubber: 'Elastic, e.g. in waistbands.',
    metallic: 'Metal-coated fiber added for shine.',
    other: 'Fibers the store did not name.',
  };

  /**
   * Compare a product's fabric with what the shopper wants.
   * `prefs` = { fibers: ['cotton'], avoid: ['polyester'], stretch: 5 } (or just an array of fibers).
   *
   * Returns { status, pct, label, stretch, summary, details, composition, origin }
   *   status: 'pure' | 'pure-main' | 'varies' | 'blend' | 'none' | 'blocked' | 'likely' | 'unknown' | 'error'
   *   pct: best share of wanted materials (used for filtering), or null when unknown
   *   label: the matched materials ("linen/cotton"), or the avoided ones for 'blocked'
   *   stretch: % of elastane counted as allowed stretch
   */
  function score(r, prefs) {
    const pr = Array.isArray(prefs) ? { fibers: prefs } : prefs || {};
    const wanted = pr.fibers && pr.fibers.length ? pr.fibers : ['cotton'];
    const want = new Set(wanted);
    const avoid = new Set(pr.avoid || []);
    const allowStretch = pr.stretch || 0;
    const name = wantedName(wanted);
    const origin = (r && r.origin) || null;
    const nm = (f) => FIBER_LABELS[f] || f;
    if (!r || r.kind === 'error') {
      return { status: 'error', pct: null, label: name, stretch: 0, summary: "couldn't open product page", details: [], composition: null, origin };
    }

    if (r.kind === 'pct') {
      const judge = (f) => {
        const el = f.elastane || 0;
        const stretchOk = el > 0 && el <= allowStretch && !want.has('elastane');
        let share = stretchOk ? el : 0;
        for (const [k, v] of Object.entries(f)) if (want.has(k)) share += v;
        const blocked = Object.keys(f).filter((k) => avoid.has(k) && !want.has(k) && !(k === 'elastane' && stretchOk));
        return { f, share: Math.round(share), stretch: stretchOk ? el : 0, blocked };
      };
      const details = r.main.map(describe).concat(r.parts.map((f) => 'Other parts: ' + describe(f)));
      const all = r.main.map(judge);
      const ok = all.filter((j) => !j.blocked.length);
      if (!ok.length) {
        const j = all[0];
        return { status: 'blocked', pct: 0, label: j.blocked.map(nm).join(', '), stretch: 0, summary: describe(j.f), details, composition: j.f, origin };
      }
      const best = Math.max(...ok.map((j) => j.share));
      const worst = Math.min(...ok.map((j) => j.share));
      const primary = ok.find((j) => j.share === best);
      const matched = Object.entries(primary.f)
        .filter(([k]) => want.has(k))
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => nm(k));

      let status;
      if (best === 100 && worst === 100) {
        status = r.parts.map(judge).some((j) => j.share < 100 || j.blocked.length) ? 'pure-main' : 'pure';
      } else if (best === 100) status = 'varies';
      else if (best > 0) status = 'blend';
      else status = 'none';
      const label = status === 'blend' || status === 'none' ? name : matched.join('/');
      return { status, pct: best, label, stretch: primary.stretch, summary: describe(primary.f), details, composition: primary.f, origin };
    }

    if (r.kind === 'mention') {
      const hits = r.fibers.filter((f) => want.has(f));
      const blocked = r.fibers.filter((f) => avoid.has(f) && !want.has(f));
      const summary = r.fibers.map(nm).join(', ') + ' (no % listed)';
      const details = ['Listed as "' + r.phrase + '"'];
      const base = { stretch: 0, summary, details, composition: null, origin };
      if (blocked.length) return { ...base, status: 'blocked', pct: 0, label: blocked.map(nm).join(', ') };
      if (hits.length && hits.length === r.fibers.length && !r.blend) return { ...base, status: 'likely', pct: 100, label: hits.map(nm).join('/') };
      if (hits.length) return { ...base, status: 'blend', pct: null, label: name };
      return { ...base, status: 'none', pct: 0, label: name };
    }

    return { status: 'unknown', pct: null, label: name, stretch: 0, summary: 'material not found', details: [], composition: null, origin };
  }

  // ---- where it's made ----

  const COUNTRIES = {
    usa: 'USA', 'u.s.a': 'USA', 'u.s': 'USA', us: 'USA', 'united states': 'USA', 'united states of america': 'USA', america: 'USA',
    canada: 'Canada', mexico: 'Mexico', guatemala: 'Guatemala', honduras: 'Honduras', 'el salvador': 'El Salvador', nicaragua: 'Nicaragua',
    peru: 'Peru', colombia: 'Colombia', brazil: 'Brazil', bolivia: 'Bolivia',
    uk: 'UK', 'united kingdom': 'UK', england: 'England', scotland: 'Scotland', ireland: 'Ireland', wales: 'Wales',
    portugal: 'Portugal', spain: 'Spain', france: 'France', italy: 'Italy', germany: 'Germany', poland: 'Poland', lithuania: 'Lithuania',
    romania: 'Romania', bulgaria: 'Bulgaria', greece: 'Greece', turkey: 'Turkey', 'türkiye': 'Turkey', turkiye: 'Turkey',
    morocco: 'Morocco', tunisia: 'Tunisia', egypt: 'Egypt', ethiopia: 'Ethiopia', kenya: 'Kenya', madagascar: 'Madagascar', mauritius: 'Mauritius',
    jordan: 'Jordan', israel: 'Israel', india: 'India', pakistan: 'Pakistan', bangladesh: 'Bangladesh', 'sri lanka': 'Sri Lanka', nepal: 'Nepal',
    china: 'China', 'hong kong': 'Hong Kong', taiwan: 'Taiwan', mongolia: 'Mongolia', japan: 'Japan', korea: 'Korea', 'south korea': 'Korea',
    'republic of korea': 'Korea', vietnam: 'Vietnam', 'viet nam': 'Vietnam', cambodia: 'Cambodia', laos: 'Laos', myanmar: 'Myanmar',
    thailand: 'Thailand', malaysia: 'Malaysia', indonesia: 'Indonesia', philippines: 'Philippines', australia: 'Australia', 'new zealand': 'New Zealand',
  };

  function lookupCountry(words) {
    for (let n = Math.min(words.length, 4); n > 0; n--) {
      const key = words.slice(0, n).join(' ').replace(/\.+$/, '');
      if (COUNTRIES[key]) return COUNTRIES[key];
    }
    return null;
  }

  const MADE_IN_RE = /(?<![a-z])(?:made|manufactured|produced|knit|knitted|sewn|crafted|woven)\s+in\s+(?:the\s+)?([a-z][a-z.]*(?:\s+[a-z][a-z.]*){0,4})/g;
  const ORIGIN_RE = /(?:country\s*of\s*origin|countryoforigin|country_of_origin|(?<![a-z])origin\s*:)["'\s:=\-]{0,6}([a-z][a-z.]*(?:\s+[a-z][a-z.]*){0,4})/g;

  function originIn(text, patterns) {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const words = m[1].split(/\s+/);
        if (re === ORIGIN_RE && words[0] === 'imported') return 'Imported';
        const c = lookupCountry(words);
        if (!c) continue;
        if (/^[a-z. ]*?\s+or\s+imported/.test(m[1])) return c + ' or imported';
        return c;
      }
    }
    return null;
  }

  /** Where the product is made, e.g. "USA", "Portugal", "Imported", or null. */
  function findOrigin(sources) {
    const [visible = '', data = ''] = sources.map(normalize);
    // Page data can include site menus ("Made in USA" collections), so only trust labeled origin fields there.
    return originIn(visible, [MADE_IN_RE, ORIGIN_RE]) || originIn(data, [ORIGIN_RE]);
  }

  // ---- DOM helpers (browser only) ----

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'HEADER', 'NAV', 'FOOTER']);
  // Customer reviews and Q&A ("I wish this was 100% cotton") aren't the product's real fabric.
  const REVIEW_RE = /review|yotpo|bazaarvoice|okendo|jdgm|judge-?me|stamped|testimonial|ugc|customers?-?say|insight|questions|q-?and-?a/i;
  const NEVER_SKIP = new Set(['HTML', 'BODY', 'MAIN', 'ARTICLE', 'FORM']);

  function skippable(el) {
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
    const role = el.getAttribute('role');
    if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return true;
    if (el.hasAttribute('data-weft-ui')) return true;
    if (NEVER_SKIP.has(el.tagName.toUpperCase())) return false;
    const names = (el.id || '') + ' ' + (el.getAttribute('class') || '');
    // A container with the product title (h1) is the product, not a review block.
    return REVIEW_RE.test(names) && !el.querySelector('h1');
  }

  /** Visible-ish text of a document (includes collapsed accordions, skips nav/header/footer). */
  function documentText(doc) {
    const body = doc.body || doc.documentElement;
    if (!body) return '';
    // Include open shadow roots (some stores render content inside them).
    const roots = [body];
    if (doc.defaultView) {
      const ew = doc.createTreeWalker(body, 1 /* SHOW_ELEMENT */);
      let el;
      for (let i = 0; i < roots.length; i++) {
        const w = i === 0 ? ew : doc.createTreeWalker(roots[i], 1);
        while ((el = w.nextNode())) {
          if (el.shadowRoot && !el.hasAttribute('data-weft-ui') && el.tagName !== 'WEFT-BADGE') roots.push(el.shadowRoot);
        }
      }
    }
    const parts = [];
    let len = 0;
    for (const root of roots) {
      if (len >= 3e6) break;
      len += collectText(doc, root, parts);
    }
    return parts.join(' \n ');
  }

  function collectText(doc, root, parts) {
    let len = 0;
    const memo = new Map();
    const skip = (el) => {
      if (!el) return false;
      let v = memo.get(el);
      if (v === undefined) {
        v = skippable(el) || skip(el.parentElement);
        memo.set(el, v);
      }
      return v;
    };
    const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */, {
      acceptNode: (node) => (skip(node.parentElement) ? 2 /* FILTER_REJECT */ : 1),
    });
    let n;
    while ((n = walker.nextNode()) && len < 3e6) {
      const t = n.nodeValue;
      if (t && t.trim()) {
        parts.push(t);
        len += t.length;
      }
    }
    return len;
  }

  /** Text of embedded data scripts (JSON-LD, Next.js data, inline state) plus meta descriptions. */
  function dataText(doc) {
    const parts = [];
    let len = 0;
    for (const s of doc.querySelectorAll('script')) {
      const type = (s.getAttribute('type') || '').toLowerCase();
      if (s.src || /javascript|module/.test(type) && !s.textContent.includes('%')) continue;
      const t = s.textContent;
      if (!t || !/cotton|%|percent|material|composition|fabric/i.test(t)) continue;
      parts.push(t);
      len += t.length;
      if (len > 6e6) break;
    }
    for (const m of doc.querySelectorAll('meta[name="description"], meta[property="og:description"]')) {
      parts.push('\n ' + (m.getAttribute('content') || ''));
    }
    return parts.join(' \n ');
  }

  function analyzeDocument(doc) {
    return analyze([documentText(doc), dataText(doc)]);
  }

  /** Analyze a fetched product page. `isProduct` is false when the page turned out to be a category/listing. */
  function analyzeHtml(html, url) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const result = analyzeDocument(doc);
    result.isProduct = isProductDocument(doc, url);
    return result;
  }

  const PRODUCT_TYPES = new Set(['Product', 'ProductGroup', 'IndividualProduct', 'ProductModel']);

  /** Does this document describe a single product (rather than a list of them)? */
  function isProductDocument(doc, url) {
    const og = doc.querySelector('meta[property="og:type"]');
    if (og && /^(?:og:)?product(?:\.item)?$/i.test((og.getAttribute('content') || '').trim())) return true;
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const items = [].concat(data, data && data['@graph'] ? data['@graph'] : []);
        if (items.some((d) => d && [].concat(d['@type'] || []).some((t) => PRODUCT_TYPES.has(t)))) return true;
      } catch (e) {
        /* ignore malformed JSON-LD */
      }
    }
    return Boolean(url && looksLikeProductUrl(url));
  }

  const PRODUCT_PATH_RE =
    /\/(?:p|dp|ip|gp\/product|product|products|productpage|item|items|pd|prd|shop\/[a-z-]+\/p)\/|\/p\/|productpage|product\.do|[-_/]p\d{4,}|\d{5,}|\.html?$/i;

  function looksLikeProductUrl(url) {
    try {
      const u = typeof url === 'string' ? new URL(url) : url;
      return PRODUCT_PATH_RE.test(u.pathname + u.search);
    } catch (e) {
      return false;
    }
  }

  const api = {
    normalize,
    findGroups,
    findMentions,
    analyze,
    score,
    wantedName,
    findOrigin,
    fiberKind,
    NATURAL,
    MATERIALS,
    SYNTHETIC,
    AVOIDABLE,
    FIBER_INFO,
    FIBER_LABELS,
    analyzeDocument,
    analyzeHtml,
    documentText,
    dataText,
    isProductDocument,
    looksLikeProductUrl,
    describe,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WeftParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
