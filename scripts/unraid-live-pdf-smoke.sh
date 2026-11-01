#!/usr/bin/env bash
# Live, READ-ONLY PDF smoke test against the already-running MCP container.
# No documents, Paperless configuration, or docker container settings are changed.
set -Eeuo pipefail
CONTAINER="Paperless-NGX-MCP"
echo "Pruefe laufenden MCP-Container und neue PDF-Werkzeuge ..."
docker inspect --format '{{.Config.Image}}: {{.State.Status}}' "$CONTAINER"
docker exec -i "$CONTAINER" node <<'NODE'
const assert = require("node:assert/strict");
const url = "http://127.0.0.1:3000/mcp";
const commonHeaders = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};
let session;

function parseRpcResponse(raw) {
  const events = raw.split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim());
  const candidates = events.length ? events : [raw];
  for (const item of candidates) {
    let parsed;
    try { parsed = JSON.parse(item); } catch { continue; }
    if (parsed.error) throw Error("MCP-RPC-Fehler: " + (parsed.error.message || "unknown"));
    if ("result" in parsed) return parsed.result;
  }
  throw Error("Keine auswertbare JSON-RPC-Antwort erhalten");
}

async function request(method, params, id) {
  const result = await fetch(url, {
    method: "POST",
    headers: {
      ...commonHeaders,
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    signal: AbortSignal.timeout(90000),
  });
  if (!session) session = result.headers.get("mcp-session-id") || undefined;
  const raw = await result.text();
  assert.equal(result.status, 200, "MCP HTTP " + result.status + ": " + raw.slice(0, 150));
  return parseRpcResponse(raw);
}

function toolResult(result, name) {
  if (result.isError) throw Error("MCP-Tool " + name + " meldet einen Fehler: " + (result.content || []).filter(p => p.type === "text").map(p => p.text).join(" ").slice(0, 600));
  const content = result.content || [];
  const text = content.find(item => item.type === "text");
  return { content, body: text ? JSON.parse(text.text) : {} };
}

async function run() {
  const init = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "unraid-live-pdf-check", version: "1" },
  }, 1);
  assert.ok(init.serverInfo && session, "MCP-Initialisierung fehlgeschlagen");
  const list = await request("tools/list", {}, 2);
  const names = new Set((list.tools || []).map(t => t.name));
  for (const name of ["list_documents", "get_document_pdf_info", "get_document_pdf_page"]) {
    assert.ok(names.has(name), "MCP-Werkzeug fehlt: " + name);
  }
  console.log("OK: Beide PDF-Werkzeuge stehen am Live-MCP bereit.");

  const candidates = toolResult(await request("tools/call", {
    name: "list_documents",
    arguments: { page_size: 25 },
  }, 3), "list_documents").body.results || [];
  const selected = candidates.find(d => d.page_count >= 2 && d.mime_type === "application/pdf");
  assert.ok(selected, "Kein mindestens zweiseitiges PDF unter den neuesten 25 Dokumenten gefunden");

  const info = toolResult(await request("tools/call", {
    name: "get_document_pdf_info",
    arguments: { id: selected.id },
  }, 4), "get_document_pdf_info").body;
  assert.equal(info.status, "ok");
  assert.ok(info.pageCount >= 2);
  console.log("OK: Echtes mehrseitiges PDF erkannt (" + info.pageCount + " Seiten).");

  const result = toolResult(await request("tools/call", {
    name: "get_document_pdf_page",
    arguments: { id: selected.id, page: 2, max_dimension: 900 },
  }, 5), "get_document_pdf_page");

  const image = result.content.find(p => p.type === "image");
  assert.ok(image, "Keine native MCP-Bildantwort fuer Seite 2");
  assert.equal(image.mimeType, "image/jpeg");
  const jpeg = Buffer.from(image.data, "base64");
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.equal(result.body.page, 2);
  assert.equal(result.body.pageCount, info.pageCount);
  console.log("OK: Seite 2 als JPEG und Seitentext ueber MCP empfangen (" +
    jpeg.byteLength + " Bildbytes, " +
    (result.body.selectableText || "").length + " Textzeichen).");
  console.log("ERFOLG: Vollstaendiger, read-only PDF-Seitenzugriff funktioniert am Live-MCP.");
}

run().catch(err => { console.error("FEHLER:", err.message); process.exitCode = 1; });
NODE
