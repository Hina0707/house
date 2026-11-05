"use strict";

// 브라우저에서 조회 자료와 화면에서 고른 비교 조건을 따로 보관합니다.
const $ = (id) => document.getElementById(id);
const state = { payload: null, regionName: "서울 강남구", region: "11680", period: "6", area: "all", apartment: "all", metric: "median", search: "", sort: "recent", page: 1, loading: false };
const PAGE_SIZE = 12;
let controller;
let resizeTimer;
const formatNumber = (value, digits = 0) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(value);
const apartmentKey = (row) => JSON.stringify([row.dong, row.name]);

// 실제 자료에 쓰이는 금액 단위는 만원이며 표시할 때만 억 단위로 바꿉니다.
function formatMoney(value) {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  const billionPart = Math.floor(rounded / 10000);
  const remainder = rounded % 10000;
  return billionPart ? `${formatNumber(billionPart)}억${remainder ? ` ${formatNumber(remainder)}만` : ""}` : `${formatNumber(remainder)}만`;
}

// 빈 배열은 0원으로 보이지 않도록 계산 결과를 비워 둡니다.
function summarize(rows) {
  if (!rows.length) return { count: 0, median: null, average: null, unit: null };
  const amounts = rows.map((row) => row.amount).sort((a, b) => a - b);
  const middle = Math.floor(amounts.length / 2);
  return {
    count: rows.length,
    median: amounts.length % 2 ? amounts[middle] : (amounts[middle - 1] + amounts[middle]) / 2,
    average: amounts.reduce((sum, value) => sum + value, 0) / amounts.length,
    unit: rows.reduce((sum, row) => sum + row.amount / row.area, 0) / rows.length
  };
}

// 외부 자료의 아파트명과 동 이름은 항상 텍스트 노드로 넣습니다.
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function monthLabel(month, full = false) {
  return full ? `${month.slice(0, 4)}년 ${Number(month.slice(4))}월` : `${month.slice(0, 4)}.${month.slice(4)}`;
}

// 면적 구간의 경계를 겹치지 않게 나눕니다.
function areaMatches(row, area) {
  return area === "all" || (area === "small" && row.area <= 60)
    || (area === "medium" && row.area > 60 && row.area <= 85)
    || (area === "large" && row.area > 85);
}

function scopedRows() {
  return (state.payload?.items || []).filter((row) => areaMatches(row, state.area)
    && (state.apartment === "all" || apartmentKey(row) === state.apartment));
}

// 표의 검색과 정렬은 그래프의 비교 조건을 바꾸지 않습니다.
function tableRows() {
  const search = state.search.trim().toLocaleLowerCase("ko-KR");
  const rows = scopedRows().filter((row) => !search || `${row.name} ${row.dong}`.toLocaleLowerCase("ko-KR").includes(search));
  return rows.sort((a, b) => {
    if (state.sort === "high") return b.amount - a.amount || b.date.localeCompare(a.date);
    if (state.sort === "low") return a.amount - b.amount || b.date.localeCompare(a.date);
    if (state.sort === "area") return b.area - a.area || b.date.localeCompare(a.date);
    return b.date.localeCompare(a.date) || b.amount - a.amount;
  });
}

function monthlyStats() {
  const rows = scopedRows();
  return (state.payload?.months || []).map((month) => ({ month, ...summarize(rows.filter((row) => row.month === month)) }));
}

function setValue(id, value, suffix) {
  const node = $(id);
  node.replaceChildren(document.createTextNode(value === null ? "—" : value));
  if (value !== null && suffix) node.append(element("small", "", suffix));
}

// 직전 달과 비교할 자료가 없으면 상승률을 만들어 내지 않습니다.
function setChange(id, current, previous, count = false) {
  const node = $(id);
  node.classList.remove("up", "down");
  if (current === null || previous === null || previous === 0) {
    node.textContent = "전월 비교 자료 없음";
    return;
  }
  const change = (current - previous) / previous * 100;
  if (Math.abs(change) < .05) { node.textContent = "전월과 같은 수준"; return; }
  node.classList.add(change > 0 ? "up" : "down");
  node.textContent = `${change > 0 ? "↑" : "↓"} 전월 대비 ${Math.abs(change).toFixed(1)}%${count ? ` · ${Math.abs(current - previous)}건 ${change > 0 ? "증가" : "감소"}` : ""}`;
}

function renderStats(monthly) {
  const current = monthly.at(-1) || { count: 0, median: null, average: null, unit: null };
  const previous = monthly.at(-2) || {};
  $("overview-title").replaceChildren(document.createTextNode(state.regionName + " "), element("span", "", "한눈에 보기"));
  $("metric-month").textContent = current.month ? `${monthLabel(current.month, true)} · 선택 조건 기준` : state.loading ? "자료 확인 중" : "자료 없음";
  setValue("median-value", current.median === null ? null : (current.median / 10000).toFixed(2), "억 원");
  setValue("average-value", current.average === null ? null : (current.average / 10000).toFixed(2), "억 원");
  setValue("count-value", state.payload ? formatNumber(current.count) : null, "건");
  setValue("unit-value", current.unit === null ? null : formatNumber(current.unit), "만 원");
  setChange("median-change", current.median, previous.median ?? null);
  setChange("average-change", current.average, previous.average ?? null);
  setChange("count-change", current.count, previous.count ?? null, true);
}

// SVG를 직접 그려 외부 차트 서비스 없이도 가격 추이를 표시합니다.
function svgElement(tag, attributes, content) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, String(value));
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function renderChart(monthly = monthlyStats()) {
  const chart = $("chart");
  chart.replaceChildren();
  chart.setAttribute("aria-busy", String(state.loading));
  $("chart-metric-label").textContent = state.metric === "median" ? "중위 거래금액" : "평균 거래금액";
  $("chart-range").textContent = monthly.length ? `${monthLabel(monthly[0].month)} — ${monthLabel(monthly.at(-1).month)}` : "—";
  const valid = monthly.filter((row) => row[state.metric] !== null);
  if (!valid.length) {
    chart.append(element("p", "chart-empty", state.loading ? "거래금액의 흐름을 불러오는 중..." : "조건에 맞는 거래가 없습니다.\n면적이나 아파트 조건을 바꿔 보세요."));
    $("chart-insight").textContent = "거래가 없는 달은 평균과 중위값을 계산하지 않습니다.";
    renderMonthlyTable(monthly);
    return;
  }
  const width = Math.max(280, chart.clientWidth || 740), height = width < 430 ? 220 : 280;
  const left = 46, right = width - 18, top = 26, bottom = height - 40;
  const values = valid.map((row) => row[state.metric] / 10000);
  const low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max((high - low) * .25, high * .04, .1);
  const minimum = Math.max(0, low - padding), maximum = high + padding;
  const x = (i) => left + i * (right - left) / Math.max(1, monthly.length - 1);
  const y = (value) => bottom - (value / 10000 - minimum) / (maximum - minimum) * (bottom - top);
  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": "svg-chart-title svg-chart-desc" });
  svg.append(svgElement("title", { id: "svg-chart-title" }, `${state.regionName} 월별 ${state.metric === "median" ? "중위" : "평균"} 거래금액`));
  svg.append(svgElement("desc", { id: "svg-chart-desc" }, "단위는 억 원입니다. 각 점을 선택하거나 아래 월별 숫자로 보기를 펼치면 금액과 거래량을 확인할 수 있습니다."));
  const defs = svgElement("defs");
  const gradient = svgElement("linearGradient", { id: "price-fill", x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(svgElement("stop", { offset: "0%", "stop-color": "#83b292", "stop-opacity": .24 }), svgElement("stop", { offset: "100%", "stop-color": "#83b292", "stop-opacity": .015 }));
  defs.append(gradient); svg.append(defs);
  for (let i = 0; i <= 4; i++) {
    const value = minimum + (maximum - minimum) * i / 4, position = bottom - i * (bottom - top) / 4;
    svg.append(svgElement("line", { x1: left, x2: right, y1: position, y2: position, stroke: "#edf1e8", "stroke-dasharray": "3 4" }));
    svg.append(svgElement("text", { x: left - 10, y: position + 4, "text-anchor": "end" }, value.toFixed(1)));
  }
  const step = Math.max(1, Math.ceil(monthly.length / (width / 68)));
  monthly.forEach((row, i) => {
    if (i % step === 0 || i === monthly.length - 1) svg.append(svgElement("text", { x: x(i), y: height - 12, "text-anchor": "middle" }, `${Number(row.month.slice(4))}월`));
  });
  let segment = [];
  const drawSegment = () => {
    if (!segment.length) return;
    const line = segment.map((point, i) => `${i ? "L" : "M"}${point.x},${point.y}`).join(" ");
    if (segment.length > 1) {
      svg.append(svgElement("path", { d: `${line} L${segment.at(-1).x},${bottom} L${segment[0].x},${bottom} Z`, fill: "url(#price-fill)" }));
      svg.append(svgElement("path", { d: line, fill: "none", stroke: "#41825a", "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    segment = [];
  };
  monthly.forEach((row, i) => { if (row[state.metric] === null) drawSegment(); else segment.push({ x: x(i), y: y(row[state.metric]) }); });
  drawSegment();
  const tooltip = element("div", "chart-tooltip"); tooltip.hidden = true;
  monthly.forEach((row, i) => {
    if (row[state.metric] === null) return;
    const dot = svgElement("circle", { cx: x(i), cy: y(row[state.metric]), r: 4.5, class: "chart-dot", tabindex: 0, role: "button", "aria-label": `${monthLabel(row.month, true)}, ${formatMoney(row[state.metric])} 원, ${row.count}건` });
    const show = () => {
      tooltip.replaceChildren(document.createTextNode(monthLabel(row.month, true)), element("strong", "", `${formatMoney(row[state.metric])} 원`), document.createTextNode(`거래 ${formatNumber(row.count)}건`));
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(85, Math.min(width - 85, x(i)))}px`;
    };
    dot.addEventListener("mouseenter", show); dot.addEventListener("focus", show); dot.addEventListener("click", show);
    dot.addEventListener("blur", () => { tooltip.hidden = true; });
    dot.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); show(); } if (event.key === "Escape") tooltip.hidden = true; });
    svg.append(dot);
  });
  svg.addEventListener("mouseleave", () => { tooltip.hidden = true; });
  chart.append(svg, tooltip);
  $("chart-insight").textContent = `${valid.length}개월의 거래 기록 · 거래 없는 달은 선을 연결하지 않습니다.`;
  renderMonthlyTable(monthly);
}

// 그래프의 모든 숫자를 표로도 제공해 키보드와 화면 읽기 도구로 확인할 수 있게 합니다.
function renderMonthlyTable(monthly) {
  const fragment = document.createDocumentFragment();
  for (const row of monthly) {
    const tr = element("tr");
    for (const value of [monthLabel(row.month), formatMoney(row.median), formatMoney(row.average), `${formatNumber(row.count)}건`]) tr.append(element("td", "", value));
    fragment.append(tr);
  }
  $("monthly-body").replaceChildren(fragment);
}

function renderDistribution() {
  const rows = scopedRows();
  const fragment = document.createDocumentFragment();
  for (const [area, label] of [["small", "60㎡ 이하"], ["medium", "60~85㎡"], ["large", "85㎡ 초과"]]) {
    const count = rows.filter((row) => areaMatches(row, area)).length;
    const share = rows.length ? count / rows.length * 100 : 0;
    const row = element("div", "distribution-row"), info = element("div"), track = element("div", "distribution-track"), fill = element("div", "distribution-fill");
    info.append(element("span", "", label), element("strong", "", `${share.toFixed(0)}% · ${formatNumber(count)}건`));
    fill.style.width = `${share}%`; track.append(fill); row.append(info, track); fragment.append(row);
  }
  $("distribution").replaceChildren(fragment);
  $("range-count").textContent = state.payload ? `${formatNumber(rows.length)}건` : "—";
}

// 거래 목록은 한 페이지에 열두 건씩 보여줍니다.
function renderTable() {
  const rows = tableRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * PAGE_SIZE;
  const fragment = document.createDocumentFragment();
  for (const row of rows.slice(start, start + PAGE_SIZE)) {
    const tr = element("tr"), name = element("td"), link = element("button", "apt-link", row.name);
    link.type = "button"; link.title = "이 아파트의 거래만 보기";
    link.addEventListener("click", () => { state.apartment = apartmentKey(row); $("apartment").value = state.apartment; state.search = ""; $("search").value = ""; state.page = 1; render(); });
    name.append(link, element("span", "apt-location", `${row.dong}${row.builtYear ? ` · ${row.builtYear}년 준공` : ""}`)); tr.append(name);
    const columns = [["계약일", row.date.replaceAll("-", "."), ""], ["거래금액", `${formatMoney(row.amount)} 원`, "trade-price"], ["전용면적", `${formatNumber(row.area, 2)}㎡`, ""], ["층", row.floor === null ? "미제공" : `${row.floor}층`, ""]];
    for (const [label, value, className] of columns) { const td = element("td", className, value); td.dataset.label = label; tr.append(td); }
    const method = element("td"); method.dataset.label = "거래유형"; method.append(element("span", "method-badge", row.method)); tr.append(method); fragment.append(tr);
  }
  if (!rows.length) {
    const tr = element("tr"), td = element("td", "table-empty", state.loading ? "실거래 자료를 불러오고 있어요." : state.payload ? "조건에 맞는 거래가 없습니다. 검색어나 면적·아파트 조건을 바꿔 보세요." : "거래 내역은 자료를 조회하면 표시됩니다.");
    td.colSpan = 6; tr.append(td); fragment.append(tr);
  }
  $("trade-body").replaceChildren(fragment);
  $("table-count").textContent = formatNumber(rows.length);
  $("page-info").textContent = rows.length ? `총 ${formatNumber(rows.length)}건 중 ${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)}건` : "표시할 거래 없음";
  $("page-number").textContent = `${state.page} / ${pages}`;
  $("previous-page").disabled = state.page <= 1;
  $("next-page").disabled = state.page >= pages;
  $("download-button").disabled = rows.length === 0;
}

function render() {
  const monthly = monthlyStats();
  renderStats(monthly); renderChart(monthly); renderDistribution(); renderTable();
}

// 아파트 이름이 같아도 법정동이 다르면 서로 다른 항목으로 선택합니다.
function buildApartments() {
  const options = new Map();
  for (const row of state.payload.items) options.set(apartmentKey(row), `${row.name} · ${row.dong}`);
  $("apartment").replaceChildren(new Option("전체 아파트", "all"));
  for (const [key, label] of [...options].sort((a, b) => a[1].localeCompare(b[1], "ko"))) $("apartment").append(new Option(label, key));
}

function setBusy(busy) {
  state.loading = busy;
  for (const control of $("query-form").querySelectorAll("button, input, select")) control.disabled = busy;
  for (const button of document.querySelectorAll("[data-area], [data-metric]")) button.disabled = busy || !state.payload;
  $("apartment").disabled = busy || !state.payload;
  $("search").disabled = busy || !state.payload;
  $("query-button").textContent = busy ? "불러오는 중..." : "집값 살펴보기";
  $("chart").setAttribute("aria-busy", String(busy));
}

// 실패하거나 지역이 바뀌었을 때 이전 지역의 숫자가 남지 않게 비웁니다.
async function loadTrades() {
  const custom = $("region").value === "custom";
  const region = custom ? $("custom-code").value.trim() : $("region").value;
  if (!/^\d{5}$/.test(region)) { $("custom-code").setCustomValidity("숫자 5자리 지역 코드를 입력해 주세요."); $("custom-code").reportValidity(); return; }
  $("custom-code").setCustomValidity("");
  const end = $("end-month").value.replace("-", "");
  controller?.abort(); const request = new AbortController(); controller = request;
  state.region = region; state.regionName = custom ? `지역 코드 ${region}` : $("region").selectedOptions[0].textContent;
  state.payload = null; state.apartment = "all"; state.page = 1; state.search = ""; $("search").value = "";
  $("apartment").replaceChildren(new Option("전체 아파트", "all"));
  $("error-panel").hidden = true;
  $("feedback").replaceChildren(element("span", "spinner"), document.createTextNode(`${state.regionName}의 ${state.period}개월 실거래 자료를 불러오는 중입니다.`));
  $("updated-at").textContent = "자료 확인 중";
  setBusy(true); render();
  const timer = setTimeout(() => request.abort(), 50000);
  try {
    const response = await fetch(`/api/trades?${new URLSearchParams({ region, end, months: state.period })}`, { signal: request.signal });
    let payload;
    try { payload = await response.json(); } catch { throw new Error("자료 서버를 찾을 수 없습니다. 로컬 서버 또는 배포 상태를 확인해 주세요."); }
    if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "거래 자료를 가져오지 못했습니다.");
    if (!Array.isArray(payload.items) || !Array.isArray(payload.months)) throw new Error("거래 자료의 형식이 올바르지 않습니다.");
    if (controller !== request) return;
    state.payload = payload;
    buildApartments();
    $("feedback").textContent = `${state.regionName} · ${monthLabel(payload.months[0])} ~ ${monthLabel(payload.months.at(-1))} · ${formatNumber(payload.items.length)}건의 거래를 확인했어요.`;
    $("updated-at").textContent = `자료 조회 · ${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "numeric", minute: "numeric", hour12: false }).format(new Date(payload.fetchedAt))}`;
    $("exclusion-note").textContent = `조회 기간의 해제·취소 ${formatNumber(payload.excluded)}건과 금액·면적·날짜 미확인 ${formatNumber(payload.invalid)}건은 제외했습니다. 신고 자료는 이후 정정될 수 있습니다.`;
  } catch (error) {
    if (controller !== request) return;
    $("error-panel").hidden = false;
    $("error-message").textContent = request.signal.aborted ? "조회 시간이 길어지고 있습니다. 3개월로 줄여 다시 조회해 주세요." : error instanceof TypeError ? "인터넷 연결 또는 국토교통부 서버 상태를 확인해 주세요." : error.message;
    $("feedback").textContent = "자료를 불러오지 못했습니다. 조회 조건을 확인하고 다시 시도해 주세요.";
    $("updated-at").textContent = "조회 미완료";
  } finally {
    clearTimeout(timer);
    if (controller === request) { setBusy(false); render(); }
  }
}

// CSV는 화면의 검색·정렬 조건을 반영한 전체 목록을 내려받습니다.
function downloadCsv() {
  const rows = tableRows();
  if (!rows.length) return;
  const escape = (value) => {
    let text = String(value ?? "");
    if (typeof value !== "number" && /^[=+@-]/.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const lines = [["아파트", "법정동", "계약일", "거래금액(만원)", "전용면적(㎡)", "층", "준공연도", "거래유형"], ...rows.map((row) => [row.name, row.dong, row.date, row.amount, row.area, row.floor, row.builtYear, row.method])];
  const blob = new Blob(["\uFEFF" + lines.map((line) => line.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = element("a"); link.href = url; link.download = `아파트_실거래_${state.region}_${state.payload.months[0]}_${state.payload.months.at(-1)}.csv`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 빠른 선택 목록에 없는 지역도 법정동 코드로 조회할 수 있습니다.
async function initializeRegions() {
  let regions = [{ group: "서울", code: "11680", name: "서울 강남구" }];
  try { const response = await fetch("regions.json"); if (response.ok) regions = await response.json(); } catch { /* 기본 지역으로도 조회할 수 있습니다. */ }
  const groups = new Map();
  $("region").replaceChildren();
  for (const region of regions) {
    if (!groups.has(region.group)) { const group = element("optgroup"); group.label = region.group; groups.set(region.group, group); $("region").append(group); }
    groups.get(region.group).append(new Option(region.name, region.code));
  }
  $("region").append(new Option("다른 지역 · 코드로 조회", "custom"));
  $("region").value = "11680";
}

// 입력값, 모바일 터치와 키보드 동작을 한곳에서 연결합니다.
$("query-form").addEventListener("submit", (event) => { event.preventDefault(); loadTrades(); });
$("retry-button").addEventListener("click", loadTrades);
$("region").addEventListener("change", () => { const custom = $("region").value === "custom"; $("custom-field").hidden = !custom; $("custom-code").required = custom; if (custom) $("custom-code").focus(); });
$("custom-code").addEventListener("input", () => $("custom-code").setCustomValidity(""));
for (const button of document.querySelectorAll("[data-period]")) button.addEventListener("click", () => { state.period = button.dataset.period; for (const other of document.querySelectorAll("[data-period]")) other.setAttribute("aria-pressed", String(other === button)); });
for (const button of document.querySelectorAll("[data-area]")) button.addEventListener("click", () => { state.area = button.dataset.area; state.page = 1; for (const other of document.querySelectorAll("[data-area]")) other.setAttribute("aria-pressed", String(other === button)); render(); });
for (const button of document.querySelectorAll("[data-metric]")) button.addEventListener("click", () => { state.metric = button.dataset.metric; for (const other of document.querySelectorAll("[data-metric]")) other.setAttribute("aria-pressed", String(other === button)); renderChart(); });
$("apartment").addEventListener("change", () => { state.apartment = $("apartment").value; state.page = 1; render(); });
$("search").addEventListener("input", () => { state.search = $("search").value; state.page = 1; renderTable(); });
$("sort").addEventListener("change", () => { state.sort = $("sort").value; state.page = 1; renderTable(); });
$("previous-page").addEventListener("click", () => { state.page--; renderTable(); });
$("next-page").addEventListener("click", () => { state.page++; renderTable(); });
$("download-button").addEventListener("click", downloadCsv);
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.payload) renderChart(); }, 150); });

// 기본 조회는 신고가 쌓인 직전 달까지 6개월이며 현재 월도 직접 선택할 수 있습니다.
const dateParts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }).formatToParts(new Date());
const currentYear = Number(dateParts.find((part) => part.type === "year").value);
const currentMonth = Number(dateParts.find((part) => part.type === "month").value);
const previous = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
$("end-month").max = `${currentYear}-${String(currentMonth).padStart(2, "0")}`;
$("end-month").value = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
initializeRegions().then(loadTrades);
