/* EchoSeq frontend: no build step, no external requests. */
(function () {
  "use strict";
  const C = window.Charts;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const state = {
    dataset: null,
    result: null,
    options: null,
    selected: new Set(),
    colors: {},
    versions: loadVersions(),
    compare: new Set(),
    inspectionIndex: null,
    inspection: null,
    selfTest: [],
  };
  let analysisRunId = 0;

  const SCENARIO_META = [
    { id: "background_only", title: "独立背景", tag: "误归因反例", tone: "good", text: "无触发泊松过程。估计 η 应接近 0；若出现高 ρ，说明拟合/选择或样本量有问题。" },
    { id: "self_excitation", title: "自激正例", tag: "参数恢复", tone: "", text: "稳定对角自激加少量互激。检查 μ、η、β 和 ρ 是否接近合成真值。" },
    { id: "background_shift", title: "背景突变", tag: "误归因反例", tone: "warning", text: "第 60 单位背景率阶跃且几乎无触发。常数背景会把阶跃解释成高 η/长记忆。" },
    { id: "cross_trigger", title: "跨类别触发", tag: "多类别", tone: "", text: "一类事件领先另一类。矩阵可显示预测链接，但不能证明因果。" },
    { id: "observation_gaps", title: "中间停采", tag: "窗口/缺口", tone: "warning", text: "只保留多个活跃窗口内事件；缺口内事件未记录，但仍可能触发窗口内事件。" },
    { id: "rounded_batches", title: "成批舍入", tag: "分辨率限制", tone: "critical", text: "时间戳按 1 单位舍入并产生并列。快速 β 与同戳父子顺序不可识别。" },
  ];

  function loadVersions() {
    try { return JSON.parse(localStorage.getItem("echoseq.versions.v1") || "[]"); }
    catch { return []; }
  }
  function saveVersionsStorage() {
    localStorage.setItem("echoseq.versions.v1", JSON.stringify(state.versions));
  }

  function toast(message, type = "") {
    const node = C.el("div", { class: `toast ${type}`, text: message });
    $("#toastRegion").appendChild(node);
    setTimeout(() => { node.style.opacity = "0"; node.style.transition = "opacity .25s"; }, 3200);
    setTimeout(() => node.remove(), 3600);
  }

  function setLoading(show, title, sub) {
    $("#loadingOverlay").classList.toggle("show", show);
    if (title) $("#loadingTitle").textContent = title;
    if (sub) $("#loadingSub").textContent = sub;
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error || `请求失败 ${res.status}`);
    return json;
  }

  function fmt(v, d = 3) { return C.fmt(v, d); }
  function windowRange(w) {
    if (Array.isArray(w)) return { start: w[0], end: w[1] };
    return { start: w.start ?? w[0], end: w.end ?? w[1] };
  }
  function windowsToText(wins) {
    return JSON.stringify((wins || []).map(windowRange), null, 2);
  }
  function pct(v, d = 1) { return v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(d)}%`; }
  function pval(v) {
    if (v === null || v === undefined) return "—";
    if (v < 0.001) return "<0.001";
    return v.toFixed(3);
  }
  function colorFor(cat, allCats) {
    const cats = allCats || (state.dataset?.categories || []);
    let idx = cats.indexOf(cat);
    if (idx < 0) idx = Object.keys(state.colors).length;
    if (!state.colors[cat]) state.colors[cat] = C.PALETTE[idx % C.PALETTE.length];
    return state.colors[cat];
  }

  function switchTab(name) {
    $$(".tab").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    $$(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === name));
    if (name === "timeline") renderIntensity();
    if (name === "matrix") renderMatrix();
    if (name === "diagnostics") renderDiagnosticsCharts();
    if (name === "versions") renderVersionCompare();
  }

  function bindTabs() {
    $$(".tab").forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
  }

  function currentOptions() {
    return {
      selectedCategories: Array.from(state.selected),
      trainFrac: parseFloat($("#trainFrac").value),
      backgroundComplexity: $("#bgComplexity").value === "auto" ? "auto" : parseInt($("#bgComplexity").value, 10),
      kernelComplexity: $("#kernelComplexity").value,
      kernelShape: $("#kernelShape").value,
      boundary: $("#boundaryMode").value,
      gapCorrection: $("#gapCorrection").checked,
      enforceStable: $("#enforceStable").checked,
      includeForecast: true,
      forecastPaths: 140,
      maxIter: 180,
    };
  }

  async function loadScenario(scenario, autoRun = true) {
    setLoading(true, "生成合成数据…", "内置标准库仿真器正在生成事件序列");
    try {
      const seed = parseInt($("#seedInput").value || "11", 10);
      const json = await api("/api/synthetic", { scenario, seed });
      state.dataset = json.dataset;
      state.colors = {};
      state.selected = new Set(state.dataset.categories);
      $("#windowsInput").value = windowsToText(state.dataset.windows);
      renderCategories();
      if (autoRun) await runAnalysis();
      else toast("示例已载入", "good");
    } finally { setLoading(false); }
  }

  function renderCategories() {
    const host = $("#categoryList");
    host.replaceChildren();
    if (!state.dataset) {
      host.appendChild(C.el("span", { class: "muted small", text: "尚未载入数据。" }));
      return;
    }
    const counts = {};
    for (const e of state.dataset.events) counts[e.category] = (counts[e.category] || 0) + 1;
    for (const cat of state.dataset.categories) {
      const cb = C.el("input", { type: "checkbox", checked: state.selected.has(cat), "aria-label": `选择类别 ${cat}` });
      cb.addEventListener("change", () => {
        if (cb.checked) state.selected.add(cat); else state.selected.delete(cat);
        if (state.result) runAnalysis().catch(showError);
      });
      const pill = C.el("label", { class: "category-pill" }, [
        cb,
        C.el("span", { class: "swatch", style: `background:${colorFor(cat)}` }),
        C.el("span", { text: cat }),
        C.el("span", { class: "count", text: counts[cat] || 0 }),
      ]);
      host.appendChild(pill);
    }
  }

  async function runAnalysis() {
    if (!state.dataset) { toast("请先生成或导入数据", "error"); return; }
    if (state.selected.size === 0) { toast("至少选择一个类别", "error"); return; }
    const requestOptions = currentOptions();
    const runId = ++analysisRunId;
    setLoading(true, "正在真实拟合…", "候选 MLE、窗口补偿器、残差与预测模拟可能需要数秒");
    $("#runBtn").disabled = true;
    try {
      const json = await api("/api/analyze", { dataset: state.dataset, options: requestOptions });
      if (runId !== analysisRunId) return;
      // Commit the option snapshot only after success.  If refitting a changed
      // category selection fails, event inspection must keep using the previous
      // result's matching state.options rather than mismatching fit/categories.
      state.options = requestOptions;
      state.result = json;
      state.inspection = null;
      state.inspectionIndex = null;
      renderAll();
      toast("拟合与留出检验完成", "good");
    } catch (e) {
      if (runId === analysisRunId) showError(e);
    } finally {
      if (runId === analysisRunId) {
        $("#runBtn").disabled = false;
        setLoading(false);
      }
    }
  }

  function showError(e) {
    console.error(e);
    toast(e.message || String(e), "error");
    $("#alertRegion").appendChild(C.el("div", { class: "alert critical" }, [
      C.el("div", { class: "title", text: "分析失败" }),
      document.createTextNode(e.message || String(e)),
    ]));
  }

  function renderAll() {
    $("#emptyState").classList.add("hidden");
    $("#overviewContent").classList.remove("hidden");
    renderKpis();
    renderAlerts();
    renderDataKv();
    renderCandidates();
    renderEventSelect();
    renderEventInspectorPlaceholder();
    renderMatrix();
    renderBetaTable();
    renderDiagnostics();
    renderIntensity();
    renderTruth();
    renderVersionList();
  }

  function renderKpis() {
    const r = state.result, d = r.dataset, f = r.fit, h = r.holdout;
    const ksP = h.residual_tests?.ks?.p_value;
    const chiP = h.counts?.p_value;
    const kpis = [
      { label: "事件数 / 类别", value: `${d.n_events}`, sub: `${d.categories.length} 类 · ${d.n_windows} 个窗口`, tone: "" },
      { label: "活跃时间覆盖", value: pct(d.coverage, 0), sub: `缺口 ${fmt(d.gap_duration, 1)} ${d.time_unit || ""}`, tone: d.coverage < .75 ? "warning" : "good" },
      { label: "稳定性 ρ(η)", value: fmt(f.rho, 3), sub: f.rho < .8 ? "稳定裕度充足" : f.rho < 1 ? "接近临界，长期预测需谨慎" : "超临界：拒绝推演", tone: f.rho >= 1 ? "critical" : f.rho >= .8 ? "warning" : "good" },
      { label: "留出残差 KS p", value: pval(ksP), sub: `均值 ${fmt(h.residual_tests.mean, 2)}（期望 1）· n=${h.residual_tests.n || 0}`, tone: ksP !== undefined && ksP < .05 ? "warning" : "good" },
      { label: "计数检验 p", value: pval(chiP), sub: `留出 ${h.events} 事件 · 每事件 ll ${fmt(h.loglik_per_event, 2)}`, tone: chiP < .01 ? "critical" : chiP < .05 ? "warning" : "good" },
    ];
    $("#kpiGrid").replaceChildren(...kpis.map(k => C.el("div", { class: `kpi ${k.tone}` }, [
      C.el("div", { class: "label", text: k.label }),
      C.el("div", { class: "value", text: k.value }),
      C.el("div", { class: "sub", text: k.sub }),
    ])));

    const dk = [
      { label: "残差均值", value: fmt(h.residual_tests.mean, 3) },
      { label: "KS p", value: pval(ksP) },
      { label: "Ljung-Box p", value: pval(h.residual_tests.ljung_box?.p_value) },
      { label: "计数 χ² p", value: pval(chiP) },
      { label: "ρ(η)", value: fmt(f.rho, 3) },
    ];
    $("#diagKpis").replaceChildren(...dk.map(k => C.el("div", { class: "kpi" }, [
      C.el("div", { class: "label", text: k.label }),
      C.el("div", { class: "value", style: "font-size:23px", text: k.value }),
    ])));
  }

  function alertNode(level, title, text) {
    return C.el("div", { class: `alert ${level}` }, [C.el("div", { class: "title", text: title }), document.createTextNode(text)]);
  }

  function renderAlerts() {
    const r = state.result;
    const host = $("#alertRegion");
    host.replaceChildren();
    host.appendChild(alertNode("info", "解释边界", r.disclaimer));
    const ra = r.resolution_assessment;
    host.appendChild(alertNode(ra.level === "ok" ? "good" : ra.level, ra.title, `${ra.detail} ${ra.recommendation}`));
    const bd = r.boundary_diagnostics;
    host.appendChild(alertNode("info", "起始历史与停采", `${bd.left_boundary}；${bd.gap_rule}。左边界记忆窗内 ${bd.left_edge_events} 事件，缺口后记忆窗内 ${bd.post_gap_edge_events} 事件。${bd.warning}`));
    if (r.fit.rho >= .8) host.appendChild(alertNode(r.fit.rho >= 1 ? "critical" : "warning", "聚集还是基线/突变？", `分支谱半径 ${fmt(r.fit.rho, 3)}。高 ρ 可能来自真实自激，也可能来自未建模的背景变化或窗口边界；请对照分段背景、留出计数与合成反例。`));
    const rt = r.holdout.residual_tests;
    if (rt.available && (rt.ks?.p_value < .05 || rt.ljung_box?.p_value < .05)) {
      host.appendChild(alertNode("warning", "留出残差检验提示失配", `KS p=${pval(rt.ks?.p_value)}，Ljung-Box p=${pval(rt.ljung_box?.p_value)}。训练 AIC 优并不保证留出时间结构正确。`));
    }
  }

  function renderDataKv() {
    const d = state.result.dataset;
    $("#windowSourceTag").textContent = d.window_source === "imported" ? "已导入窗口" : "窗口由事件跨度推断";
    const rows = [
      ["名称", d.name || "未命名"], ["类别", d.categories.join("、")],
      ["事件数", d.n_events], ["有效窗口", `${d.n_windows} 个 / ${fmt(d.active_duration, 1)} ${d.time_unit || ""}`],
      ["日历跨度", `${fmt(d.calendar_span, 1)}；覆盖率 ${pct(d.coverage, 1)}`],
      ["缺口", `${d.gaps.length} 个 / ${fmt(d.gap_duration, 1)} ${d.time_unit || ""}`],
      ["检测分辨率", d.resolution ? fmt(d.resolution, 4) : "未检出"],
      ["并列额外事件", `${d.rounding.tied_events}（${pct(d.rounding.tie_rate, 1)}）；最大同戳批次 ${d.rounding.max_batch}`],
      ["时间原点", d.time_origin || "数值时间"],
    ];
    const dl = $("#dataKv");
    dl.replaceChildren();
    rows.forEach(([k, v]) => {
      dl.appendChild(C.el("dt", { text: k }));
      dl.appendChild(C.el("dd", { text: String(v) }));
    });
  }

  function renderCandidates() {
    const tb = $("#candidateTable tbody");
    tb.replaceChildren();
    state.result.candidates.forEach(c => {
      const tr = C.el("tr", { class: c.is_selected ? "selected" : "" });
      const familyLabel = c.model_family === "poisson" ? "Poisson" : c.model_family === "hawkes_gamma2" ? "Hawkes Γ2" : "Hawkes exp";
      tr.appendChild(C.el("td", { text: c.is_selected ? `★ ${familyLabel}` : familyLabel }));
      tr.appendChild(C.el("td", { text: c.bg_bins }));
      tr.appendChild(C.el("td", { text: c.model_family === "poisson" ? "—" : `${c.beta_mode} · ${c.kernel_shape === "gamma2" ? "Gamma(2)" : "指数"}` }));
      tr.appendChild(C.el("td", { text: c.n_params }));
      tr.appendChild(C.el("td", { text: fmt(c.loglik, 2) }));
      tr.appendChild(C.el("td", { text: fmt(c.aic, 2) }));
      tr.appendChild(C.el("td", { text: fmt(c.bic, 2) }));
      tr.appendChild(C.el("td", { text: fmt(c.rho, 3) }));
      tr.appendChild(C.el("td", { text: c.stable ? "稳定" : "拒绝预测" }));
      tb.appendChild(tr);
    });
    $("#candidateErrors").textContent = state.result.candidate_errors?.length ? `部分候选失败但不影响选中模型：${state.result.candidate_errors.join(" | ")}` : "";
  }

  function renderIntensity() {
    if (!state.result) return;
    const r = state.result;
    const t = r.trace.t;
    const bgTotal = t.map((_, i) => r.trace.background.reduce((s, row) => s + row[i], 0));
    const trTotal = t.map((_, i) => r.trace.triggered.reduce((s, row) => s + row[i], 0));
    const series = [];
    if ($("#showTotalLine").checked) series.push({ name: "总强度 Σλ", values: r.trace.total, color: "var(--ink)", width: 2.6 });
    if ($("#showBgLines").checked) series.push({ name: "背景合计 Σμ", values: bgTotal, color: "var(--aqua)", width: 2, area: true });
    if ($("#showTrigLines").checked) series.push({ name: "触发合计", values: trTotal, color: "var(--orange)", width: 2, area: true });
    const allT = r.dataset.windows.flat();
    C.lineChart($("#intensityChart"), {
      x: t,
      series,
      windows: r.dataset.windows,
      gaps: r.dataset.gaps,
      splitX: r.split,
      xMin: Math.min(...allT), xMax: Math.max(...allT),
      xLabel: `时间（${r.dataset.time_unit || "单位"}）`,
      formatX: v => fmt(v, 0),
      formatY: v => fmt(v, 2),
      events: r.events.map(e => ({ t: e.t, color: colorFor(e.category, r.dataset.categories) })),
      ariaLabel: "条件强度时间线",
      height: 390,
    });
  }

  function renderEventSelect() {
    const sel = $("#eventSelect");
    sel.replaceChildren();
    const evs = state.result.events;
    for (const e of evs) {
      sel.appendChild(C.el("option", { value: String(e.index), text: `#${e.index} · t=${fmt(e.t, 2)} · ${e.category}` }));
    }
    const choosePosition = pos => {
      if (!sel.options.length) return;
      const actual = Math.max(0, Math.min(sel.options.length - 1, pos));
      sel.selectedIndex = actual;
      inspectEvent(parseInt(sel.value, 10));
    };
    sel.onchange = () => inspectEvent(parseInt(sel.value, 10));
    $("#prevEventBtn").onclick = () => choosePosition(sel.selectedIndex > 0 ? sel.selectedIndex - 1 : 0);
    $("#nextEventBtn").onclick = () => choosePosition(sel.selectedIndex + 1);
    $("#surpriseEventBtn").onclick = () => {
      const rows = state.result.holdout.residual_rows.filter(r => r.residual !== null && r.residual !== undefined);
      if (!rows.length) return toast("没有完整留出间隔", "error");
      const target = rows.reduce((a, b) => Math.abs((b.residual || 0) - 1) > Math.abs((a.residual || 0) - 1) ? b : a);
      const match = evs.reduce((best, e) => Math.abs(e.t - target.t) < Math.abs((best?.t ?? Infinity) - target.t) ? e : best, null);
      if (match) {
        const pos = Array.from(sel.options).findIndex(o => parseInt(o.value, 10) === match.index);
        if (pos >= 0) choosePosition(pos);
        switchTab("inspector");
      }
    };
    choosePosition(5);
  }

  function renderEventInspectorPlaceholder() {
    $("#eventInspector").replaceChildren(C.el("p", { class: "muted", text: "正在计算事件归因…" }));
  }

  async function inspectEvent(index) {
    if (!state.result || !state.dataset) return;
    state.inspectionIndex = index;
    try {
      const json = await api("/api/event", {
        dataset: state.dataset,
        fit: state.result.fit,
        eventIndex: index,
        selectedCategories: state.options?.selectedCategories,
      });
      state.inspection = json.event;
      renderEventInspector();
    } catch (e) { toast(e.message, "error"); }
  }

  function renderEventInspector() {
    const x = state.inspection;
    const host = $("#eventInspector");
    if (!x) return;
    host.replaceChildren();
    const catColor = colorFor(x.category);
    const split = C.el("div", { class: "split-bar", role: "img", "aria-label": "背景与触发强度占比" }, [
      C.el("div", { style: `width:${x.background_share * 100}%;background:var(--aqua)`, title: "背景/基线" }),
      C.el("div", { style: `width:${x.trigger_share * 100}%;background:var(--orange)`, title: "历史事件触发" }),
    ]);
    const kvItems = [
      ["事件", `#${x.event_index} · t=${fmt(x.t, 3)} · ${x.category}`],
      ["事件时 λ", fmt(x.lambda, 5)],
      ["背景 μ 分量", `${fmt(x.background, 5)}（${pct(x.background_share)}）`],
      ["历史事件触发", `${fmt(x.trigger, 5)}（${pct(x.trigger_share)}）`],
    ];
    if ((x.unobserved_history_or_gap_trigger || 0) > 1e-6) {
      kvItems.push(["其中：起始历史/停采缺口的期望贡献", fmt(x.unobserved_history_or_gap_trigger, 5)]);
    }
    const kvs = C.el("div", { class: "kv-list", style: "margin:12px 0" }, kvItems.flatMap(([k, v]) => [
      C.el("dt", { text: k }), C.el("dd", { text: v }),
    ]));
    host.appendChild(split);
    host.appendChild(C.el("div", { class: "chart-legend" }, [
      C.el("span", { class: "legend-item" }, [C.el("span", { class: "legend-rect", style: "background:var(--aqua)" }), "持续基线/未归因具体父事件"]),
      C.el("span", { class: "legend-item" }, [C.el("span", { class: "legend-rect", style: "background:var(--orange)" }), "已记录历史事件贡献"]),
    ]));
    host.appendChild(kvs);

    host.appendChild(C.el("h3", { text: "按来源类别汇总" }));
    const sourceTable = C.el("div", { class: "table-wrap" });
    const table = C.el("table", { class: "data" });
    table.innerHTML = "<thead><tr><th>来源类别</th><th>贡献</th><th>占 λ</th><th style='min-width:140px'>比例</th></tr></thead>";
    const tb = C.el("tbody");
    x.source_totals.forEach(s => {
      const tr = C.el("tr");
      tr.appendChild(C.el("td", { text: s.category }));
      tr.appendChild(C.el("td", { text: fmt(s.contribution, 5) }));
      tr.appendChild(C.el("td", { text: pct(s.share) }));
      const bar = C.el("div", { class: "contrib-bar" }, [C.el("div", { class: "contrib-fill", style: `width:${Math.max(2, s.share * 100)}%;background:${colorFor(s.category)}` })]);
      tr.appendChild(C.el("td", {}, [bar]));
      tb.appendChild(tr);
    });
    table.appendChild(tb); sourceTable.appendChild(table); host.appendChild(sourceTable);

    const topSum = x.top_sources.reduce((a, r) => a + r.contribution, 0);
    const otherTrigger = Math.max(0, x.trigger - topSum);
    const unexplained = x.background + otherTrigger;
    host.appendChild(C.el("div", { class: "grid-3", style: "margin:14px 0" }, [
      metricCard("Top 历史事件贡献", fmt(topSum, 4), `占 λ ${pct(topSum / x.lambda)}`, ""),
      metricCard("其他长尾触发", fmt(otherTrigger, 4), "未进入 Top 列表的先验事件", ""),
      metricCard("基线+长尾未归因", fmt(unexplained, 4), `占 λ ${pct(unexplained / x.lambda)}`, "warning"),
    ]));

    host.appendChild(C.el("h3", { text: "最可能的触发来源事件（归一化贡献 ≈ 父事件概率）" }));
    const wrap = C.el("div", { class: "table-wrap" });
    const topTable = C.el("table", { class: "data" });
    topTable.innerHTML = "<thead><tr><th>来源事件</th><th>类别</th><th>滞后</th><th>核贡献</th><th>占 λ/父概率</th><th style='min-width:160px'>概率条</th></tr></thead>";
    const topBody = C.el("tbody");
    x.top_sources.forEach(r => {
      const tr = C.el("tr");
      tr.appendChild(C.el("td", { text: `#${r.event_index} @ ${fmt(r.t, 2)}` }));
      tr.appendChild(C.el("td", { text: r.category }));
      tr.appendChild(C.el("td", { text: fmt(r.lag, 3) }));
      tr.appendChild(C.el("td", { text: fmt(r.contribution, 6) }));
      tr.appendChild(C.el("td", { text: pct(r.parent_probability, 1) }));
      tr.appendChild(C.el("td", {}, [C.el("div", { class: "contrib-bar" }, [C.el("div", { class: "contrib-fill", style: `width:${Math.max(1.5, r.parent_probability * 100)}%;background:${colorFor(r.category)}` })])]));
      topBody.appendChild(tr);
    });
    topTable.appendChild(topBody); wrap.appendChild(topTable); host.appendChild(wrap);
    host.appendChild(C.el("p", { class: "small muted", text: x.note }));
  }

  function metricCard(label, value, sub, tone) {
    return C.el("div", { class: `kpi ${tone}` }, [
      C.el("div", { class: "label", text: label }),
      C.el("div", { class: "value", style: "font-size:22px", text: value }),
      C.el("div", { class: "sub", text: sub }),
    ]);
  }

  function renderMatrix() {
    if (!state.result) return;
    const f = state.result.fit;
    C.heatmap($("#heatmap"), f.eta, f.categories, { valueName: "η 直接子代率" });
    $("#stabilityText").textContent = `H=η 的谱半径 ρ=${fmt(f.rho, 4)}。多类别稳定条件是 ρ<1；当前${f.stable ? "满足" : "不满足"}。${f.stationary_forecast_allowed ? "允许有限期限预测与稳态均值解释。" : "已拒绝长期推演，避免预测指数/无限增长。"} 注意：η_ij 是预测性触发强度，不是干预后的因果效应。`;
  }

  function renderBetaTable() {
    if (!state.result) return;
    const f = state.result.fit, res = state.result.dataset.resolution;
    const tb = $("#betaTable tbody"); tb.replaceChildren();
    for (let i = 0; i < f.categories.length; i++) {
      for (let j = 0; j < f.categories.length; j++) {
        const b = f.beta[i][j];
        const tr = C.el("tr");
        tr.appendChild(C.el("td", { text: `${f.categories[j]} → ${f.categories[i]}` }));
        tr.appendChild(C.el("td", { text: fmt(b, 4) }));
        tr.appendChild(C.el("td", { text: fmt(1 / b, 3) }));
        tr.appendChild(C.el("td", { text: fmt(3 / b, 3) }));
        tr.appendChild(C.el("td", { text: res ? fmt(b * res, 3) : "—" }));
        tb.appendChild(tr);
      }
    }
  }

  function renderDiagnostics() {
    renderDiagnosticsCharts();
    const h = state.result.holdout;
    const tb = $("#countCatTable tbody"); tb.replaceChildren();
    h.counts.by_category.forEach(c => {
      const tr = C.el("tr");
      [c.category, c.observed, fmt(c.expected, 2), fmt(c.z, 2)].forEach((v, i) => tr.appendChild(C.el("td", { text: String(v) })));
      tb.appendChild(tr);
    });
    renderForecast();
  }

  let diagChartsRendered = false;
  function renderDiagnosticsCharts() {
    if (!state.result || !$('[data-panel="diagnostics"]').classList.contains("active")) return;
    const rt = state.result.holdout.residual_tests;
    if (rt.available) {
      C.scatterChart($("#qqChart"), { points: rt.qq.map(p => ({ x: p.theoretical, y: p.empirical })), xLabel: "Exp(1) 理论分位", yLabel: "样本残差", max: Math.max(3.5, ...rt.qq.map(p => Math.max(p.theoretical, p.empirical))) });
      C.barChart($("#acfChart"), { labels: rt.acf.map(a => String(a.lag)), series: [{ name: "ACF", values: rt.acf.map(a => a.acf), color: "var(--violet)" }], reference: rt.acf[0]?.threshold || .2, symmetric: true, digits: 2 });
      const counts = state.result.holdout.counts;
      const labels = Array.from({ length: counts.bins }, (_, i) => `${i + 1}`);
      const obs = [], exp = [];
      for (let b = 0; b < counts.bins; b++) {
        obs.push(counts.cells.filter(c => c.bin === b + 1).reduce((s, c) => s + c.observed, 0));
        exp.push(counts.cells.filter(c => c.bin === b + 1).reduce((s, c) => s + c.expected, 0));
      }
      C.barChart($("#countChart"), { labels, series: [{ name: "观测", values: obs, color: C.PALETTE[0] }, { name: "补偿器期望", values: exp, color: C.PALETTE[1] }], format: v => fmt(v, 1), digits: 0 });
    }
    diagChartsRendered = true;
  }

  function renderForecast() {
    const fc = state.result.forecast, host = $("#forecastContent");
    host.replaceChildren();
    if (!fc) { host.textContent = "未启用预测。"; return; }
    if (!fc.holdout_predictive.allowed) {
      host.appendChild(alertNode("critical", "拒绝长期推演", fc.holdout_predictive.reason || "稳定性条件不满足。"));
      return;
    }
    const h = state.result.holdout;
    const pred = fc.holdout_predictive;
    host.appendChild(C.el("p", { class: "muted", text: `基于训练结束状态进行 ${pred.n_paths} 条 thinning 路径模拟；留出观测不参与这些路径的未来事件更新。未来投影区间长度 ${fmt(fc.horizon, 1)}。` }));
    const wrap = C.el("div", { class: "table-wrap" });
    const table = C.el("table", { class: "data" });
    table.innerHTML = "<thead><tr><th>范围/类别</th><th>实际观测</th><th>预测均值</th><th>中位数</th><th>90% 区间</th></tr></thead>";
    const tb = C.el("tbody");
    function addRow(name, observed, interval) {
      const tr = C.el("tr");
      tr.appendChild(C.el("td", { text: name }));
      tr.appendChild(C.el("td", { text: observed === null || observed === undefined ? "—" : String(observed) }));
      tr.appendChild(C.el("td", { text: fmt(interval.mean, 2) }));
      tr.appendChild(C.el("td", { text: fmt(interval.p50, 1) }));
      tr.appendChild(C.el("td", { text: `[${fmt(interval.p05, 1)}, ${fmt(interval.p95, 1)}]` }));
      tb.appendChild(tr);
    }
    addRow("留出全类别", h.counts.total_observed, pred.total);
    pred.categories.forEach((interval, i) => addRow(`留出 · ${state.result.fit.categories[i]}`, h.counts.by_category[i]?.observed, interval));
    if (fc.future.allowed) {
      addRow("未来全类别", null, fc.future.total);
      fc.future.categories.forEach((interval, i) => addRow(`未来 · ${state.result.fit.categories[i]}`, null, interval));
    }
    table.appendChild(tb); wrap.appendChild(table); host.appendChild(wrap);
  }

  function renderTruth() {
    const card = $("#truthCard");
    if (!state.result?.truth_score && !state.dataset?.synthetic_truth) { card.hidden = true; return; }
    card.hidden = false;
    const score = state.result.truth_score;
    const truth = state.dataset.synthetic_truth;
    const host = $("#truthContent");
    host.replaceChildren();
    if (score) {
      host.appendChild(C.el("div", { class: "grid-4" }, [
        metricCard("η MAE", fmt(score.eta_mae, 3), "全部来源→目标单元", score.eta_mae < .12 ? "good" : "warning"),
        metricCard("背景相对 MAE", pct(score.background_relative_mae, 0), "分段真值按时间平均", score.background_relative_mae < .25 ? "good" : "warning"),
        metricCard("ρ 误差", fmt(score.rho_error, 3), `真 ${fmt(score.true_rho, 2)} / 估 ${fmt(score.estimated_rho, 2)}`, score.rho_error < .15 ? "good" : "warning"),
        metricCard("误归因触发质量", fmt(score.false_trigger_mass, 3), "真值≈0 链接的估计 η 和", score.false_trigger_mass < .15 ? "good" : "critical"),
      ]));
    }
    const grid = C.el("div", { class: "grid-2", style: "margin-top:14px" });
    grid.appendChild(matrixMini("真值 η", truth.eta, state.dataset.categories));
    grid.appendChild(matrixMini("当前估计 η", state.result.fit.eta, state.result.fit.categories));
    host.appendChild(grid);
  }

  function matrixMini(title, matrix, labels) {
    const card = C.el("div");
    card.appendChild(C.el("h3", { text: title }));
    const wrap = C.el("div", { class: "table-wrap" });
    const table = C.el("table", { class: "data" });
    const thead = C.el("thead"); const hr = C.el("tr");
    hr.appendChild(C.el("th", { text: "来源→目标" }));
    labels.forEach(l => hr.appendChild(C.el("th", { text: l })));
    thead.appendChild(hr); table.appendChild(thead);
    const tb = C.el("tbody");
    labels.forEach((target, i) => {
      const tr = C.el("tr"); tr.appendChild(C.el("td", { text: target }));
      labels.forEach((source, j) => tr.appendChild(C.el("td", { text: fmt(matrix[i][j], 3) })));
      tb.appendChild(tr);
    });
    table.appendChild(tb); wrap.appendChild(table); card.appendChild(wrap);
    return card;
  }

  function renderLab() {
    const grid = $("#labGrid");
    grid.replaceChildren();
    SCENARIO_META.forEach(meta => {
      const card = C.el("div", { class: "scenario-card" }, [
        C.el("h3", { text: meta.title }),
        C.el("div", { class: "tag-row" }, [C.el("span", { class: `tag ${meta.tone}`, text: meta.tag }), C.el("span", { class: "tag", text: meta.id })]),
        C.el("p", { text: meta.text }),
        C.el("button", { class: "btn small primary", type: "button", onclick: () => { $("#scenarioSelect").value = meta.id; loadScenario(meta.id, true).catch(showError); } }, ["生成并拟合"]),
      ]);
      grid.appendChild(card);
    });
    const allBtn = C.el("button", { class: "btn", type: "button", text: "一键运行三项核心自检（独立背景 / 自激 / 背景突变）" });
    allBtn.style.marginBottom = "12px";
    allBtn.addEventListener("click", runSelfTest);
    grid.parentElement.insertBefore(allBtn, grid);
  }

  async function runSelfTest() {
    setLoading(true, "运行合成自检…", "三个反例依次进行真实拟合，约需 5–20 秒");
    state.selfTest = [];
    try {
      for (const scenario of ["background_only", "self_excitation", "background_shift"]) {
        const dataset = await api("/api/synthetic", { scenario, seed: 11 }).then(j => j.dataset);
        const result = await api("/api/analyze", { dataset, options: { ...currentOptions(), selectedCategories: dataset.categories, maxIter: 150, forecastPaths: 80 } });
        state.selfTest.push({ scenario, dataset, result });
      }
      renderSelfTestSummary();
      toast("合成自检完成", "good");
    } catch (e) { showError(e); }
    finally { setLoading(false); }
  }

  function renderSelfTestSummary() {
    const host = $("#truthContent");
    $("#truthCard").hidden = false;
    host.replaceChildren();
    const wrap = C.el("div", { class: "table-wrap" });
    const table = C.el("table", { class: "data" });
    table.innerHTML = "<thead><tr><th>场景</th><th>选中模型</th><th>ρ</th><th>η MAE</th><th>背景 MAE</th><th>误归因质量</th><th>留出 KS p</th><th>计数 p</th></tr></thead>";
    const tb = C.el("tbody");
    state.selfTest.forEach(({ scenario, result }) => {
      const s = result.truth_score || {};
      const tr = C.el("tr");
      [scenario, `${result.fit.model_family}/${result.fit.bg_bins}/${result.fit.beta_mode}`, fmt(result.fit.rho, 3), fmt(s.eta_mae, 3), pct(s.background_relative_mae, 0), fmt(s.false_trigger_mass, 3), pval(result.holdout.residual_tests.ks?.p_value), pval(result.holdout.counts.p_value)].forEach(v => tr.appendChild(C.el("td", { text: String(v) })));
      tb.appendChild(tr);
    });
    table.appendChild(tb); wrap.appendChild(table); host.appendChild(C.el("h2", { text: "自检汇总" })); host.appendChild(wrap);
    host.appendChild(C.el("p", { class: "small muted", text: "单次随机样本只用于开发期冒烟检查，不构成统计覆盖率证明；可更换种子重复实验。" }));
  }

  function saveVersion() {
    if (!state.result) return toast("请先拟合", "error");
    const name = $("#versionName").value.trim() || `版本 ${state.versions.length + 1}`;
    const version = {
      id: `v_${Date.now()}`,
      savedAt: new Date().toISOString(),
      name,
      options: state.options,
      dataset: state.dataset,
      result: state.result,
    };
    state.versions.unshift(version);
    saveVersionsStorage(); renderVersionList();
    toast("版本已保存到本浏览器", "good");
  }

  function renderVersionList() {
    const host = $("#versionList");
    host.replaceChildren();
    if (!state.versions.length) { host.appendChild(C.el("p", { class: "small muted", text: "尚未保存版本。" })); return; }
    state.versions.slice(0, 20).forEach(v => {
      const checked = state.compare.has(v.id);
      const cb = C.el("input", { type: "checkbox", checked });
      cb.addEventListener("change", () => {
        if (cb.checked) {
          if (state.compare.size >= 2) { cb.checked = false; return toast("最多选择两个版本", "error"); }
          state.compare.add(v.id);
        } else state.compare.delete(v.id);
      });
      const item = C.el("div", { class: "version-item" }, [
        C.el("div", { class: "title" }, [cb, document.createTextNode(v.name)]),
        C.el("div", { class: "meta", text: `${new Date(v.savedAt).toLocaleString()} · ρ=${fmt(v.result.fit.rho, 3)} · AIC=${fmt(v.result.fit.aic, 1)}` }),
        C.el("div", { class: "version-actions" }, [
          C.el("button", { class: "btn small", type: "button", onclick: () => loadVersion(v.id) }, ["载入"]),
          C.el("button", { class: "btn small danger", type: "button", onclick: () => deleteVersion(v.id) }, ["删除"]),
        ]),
      ]);
      host.appendChild(item);
    });
  }

  function loadVersion(id) {
    const v = state.versions.find(x => x.id === id);
    if (!v) return;
    state.dataset = v.dataset; state.result = v.result; state.options = v.options;
    state.selected = new Set(v.options?.selectedCategories || v.dataset.categories);
    state.colors = {};
    if (v.options?.trainFrac !== undefined) {
      $("#trainFrac").value = String(v.options.trainFrac);
      $("#trainFracValue").textContent = `${Math.round(v.options.trainFrac * 100)}% 训练 · ${100 - Math.round(v.options.trainFrac * 100)}% 留出`;
    }
    if (v.options?.backgroundComplexity !== undefined) $("#bgComplexity").value = String(v.options.backgroundComplexity);
    if (v.options?.kernelComplexity) $("#kernelComplexity").value = v.options.kernelComplexity;
    if (v.options?.kernelShape) $("#kernelShape").value = v.options.kernelShape;
    if (v.options?.boundary) $("#boundaryMode").value = v.options.boundary;
    if (v.options?.gapCorrection !== undefined) $("#gapCorrection").checked = !!v.options.gapCorrection;
    if (v.options?.enforceStable !== undefined) $("#enforceStable").checked = !!v.options.enforceStable;
    $("#windowsInput").value = windowsToText(v.dataset.windows);
    renderCategories(); renderAll(); switchTab("overview");
    toast(`已载入 ${v.name}`, "good");
  }
  function deleteVersion(id) {
    state.versions = state.versions.filter(v => v.id !== id); state.compare.delete(id); saveVersionsStorage(); renderVersionList(); renderVersionCompare();
  }

  function compareSelected() {
    if (state.compare.size !== 2) return toast("请勾选恰好两个版本", "error");
    switchTab("versions");
  }

  function renderVersionCompare() {
    const host = $("#versionCompare");
    if (!host) return;
    const ids = Array.from(state.compare);
    if (ids.length !== 2) {
      host.replaceChildren(C.el("div", { class: "empty-state" }, [C.el("h2", { text: "选择两个版本进行对照" }), C.el("p", { text: "在侧栏版本列表中勾选两个版本。" })]));
      return;
    }
    const a = state.versions.find(v => v.id === ids[0]);
    const b = state.versions.find(v => v.id === ids[1]);
    host.replaceChildren();
    const rows = [
      ["保存时间", new Date(a.savedAt).toLocaleString(), new Date(b.savedAt).toLocaleString(), false],
      ["背景复杂度", a.result.fit.bg_bins, b.result.fit.bg_bins, false],
      ["β 结构", a.result.fit.beta_mode, b.result.fit.beta_mode, false],
      ["核形状", a.result.fit.kernel_shape || "exp", b.result.fit.kernel_shape || "exp", false],
      ["对数似然", fmt(a.result.fit.loglik, 2), fmt(b.result.fit.loglik, 2), true],
      ["AIC", fmt(a.result.fit.aic, 2), fmt(b.result.fit.aic, 2), false],
      ["BIC", fmt(a.result.fit.bic, 2), fmt(b.result.fit.bic, 2), false],
      ["ρ(η)", fmt(a.result.fit.rho, 3), fmt(b.result.fit.rho, 3), false],
      ["留出 ll/event", fmt(a.result.holdout.loglik_per_event, 3), fmt(b.result.holdout.loglik_per_event, 3), true],
      ["残差均值", fmt(a.result.holdout.residual_tests.mean, 3), fmt(b.result.holdout.residual_tests.mean, 3), false],
      ["KS p", pval(a.result.holdout.residual_tests.ks?.p_value), pval(b.result.holdout.residual_tests.ks?.p_value), false],
      ["LB p", pval(a.result.holdout.residual_tests.ljung_box?.p_value), pval(b.result.holdout.residual_tests.ljung_box?.p_value), false],
      ["计数 p", pval(a.result.holdout.counts.p_value), pval(b.result.holdout.counts.p_value), false],
    ];
    const wrap = C.el("div", { class: "table-wrap" });
    const table = C.el("table", { class: "data" });
    table.innerHTML = "<thead><tr><th>指标</th><th>A</th><th>B</th><th>B−A / 判断</th></tr></thead>";
    const tb = C.el("tbody");
    rows.forEach(([label, va, vb, higherBetter]) => {
      const tr = C.el("tr");
      tr.appendChild(C.el("td", { text: label })); tr.appendChild(C.el("td", { text: String(va) })); tr.appendChild(C.el("td", { text: String(vb) }));
      let delta = "—"; let cls = "";
      const na = parseFloat(va), nb = parseFloat(vb);
      if (Number.isFinite(na) && Number.isFinite(nb)) {
        const d = nb - na;
        delta = `${d >= 0 ? "+" : ""}${d.toFixed(3)}`;
        cls = higherBetter ? (d > 0 ? "diff-good" : d < 0 ? "diff-bad" : "") : "";
      }
      tr.appendChild(C.el("td", { class: cls, text: delta }));
      tb.appendChild(tr);
    });
    table.appendChild(tb); wrap.appendChild(table); host.appendChild(wrap);
    const grids = C.el("div", { class: "grid-2", style: "margin-top:14px" });
    grids.appendChild(matrixMini(`A: ${a.name} η`, a.result.fit.eta, a.result.fit.categories));
    grids.appendChild(matrixMini(`B: ${b.name} η`, b.result.fit.eta, b.result.fit.categories));
    host.appendChild(grids);
  }

  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error("CSV 至少需要表头和一行事件");
    const delim = lines[0].includes("\t") ? "\t" : (lines[0].split(",").length > 1 ? "," : ";");
    const headers = splitCsvLine(lines[0], delim).map(h => h.trim().replace(/^"|"$/g, ""));
    const timeKey = headers.find(h => /^(t|time|timestamp|datetime|date|ts|时间)$/i.test(h));
    const catKey = headers.find(h => /^(category|cat|type|class|label|event_type|类别)$/i.test(h));
    if (!timeKey) throw new Error("CSV 找不到 time/timestamp/t 列");
    const events = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = splitCsvLine(lines[i], delim);
      const row = Object.fromEntries(headers.map((h, j) => [h, vals[j]?.replace(/^"|"$/g, "")]));
      if (!row[timeKey]) continue;
      const rawTime = row[timeKey].trim();
      // Do not use parseFloat here: parseFloat("2026-01-01T09:00") is 2026,
      // which would collapse every ISO timestamp from the same year.
      const numericTime = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(rawTime)
        ? parseFloat(rawTime)
        : rawTime;
      events.push({ t: numericTime, category: row[catKey] || "event" });
    }
    const categories = Array.from(new Set(events.map(e => e.category))).sort();
    return { name: "imported-csv", time_unit: "auto", categories, events, windows: [] };
  }
  function splitCsvLine(line, delim) {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = !q;
      else if (ch === delim && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur); return out;
  }

  function handleFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        let ds;
        if (file.name.endsWith(".json")) ds = JSON.parse(text);
        else ds = parseCsv(text);
        if (!ds.events?.length) throw new Error("文件中没有 events");
        if (!Array.isArray(ds.categories) || !ds.categories.length) {
          ds.categories = Array.from(new Set(ds.events.map(e => e.category))).sort();
        }
        state.dataset = ds; state.colors = {}; state.selected = new Set(ds.categories);
        $("#windowsInput").value = windowsToText(ds.windows);
        renderCategories(); toast("文件已导入，点击“拟合并检验”", "good");
      } catch (e) { showError(e); }
    };
    reader.readAsText(file);
  }

  function bindInputs() {
    $("#runBtn").addEventListener("click", () => runAnalysis().catch(showError));
    $("#generateBtn").addEventListener("click", () => loadScenario($("#scenarioSelect").value).catch(showError));
    $("#emptyLoadBtn").addEventListener("click", () => loadScenario("self_excitation").catch(showError));
    $("#emptyCounterBtn").addEventListener("click", () => loadScenario("background_shift").catch(showError));
    $("#scenarioSelect").addEventListener("change", () => loadScenario($("#scenarioSelect").value).catch(showError));
    $("#seedInput").addEventListener("change", () => loadScenario($("#scenarioSelect").value).catch(showError));
    $("#trainFrac").addEventListener("input", e => $("#trainFracValue").textContent = `${Math.round(e.target.value * 100)}% 训练 · ${100 - Math.round(e.target.value * 100)}% 留出`);
    ["showTotalLine", "showBgLines", "showTrigLines"].forEach(id => $("#" + id).addEventListener("change", renderIntensity));
    $("#selectAllCats").addEventListener("click", () => {
      if (!state.dataset?.categories?.length) return toast("请先生成或导入数据", "error");
      state.selected = new Set(state.dataset.categories);
      renderCategories();
      runAnalysis().catch(showError);
    });
    $("#invertCats").addEventListener("click", () => {
      if (!state.dataset?.categories?.length) return toast("请先生成或导入数据", "error");
      state.selected = new Set(state.dataset.categories.filter(c => !state.selected.has(c)));
      renderCategories();
      runAnalysis().catch(showError);
    });
    $("#applyWindowsBtn").addEventListener("click", () => {
      try {
        const parsed = JSON.parse($("#windowsInput").value || "[]");
        const wins = (Array.isArray(parsed) ? parsed : parsed.windows).map(w => Array.isArray(w) ? { start: w[0], end: w[1] } : w);
        if (!wins.length) throw new Error("至少需要一个窗口");
        state.dataset.windows = wins;
        runAnalysis().catch(showError);
      } catch (e) { showError(e); }
    });
    $("#fileInput").addEventListener("change", e => e.target.files[0] && handleFile(e.target.files[0]));
    const dz = $("#dropzone");
    dz.addEventListener("click", () => $("#fileInput").click());
    dz.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") $("#fileInput").click(); });
    ["dragover", "dragenter"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("drag"); }));
    ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("drag"); }));
    dz.addEventListener("drop", e => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));
    $("#saveVersionBtn").addEventListener("click", saveVersion);
    $("#compareVersionsBtn").addEventListener("click", compareSelected);
    $("#exportReportBtn").addEventListener("click", () => {
      if (!state.result) return toast("暂无结果", "error");
      const blob = new Blob([JSON.stringify({ dataset: state.dataset, options: state.options, result: state.result }, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `echoseq-report-${Date.now()}.json`; a.click(); URL.revokeObjectURL(a.href);
    });
    $("#themeToggle").addEventListener("click", () => {
      const root = document.documentElement;
      const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
      root.dataset.theme = dark ? "light" : "dark";
      setTimeout(() => { if (state.result) { renderIntensity(); renderDiagnosticsCharts(); } }, 50);
    });
    window.addEventListener("resize", () => {
      clearTimeout(window.__echoseqResize);
      window.__echoseqResize = setTimeout(() => { if (state.result) { renderIntensity(); renderDiagnosticsCharts(); } }, 180);
    });
  }

  function init() {
    bindTabs(); bindInputs(); renderLab(); renderVersionList();
    fetch("/api/health").then(r => r.json()).then(j => { if (!j.ok) throw new Error(); }).catch(() => toast("后端 /api 未就绪，请用 python3 -m app.server 启动", "error"));
  }
  document.addEventListener("DOMContentLoaded", init);
})();
