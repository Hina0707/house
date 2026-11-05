"use strict";

// 정적 화면과 API가 별도로 배포되는 구성을 검증합니다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");

test("배포 파일에는 화면만 포함하고 API와 로컬 서버는 분리한다", () => {
  execFileSync(process.execPath, [path.join(root, "tools/build.cjs")]);
  assert.deepEqual(fs.readdirSync(path.join(root, "dist")).sort(), ["index.html", "regions.json", "script.js", "style.css"]);
  const html = fs.readFileSync(path.join(root, "dist/index.html"), "utf8");
  assert.ok(html.includes('src="script.js"'));
  assert.equal(fs.existsSync(path.join(root, "app.js")), false);
  assert.equal(fs.existsSync(path.join(root, "server.cjs")), false);
  const config = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, "dist");
  assert.ok(fs.existsSync(path.join(root, "api/trades.js")));
});
