import { CallToolResult } from "@modelcontextprotocol/sdk/types";

const CONFIRM_MESSAGE =
  "Confirmation required for destructive operation. Set confirm: true to proceed.";

export function requireConfirm(confirm: boolean | undefined): void {
  if (!confirm) throw new Error(CONFIRM_MESSAGE);
}

export const deletedResponse = (): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ status: "deleted" }) }],
});

export function parseFilenameFromContentDisposition(
  header: string | null | undefined,
  fallback: string
): string {
  return (
    header?.split("filename=")[1]?.replace(/"/g, "") || fallback
  );
}

/**
 * Embedded MCP resources require absolute URIs, rather than bare filenames.
 * This URI identifies inline content; it is not a fetchable URL.
 */
export function paperlessResourceUri(...segments: (string | number)[]): string {
  return `paperless://files/${segments
    .map((segment) => encodeURIComponent(String(segment)))
    .join("/")}`;
}

/**
 * Keep binary tool calls safe-by-default for clients that cannot ingest large
 * embedded MCP resources. This result contains neither document data nor IDs.
 */
export function binaryModeNotice(tool: string, optInMode: "image" | "resource"): CallToolResult {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        tool,
        status: "binary_suppressed",
        mode: "metadata",
        message: `No binary content returned. If explicitly required, call again with mode="${optInMode}".`,
      }),
    }],
  };
}

/** Logs only non-sensitive tool names, sizes and modes. Never log binary bytes. */
export function logBinaryTransfer(tool: string, sizeBytes: number, mode: string): void {
  if (process.env.PAPERLESS_MCP_DIAGNOSTICS !== "1") return;
  console.info(JSON.stringify({ event: "mcp_binary_result", tool, sizeBytes, mode }));
}
