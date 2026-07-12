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
  // cytoscape loader — vendored UMD served beside this bundle (same origin).
  var CY_URL = "/dashboard-plugins/hermes-memory/dist/cytoscape.min.js";
  (function () {
    var ss = document.getElementsByTagName("script");
    for (var i = 0; i < ss.length; i++) {
      var src = ss[i].src || "";
      if (src.indexOf("hermes-memory") >= 0 && /index\.js/.test(src)) { CY_URL = src.replace(/index\.js(\?.*)?$/, "cytoscape.min.js"); break; }
    }
  })();
  var _cyP = null;
  function loadCy() {
    if (window.cytoscape) return Promise.resolve(window.cytoscape);
    if (_cyP) return _cyP;
    _cyP = new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = CY_URL;
      s.onload = function () { res(window.cytoscape); };
      s.onerror = function () { rej(new Error("cytoscape failed to load")); };
      document.head.appendChild(s);
    });
    return _cyP;
  }

  var CY_STYLE = [
    { selector: "node", style: {
        "background-color": "data(color)", "width": "data(size)", "height": "data(size)",
        "label": "data(label)", "color": "#dbeeea", "font-size": 11, "font-weight": 600,
        "text-valign": "center", "text-halign": "center",
        "text-outline-color": "#0a0e10", "text-outline-width": 2.5,
        "border-width": 2, "border-color": "data(color)", "border-opacity": 0.35,
        "transition-property": "opacity, border-width, border-opacity", "transition-duration": "140ms" } },
    { selector: "edge", style: {
        "width": "data(w)", "line-color": "#39494c", "target-arrow-color": "#4a5f62",
        "target-arrow-shape": "triangle", "arrow-scale": 0.8, "curve-style": "bezier", "opacity": 0.5,
        "transition-property": "opacity, line-color", "transition-duration": "140ms" } },
    { selector: ".dim", style: { "opacity": 0.1 } },
    { selector: "node.hl", style: { "border-width": 4, "border-opacity": 1 } },
    { selector: "edge.hl", style: { "opacity": 0.95, "line-color": "#6fe3d6", "target-arrow-color": "#6fe3d6" } },
    { selector: "node.sel", style: { "border-color": "#ffffff", "border-width": 4, "border-opacity": 1 } },
    { selector: "node[?isFact]", style: { "width": "data(size)", "height": "data(size)", "label": "", "border-width": 1, "border-opacity": 0.6 } },
    { selector: "edge[?fact]", style: { "width": 0.7, "opacity": 0.25, "line-color": "#4a5f62", "target-arrow-shape": "none" } },
    { selector: "edge[?deriv]", style: { "width": 1.5, "line-style": "dashed", "line-color": "#b98cff", "target-arrow-color": "#b98cff", "target-arrow-shape": "triangle", "arrow-scale": 0.7, "opacity": 0.8 } },
    { selector: "node.factsel", style: { "border-color": "#ffffff", "border-width": 3, "border-opacity": 1 } }
  ];

  // ---------- interactive node graph (cytoscape, force layout) ----------
  function CyGraph(props) {
    var peers = props.peers, edges = props.edges, levelNames = props.levelNames,
        colorOf = props.levelColor, onSelect = props.onSelect, selected = props.selected;
    var boxRef = useRef(null), cyRef = useRef(null), wrapRef = useRef(null), expRef = useRef({});
    var st = useState("loading"); var setSt = st[1]; st = st[0]; // loading | ready | error
    var fdet = useState(null); var setFdet = fdet[1]; fdet = fdet[0]; // tapped fact detail

    function elements() {
      // per-peer dominant level, derived from the edges observed on that peer
      var pl = {};
      edges.forEach(function (e) { var t = pl[e.observed] || (pl[e.observed] = {}); Object.keys(e.levels || {}).forEach(function (k) { t[k] = (t[k] || 0) + e.levels[k]; }); });
      function dom(id) { var t = pl[id] || {}, best = "explicit", bv = -1; Object.keys(t).forEach(function (k) { if (t[k] > bv) { bv = t[k]; best = k; } }); return best; }
      var maxF = Math.max.apply(null, peers.map(function (p) { return p.observed_facts || 0; }).concat([1]));
      var nodes = peers.map(function (p) {
        var lvl = dom(p.id);
        return { data: { id: p.id, label: p.id, facts: p.observed_facts || 0,
          size: 22 + 52 * Math.sqrt((p.observed_facts || 0) / maxF),
          color: colorOf(lvl, levelNames.indexOf(lvl)) } };
      });
      var maxE = Math.max.apply(null, edges.map(function (e) { return e.total || 0; }).concat([1]));
      var eels = edges.filter(function (e) { return e.observer !== e.observed; }).map(function (e, i) {
        return { data: { id: "e" + i, source: e.observer, target: e.observed, total: e.total, w: 1 + 7 * (e.total / maxE) } };
      });
      return nodes.concat(eels);
    }

    // mount once
    useEffect(function () {
      var alive = true;
      loadCy().then(function (cytoscape) {
        if (!alive || !boxRef.current) return;
        var cy = cytoscape({
          container: boxRef.current, elements: elements(), style: CY_STYLE,
          layout: { name: "cose", animate: true, animationDuration: 600, padding: 36, nodeRepulsion: function () { return 9000; }, idealEdgeLength: function () { return 95; }, gravity: 0.25, numIter: 1200, fit: true },
          minZoom: 0.2, maxZoom: 4, wheelSensitivity: 0.25, boxSelectionEnabled: false
        });
        cyRef.current = cy;
        // double-click a peer to bloom its facts as child nodes; higher-order
        // facts link to their source facts (source_ids) — the derivation graph.
        function addFactNode(f, added) {
          var fid = "f:" + f.id; if (cy.getElementById(fid).nonempty()) return;
          var lv = f.level || "explicit";
          cy.add({ group: "nodes", data: { id: fid, isFact: 1, level: lv, size: lv === "explicit" ? 9 : 14,
            color: colorOf(lv, levelNames.indexOf(lv)), content: f.content, observer: f.observer_id, observed: f.observed_id } });
          added.push(fid);
        }
        function toggleExpand(pid) {
          var exp = expRef.current;
          if (exp[pid]) { cy.batch(function () { exp[pid].forEach(function (fid) { var el = cy.getElementById(fid); if (el.nonempty()) el.remove(); }); }); delete exp[pid]; return; }
          // higher-order facts first so derivation nodes actually surface
          fj(API + "/facts?observed=" + encodeURIComponent(pid) + "&order=graph&limit=120").then(function (r) {
            var items = (r && r.items) || [];
            // sources referenced by these facts but not yet on the canvas
            var need = {};
            items.forEach(function (f) { (f.source_ids || []).forEach(function (sid) { if (cy.getElementById("f:" + sid).empty()) need[sid] = 1; }); });
            var needIds = Object.keys(need);
            function finish(sources) {
              var all = items.concat(sources || []), added = [];
              cy.batch(function () {
                all.forEach(function (f) { addFactNode(f, added); });
                // peer -> its own facts
                items.forEach(function (f) { var eid = "pe:f:" + f.id; if (cy.getElementById(eid).empty()) cy.add({ group: "edges", data: { id: eid, source: pid, target: "f:" + f.id, fact: 1 } }); });
                // derivation edges across everything now present
                all.forEach(function (f) {
                  (f.source_ids || []).forEach(function (sid) {
                    if (cy.getElementById("f:" + sid).nonempty()) { var eid = "de:" + f.id + ":" + sid; if (cy.getElementById(eid).empty()) cy.add({ group: "edges", data: { id: eid, source: "f:" + f.id, target: "f:" + sid, deriv: 1 } }); }
                  });
                });
              });
              exp[pid] = added;
              cy.layout({ name: "cose", animate: true, animationDuration: 500, fit: false, padding: 36 }).run();
            }
            if (needIds.length) { fj(API + "/facts?ids=" + encodeURIComponent(needIds.join(","))).then(function (rr) { finish((rr && rr.items) || []); }).catch(function () { finish([]); }); }
            else { finish([]); }
          }).catch(function () {});
        }
        cy.on("mouseover", "node", function (ev) { var nb = ev.target.closedNeighborhood(); cy.elements().addClass("dim"); nb.removeClass("dim"); nb.addClass("hl"); });
        cy.on("mouseout", "node", function () { cy.elements().removeClass("dim hl"); });
        var lastTap = { id: null, t: 0 };
        cy.on("tap", "node", function (ev) {
          var n = ev.target, id = n.id();
          if (n.data("isFact")) { setFdet({ content: n.data("content"), level: n.data("level"), observer: n.data("observer"), observed: n.data("observed") }); cy.nodes().removeClass("factsel"); n.addClass("factsel"); return; }
          var now = (window.Date && Date.now()) || 0;
          if (lastTap.id === id && now - lastTap.t < 320) { lastTap = { id: null, t: 0 }; toggleExpand(id); return; }
          lastTap = { id: id, t: now };
          onSelect && onSelect(id);
        });
        cy.on("tap", function (ev) { if (ev.target === cy) { onSelect && onSelect(null); setFdet(null); cy.nodes().removeClass("factsel"); } });
        if (alive) setSt("ready");
      }).catch(function () { if (alive) setSt("error"); });
      function onFs() { var cy = cyRef.current; if (cy) window.setTimeout(function () { cy.resize(); cy.fit(undefined, 40); }, 120); }
      document.addEventListener("fullscreenchange", onFs);
      return function () { alive = false; document.removeEventListener("fullscreenchange", onFs); if (cyRef.current) { cyRef.current.destroy(); cyRef.current = null; } };
    }, []);

    // rebuild only when the graph's shape changes — NOT on every 8s overview poll
    useEffect(function () {
      var cy = cyRef.current; if (!cy) return;
      cy.batch(function () { cy.elements().remove(); cy.add(elements()); });
      cy.layout({ name: "cose", animate: false, padding: 36, numIter: 800, fit: true }).run();
    }, [peers.length, edges.length]);

    // reflect selection coming from elsewhere (e.g. fact explorer)
    useEffect(function () {
      var cy = cyRef.current; if (!cy) return;
      cy.nodes().removeClass("sel");
      if (selected && cy.getElementById(selected).nonempty()) cy.getElementById(selected).addClass("sel");
    }, [selected]);

    function zoomBy(f) { var cy = cyRef.current; if (cy) cy.zoom({ level: cy.zoom() * f, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); }
    function toggleFull() { var el = wrapRef.current; if (!el) return; if (document.fullscreenElement) { document.exitFullscreen && document.exitFullscreen(); } else if (el.requestFullscreen) { el.requestFullscreen(); } else if (el.webkitRequestFullscreen) { el.webkitRequestFullscreen(); } }
    return h("div", { className: "hm-cy-wrap", ref: wrapRef },
      h("div", { ref: boxRef, className: "hm-cy" }),
      h("div", { className: "hm-cy-ctrl" },
        h("button", { title: "zoom in", onClick: function () { zoomBy(1.3); } }, "+"),
        h("button", { title: "zoom out", onClick: function () { zoomBy(1 / 1.3); } }, "−"),
        h("button", { title: "fit to view", onClick: function () { var cy = cyRef.current; if (cy) cy.fit(undefined, 40); } }, "fit"),
        h("button", { title: "re-layout", onClick: function () { var cy = cyRef.current; if (cy) cy.layout({ name: "cose", animate: true, animationDuration: 500, fit: true, padding: 36 }).run(); } }, "↻"),
        h("button", { title: "fullscreen", onClick: toggleFull }, "⛶")),
      fdet ? h("div", { className: "hm-cy-detail" },
        h("button", { className: "hm-cy-detail-x", title: "close", onClick: function () { setFdet(null); if (cyRef.current) cyRef.current.nodes().removeClass("factsel"); } }, "×"),
        h("div", { className: "hm-mono", style: { fontSize: 10, opacity: 0.7, marginBottom: 4 } }, fdet.observer + " → " + fdet.observed + " · " + fdet.level),
        h("div", { style: { fontSize: 13, lineHeight: 1.45 } }, fdet.content)) : null,
      st !== "ready" ? h("div", { className: "hm-cy-load hm-muted" }, st === "error" ? "graph engine failed to load" : "building graph…") : null);
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

  // ---------- drill-down: a level exploded into its individual facts as leaf nodes ----------
  function FactsView(props) {
    var facts = props.facts, level = props.level, onPick = props.onPick, sel = props.selected, color = props.color;
    var CAP = 44;
    var shown = facts.slice(0, CAP);
    var cx = VBW / 2, cy = VBH / 2, R = Math.min(VBW, VBH) * 0.36;
    function place(i) {
      var a = (i / Math.max(shown.length, 1)) * Math.PI * 2 - Math.PI / 2;
      var rr = R * (i % 2 ? 1 : 0.82);
      return { x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) };
    }
    var lines = shown.map(function (f, i) { var p = place(i);
      return h("path", { key: "fl" + i, className: "hm-edge", d: "M" + cx + "," + cy + " L" + p.x + "," + p.y, strokeWidth: 1, style: { opacity: 0.22, cursor: "default" } }); });
    var nodes = shown.map(function (f, i) { var p = place(i);
      var isSel = sel && sel.id === f.id;
      return h("g", { key: f.id || i, className: "hm-node" + (isSel ? " sel" : ""), transform: "translate(" + p.x + "," + p.y + ")",
          style: { cursor: "pointer" }, onClick: function () { onPick(f); } },
        h("circle", { r: isSel ? 9 : 6, style: { fill: color, stroke: color, strokeWidth: isSel ? 2 : 1 } }),
        h("title", null, f.content)); });
    return h("svg", { viewBox: "0 0 " + VBW + " " + VBH, height: 320, role: "img" },
      lines, nodes,
      h("g", { transform: "translate(" + cx + "," + cy + ")" },
        h("circle", { r: 26, style: { fill: "var(--color-muted)", stroke: color, strokeWidth: 2 } }),
        h("text", { textAnchor: "middle", dy: -2, fontSize: 12 }, level),
        h("text", { textAnchor: "middle", dy: 13, fontSize: 11, className: "hm-elabel" }, fmt(facts.length))),
      facts.length > CAP ? h("text", { x: cx, y: VBH - 8, textAnchor: "middle", className: "hm-elabel" }, "showing " + CAP + " of " + facts.length + " · full list in Fact Explorer") : null);
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
    var drill = useState(null), setDrill = drill[1]; drill = drill[0]; // null | {kind:peer|edge|level, ...}
    var fd = useState(null), setFd = fd[1]; fd = fd[0]; // selected fact detail

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
    var isEdge = drill && drill.kind === "edge";
    var isPeer = drill && drill.kind === "peer";
    var isLevel = drill && drill.kind === "level";
    function goTop() { setDrill(null); setLevels(allLevels()); setFilter({}); setFd(null); }
    function goPeer(p) { setDrill({ kind: "peer", peer: p }); setFilter({ observed: p }); setLevels(allLevels()); setFd(null); }
    function goEdge(d) { setDrill({ kind: "edge", from: d.from, observer: d.observer, observed: d.observed, levels: d.levels, total: d.total }); setFilter({ observer: d.observer, observed: d.observed }); setLevels(allLevels()); setFd(null); }
    function goLevel(d, k) { setDrill({ kind: "level", from: d.from, observer: d.observer, observed: d.observed, levels: d.levels, level: k }); setFilter({ observer: d.observer, observed: d.observed }); setLevels(new Set([k])); setFd(null); }
    function crumbLink(key, label, fn) { return h("a", { key: key, style: { cursor: "pointer", color: "var(--color-primary)", marginLeft: 6 }, onClick: fn }, label); }
    function crumbTxt(key, label) { return h("span", { key: key, className: "hm-muted hm-mono", style: { marginLeft: 6 } }, label); }

    var crumb = h("div", { className: "hm-row", style: { marginBottom: 6, fontSize: 12 } }, [
      h("a", { key: "top", style: { cursor: "pointer", color: drill ? "var(--color-primary)" : "var(--color-muted-foreground)" }, onClick: goTop }, "All peers"),
      isPeer ? crumbTxt("p", "›  " + drill.peer) : null,
      ((isEdge || isLevel) && drill.from) ? crumbLink("from", "›  " + drill.from, function () { goPeer(drill.from); }) : null,
      (isEdge || isLevel) ? crumbLink("col", "›  " + drill.observer + " → " + drill.observed, function () { goEdge(drill); }) : null,
      isLevel ? crumbTxt("lv", "›  " + drill.level) : null,
      (isLevel && fd) ? crumbTxt("fx", "›  fact") : null,
      drill ? crumbLink("back", "← back", function () {
        if (isLevel) { goEdge(drill); } else if (isEdge && drill.from) { goPeer(drill.from); } else { goTop(); }
      }) : null,
    ]);

    var graphInner = h(CyGraph, { peers: ov.peers, edges: ov.edges, levelNames: levelNames, levelColor: levelColor,
      selected: filter.observed || filter.observer || null,
      onSelect: function (id) { setFd(null); setFilter(id ? { observed: id } : {}); } });

    var subtitle = isLevel ? "  · facts in this level" : isEdge ? "  · collection → levels" : isPeer ? "  · peer focus · its collections" : "  · observer → observed, weighted by facts";
    var hint = isLevel ? "Click a fact node to read it · back for the level buckets"
      : isEdge ? "Click a level to explode it into its facts · back to zoom out"
      : isPeer ? "Click a collection to open its levels · crumb or back to zoom out"
      : "Scroll to zoom · drag to pan · hover to focus a neighborhood · click a node to filter facts · double-click a peer to bloom its facts (purple = derivation) · ⛶ fullscreen";
    var detail = (isLevel && fd) ? h("div", { style: { marginTop: 10, padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: 10, background: "var(--color-muted)" } },
      h("div", { className: "hm-mono", style: { fontSize: 11, color: "var(--color-muted-foreground)", marginBottom: 4 } },
        fd.observer_id + " → " + fd.observed_id + " · " + (fd.level || "explicit") + (fd.created_at ? " · " + String(fd.created_at).slice(0, 10) : "")),
      h("div", { style: { fontSize: 13, lineHeight: 1.5 } }, fd.content),
      fd.session_id ? h("div", { className: "hm-mono", style: { fontSize: 10, color: "var(--color-muted-foreground)", marginTop: 6 } }, "session " + fd.session_id) : null) : null;
    var graphCard = h(C.Card, { className: "hm-graph" },
      drill ? null : legend,
      h(C.CardHeader, { style: { paddingBottom: 6 } }, h(C.CardTitle, { style: hdr() }, "Theory-of-Mind Graph",
        h("span", { className: "hm-muted", style: sub() }, subtitle))),
      h(C.CardContent, null, crumb, graphInner,
        h("p", { className: "hm-muted", style: { fontSize: 12, margin: "4px 0 0" } }, hint), detail));

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
