import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerDocumentTools } from "./documents";
import { registerSystemTools } from "./system";
import { createMockApi, createMockServer, getResourceContent, getTextContent } from "./test-helpers";
import { paperlessResourceUri } from "./utils/responses";

function imageContent(result: CallToolResult) {
  return result.content.find((part) => part.type === "image");
}

describe("MCP binary safety and image compatibility", () => {
  test("keeps absolute encoded URI for explicitly requested PDF resources", () => {
    const uri = paperlessResourceUri("documents", 42, "Ärztliche Unterlagen/2026.pdf");
    assert.equal(uri, "paperless://files/documents/42/%C3%84rztliche%20Unterlagen%2F2026.pdf");
    assert.equal(new URL(uri).protocol, "paperless:");
  });

  test("download_document does not fetch or return bytes without explicit opt-in", async () => {
    let calls = 0;
    const { tools, server } = createMockServer();
    registerDocumentTools(server, createMockApi({
      downloadDocument: async () => { calls++; return { data: Buffer.from("secret") }; },
    }));
    const result = await tools.get("download_document")!.callback({ id: 42 });
    assert.equal(calls, 0);
    assert.equal(getResourceContent(result), null);
    assert.equal((getTextContent(result) as { status: string }).status, "binary_suppressed");
  });

  test("download_document explicit mode resource retains URI and PDF bytes", async () => {
    const bytes = Buffer.from("%PDF-1.7", "utf8");
    const { server, tools } = createMockServer();
    registerDocumentTools(server, createMockApi({
      downloadDocument: async () => ({
        data: bytes,
        headers: { "content-disposition": 'attachment; filename="Bericht 2026.pdf"' },
      }),
    }));
    const result = await tools.get("download_document")!.callback({ id: 42, mode: "resource" });
    assert.deepEqual(getResourceContent(result), {
      uri: "paperless://files/documents/42/Bericht%202026.pdf",
      blob: bytes.toString("base64"),
      mimeType: "application/pdf",
    });
  });

  test("thumbnail defaults to metadata, but opted-in output uses native MCP image", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    let calls = 0;
    const { server, tools } = createMockServer();
    registerDocumentTools(server, createMockApi({
      getThumbnail: async () => { calls++; return { data: bytes, headers: { "content-type": "image/webp" } }; },
    }));
    const safe = await tools.get("get_document_thumbnail")!.callback({ id: 42 });
    assert.equal(calls, 0);
    assert.equal((getTextContent(safe) as { status: string }).status, "binary_suppressed");
    const result = await tools.get("get_document_thumbnail")!.callback({ id: 42, mode: "image" });
    assert.deepEqual(imageContent(result), {
      type: "image", data: bytes.toString("base64"), mimeType: "image/webp",
    });
    assert.equal(getResourceContent(result), null);
    assert.equal(calls, 1);
  });

  test("preview defaults to metadata and returns native thumbnail for image mode", async () => {
    let thumbnailCalls = 0;
    let pdfCalls = 0;
    const bytes = Buffer.from([4, 5, 6]);
    const { server, tools } = createMockServer();
    registerDocumentTools(server, createMockApi({
      getThumbnail: async () => {
        thumbnailCalls++;
        return { data: bytes, headers: { "content-type": "image/webp" } };
      },
      requestRaw: async () => {
        pdfCalls++;
        return { data: Buffer.from("%PDF"), headers: { "content-type": "application/pdf" } };
      },
    }));
    const safe = await tools.get("get_document_preview")!.callback({ id: 42 });
    assert.equal(thumbnailCalls + pdfCalls, 0);
    assert.equal((getTextContent(safe) as { status: string }).status, "binary_suppressed");
    const result = await tools.get("get_document_preview")!.callback({ id: 42, mode: "image" });
    assert.deepEqual(imageContent(result), {
      type: "image", data: bytes.toString("base64"), mimeType: "image/webp",
    });
    assert.equal(thumbnailCalls, 1);
    assert.equal(pdfCalls, 0);
    assert.match(JSON.stringify(result), /lower-resolution thumbnail/);
  });

  test("PDF preview uses explicitly requested resource mode", async () => {
    const pdf = Buffer.from("%PDF-1.7");
    const { server, tools } = createMockServer();
    registerDocumentTools(server, createMockApi({
      requestRaw: async () => ({
        data: pdf, headers: { "content-type": "application/pdf" },
      }),
    }));
    const result = await tools.get("get_document_preview")!.callback({ id: 42, mode: "resource" });
    assert.deepEqual(getResourceContent(result), {
      uri: "paperless://files/documents/42/preview.pdf",
      blob: pdf.toString("base64"),
      mimeType: "application/pdf",
    });
  });

  test("unexpected preview content is withheld", async () => {
    const { server, tools } = createMockServer();
    registerDocumentTools(server, createMockApi({
      requestRaw: async () => ({
        data: Buffer.from("private error details"),
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    }));
    const result = await tools.get("get_document_preview")!.callback({ id: 42, mode: "resource" });
    assert.equal((getTextContent(result) as { status: string }).status, "unsupported_preview_mime_type");
    assert.equal(JSON.stringify(result).includes("private error details"), false);
  });

  test("bulk ZIP does not POST until mode=resource and then includes only ZIP bytes", async () => {
    const bytes = Buffer.from([80, 75, 3, 4]);
    let calls = 0;
    const { server, tools } = createMockServer();
    registerSystemTools(server, createMockApi({
      requestRaw: async () => { calls++; return { data: bytes }; },
    }));
    const safe = await tools.get("download_documents_bulk")!.callback({ documents: [42] });
    assert.equal(calls, 0);
    assert.equal((getTextContent(safe) as { status: string }).status, "binary_suppressed");
    const result = await tools.get("download_documents_bulk")!.callback({ documents: [42], mode: "resource" });
    assert.deepEqual(getResourceContent(result), {
      uri: "paperless://files/documents/bulk-download.zip",
      blob: bytes.toString("base64"),
      mimeType: "application/zip",
    });
    assert.equal(calls, 1);
  });
});
