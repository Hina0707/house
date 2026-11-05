"use strict";

// 배포할 화면 파일만 dist에 복사하고 서버 코드와 인증키는 포함하지 않습니다.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
const files = ["index.html", "style.css", "script.js", "regions.json"];
fs.mkdirSync(output, { recursive: true });
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(output, file));
console.log(`정적 화면 ${files.length}개를 dist에 준비했습니다.`);
