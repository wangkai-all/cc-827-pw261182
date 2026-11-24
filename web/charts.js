/* Dependency-free SVG charts with a shared accessible tooltip. */
(function () {
  "use strict";

  const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#6250d6", "#008300", "#e34948"];
  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function svgEl(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  let tip;
  function tooltip() {
    if (!tip) {
      tip = el("div", { class: "chart-tooltip", role: "tooltip" });
      document.body.appendChild(tip);
    }
    return tip;
  }

  function showTooltip(evt, title, rows) {
    const tt = tooltip();
    tt.replaceChildren();
    if (title) tt.appendChild(el("div", { class: "tt-title", text: title }));
    for (const r of rows || []) {
      const stroke = el("span", { class: "tt-stroke", style: `background:${r.color || "var(--blue)"}` });
      const key = el("span", { class: "tt-key" }, [stroke, document.createTextNode(r.name || "")]);
      const val = el("span", { class: "tt-value", text: r.value });
      tt.appendChild(el("div", { class: "tt-row" }, [key, val]));
    }
    tt.classList.add("show");
    const pad = 14;
    const rect = tt.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
    tt.style.left = `${Math.max(8, x)}px`;
    tt.style.top = `${Math.max(8, y)}px`;
  }
  function hideTooltip() {
    tooltip().classList.remove("show");
  }

  function fmt(v, digits = 2) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    if (Math.abs(v) >= 1000) return v.toFixed(0);
    if (Math.abs(v) >= 10) return v.toFixed(1);
    return v.toFixed(digits);
  }

  function clear(node) {
    if (typeof node === "string") node = document.querySelector(node);
    if (!node) return null;
    node.replaceChildren();
    return node;
  }

  function dimensions(container, height) {
    const width = Math.max(320, container.clientWidth || 900);
    const h = height || Math.max(280, Math.min(380, width * 0.38));
    const margin = { top: 18, right: 18, bottom: 42, left: 54 };
    return { width, height: h, margin, iw: width - margin.left - margin.right, ih: h - margin.top - margin.bottom };
  }

  function ticks(min, max, count = 5) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min || 0];
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const start = Math.ceil(min / step) * step;
    const out = [];
    for (let v = start; v <= max + step * 0.5; v += step) out.push(v);
    return out;
  }

  function lineChart(container, cfg) {
    const root = clear(container);
    if (!root) return;
    const { width, height, margin, iw, ih } = dimensions(root, cfg.height);
    const data = cfg.x || [];
    const allY = (cfg.series || []).flatMap(s => s.values || []).filter(Number.isFinite);
    let yMax = cfg.yMax ?? Math.max(0.001, ...allY);
    let yMin = cfg.yMin ?? 0;
    if (cfg.yDomain) [yMin, yMax] = cfg.yDomain;
    const xMin = cfg.xMin ?? Math.min(...data);
    const xMax = cfg.xMax ?? Math.max(...data);
    const x = v => margin.left + ((v - xMin) / Math.max(xMax - xMin, 1e-9)) * iw;
    const y = v => margin.top + ih - ((v - yMin) / Math.max(yMax - yMin, 1e-9)) * ih;

    const svg = svgEl("svg", { class: "chart-svg", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": cfg.ariaLabel || "line chart" });
    root.appendChild(svg);

    // Window / gap shading.
    if (cfg.windows) {
      for (const [a, b] of cfg.windows) {
        svg.appendChild(svgEl("rect", { x: x(a), y: margin.top, width: Math.max(1, x(b) - x(a)), height: ih, rx: 5, fill: "color-mix(in srgb, var(--blue) 5%, var(--surface))" }));
      }
    }
    if (cfg.gaps) {
      for (const g of cfg.gaps) {
        const a = g.start ?? g[0], b = g.end ?? g[1];
        svg.appendChild(svgEl("rect", { x: x(a), y: margin.top, width: Math.max(1, x(b) - x(a)), height: ih, fill: "repeating-linear-gradient(45deg, transparent, transparent 5px, color-mix(in srgb, var(--muted) 16%, transparent) 5px, color-mix(in srgb, var(--muted) 16%, transparent) 9px)" }));
      }
    }

    // Grid and axes.
    for (const tv of ticks(yMin, yMax, 5)) {
      const yy = y(tv);
      svg.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: yy, y2: yy, stroke: "var(--grid)", "stroke-width": 1 }));
      svg.appendChild(svgEl("text", { x: margin.left - 8, y: yy + 4, "text-anchor": "end", class: "heat-axis-label", text: cfg.formatY ? cfg.formatY(tv) : fmt(tv) }));
    }
    for (const tv of ticks(xMin, xMax, 7)) {
      const xx = x(tv);
      svg.appendChild(svgEl("line", { x1: xx, x2: xx, y1: margin.top, y2: margin.top + ih, stroke: "var(--grid)", "stroke-width": 1, opacity: .55 }));
      svg.appendChild(svgEl("text", { x: xx, y: height - margin.bottom + 20, "text-anchor": "middle", class: "heat-axis-label", text: cfg.formatX ? cfg.formatX(tv) : fmt(tv, 1) }));
    }
    svg.appendChild(svgEl("line", { x1: margin.left, x2: margin.left + iw, y1: margin.top + ih, y2: margin.top + ih, stroke: "var(--axis)" }));
    if (cfg.xLabel) svg.appendChild(svgEl("text", { x: margin.left + iw / 2, y: height - 6, "text-anchor": "middle", class: "heat-axis-label", text: cfg.xLabel }));

    // Split marker.
    if (cfg.splitX !== undefined && cfg.splitX >= xMin && cfg.splitX <= xMax) {
      const xx = x(cfg.splitX);
      svg.appendChild(svgEl("line", { x1: xx, x2: xx, y1: margin.top, y2: margin.top + ih, stroke: "var(--yellow)", "stroke-width": 2, "stroke-dasharray": "5 4" }));
      svg.appendChild(svgEl("text", { x: xx + 6, y: margin.top + 13, class: "heat-axis-label", fill: "var(--warning)", text: "训练 | 留出" }));
    }

    function pathFor(values, area) {
      let dLine = "";
      let dArea = "";
      let pen = false;
      const medianDx = (xMax - xMin) / Math.max(data.length - 1, 1);
      for (let i = 0; i < data.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) { pen = false; continue; }
        const jump = i > 0 && Math.abs(data[i] - data[i - 1]) > medianDx * 4;
        const cmd = (!pen || jump) ? "M" : "L";
        dLine += `${cmd}${x(data[i]).toFixed(2)},${y(v).toFixed(2)} `;
        pen = true;
      }
      if (area) dArea = `${dLine} L${x(data[data.length - 1])},${y(yMin)} L${x(data[0])},${y(yMin)} Z`;
      return { dLine, dArea };
    }

    for (const s of cfg.series || []) {
      const { dLine, dArea } = pathFor(s.values, s.area);
      if (s.area && dArea) svg.appendChild(svgEl("path", { d: dArea, fill: s.color || PALETTE[0], opacity: s.areaOpacity || .12, stroke: "none" }));
      svg.appendChild(svgEl("path", { d: dLine, fill: "none", stroke: s.color || PALETTE[0], "stroke-width": s.width || 2.2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dash || null }));
    }

    // Event rug.
    if (cfg.events) {
      for (const e of cfg.events) {
        if (e.t < xMin || e.t > xMax) continue;
        const xx = x(e.t);
        svg.appendChild(svgEl("line", { x1: xx, x2: xx, y1: margin.top + ih + 2, y2: margin.top + ih + 9, stroke: e.color || "var(--muted)", "stroke-width": 1.4, opacity: .72 }));
      }
    }

    const cross = svgEl("line", { y1: margin.top, y2: margin.top + ih, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0 });
    svg.appendChild(cross);
    const dots = (cfg.series || []).map(s => {
      const c = svgEl("circle", { r: 4.5, fill: s.color || PALETTE[0], stroke: "var(--surface)", "stroke-width": 2, opacity: 0 });
      svg.appendChild(c);
      return c;
    });
    const hit = svgEl("rect", { x: margin.left, y: margin.top, width: iw, height: ih, fill: "transparent", tabindex: 0 });
    svg.appendChild(hit);

    function onMove(evt) {
      const rect = svg.getBoundingClientRect();
      const px = ((evt.clientX - rect.left) / rect.width) * width;
      let best = 0, bd = Infinity;
      for (let i = 0; i < data.length; i++) {
        const dd = Math.abs(x(data[i]) - px);
        if (dd < bd) { bd = dd; best = i; }
      }
      const xx = x(data[best]);
      cross.setAttribute("x1", xx); cross.setAttribute("x2", xx); cross.setAttribute("opacity", .7);
      const rows = [];
      (cfg.series || []).forEach((s, i) => {
        const v = s.values[best];
        dots[i].setAttribute("cx", xx);
        dots[i].setAttribute("cy", y(v));
        dots[i].setAttribute("opacity", Number.isFinite(v) ? 1 : 0);
        rows.push({ name: s.name, value: cfg.formatY ? cfg.formatY(v) : fmt(v, 3), color: s.color || PALETTE[i] });
      });
      showTooltip(evt, cfg.formatX ? cfg.formatX(data[best]) : `t=${fmt(data[best], 2)}`, rows);
    }
    hit.addEventListener("pointermove", onMove);
    hit.addEventListener("pointerleave", () => {
      cross.setAttribute("opacity", 0);
      dots.forEach(d => d.setAttribute("opacity", 0));
      hideTooltip();
    });

    renderLegend(root, cfg.series || []);
  }

  function renderLegend(container, series) {
    if (!series.length) return;
    const legend = el("div", { class: "chart-legend" });
    series.forEach((s, i) => {
      const mark = el("span", { class: "legend-line", style: `background:${s.color || PALETTE[i % PALETTE.length]}` });
      legend.appendChild(el("span", { class: "legend-item" }, [mark, document.createTextNode(s.name)]));
    });
    container.appendChild(legend);
  }

  function scatterChart(container, cfg) {
    const root = clear(container);
    if (!root) return;
    const { width, height, margin, iw, ih } = dimensions(root, cfg.height || 340);
    const pts = cfg.points || [];
    const max = cfg.max ?? Math.max(1.2, ...pts.map(p => Math.max(p.x, p.y)));
    const x = v => margin.left + (v / max) * iw;
    const y = v => margin.top + ih - (v / max) * ih;
    const svg = svgEl("svg", { class: "chart-svg", viewBox: `0 0 ${width} ${height}`, role: "img" });
    root.appendChild(svg);
    for (const tv of ticks(0, max, 5)) {
      svg.appendChild(svgEl("line", { x1: x(0), x2: x(max), y1: y(tv), y2: y(tv), stroke: "var(--grid)" }));
      svg.appendChild(svgEl("text", { x: margin.left - 8, y: y(tv) + 4, "text-anchor": "end", class: "heat-axis-label", text: fmt(tv, 1) }));
      svg.appendChild(svgEl("text", { x: x(tv), y: height - margin.bottom + 18, "text-anchor": "middle", class: "heat-axis-label", text: fmt(tv, 1) }));
    }
    svg.appendChild(svgEl("line", { x1: x(0), x2: x(max), y1: y(0), y2: y(max), stroke: "var(--critical)", "stroke-width": 2, "stroke-dasharray": "6 4" }));
    for (const p of pts) {
      const c = svgEl("circle", { cx: x(p.x), cy: y(p.y), r: 4.2, fill: cfg.color || PALETTE[0], opacity: .72, stroke: "var(--surface)", "stroke-width": 1.5, tabindex: 0 });
      c.addEventListener("pointermove", e => showTooltip(e, `理论 Exp 分位 ${fmt(p.x, 2)}`, [{ name: "样本残差分位", value: fmt(p.y, 2), color: cfg.color || PALETTE[0] }]));
      c.addEventListener("pointerleave", hideTooltip);
      svg.appendChild(c);
    }
    if (cfg.xLabel) svg.appendChild(svgEl("text", { x: margin.left + iw / 2, y: height - 5, "text-anchor": "middle", class: "heat-axis-label", text: cfg.xLabel }));
    if (cfg.yLabel) svg.appendChild(svgEl("text", { x: 14, y: margin.top + ih / 2, transform: `rotate(-90 14 ${margin.top + ih / 2})`, "text-anchor": "middle", class: "heat-axis-label", text: cfg.yLabel }));
  }

  function barChart(container, cfg) {
    const root = clear(container);
    if (!root) return;
    const labels = cfg.labels || [];
    const series = cfg.series || [];
    const { width, height, margin, iw, ih } = dimensions(root, cfg.height || 300);
    const rawMax = Math.max(0.001, ...series.flatMap(s => (s.values || []).map(Math.abs)), Math.abs(cfg.reference || 0));
    const yMin = cfg.symmetric ? -rawMax * 1.15 : 0;
    const yMax = cfg.symmetric ? rawMax * 1.15 : (cfg.max ?? rawMax * 1.08);
    const y = v => margin.top + ih - ((v - yMin) / Math.max(yMax - yMin, 1e-9)) * ih;
    const zeroY = y(0);
    const groupW = iw / Math.max(labels.length, 1);
    const barW = Math.min(28, groupW / (series.length + 1.6));
    const svg = svgEl("svg", { class: "chart-svg", viewBox: `0 0 ${width} ${height}`, role: "img" });
    root.appendChild(svg);
    for (const tv of ticks(yMin, yMax, 5)) {
      const yy = y(tv);
      svg.appendChild(svgEl("line", { x1: margin.left, x2: margin.left + iw, y1: yy, y2: yy, stroke: "var(--grid)" }));
      svg.appendChild(svgEl("text", { x: margin.left - 8, y: yy + 4, "text-anchor": "end", class: "heat-axis-label", text: fmt(tv, cfg.digits ?? 1) }));
    }
    if (cfg.reference !== undefined) {
      for (const ref of [cfg.reference, cfg.symmetric ? -cfg.reference : null]) {
        if (ref === null) continue;
        const yy = y(ref);
        svg.appendChild(svgEl("line", { x1: margin.left, x2: margin.left + iw, y1: yy, y2: yy, stroke: "var(--critical)", "stroke-dasharray": "5 4", "stroke-width": 1.7, opacity: .8 }));
      }
    }
    labels.forEach((lab, i) => {
      const cx = margin.left + groupW * i + groupW / 2;
      series.forEach((s, si) => {
        const v = s.values[i] || 0;
        const bx = cx - (series.length * barW) / 2 + si * barW;
        const vy = y(v);
        const by = Math.min(vy, zeroY);
        const rect = svgEl("rect", { x: bx, y: by, width: barW - 2, height: Math.max(1.5, Math.abs(zeroY - vy)), rx: 4, fill: s.color || PALETTE[si] });
        rect.addEventListener("pointermove", e => showTooltip(e, cfg.tooltipTitle ? cfg.tooltipTitle(lab, i) : lab, [{ name: s.name, value: cfg.format ? cfg.format(v) : fmt(v, 3), color: s.color || PALETTE[si] }]));
        rect.addEventListener("pointerleave", hideTooltip);
        svg.appendChild(rect);
      });
      if (labels.length <= 16) svg.appendChild(svgEl("text", { x: cx, y: height - margin.bottom + 18, "text-anchor": "middle", class: "heat-axis-label", text: lab }));
    });
    svg.appendChild(svgEl("line", { x1: margin.left, x2: margin.left + iw, y1: margin.top + ih, y2: margin.top + ih, stroke: "var(--axis)" }));
    renderLegend(root, series);
  }

  function heatmap(container, matrix, labels, cfg = {}) {
    const root = clear(container);
    if (!root) return;
    const k = labels.length;
    const max = cfg.max ?? Math.max(0.001, ...matrix.flat().map(Math.abs));
    root.style.display = "grid";
    root.style.gridTemplateColumns = `92px repeat(${k}, minmax(74px, 1fr))`;
    root.style.gap = "5px";
    root.style.alignItems = "stretch";
    root.appendChild(el("div"));
    labels.forEach(l => root.appendChild(el("div", { class: "small muted", style: "text-align:center;align-self:end;font-weight:700", text: l })));
    for (let i = 0; i < k; i++) {
      root.appendChild(el("div", { class: "small", style: "display:flex;align-items:center;font-weight:700", text: `${cfg.rowPrefix || "目标"} ${labels[i]}` }));
      for (let j = 0; j < k; j++) {
        const v = matrix[i][j];
        const alpha = Math.min(1, Math.abs(v) / max);
        const bg = `color-mix(in srgb, ${cfg.color || "var(--blue)"} ${8 + alpha * 78}%, var(--surface))`;
        const cell = el("div", {
          class: "heat-cell",
          tabindex: 0,
          style: `background:${bg};color:${alpha > .55 ? "white" : "var(--ink)"}`,
        }, [
          el("span", { class: "hv", text: fmt(v, 3) }),
          el("span", { class: "hl", text: `${labels[j]} → ${labels[i]}` }),
        ]);
        const rows = [
          { name: "来源", value: labels[j], color: "var(--muted)" },
          { name: "目标", value: labels[i], color: "var(--muted)" },
          { name: cfg.valueName || "η 直接子代率", value: fmt(v, 4), color: cfg.color || PALETTE[0] },
        ];
        cell.addEventListener("pointermove", e => showTooltip(e, "触发矩阵单元", rows));
        cell.addEventListener("focus", () => {});
        cell.addEventListener("pointerleave", hideTooltip);
        root.appendChild(cell);
      }
    }
    if (cfg.caption) root.appendChild(el("div", { class: "small muted", style: `grid-column:1 / span ${k + 1}`, text: cfg.caption }));
  }

  window.Charts = { PALETTE, el, svgEl, clear, lineChart, scatterChart, barChart, heatmap, showTooltip, hideTooltip, fmt };
})();
