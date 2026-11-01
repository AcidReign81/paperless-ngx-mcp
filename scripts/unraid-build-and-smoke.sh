#!/usr/bin/env bash
# One-time, non-destructive Unraid build and MCP smoke test.
# This script does NOT stop, alter, restart or remove the production container.
set -Eeuo pipefail

REPO="https://github.com/AcidReign81/paperless-ngx-mcp.git"
BRANCH="fix/chatgpt-safe-binary-diagnostics"
IMAGE="paperless-mcp-fork:chatgpt-safe"
WORKDIR="$(mktemp -d /tmp/paperless-mcp-build.XXXXXX)"
TEST_NAME="paperless-mcp-safe-smoke-$$"
TEST_ID=""
cleanup() {
  if [ -n "$TEST_ID" ]; then
    docker rm -f "$TEST_ID" >/dev/null 2>&1 || true
    TEST_ID=""
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

for binary in docker git; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "FEHLER: '$binary' ist auf diesem Unraid-Server nicht verfügbar."
    exit 1
  fi
done

if ! docker info >/dev/null 2>&1; then
  echo "FEHLER: Docker ist auf Unraid nicht erreichbar."
  exit 1
fi

echo "[1/4] Reparatur-Branch von deinem GitHub-Fork laden ..."
git clone --quiet --depth 1 --single-branch --branch "$BRANCH" "$REPO" "$WORKDIR/source"
COMMIT="$(git -C "$WORKDIR/source" rev-parse --short HEAD)"
echo "      GitHub-Commit: $COMMIT"

echo "[2/4] Docker-Image $IMAGE bauen ..."
docker build --pull --tag "$IMAGE" "$WORKDIR/source"

echo "[3/4] Isolierten MCP-Testcontainer starten (keine Paperless-Zugangsdaten) ..."
TEST_ID="$(docker run --detach --rm --name "$TEST_NAME" \
  --env PAPERLESS_URL=http://127.0.0.1:1 \
  --env PAPERLESS_API_KEY=unraid-smoke-test-only \
  --env PAPERLESS_MCP_SAFE_MODE=1 \
  "$IMAGE" --http --port 3000)"

echo "[4/4] MCP-Initialisierung und Werkzeugliste prüfen ..."
docker exec -i "$TEST_ID" node <<'NODE'
const url = "http://127.0.0.1:3000/mcp";
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const init = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "unraid-smoke", version: "1" } }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function run() {
  let response;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(init), signal: AbortSignal.timeout(3000) });
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await pause(400);
    }
  }
  const initBody = await response.text();
  const session = response.headers.get("mcp-session-id");
  if (response.status !== 200 || !session || !initBody.includes("result")) {
    throw new Error(`MCP initialize failed (HTTP ${response.status}, session=${Boolean(session)})`);
  }
  const listResponse = await fetch(url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": session },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(8000),
  });
  const listBody = await listResponse.text();
  if (listResponse.status !== 200 ||
      !listBody.includes('"get_system_status"') ||
      !listBody.includes('"list_documents"') ||
       listBody.includes('"get_document_preview"')) {
    throw new Error(`Unexpected tool list: HTTP ${listResponse.status}; status-only diagnostics failed`);
  }
  console.log("OK: MCP initialize, session and two read-only diagnostic tools respond.");
}
run().catch((err) => { console.error(err.message); process.exitCode = 1; });
NODE

echo
echo "ERFOLG: Image $IMAGE (Commit $COMMIT) wurde gebaut und der MCP-Minimalmodus getestet."
echo "Dein vorhandener Container Paperless-NGX-MCP wurde NICHT verändert."
echo "Jetzt kannst du in Unraid beim Container die Repository/Image-Angabe auf $IMAGE setzen."
