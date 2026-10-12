#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("package.json version must be semver, got: " + version);
  process.exit(1);
}

function stamp(html, ver) {
  let next = html.replace(
    /(<meta\s+name="app-version"\s+content=")[^"]*(")/,
    "$1" + ver + "$2"
  );
  next = next.replace(
    /(<span\b[^>]*\bdata-version-slot\b[^>]*>)[^<]*/,
    "$1v" + ver
  );
  if (!next.includes('name="app-version" content="' + ver + '"')) {
    throw new Error("Missing <meta name=\"app-version\"> in index.html");
  }
  if (!next.includes(">v" + ver + "<")) {
    throw new Error("Missing [data-version-slot] in index.html");
  }
  return next;
}

const srcPath = path.join(root, "index.html");
const html = fs.readFileSync(srcPath, "utf8");
const stamped = stamp(html, version);

if (stamped !== html) {
  fs.writeFileSync(srcPath, stamped);
  console.log("updated index.html to v" + version);
}

const distDir = path.join(root, "dist");
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, "index.html"), stamped);
console.log("dist/index.html v" + version);
