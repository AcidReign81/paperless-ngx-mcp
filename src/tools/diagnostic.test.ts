import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerDiagnosticTools } from "./diagnostic";
import { createMockApi, createMockServer, getTextContent } from "./test-helpers";

describe("minimal MCP diagnostic mode", () => {
  test("registers only two compact read-only tools", () => {
    const { server, tools } = createMockServer();
    registerDiagnosticTools(server, createMockApi());
    assert.deepEqual([...tools.keys()], ["get_system_status", "list_documents"]);
    assert.equal([...tools.keys()].some((name) => /download|preview|thumbnail/.test(name)), false);
  });

  test("status returns JSON without document content", async () => {
    const { server, tools } = createMockServer();
    registerDiagnosticTools(server, createMockApi({
      request: async (path: string) => {
        assert.equal(path, "/status/");
        return { status: "ok", task_queue: "ok" };
      },
    }));
    assert.deepEqual(getTextContent(await tools.get("get_system_status")!.callback({})), {
      status: "ok", task_queue: "ok",
    });
  });

  test("lists only IDs and titles, omitting document contents and other metadata", async () => {
    let query = "";
    const { server, tools } = createMockServer();
    registerDiagnosticTools(server, createMockApi({
      getDocuments: async (q: string) => {
        query = q;
        return {
          count: 1,
          results: [{
            id: 42, title: "Sample", content: "private document",
            custom_fields: [{ name: "secret" }],
          }],
        };
      },
    }));
    const result = await tools.get("list_documents")!.callback({ page_size: 3 });
    assert.equal(query, "?page_size=3&fields=id,title");
    assert.deepEqual(getTextContent(result), {
      count: 1,
      results: [{ id: 42, title: "Sample" }],
    });
    assert.equal(JSON.stringify(result).includes("private document"), false);
  });
});
