"use strict";

// 실제 API를 호출하지 않고 계산 경계와 응답 처리를 검증합니다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const handler = require("../api/trades.js");
const { monthRange, normalize, checkPayload } = handler.helpers;
const originalFetch = global.fetch;

function frontend() {
  const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  const context = vm.createContext({});
  vm.runInContext(source.slice(0, source.indexOf("// 입력값, 모바일")) + "\nglobalThis.logic = {summarize, formatMoney, areaMatches, monthlyStats, tableRows, configure(value){Object.assign(state,value);}};", context);
  return context.logic;
}

function record(fields = {}) {
  return { aptNm: "검증 아파트", umdNm: "역삼동", dealAmount: "120,000", excluUseAr: "84.9", dealYear: "2026", dealMonth: "1", dealDay: "15", floor: "0", ...fields };
}

test("달 목록은 연도가 바뀌어도 순서대로 이어진다", () => {
  assert.deepEqual(monthRange("202601", 3), ["202511", "202512", "202601"]);
});

test("단위, 0층, 취소 거래와 잘못된 날짜를 처리한다", () => {
  const item = normalize(record());
  assert.equal(item.amount, 120000); assert.equal(item.area, 84.9); assert.equal(item.floor, 0);
  assert.equal(item.date, "2026-01-15");
  assert.equal(normalize(record({ cdealType: "O" })).cancelled, true);
  assert.equal(normalize(record({ cdealDay: "2026.02.01" })).cancelled, true);
  for (const fields of [{ dealAmount: "-" }, { excluUseAr: "0" }, { dealDay: "32" }, { dealYear: "2025", dealMonth: "2", dealDay: "29" }]) assert.equal(normalize(record(fields)).invalid, true);
});

test("정상 XML과 한 건·빈 목록을 읽고 인증 오류를 구분한다", () => {
  const xml = "<response><header><resultCode>000</resultCode></header><body><items><item><aptNm>A &amp; B</aptNm></item></items><totalCount>1</totalCount></body></response>";
  assert.equal(checkPayload(xml).items[0].aptNm, "A & B");
  assert.equal(checkPayload("<response><header><resultCode>000</resultCode></header><body><items/><totalCount>0</totalCount></body></response>").items.length, 0);
  assert.throws(() => checkPayload("<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>"), /인증키/);
  assert.throws(() => checkPayload("<!DOCTYPE x><response/>"));
});

test("중위값, 평균과 결측을 올바르게 계산한다", () => {
  const app = frontend();
  const result = app.summarize([{ amount: 10000, area: 50 }, { amount: 20000, area: 100 }, { amount: 90000, area: 100 }]);
  assert.equal(result.median, 20000); assert.equal(result.average, 40000);
  assert.equal(app.summarize([{ amount: 10, area: 5 }, { amount: 20, area: 5 }]).median, 15);
  assert.equal(app.summarize([]).median, null); assert.equal(app.formatMoney(null), "—");
  assert.equal(app.formatMoney(125000), "12억 5,000만");
});

test("면적 경계, 동별 아파트와 검색·정렬 조건을 구분한다", () => {
  const app = frontend();
  assert.equal(app.areaMatches({ area: 60 }, "small"), true);
  assert.equal(app.areaMatches({ area: 60 }, "medium"), false);
  assert.equal(app.areaMatches({ area: 85 }, "medium"), true);
  assert.equal(app.areaMatches({ area: 85 }, "large"), false);
  const items = [{ name: "같은 이름", dong: "가동", area: 60, amount: 100, date: "2026-01-10", month: "202601" }, { name: "같은 이름", dong: "나동", area: 85, amount: 200, date: "2026-03-20", month: "202603" }];
  app.configure({ payload: { months: ["202601", "202602", "202603"], items } });
  assert.equal(app.monthlyStats()[1].median, null);
  app.configure({ apartment: JSON.stringify(["가동", "같은 이름"]) }); assert.equal(app.tableRows().length, 1);
  app.configure({ apartment: "all", search: "나동" }); assert.equal(app.tableRows()[0].amount, 200);
  app.configure({ search: "", sort: "low" }); assert.equal(app.tableRows()[0].amount, 100);
});

test("API는 모든 페이지를 조회하고 실패 응답에서 키를 노출하지 않는다", async (t) => {
  const oldKey = process.env.MOLIT_KEY;
  process.env.MOLIT_KEY = "test+/=key";
  t.after(() => { global.fetch = originalFetch; if (oldKey === undefined) delete process.env.MOLIT_KEY; else process.env.MOLIT_KEY = oldKey; });
  const urls = [];
  global.fetch = async (url) => {
    urls.push(new URL(url));
    const month = urls.at(-1).searchParams.get("DEAL_YMD"), page = urls.at(-1).searchParams.get("pageNo");
    const size = month === "202511" ? (page === "1" ? 1000 : 1) : 0;
    const item = "<item><aptNm>검증</aptNm><umdNm>가동</umdNm><dealAmount>120,000</dealAmount><excluUseAr>84</excluUseAr><dealYear>2025</dealYear><dealMonth>11</dealMonth><dealDay>1</dealDay></item>";
    return { ok: true, text: async () => `<response><header><resultCode>000</resultCode></header><body><items>${item.repeat(size)}</items><totalCount>${month === "202511" ? 1001 : 0}</totalCount></body></response>` };
  };
  const invoke = async (query, method = "GET") => {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ query, method }, res); return res;
  };
  const query = { region: "11110", end: "202601", months: "3" };
  const response = await invoke(query);
  assert.equal(response.code, 200); assert.equal(response.body.items.length, 1001); assert.equal(urls.length, 4);
  assert.ok(urls.some((url) => url.searchParams.get("pageNo") === "2"));
  assert.equal(urls[0].searchParams.get("serviceKey"), "test+/=key");
  assert.equal((await invoke({ ...query, region: "bad" })).code, 400);
  assert.equal((await invoke(query, "POST")).code, 405);
  global.fetch = async () => { throw new Error("test+/=key"); };
  const error = await invoke({ ...query, region: "11140" });
  assert.equal(error.code, 502); assert.ok(!JSON.stringify(error.body).includes("test+/=key"));
  delete process.env.MOLIT_KEY; assert.equal((await invoke(query)).code, 500);
});
