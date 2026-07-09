/* hermes-memory dashboard plugin — UI bundle (dependency-free IIFE).
 * React + UI primitives come from window.__HERMES_PLUGIN_SDK__ (never bundled).
 * Everything is discovered from the backend at runtime: peers, levels, edges,
 * counts, workspace. No hardcoded names or volumes. */
(function () {
  "use strict";
  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;
  var React = SDK.React;
  var H = SDK.hooks;
  var useState = H.useState, useEffect = H.useEffect, useRef = H.useRef, useMemo = H.useMemo;
  var h = React.createElement;
  var fj = SDK.fetchJSON;
  var API = "/api/plugins/hermes-memory";

  var FIXED = { explicit: "#46d6c8", deductive: "#f2b544", inductive: "#b98cff" };
  var PALETTE = ["#46d6c8", "#f2b544", "#b98cff", "#6fb2ff", "#ff8fb0", "#8ee06a", "#e0c66a", "#ff9d5c"];
  function levelColor(name, idx) { return FIXED[name] || PALETTE[idx % PALETTE.length]; }
  function fmt(n) { return (n === null || n === undefined) ? "–" : Number(n).toLocaleString(); }

  // ---------- interactive graph ----------
  var VBW = 660, VBH = 340;
  function Graph(props) {
    var peers = props.peers, edges = props.edges, filter = props.filter, onNode = props.onNode, onEdge = props.onEdge;
    var svgRef = useRef(null);
    var posRef = useRef({});
    var drag = useRef(null);
    var tick = useState(0); var setTick = tick[1];

    // (re)seed positions for any new peer on a circle
    var ids = peers.map(function (p) { return p.id; });
    var pos = posRef.current;
    var cx = VBW / 2, cy = VBH / 2, R = Math.min(VBW, VBH) * 0.34;
    ids.forEach(function (id, i) {
      if (!pos[id]) {
        var a = (i / Math.max(ids.length, 1)) * Math.PI * 2 - Math.PI / 2;
        pos[id] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
      }
    });

    var maxF = Math.max.apply(null, peers.map(function (p) { return p.observed_facts || 0; }).concat([1]));
    var maxE = Math.max.apply(null, edges.map(function (e) { return e.total || 0; }).concat([1]));
    function rad(p) { return 14 + 20 * Math.sqrt((p.observed_facts || 0) / maxF); }
    function toSvg(e) {
      var r = svgRef.current.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width * VBW, y: (e.clientY - r.top) / r.height * VBH };
    }
    function onDown(id) { return function (e) { drag.current = id; e.preventDefault(); }; }
    useEffect(function () {
      function mv(e) { if (!drag.current) return; var pt = toSvg(e); pos[drag.current] = pt; setTick(function (t) { return t + 1; }); }
      function up() { drag.current = null; }
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
      return function () { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    }, []);

    var edgeEls = edges.map(function (e, i) {
      var a = pos[e.observer], b = pos[e.observed];
      if (!a || !b) return null;
      var w = 1.3 + 5 * (e.total / maxE);
      var sel = filter && filter.observer === e.observer && filter.observed === e.observed;
      var mx, my, path;
      if (e.observer === e.observed) { // self-loop
        path = "M" + (a.x - 8) + "," + (a.y - rad({ observed_facts: 0 }) - 4) +
               " C" + (a.x - 40) + "," + (a.y - 70) + " " + (a.x + 40) + "," + (a.y - 70) + " " + (a.x + 8) + "," + (a.y - rad({ observed_facts: 0 }) - 4);
        mx = a.x; my = a.y - 60;
      } else {
        var midx = (a.x + b.x) / 2, midy = (a.y + b.y) / 2 - 18;
        path = "M" + a.x + "," + a.y + " Q" + midx + "," + midy + " " + b.x + "," + b.y;
        mx = midx; my = midy - 2;
      }
      return h("g", { key: "e" + i },
        h("path", { className: "hm-edge", d: path, strokeWidth: w, markerEnd: "url(#hm-arrow)",
          style: sel ? { opacity: 0.95 } : null, onClick: function () { onEdge(e); } }),
        h("text", { className: "hm-elabel", x: mx, y: my, textAnchor: "middle" }, fmt(e.total)));
    });

    var nodeEls = peers.map(function (p) {
      var pt = pos[p.id]; if (!pt) return null;
      var r = rad(p);
      var sel = filter && (filter.observed === p.id || filter.observer === p.id);
      return h("g", { key: p.id, className: "hm-node" + (sel ? " sel" : ""),
          transform: "translate(" + pt.x + "," + pt.y + ")",
          onPointerDown: onDown(p.id), onClick: function () { onNode(p.id); } },
        h("circle", { r: r }),
        h("text", { textAnchor: "middle", dy: 4, fontSize: Math.max(10, r * 0.42) }, p.id));
    });

    return h("svg", { ref: svgRef, viewBox: "0 0 " + VBW + " " + VBH, height: 320, role: "img" },
      h("defs", null, h("marker", { id: "hm-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
        h("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--color-primary)", opacity: 0.7 }))),
      edgeEls, nodeEls);
  }

  // ---------- drill-down: a collection exploded into its level buckets ----------
  function LevelView(props) {
    var edge = props.edge, onPick = props.onPick, active = props.active, names = props.names;
    var lv = edge.levels || {};
    var keys = Object.keys(lv);
    var cx = VBW / 2, cy = VBH / 2, R = Math.min(VBW, VBH) * 0.30;
    var maxc = Math.max.apply(null, keys.map(function (k) { return lv[k]; }).concat([1]));
    var spokes = keys.map(function (k, i) {
      var a = (i / Math.max(keys.length, 1)) * Math.PI * 2 - Math.PI / 2;
      return { k: k, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), i: i };
    });
    var edgeEls = spokes.map(function (s) {
      return h("path", { key: "l" + s.i, className: "hm-edge", d: "M" + cx + "," + cy + " L" + s.x + "," + s.y, strokeWidth: 2, style: { cursor: "default" } });
    });
    var nodeEls = spokes.map(function (s) {
      var col = levelColor(s.k, names.indexOf(s.k));
      var r = 16 + 18 * Math.sqrt(lv[s.k] / maxc);
      var sel = active === s.k;
      return h("g", { key: s.k, className: "hm-node" + (sel ? " sel" : ""), transform: "translate(" + s.x + "," + s.y + ")",
          style: { cursor: "pointer" }, onClick: function () { onPick(s.k); } },
        h("circle", { r: r, style: { stroke: col, strokeWidth: sel ? 3 : 1.5 } }),
        h("text", { textAnchor: "middle", dy: -1, fontSize: 12 }, s.k),
        h("text", { textAnchor: "middle", dy: 14, fontSize: 11, className: "hm-elabel" }, fmt(lv[s.k])));
    });
    return h("svg", { viewBox: "0 0 " + VBW + " " + VBH, height: 320, role: "img" },
      edgeEls, nodeEls,
      h("g", { transform: "translate(" + cx + "," + cy + ")" },
        h("circle", { r: 27, style: { fill: "var(--color-muted)", stroke: "var(--color-primary)", strokeWidth: 1.5 } }),
        h("text", { textAnchor: "middle", dy: -3, fontSize: 11, className: "hm-mono" }, edge.observer),
        h("text", { textAnchor: "middle", dy: 11, fontSize: 11, className: "hm-mono" }, "→ " + edge.observed)));
  }

  // ---------- drill-down: a peer exploded into the collections it's part of ----------
  function PeerFocus(props) {
    var peer = props.peer, edges = props.edges, onEdge = props.onEdge;
    var rel = edges.filter(function (e) { return e.observer === peer || e.observed === peer; });
    var cx = VBW / 2, cy = VBH / 2, R = Math.min(VBW, VBH) * 0.33;
    var maxc = Math.max.apply(null, rel.map(function (e) { return e.total; }).concat([1]));
    var spokes = rel.map(function (e, i) {
      var a = (i / Math.max(rel.length, 1)) * Math.PI * 2 - Math.PI / 2;
      var outgoing = e.observer === peer; // peer observes the other endpoint
      return { e: e, other: outgoing ? e.observed : e.observer, outgoing: outgoing,
               x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), i: i };
    });
    var edgeEls = spokes.map(function (s) {
      var w = 1.3 + 5 * (s.e.total / maxc);
      var d = s.outgoing ? ("M" + cx + "," + cy + " L" + s.x + "," + s.y) : ("M" + s.x + "," + s.y + " L" + cx + "," + cy);
      return h("path", { key: "s" + s.i, className: "hm-edge", d: d, strokeWidth: w, markerEnd: "url(#hm-arrow)",
        style: { cursor: "pointer" }, onClick: function () { onEdge(s.e); } });
    });
    var nodeEls = spokes.map(function (s) {
      var r = 15 + 15 * Math.sqrt(s.e.total / maxc);
      var isSelf = s.other === peer;
      return h("g", { key: s.i, className: "hm-node", transform: "translate(" + s.x + "," + s.y + ")",
          style: { cursor: "pointer" }, onClick: function () { onEdge(s.e); } },
        h("circle", { r: r }),
        h("text", { textAnchor: "middle", dy: -1, fontSize: 11 }, isSelf ? "self" : s.other),
        h("text", { textAnchor: "middle", dy: 13, fontSize: 10, className: "hm-elabel" }, (s.outgoing ? "→ " : "← ") + fmt(s.e.total)));
    });
    return h("svg", { viewBox: "0 0 " + VBW + " " + VBH, height: 320, role: "img" },
      h("defs", null, h("marker", { id: "hm-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
        h("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--color-primary)", opacity: 0.7 }))),
      edgeEls, nodeEls,
      h("g", { transform: "translate(" + cx + "," + cy + ")" },
        h("circle", { r: 30, style: { fill: "color-mix(in srgb, var(--color-primary) 22%, var(--color-muted))", stroke: "var(--color-primary)", strokeWidth: 2 } }),
        h("text", { textAnchor: "middle", dy: 4, fontSize: 13, className: "hm-mono" }, peer)),
      rel.length ? null : h("text", { x: cx, y: cy + 60, textAnchor: "middle", className: "hm-elabel" }, "no collections"));
  }

  // ---------- small card ----------
  function Card(title, sub, body) {
    var C = SDK.components;
    return h(C.Card, null,
      h(C.CardHeader, { style: { paddingBottom: 8 } },
        h(C.CardTitle, { style: { fontSize: 13, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--color-muted-foreground)" } },
          title, sub ? h("span", { className: "hm-muted", style: { textTransform: "none", letterSpacing: 0 } }, "  · " + sub) : null)),
      h(C.CardContent, null, body));
  }

  // ---------- app ----------
  function App() {
    var ov = useState(null), setOv = ov[1]; ov = ov[0];
    var err = useState(null), setErr = err[1]; err = err[0];
    var filter = useState({}), setFilter = filter[1]; filter = filter[0];
    var levels = useState(null), setLevels = levels[1]; levels = levels[0]; // Set of active level names
    var q = useState(""), setQ = q[1]; q = q[0];
    var facts = useState({ total: 0, items: [] }), setFacts = facts[1]; facts = facts[0];
    var msgs = useState([]), setMsgs = msgs[1]; msgs = msgs[0];
    var chatQ = useState(""), setChatQ = chatQ[1]; chatQ = chatQ[0];
    var observer = useState(""), setObserver = observer[1]; observer = observer[0];
    var target = useState(""), setTarget = target[1]; target = target[0];
    var busy = useState(false), setBusy = busy[1]; busy = busy[0];
    var drill = useState(null), setDrill = drill[1]; drill = drill[0]; // null | selected edge/collection

    // overview + live poll
    useEffect(function () {
      var live = true;
      function load() {
        fj(API + "/overview").then(function (d) {
          if (!live) return; setOv(d); setErr(null);
          setLevels(function (prev) { return prev || new Set(Object.keys(d.levels || {})); });
          setObserver(function (prev) { return prev || (d.peers[0] && d.peers[0].id) || ""; });
        }).catch(function (e) { if (live) setErr(String(e)); });
      }
      load(); var t = setInterval(load, 8000);
      return function () { live = false; clearInterval(t); };
    }, []);

    // facts on filter/search change
    var totalFacts = ov ? ov.total_facts : 0;
    useEffect(function () {
      var p = new URLSearchParams();
      if (filter.observer) p.set("observer", filter.observer);
      if (filter.observed) p.set("observed", filter.observed);
      if (q) p.set("q", q);
      p.set("limit", "150");
      fj(API + "/facts?" + p.toString()).then(setFacts).catch(function () {});
    }, [filter.observer, filter.observed, q, totalFacts]);

    function askDream() {
      if (!window.confirm("Schedule a consolidation dream now? This enqueues a dream task in Honcho.")) return;
      fj(API + "/schedule_dream", { method: "POST" }).then(function () {
        setMsgs(function (m) { return m.concat([{ role: "bot", text: "Dream scheduled." }]); });
      }).catch(function (e) { setErr(String(e)); });
    }
    function send() {
      if (!chatQ.trim() || !observer) return;
      var mine = { role: "me", text: chatQ };
      setMsgs(function (m) { return m.concat([mine]); }); setBusy(true);
      var body = { observer: observer, query: chatQ, reasoning_level: "medium" };
      if (target) body.target = target;
      setChatQ("");
      fj(API + "/chat", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })
        .then(function (r) {
          var text = (r && (r.content || r.answer || r.response)) || (typeof r === "string" ? r : JSON.stringify(r));
          setMsgs(function (m) { return m.concat([{ role: "bot", text: text }]); });
        }).catch(function (e) { setMsgs(function (m) { return m.concat([{ role: "bot", text: "error: " + e }]); }); })
        .then(function () { setBusy(false); });
    }

    if (err && !ov) return h("div", { className: "hm-wrap" }, h("div", { className: "hm-err" }, "Could not reach the memory backend: " + err));
    if (!ov) return h("div", { className: "hm-wrap hm-muted" }, "Loading memory…");

    var C = SDK.components;
    var levelNames = Object.keys(ov.levels || {});
    var qq = ov.queue || {};
    var pct = qq.total ? Math.round((qq.completed || 0) / qq.total * 100) : 0;

    // health strip
    var health = h("div", { className: "hm-health" },
      stat(ov.peers.length, "peers"),
      stat(ov.edges.length, "collections"),
      stat(fmt(ov.total_facts), "facts"),
      stat(fmt(qq.pending), "queue pending"),
      stat(fmt(qq.in_progress), "in progress"));

    // pipeline
    var pipe = h("div", null,
      h("div", { className: "hm-pipe" },
        pstage("messages", "–", "raw input", null),
        pstage("reconciler", fmt(qq.completed), "work done", "var(--color-primary)"),
        pstage("representation", fmt(qq.pending), "pending in deriver", (qq.pending ? "live" : null)),
        pstage("documents", fmt(ov.total_facts), "facts derived", "var(--color-primary)"),
        pstage("dream", ov.edges.length, "collections", null)),
      h("div", { className: "hm-row", style: { marginTop: 8, fontSize: 13 } },
        h("span", null, "Work queue ", h("b", null, fmt(qq.completed)), " / ", fmt(qq.total), " done · ",
          h("span", { style: { color: "var(--color-primary)" } }, fmt(qq.pending), " pending"), " · ", fmt(qq.in_progress), " in progress"),
        h("span", { className: "hm-spacer" }),
        h("span", { className: "hm-mono hm-muted", style: { fontSize: 11 } }, qq.sessions + " sessions · " + pct + "%")),
      h("div", { className: "hm-qbar" }, h("i", { style: { width: pct + "%" } })));

    // graph legend (toggle levels)
    var legend = h("div", { className: "hm-legend" }, levelNames.map(function (lv, i) {
      var on = levels && levels.has(lv);
      return h("span", { key: lv, style: { opacity: on ? 1 : 0.4 }, onClick: function () {
          setLevels(function (s) { var n = new Set(s); n.has(lv) ? n.delete(lv) : n.add(lv); return n; }); } },
        h("i", { className: "hm-sw", style: { background: levelColor(lv, i) } }), lv, " ", h("span", { className: "hm-mono" }, fmt(ov.levels[lv])));
    }));

    var allLevels = function () { return new Set(levelNames); };
    var activeLevel = (levels && levels.size === 1) ? Array.from(levels)[0] : null;
    var isEdge = drill && drill.kind === "edge";
    var isPeer = drill && drill.kind === "peer";
    function goTop() { setDrill(null); setLevels(allLevels()); setFilter({}); }
    function goPeer(p) { setDrill({ kind: "peer", peer: p }); setFilter({ observed: p }); setLevels(allLevels()); }
    function crumbLink(label, fn) { return h("a", { style: { cursor: "pointer", color: "var(--color-primary)", marginLeft: 6 }, onClick: fn }, label); }
    function crumbTxt(label) { return h("span", { className: "hm-muted hm-mono", style: { marginLeft: 6 } }, label); }

    var crumb = h("div", { className: "hm-row", style: { marginBottom: 6, fontSize: 12 } }, [
      h("a", { key: "top", style: { cursor: "pointer", color: drill ? "var(--color-primary)" : "var(--color-muted-foreground)" }, onClick: goTop }, "All peers"),
      isPeer ? crumbTxt("›  " + drill.peer) : null,
      (isEdge && drill.from) ? h("span", { key: "f" }, crumbTxt("›"), crumbLink(drill.from, function () { goPeer(drill.from); })) : null,
      isEdge ? crumbTxt("›  " + drill.observer + " → " + drill.observed) : null,
      (isEdge && activeLevel) ? crumbTxt("›  " + activeLevel) : null,
      drill ? crumbLink("← back", function () {
        if (isEdge && drill.from) { goPeer(drill.from); } else { goTop(); }
      }) : null,
    ]);

    var graphInner = isEdge
      ? h(LevelView, { edge: drill, names: levelNames, active: activeLevel,
          onPick: function (k) { setLevels(function (s) { return (s && s.size === 1 && s.has(k)) ? allLevels() : new Set([k]); }); } })
      : isPeer
        ? h(PeerFocus, { peer: drill.peer, edges: ov.edges,
            onEdge: function (e) { setDrill({ kind: "edge", from: drill.peer, observer: e.observer, observed: e.observed, levels: e.levels, total: e.total }); setFilter({ observer: e.observer, observed: e.observed }); setLevels(allLevels()); } })
        : h(Graph, { peers: ov.peers, edges: ov.edges, filter: filter,
            onNode: function (id) { goPeer(id); },
            onEdge: function (e) { setDrill({ kind: "edge", observer: e.observer, observed: e.observed, levels: e.levels, total: e.total }); setFilter({ observer: e.observer, observed: e.observed }); setLevels(allLevels()); } });

    var subtitle = isEdge ? "  · collection → levels" : isPeer ? "  · peer focus · its collections" : "  · observer → observed, weighted by facts";
    var hint = isEdge ? "Click a level to filter the facts below · back to zoom out"
      : isPeer ? "Click a collection to open its levels · click the peer crumb or back to zoom out"
      : "Drag nodes · click a node to explode its collections · click an edge to drill straight to levels";
    var graphCard = h(C.Card, { className: "hm-graph" },
      drill ? null : legend,
      h(C.CardHeader, { style: { paddingBottom: 6 } }, h(C.CardTitle, { style: hdr() }, "Theory-of-Mind Graph",
        h("span", { className: "hm-muted", style: sub() }, subtitle))),
      h(C.CardContent, null, crumb, graphInner,
        h("p", { className: "hm-muted", style: { fontSize: 12, margin: "4px 0 0" } }, hint)));

    // fact explorer
    var visibleFacts = facts.items.filter(function (c) { return !levels || levels.has(c.level || "explicit"); });
    var factCard = Card("Fact Explorer", fmt(facts.total) + " match" + (facts.total === 1 ? "" : "es"),
      h("div", null,
        h("div", { className: "hm-toolbar" },
          h("div", { className: "hm-search hm-mono" }, "🔎",
            h("input", { placeholder: "search facts…", value: q, onChange: function (e) { setQ(e.target.value); } })),
          levelNames.map(function (lv, i) {
            var on = levels && levels.has(lv);
            return h("button", { key: lv, className: "hm-chip" + (on ? " on" : ""),
              style: on ? { borderColor: levelColor(lv, i), boxShadow: "inset 0 0 0 1px " + levelColor(lv, i) } : null,
              onClick: function () { setLevels(function (s) { var n = new Set(s); n.has(lv) ? n.delete(lv) : n.add(lv); return n; }); } },
              lv + " · " + fmt(ov.levels[lv])); })),
        h("div", { className: "hm-facts" }, visibleFacts.length ? visibleFacts.map(function (c, i) {
          var col = levelColor(c.level || "explicit", levelNames.indexOf(c.level));
          return h("div", { className: "hm-fact", key: c.id || i },
            h("span", { className: "rel hm-mono" }, c.observer_id, h("span", { className: "hm-arrow" }, "→"), c.observed_id),
            h("span", { className: "txt" }, c.content),
            h("span", { className: "hm-badge", style: { background: "color-mix(in srgb," + col + " 16%, transparent)", color: col } }, c.level || "explicit"));
        }) : h("div", { className: "hm-muted", style: { fontSize: 13, padding: "8px 2px" } }, "No facts match."))));

    // chat
    var peerOpts = ov.peers.map(function (p) { return h("option", { key: p.id, value: p.id }, p.id); });
    var chatCard = Card("Ask the Memory", "dialectic",
      h("div", null,
        h("div", { className: "hm-chat" }, msgs.length ? msgs.map(function (m, i) {
          return h("div", { key: i, className: "hm-msg " + (m.role === "me" ? "me" : "bot") }, m.text);
        }) : h("div", { className: "hm-muted", style: { fontSize: 13 } }, "Ask a peer what it knows. e.g. “what does hermes know about how mukul works?”")),
        h("div", { className: "hm-composer" },
          h("select", { value: observer, onChange: function (e) { setObserver(e.target.value); }, title: "asked peer" }, peerOpts),
          h("select", { value: target, onChange: function (e) { setTarget(e.target.value); }, title: "about (optional)" },
            [h("option", { key: "_", value: "" }, "about… (any)")].concat(peerOpts)),
          h("input", { placeholder: "question…", value: chatQ,
            onKeyDown: function (e) { if (e.key === "Enter") send(); }, onChange: function (e) { setChatQ(e.target.value); } }),
          h("button", { className: "hm-btn", disabled: busy || !chatQ.trim(), onClick: send }, busy ? "…" : "Ask"))));

    // dream
    var dreamCard = Card("Dreams", "consolidation",
      h("div", null,
        h("div", { className: "hm-row", style: { marginBottom: 8 } },
          h("span", { className: "hm-muted", style: { fontSize: 12 } }, ov.edges.length + " collections · deriver folds facts into higher-level memory"),
          h("span", { className: "hm-spacer" }),
          h("button", { className: "hm-btn ghost", onClick: askDream }, "Schedule dream")),
        h("div", null, ov.edges.slice().sort(function (a, b) { return b.total - a.total; }).slice(0, 6).map(function (e, i) {
          return h("div", { className: "hm-tl", key: i },
            h("span", { className: "when hm-mono" }, fmt(e.total)),
            h("span", null, e.observer + " → " + e.observed + "  ",
              h("span", { className: "hm-muted", style: { fontSize: 11 } }, Object.keys(e.levels).map(function (k) { return k + ":" + e.levels[k]; }).join("  "))));
        }))));

    return h("div", { className: "hm-wrap" },
      h("div", { className: "hm-row" },
        h("div", { style: { fontSize: 18, fontWeight: 650 } }, "Agent Memory"),
        h("span", { className: "hm-mono hm-muted", style: { fontSize: 12, border: "1px solid var(--color-border)", borderRadius: 999, padding: "3px 9px" } }, "workspace: " + ov.workspace),
        err ? h("span", { className: "hm-err" }, "· " + err) : null,
        h("span", { className: "hm-spacer" }), health),
      Card("Memory Pipeline", "what the deriver is doing", pipe),
      h("div", { style: { display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16 } },
        h("div", { style: { display: "flex", flexDirection: "column", gap: 16 } }, graphCard, factCard),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 16 } }, chatCard, dreamCard)));
  }

  function hdr() { return { fontSize: 13, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--color-muted-foreground)" }; }
  function sub() { return { textTransform: "none", letterSpacing: 0 }; }
  function stat(n, l) { return h("div", { className: "hm-stat" }, h("div", { className: "n" }, n), h("div", { className: "l" }, l)); }
  function pstage(label, n, t, live) {
    var col = live === "live" ? "var(--color-primary)" : (live || "var(--color-muted-foreground)");
    return h("div", { className: "hm-stage" },
      h("div", { className: "s-l" }, label),
      h("div", { className: "s-n" }, n),
      h("div", { className: "s-t", style: { color: col } },
        live === "live" ? h("span", { className: "hm-pulse" }) : null, t));
  }

  window.__HERMES_PLUGINS__.register("hermes-memory", App);
})();
