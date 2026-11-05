import { parseAgentMessage } from "./agent-messages/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
  AgentListItemPayloadSchema,
  AgentSnapshotPayloadSchema,
} from "@getpaseo/protocol/messages";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { CodexAppServerAgentClient } from "./providers/codex-app-server-agent.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";

// Opt in to the same workflow with the installed providers instead of test clients.
const real = process.env.PASEO_ARCHIVE_REAL === "1";
const StatusSchema = z.object({ snapshot: AgentSnapshotPayloadSchema });
const ListSchema = z.object({ agents: z.array(AgentListItemPayloadSchema) });

test.each(["codex", "claude"] as const)(
  "archived %s history remains archived across MCP discovery",
  async (provider) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "archive-discovery-"));
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: real
        ? {
            [provider]:
              provider === "codex"
                ? new CodexAppServerAgentClient(logger)
                : new ClaudeAgentClient({ logger }),
          }
        : createTestAgentClients(),
      pluginsEnabled: false,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const mcp = new Client({ name: "archive-discovery-test", version: "1.0.0" });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await mcp.callTool({ name, arguments: args });
      if (result.isError) throw new Error(JSON.stringify(result.content));
      return result.structuredContent;
    };
    const list = async (includeArchived: boolean) =>
      ListSchema.parse(await call("list_agents", { cwd, includeArchived })).agents;
    const status = async (agentId: string) =>
      StatusSchema.parse(await call("get_agent_status", { agentId })).snapshot;
    try {
      await client.connect();
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp/agents`)),
      );
      const realModel = provider === "codex" ? "gpt-5.6-sol" : "haiku";
      const agent = await client.createAgent({
        config: {
          provider,
          cwd,
          model: real ? realModel : undefined,
          modeId: provider === "codex" ? "full-access" : "bypassPermissions",
        },
      });
      await daemon.daemon.agentManager.runAgent(
        agent.id,
        "Reply with ARCHIVE_OK. Do not use tools.",
      );
      expect((await list(false)).map((item) => item.id)).toContain(agent.id);
      await call("archive_agent", { agentId: agent.id });
      const archivedAt = (await status(agent.id)).archivedAt;
      expect(archivedAt).toEqual(expect.any(String));
      expect((await list(false)).map((item) => item.id)).not.toContain(agent.id);

      const timeline = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
      expect(timeline.entries.length).toBeGreaterThan(0);
      expect.soft((await status(agent.id)).archivedAt).toBe(archivedAt);
      expect.soft((await list(false)).map((item) => item.id)).not.toContain(agent.id);
      expect
        .soft((await list(true)).find((item) => item.id === agent.id)?.archivedAt)
        .toBe(archivedAt);
      const ordinary = await client.fetchAgents({ filter: { includeArchived: false } });
      expect.soft(ordinary.entries.map((entry) => entry.agent.id)).not.toContain(agent.id);
      const inclusive = await client.fetchAgents({ filter: { includeArchived: true } });
      expect
        .soft(inclusive.entries.find((entry) => entry.agent.id === agent.id)?.agent.archivedAt)
        .toBe(archivedAt);

      await client.refreshAgent(agent.id);
      expect((await status(agent.id)).archivedAt).toBeNull();
      expect((await list(false)).map((item) => item.id)).toContain(agent.id);
    } finally {
      await mcp.close();
      await client.close();
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);

test("CLI archive resolves exact closed background UUID outside discovery", async () => {
  const { createDaemonTestContext } = await import("../test-utils/daemon-test-context.js");
  const ctx = await createDaemonTestContext({ pluginsEnabled: false, relayEnabled: false });
  const cwd = await mkdtemp(join(tmpdir(), "paseo-cli-archive-audit-"));
  const run = promisify(execFile);
  try {
    const hidden = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      background: true,
      title: "Audit background",
    });
    const visible = await ctx.client.createAgent({
      provider: "codex",
      cwd: await mkdtemp(join(cwd, "visible-")),
      title: "Audit visible",
    });
    await ctx.daemon.daemon.agentManager.closeAgent(hidden.id);
    await ctx.daemon.daemon.agentManager.closeAgent(visible.id);
    expect((await ctx.client.fetchAgent({ agentId: hidden.id }))?.agent).toMatchObject({
      status: "closed",
      archivedAt: null,
    });
    const cli = async (args: string[]) => {
      try {
        const result = await run(
          process.execPath,
          [
            "--import",
            "tsx",
            resolvePath("packages/cli/src/index.ts"),
            "--host",
            `127.0.0.1:${ctx.daemon.port}`,
            ...args,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, PASEO_HOME: ctx.daemon.paseoHome, PASEO_HOST: "" },
            timeout: 25_000,
          },
        );
        return { code: 0, ...result };
      } catch (error) {
        const result = error as Error & { code: number; stdout: string; stderr: string };
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      }
    };
    const inspect = await cli(["inspect", hidden.id, "--json"]);
    expect(inspect.code, inspect.stderr).toBe(0);
    const archive = await cli(["archive", hidden.id, "--json"]);
    expect(archive.code, archive.stderr).toBe(0);
    const control = await cli(["archive", visible.id, "--json"]);
    expect(control.code, control.stderr).toBe(0);
    expect((await ctx.client.fetchAgent({ agentId: hidden.id }))?.agent).toMatchObject({
      status: "closed",
      archivedAt: expect.any(String),
    });
    console.log("AUDIT CLI", {
      inspect: inspect.code,
      backgroundArchive: archive.code,
      visibleArchive: control.code,
    });
  } finally {
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);

test.each(["archive-first", "send-first", "cascade"])(
  "guarded send serializes %s across awaited resume",
  async (order) => {
    let release!: () => void;
    let entered!: () => void;
    const loading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finishModel!: () => void;
    let modelCompleted = false;
    const modelGate = new Promise<void>((done) => {
      finishModel = done;
    });
    const prompts: unknown[] = [];
    const daemon = await createTestPaseoDaemon({
      pluginsEnabled: false,
      relayEnabled: false,
      agentClients: createTestAgentClients({
        beforeResumeSession: async () => {
          entered();
          await gate;
        },
        beforeTurnComplete: async () => {
          await modelGate;
          modelCompleted = true;
        },
        onStartTurn: (prompt) => {
          prompts.push(prompt);
        },
      }),
    });
    const { DaemonClient: SourceClient } = await import("../../../../client/src/daemon-client.js");
    const { WebSocket } = await import("ws");
    const client = new SourceClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: `guard-${order}`,
      webSocketFactory: (url, options) => new WebSocket(url, options?.protocols),
    });
    const cwd = await mkdtemp(path.join(os.tmpdir(), "guarded-send-"));
    try {
      await client.connect();
      const parent = await client.createAgent({ provider: "codex", cwd, modeId: "full-access" });
      const agent = await client.createAgent({
        provider: "codex",
        workspaceId: parent.workspaceId,
        cwd,
        modeId: "full-access",
        labels: { "paseo.parent-agent-id": parent.id },
      });
      await daemon.daemon.agentManager.closeAgent(agent.id);
      if (order === "archive-first") {
        await client.archiveAgent(agent.id);
        await expect(
          client.sendIfNotArchived(agent.id, "automated", {
            sourceAgentId: parent.id,
            sourceAgentServerId: "source-host",
            messageId: "guarded-automated",
          }),
        ).rejects.toMatchObject({
          code: "AGENT_ARCHIVED",
        });
        expect(prompts).toEqual([]);
        release();
        await client.sendAgentMessage(agent.id, "human");
        expect((await client.fetchAgent({ agentId: agent.id }))?.agent.archivedAt).toBeNull();
        expect(prompts).toEqual(["human"]);
        finishModel();
        await client.waitForFinish(agent.id, 5_000);
        // Definite refusal must not poison the message receipt with unknown outcome.
        await client.sendIfNotArchived(agent.id, "automated", {
          sourceAgentId: parent.id,
          sourceAgentServerId: "source-host",
          messageId: "guarded-automated",
        });
        expect(prompts).toHaveLength(2);
        expect(parseAgentMessage(String(prompts[1]))).toMatchObject({
          text: "automated",
          source: { agentId: parent.id, serverId: "source-host" },
        });
      } else {
        const sending = client.sendIfNotArchived(agent.id, "automated", {
          sourceAgentId: parent.id,
          sourceAgentServerId: "source-host",
          messageId: "guarded-automated",
        });
        await loading;
        const archiving =
          order === "cascade"
            ? daemon.daemon.agentManager.archiveAgent(parent.id)
            : daemon.daemon.agentManager.archiveSnapshot(agent.id, new Date().toISOString());
        release();
        await sending;
        expect(modelCompleted).toBe(false);
        await archiving;
        expect(modelCompleted).toBe(false);
        expect(prompts).toHaveLength(1);
        expect(parseAgentMessage(String(prompts[0]))).toMatchObject({
          text: "automated",
          source: { agentId: parent.id, serverId: "source-host" },
        });
        expect((await client.fetchAgent({ agentId: agent.id }))?.agent.archivedAt).toEqual(
          expect.any(String),
        );
        await expect(client.sendIfNotArchived(agent.id, "late")).rejects.toMatchObject({
          code: "AGENT_ARCHIVED",
        });
        expect(prompts).toHaveLength(1);
        expect(parseAgentMessage(String(prompts[0]))).toMatchObject({
          text: "automated",
          source: { agentId: parent.id, serverId: "source-host" },
        });
      }
    } finally {
      release();
      finishModel();
      await client.close();
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);
