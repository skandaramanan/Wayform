#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { ContextStore, type ParsedEntry } from "./store.js";

function projectContext(
  project: string,
  entries: ParsedEntry[],
  total: number,
): string {
  if (total === 0) {
    return `# Shared context: ${project}\n\n(No entries yet. Use write_context to record the first decision.)`;
  }
  const header =
    total > entries.length
      ? `# Shared context: ${project}\n\n_Showing the ${entries.length} most recent of ${total} entries._`
      : `# Shared context: ${project}`;
  const body = entries
    .map(
      (e) =>
        `## ${e.type} — ${e.author} — ${e.timestamp}\n\n${e.payload}`,
    )
    .join("\n\n---\n\n");
  return `${header}\n\n${body}`;
}

async function main() {
  const cfg = loadConfig();
  const store = new ContextStore(cfg);
  await store.ensure();

  const server = new McpServer({
    name: "memorylayer",
    version: "0.1.0",
  });

  server.registerTool(
    "read_context",
    {
      title: "Read shared planning context",
      description:
        "Pull the latest shared planning context for a project and return the current projected state (all recorded decisions and context, in write order). Call this at the START of a planning turn so decisions written by collaborators are already present without anyone pasting them.",
      inputSchema: {
        project: z
          .string()
          .describe("The shared project/space name, e.g. 'business-one'."),
      },
    },
    async ({ project }) => {
      const { entries, total } = await store.read(project);
      return {
        content: [
          { type: "text", text: projectContext(project, entries, total) },
        ],
      };
    },
  );

  server.registerTool(
    "write_context",
    {
      title: "Write a shared planning decision",
      description:
        "Append a DELIBERATE decision or established context to the shared project space and commit it, so collaborators' sessions see it. Write decisions ('we decided X because Y') and durable context — NOT a firehose of every reasoning step.",
      inputSchema: {
        project: z
          .string()
          .describe("The shared project/space name, e.g. 'business-one'."),
        type: z
          .enum(["decision", "context"])
          .default("decision")
          .describe("'decision' for a settled call, 'context' for durable background."),
        payload: z
          .string()
          .describe(
            "The decision or context, stated plainly. For decisions, include the 'because' — the reasoning that settles it.",
          ),
        author: z
          .string()
          .optional()
          .describe(
            "Who is recording this. Defaults to the configured MEMORYLAYER_AUTHOR.",
          ),
      },
    },
    async ({ project, type, payload, author }) => {
      const entry = await store.write(project, {
        author: author?.trim() || cfg.author,
        type,
        payload,
      });
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${entry.type} in '${project}' as ${entry.author} at ${entry.timestamp} (${entry.file}).`,
          },
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport owns stdout; log to stderr only.
  console.error(
    `memorylayer MCP server ready (author=${cfg.author}, store=${cfg.repoPath})`,
  );
}

main().catch((err) => {
  console.error("memorylayer failed to start:", err);
  process.exit(1);
});
