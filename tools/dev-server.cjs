"use strict";

// 로컬에서 화면과 실거래가 API를 함께 실행합니다.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const handler = require("../api/trades.js");
const root = path.resolve(__dirname, "..");
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/script.js", ["script.js", "text/javascript; charset=utf-8"]],
  ["/regions.json", ["regions.json", "application/json; charset=utf-8"]]
]);
const server = http.createServer(async (req, res) => {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(data)); return res; };
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/trades") {
      req.query = Object.create(null);
      for (const name of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(name);
        req.query[name] = values.length === 1 ? values[0] : values;
      }
      await handler(req, res);
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) return res.status(405).json({ message: "조회 요청만 사용할 수 있습니다." });
    const file = files.get(url.pathname);
    if (!file) return res.status(404).json({ message: "페이지를 찾을 수 없습니다." });
    const body = await fs.readFile(path.join(root, file[0]));
    res.setHeader("Content-Type", file[1]);
    res.setHeader("Cache-Control", "no-store");
    res.end(req.method === "HEAD" ? undefined : body);
  } catch { if (!res.headersSent) res.status(500).json({ message: "요청을 처리하지 못했습니다." }); else res.end(); }
});
server.on("error", (error) => { console.error(error.code === "EADDRINUSE" ? "이미 사용 중인 포트입니다." : "서버 실행에 실패했습니다."); process.exitCode = 1; });
server.listen(Number(process.env.PORT || 3001), "127.0.0.1", () => console.log(`집값 보기 실행 중: http://localhost:${process.env.PORT || 3001}`));
