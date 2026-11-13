import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { buildRelatedAgentActivityIndex } from "./laneworks-related-activity";

const SUPERVISOR_WORKSPACE = "ws-supervisor";

interface SeatInput {
  id: string;
  role?: string;
  project?: string;
  workspaceId?: string;
  runningSince?: string;
  archivedAt?: string;
  labels?: Record<string, string>;
}

function seat(input: SeatInput): Agent {
  const labels =
    input.labels ??
    ({
      ...(input.project === undefined ? {} : { "laneworks.project": input.project }),
      ...(input.role === undefined ? {} : { "laneworks.role": input.role }),
    } satisfies Record<string, string>);
  return {
    serverId: "host-a",
    id: input.id,
    provider: "claude",
    status: input.runningSince ? "running" : "idle",
    turn: input.runningSince
      ? {
          phase: "open",
          turnId: `turn-${input.id}`,
          startedAt: new Date(input.runningSince),
          cancellationRequestId: null,
        }
      : { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-13T09:00:00.000Z"),
    updatedAt: new Date("2026-11-13T09:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-13T09:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo",
    workspaceId: input.workspaceId ?? `ws-${input.id}`,
    model: null,
    archivedAt: input.archivedAt ? new Date(input.archivedAt) : null,
    parentAgentId: null,
    labels,
  };
}

function supervisor(input?: Partial<SeatInput>): Agent {
  return seat({
    id: "supervisor",
    role: "supervisor",
    project: "proj-a",
    workspaceId: SUPERVISOR_WORKSPACE,
    ...input,
  });
}

function agentsOf(...agents: Agent[]): Map<string, Agent> {
  return new Map(agents.map((agent) => [agent.id, agent]));
}

describe("Laneworks related agent activity index", () => {
  it.each(["lead", "peer", "review"])(
    "marks the Supervisor workspace running while a %s runs in its own workspace",
    (role) => {
      const index = buildRelatedAgentActivityIndex(
        agentsOf(
          supervisor(),
          seat({
            id: role,
            role,
            project: "proj-a",
            workspaceId: `ws-${role}-background`,
            runningSince: "2026-11-13T10:00:00.000Z",
          }),
        ),
      );

      expect(Object.fromEntries(index)).toEqual({
        [SUPERVISOR_WORKSPACE]: {
          status: "running",
          enteredAt: new Date("2026-11-13T10:00:00.000Z"),
        },
      });
    },
  );

  it("marks the Supervisor workspace running while the Supervisor itself runs", () => {
    const index = buildRelatedAgentActivityIndex(
      agentsOf(supervisor({ runningSince: "2026-11-13T10:00:00.000Z" })),
    );

    expect(index.get(SUPERVISOR_WORKSPACE)).toEqual({
      status: "running",
      enteredAt: new Date("2026-11-13T10:00:00.000Z"),
    });
  });

  it("stays running until the last running seat stops", () => {
    const lead = seat({
      id: "lead",
      role: "lead",
      project: "proj-a",
      runningSince: "2026-11-13T10:00:00.000Z",
    });
    const peer = seat({
      id: "peer",
      role: "peer",
      project: "proj-a",
      runningSince: "2026-11-13T10:05:00.000Z",
    });
    const bothRunning = buildRelatedAgentActivityIndex(agentsOf(supervisor(), lead, peer));
    const leadStopped = buildRelatedAgentActivityIndex(
      agentsOf(supervisor(), seat({ id: "lead", role: "lead", project: "proj-a" }), peer),
      bothRunning,
    );
    const allStopped = buildRelatedAgentActivityIndex(
      agentsOf(
        supervisor(),
        seat({ id: "lead", role: "lead", project: "proj-a" }),
        seat({ id: "peer", role: "peer", project: "proj-a" }),
      ),
      leadStopped,
    );

    expect(bothRunning.get(SUPERVISOR_WORKSPACE)?.enteredAt).toEqual(
      new Date("2026-11-13T10:00:00.000Z"),
    );
    expect(leadStopped.get(SUPERVISOR_WORKSPACE)).toEqual({
      status: "running",
      enteredAt: new Date("2026-11-13T10:05:00.000Z"),
    });
    expect(allStopped.size).toBe(0);
  });

  it("clears when the last running seat is archived or removed", () => {
    const running = seat({
      id: "lead",
      role: "lead",
      project: "proj-a",
      runningSince: "2026-11-13T10:00:00.000Z",
    });
    const before = buildRelatedAgentActivityIndex(agentsOf(supervisor(), running));
    const archived = buildRelatedAgentActivityIndex(
      agentsOf(
        supervisor(),
        seat({
          id: "lead",
          role: "lead",
          project: "proj-a",
          runningSince: "2026-11-13T10:00:00.000Z",
          archivedAt: "2026-11-13T10:30:00.000Z",
        }),
      ),
      before,
    );
    const removed = buildRelatedAgentActivityIndex(agentsOf(supervisor()), before);

    expect(before.size).toBe(1);
    expect(archived.size).toBe(0);
    expect(removed.size).toBe(0);
  });

  it("ignores watchers, other projects, unlabeled, idle and archived agents", () => {
    const index = buildRelatedAgentActivityIndex(
      agentsOf(
        supervisor(),
        seat({
          id: "watcher",
          role: "watcher",
          project: "proj-a",
          runningSince: "2026-11-13T10:00:00.000Z",
        }),
        seat({
          id: "other-project-lead",
          role: "lead",
          project: "proj-b",
          runningSince: "2026-11-13T10:00:00.000Z",
        }),
        seat({ id: "unlabeled", labels: {}, runningSince: "2026-11-13T10:00:00.000Z" }),
        seat({
          id: "role-only",
          role: "lead",
          runningSince: "2026-11-13T10:00:00.000Z",
        }),
        seat({ id: "idle-peer", role: "peer", project: "proj-a" }),
        seat({
          id: "archived-review",
          role: "review",
          project: "proj-a",
          runningSince: "2026-11-13T10:00:00.000Z",
          archivedAt: "2026-11-13T10:30:00.000Z",
        }),
      ),
    );

    expect(index.size).toBe(0);
  });

  it("has no target when the project's Supervisor is missing or archived", () => {
    const runningLead = seat({
      id: "lead",
      role: "lead",
      project: "proj-a",
      runningSince: "2026-11-13T10:00:00.000Z",
    });

    expect(buildRelatedAgentActivityIndex(agentsOf(runningLead)).size).toBe(0);
    expect(
      buildRelatedAgentActivityIndex(
        agentsOf(supervisor({ archivedAt: "2026-11-13T09:30:00.000Z" }), runningLead),
      ).size,
    ).toBe(0);
  });

  it("marks every unarchived Supervisor workspace of the project", () => {
    const index = buildRelatedAgentActivityIndex(
      agentsOf(
        supervisor(),
        supervisor({ id: "second-supervisor", workspaceId: "ws-second-supervisor" }),
        seat({
          id: "lead",
          role: "lead",
          project: "proj-a",
          runningSince: "2026-11-13T10:00:00.000Z",
        }),
      ),
    );

    expect([...index.keys()].sort()).toEqual(["ws-second-supervisor", SUPERVISOR_WORKSPACE]);
  });

  it("follows the project key, not the parent chain, when a Lead is replaced", () => {
    const oldLead = seat({
      id: "old-lead",
      role: "lead",
      project: "proj-a",
      archivedAt: "2026-11-13T09:50:00.000Z",
    });
    const newLead = {
      ...seat({
        id: "new-lead",
        role: "lead",
        project: "proj-a",
        runningSince: "2026-11-13T10:00:00.000Z",
      }),
      parentAgentId: "old-lead",
    };

    expect(
      buildRelatedAgentActivityIndex(agentsOf(supervisor(), oldLead, newLead)).get(
        SUPERVISOR_WORKSPACE,
      ),
    ).toEqual({ status: "running", enteredAt: new Date("2026-11-13T10:00:00.000Z") });
  });

  it("moves to the new project's Supervisor when a seat's labels change", () => {
    const supervisorB = supervisor({
      id: "supervisor-b",
      project: "proj-b",
      workspaceId: "ws-supervisor-b",
    });
    const before = buildRelatedAgentActivityIndex(
      agentsOf(
        supervisor(),
        supervisorB,
        seat({
          id: "lead",
          role: "lead",
          project: "proj-a",
          runningSince: "2026-11-13T10:00:00.000Z",
        }),
      ),
    );
    const after = buildRelatedAgentActivityIndex(
      agentsOf(
        supervisor(),
        supervisorB,
        seat({
          id: "lead",
          role: "lead",
          project: "proj-b",
          runningSince: "2026-11-13T10:00:00.000Z",
        }),
      ),
      before,
    );

    expect([...before.keys()]).toEqual([SUPERVISOR_WORKSPACE]);
    expect([...after.keys()]).toEqual(["ws-supervisor-b"]);
  });

  it("keeps the previous index identity while activity is unchanged", () => {
    const agents = agentsOf(
      supervisor(),
      seat({
        id: "lead",
        role: "lead",
        project: "proj-a",
        runningSince: "2026-11-13T10:00:00.000Z",
      }),
    );
    const previous = buildRelatedAgentActivityIndex(agents);
    const idle = new Map<string, never>();

    expect(buildRelatedAgentActivityIndex(new Map(agents), previous)).toBe(previous);
    expect(buildRelatedAgentActivityIndex(agentsOf(supervisor()), idle)).toBe(idle);
  });
});
