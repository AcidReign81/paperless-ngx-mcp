import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { Annotations } from "./utils/annotations";
import { withErrorHandling } from "./utils/middlewares";

/**
 * Minimal read-only MCP surface for troubleshooting client initialization and
 * small tool results. Enabled with PAPERLESS_MCP_SAFE_MODE=1.
 *
 * No document body, binary data, custom fields or request credentials leave
 * this tool set. Normal server registrations are skipped entirely.
 */
export function registerDiagnosticTools(server: McpServer, api: PaperlessAPI): void {
  server.tool(
    "get_system_status",
    "Small read-only Paperless status response, suitable for testing MCP connectivity. No document contents.",
    {},
    Annotations.READ,
    withErrorHandling(async () => {
      const response = await api.request("/status/");
      return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
    })
  );

  server.tool(
    "list_documents",
    "List up to 10 recent document IDs and titles only, to test a small authenticated Paperless request. No document content or binaries.",
    {
      page_size: z.number().int().min(1).max(10).optional()
        .describe("At most 10 documents (default 3)."),
    },
    Annotations.READ,
    withErrorHandling(async (args) => {
      const docs = await api.getDocuments(
        `?page_size=${args.page_size ?? 3}&fields=id,title`
      );
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: docs.count,
            results: (docs.results ?? []).map((doc) => ({ id: doc.id, title: doc.title })),
          }),
        }],
      };
    })
  );
}
