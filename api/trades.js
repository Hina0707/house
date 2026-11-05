"use strict";

// 국토교통부 XML 자료를 서버에서 정리하고 인증키는 환경변수에서만 읽습니다.
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const ENDPOINT = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade";
const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
const cache = new Map();
const TTL = 10 * 60 * 1000;
const text = (value) => String(value ?? "").trim();
const failure = (message, status = 502) => Object.assign(new Error(message), { status });

// 한국 시각을 기준으로 조회 가능한 최신 계약월을 구합니다.
function currentMonth() {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return parts.find((part) => part.type === "year").value + parts.find((part) => part.type === "month").value;
}

// 선택한 종료월을 포함해 과거 월을 오래된 순서대로 만듭니다.
function monthRange(end, count) {
  const year = Number(end.slice(0, 4));
  const month = Number(end.slice(4));
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(year, month - count + i, 1));
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

// 취소 거래와 계산할 수 없는 금액·면적은 목록과 통계에서 제외합니다.
function normalize(item) {
  if (text(item.cdealDay) || ["O", "Y"].includes(text(item.cdealType).toUpperCase())) return { cancelled: true };
  const amountText = text(item.dealAmount).replaceAll(",", "");
  const areaText = text(item.excluUseAr);
  const amount = /^\d+$/.test(amountText) ? Number(amountText) : NaN;
  const area = /^\d+(\.\d+)?$/.test(areaText) ? Number(areaText) : NaN;
  const year = Number(item.dealYear), month = Number(item.dealMonth), day = Number(item.dealDay);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isFinite(area) || area <= 0
    || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return { invalid: true };
  return {
    name: text(item.aptNm) || "이름 미제공", dong: text(item.umdNm) || "동 미제공",
    amount, area, floor: /^-?\d+$/.test(text(item.floor)) ? Number(item.floor) : null,
    builtYear: /^\d{4}$/.test(text(item.buildYear)) ? Number(item.buildYear) : null,
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    month: `${year}${String(month).padStart(2, "0")}`, method: text(item.dealingGbn) || "미제공"
  };
}

// API 결과 코드를 한국어로 바꾸고 원문이나 인증키를 반환하지 않습니다.
function checkPayload(raw) {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true) throw failure("자료 응답을 읽을 수 없습니다. 잠시 후 다시 조회해 주세요.");
  const data = parser.parse(raw);
  const response = data?.response;
  const code = text(response?.header?.resultCode || data?.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnReasonCode);
  if (!["000", "00"].includes(code)) {
    if (["30", "31", "32", "20"].includes(code)) throw failure("인증키 또는 국토교통부 아파트 매매 실거래가 API 활용신청 상태를 확인해 주세요.");
    if (code === "22") throw failure("공공데이터 API의 조회 한도를 초과했습니다. 잠시 후 다시 이용해 주세요.", 429);
    throw failure("국토교통부 자료를 불러오지 못했습니다. 인증키와 요청값을 확인해 주세요.");
  }
  const body = response.body;
  const total = Number(body?.totalCount);
  const value = body?.items?.item;
  const items = value ? (Array.isArray(value) ? value : [value]) : [];
  if (!Number.isSafeInteger(total) || total < 0 || items.some((item) => !item || typeof item !== "object")) throw failure("거래 자료의 응답 형식이 올바르지 않습니다.");
  return { total, items };
}

// 한 달의 모든 페이지를 읽고 완료된 결과만 잠시 보관합니다.
async function fetchMonth(region, month, key, signal) {
  const cacheKey = `${region}:${month}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const rawItems = [];
  let total = 0;
  for (let page = 1; page === 1 || rawItems.length < total; page++) {
    if (page > 50) throw failure("조회할 거래가 너무 많습니다. 조회 지역을 나누어 주세요.");
    const url = `${ENDPOINT}?serviceKey=${encodeURIComponent(key)}&LAWD_CD=${region}&DEAL_YMD=${month}&pageNo=${page}&numOfRows=1000`;
    const response = await fetch(url, { signal });
    const payload = checkPayload(await response.text());
    if (!response.ok) throw failure("국토교통부 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.");
    total = payload.total;
    if (payload.items.length === 0 && rawItems.length < total) throw failure("일부 거래 자료가 누락되었습니다. 다시 조회해 주세요.");
    rawItems.push(...payload.items);
  }
  let cancelled = 0, invalid = 0;
  const items = [];
  for (const row of rawItems) {
    const item = normalize(row);
    if (item.cancelled) cancelled++;
    else if (item.invalid) invalid++;
    else items.push(item);
  }
  const data = { items, cancelled, invalid };
  if (cache.size >= 36) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// 최대 세 달씩 함께 조회해 응답을 기다리는 시간을 줄입니다.
async function fetchRange(region, months, key, signal) {
  const results = new Array(months.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, months.length) }, async () => {
    while (cursor < months.length) {
      const index = cursor++;
      results[index] = await fetchMonth(region, months[index], key, signal);
    }
  }));
  return results;
}

// Vercel과 로컬 서버에서 같은 API 함수를 실행합니다.
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ message: "조회 요청만 사용할 수 있습니다." });
  }
  const { region = "11680", end = currentMonth(), months = "6" } = req.query || {};
  if (typeof region !== "string" || !/^\d{5}$/.test(region)) return res.status(400).json({ message: "시군구의 법정동 코드 앞 5자리를 입력해 주세요." });
  if (typeof end !== "string" || !/^\d{4}(0[1-9]|1[0-2])$/.test(end) || end < "200601" || end > currentMonth()) return res.status(400).json({ message: "2006년 1월부터 현재까지의 계약월을 선택해 주세요." });
  if (typeof months !== "string" || !["3", "6", "12"].includes(months)) return res.status(400).json({ message: "조회 기간은 3개월, 6개월, 12개월 중 선택해 주세요." });
  const key = process.env.MOLIT_KEY?.trim();
  if (!key) return res.status(500).json({ message: "서버에 MOLIT_KEY 환경변수를 설정해 주세요." });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const range = monthRange(end, Number(months));
    const results = await fetchRange(region, range, key, controller.signal);
    return res.status(200).json({
      region, months: range, items: results.flatMap((part) => part.items).sort((a, b) => b.date.localeCompare(a.date)),
      excluded: results.reduce((sum, part) => sum + part.cancelled, 0),
      invalid: results.reduce((sum, part) => sum + part.invalid, 0), fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    controller.abort();
    return res.status(error.status || (error.name === "AbortError" ? 504 : 502)).json({
      message: error.status ? error.message : error.name === "AbortError"
        ? "자료 조회 시간이 길어지고 있습니다. 기간을 줄여 다시 조회해 주세요."
        : "국토교통부 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요."
    });
  } finally { clearTimeout(timer); }
};

// 계산과 응답 처리의 경계 조건을 검증할 때도 같은 함수를 사용합니다.
module.exports.helpers = { monthRange, normalize, checkPayload };
