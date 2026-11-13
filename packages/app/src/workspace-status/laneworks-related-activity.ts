import { getWorkspaceStateBucketPriority } from "@getpaseo/protocol/agent-state-bucket";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";

/*
 * Laneworks fork extension; upstream Paseo has no equivalent.
 *
 * Laneworks runs a project's Lead, Peer and Review seats in background workspaces, which the
 * sidebar hides, so the Supervisor's workspace row is the only row that can show their work.
 * This index marks that row running while the Supervisor or any of those seats has an open turn.
 *
 * Seats match by the labels Laneworks stamps on every agent it creates, keyed by project rather
 * than by parent chain: a replaced Lead, or a seat created by another seat, still counts. The
 * index is derived from the app's complete agent directory (background agents included), so a
 * seat that stops, is archived, is removed or changes its labels drops out on the next agent
 * update with no remembered target. It is display data only: agent status, the daemon's
 * workspace status and background visibility are unchanged.
 */
const PROJECT_LABEL = "laneworks.project";
const ROLE_LABEL = "laneworks.role";
const SUPERVISOR_ROLE = "supervisor";
const RELATED_ROLES: ReadonlySet<string> = new Set([SUPERVISOR_ROLE, "lead", "peer", "review"]);

export interface RelatedAgentActivity {
  status: "running";
  enteredAt: Date;
}

interface WorkspaceStatusView {
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
}

/** Supervisor workspace id → running activity of its project's seats. */
export function buildRelatedAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, RelatedAgentActivity>,
): Map<string, RelatedAgentActivity> {
  const supervisorWorkspaceIdsByProject = new Map<string, Set<string>>();
  const runningSinceByProject = new Map<string, Date>();

  for (const agent of agents.values()) {
    const project = agent.labels[PROJECT_LABEL];
    const role = agent.labels[ROLE_LABEL];
    if (agent.archivedAt || !project || !role || !RELATED_ROLES.has(role)) {
      continue;
    }
    if (role === SUPERVISOR_ROLE && agent.workspaceId) {
      const workspaceIds = supervisorWorkspaceIdsByProject.get(project) ?? new Set<string>();
      workspaceIds.add(agent.workspaceId);
      supervisorWorkspaceIdsByProject.set(project, workspaceIds);
    }
    if (agent.turn.phase === "open") {
      // Earliest open turn, so overlapping seats read as one continuous running period.
      const startedAt = agent.turn.startedAt ?? agent.updatedAt;
      const runningSince = runningSinceByProject.get(project);
      if (!runningSince || startedAt < runningSince) {
        runningSinceByProject.set(project, startedAt);
      }
    }
  }

  const next = new Map<string, RelatedAgentActivity>();
  for (const [project, runningSince] of runningSinceByProject) {
    for (const workspaceId of supervisorWorkspaceIdsByProject.get(project) ?? []) {
      const existing = next.get(workspaceId);
      if (!existing || runningSince < existing.enteredAt) {
        next.set(workspaceId, { status: "running", enteredAt: runningSince });
      }
    }
  }

  return reuseUnchangedEntries(next, previous);
}

/**
 * Seat activity raises the row to running only from a lower-priority bucket (attention, done).
 * The row's own needs_input and failed stay on top, in the priority order the daemon uses to
 * aggregate a workspace's own agents.
 */
export function applyRelatedAgentActivity(
  own: WorkspaceStatusView,
  related: RelatedAgentActivity | undefined,
): WorkspaceStatusView {
  if (
    !related ||
    getWorkspaceStateBucketPriority(own.status) <= getWorkspaceStateBucketPriority(related.status)
  ) {
    return own;
  }
  return related;
}

// Agent updates rebuild the index constantly; unchanged entries keep their identity so the
// sidebar does not re-render for activity that did not move.
function reuseUnchangedEntries(
  next: Map<string, RelatedAgentActivity>,
  previous: ReadonlyMap<string, RelatedAgentActivity> | undefined,
): Map<string, RelatedAgentActivity> {
  if (!previous) {
    return next;
  }
  let unchanged = previous.size === next.size;
  for (const [workspaceId, activity] of next) {
    const prior = previous.get(workspaceId);
    if (prior && prior.enteredAt.getTime() === activity.enteredAt.getTime()) {
      next.set(workspaceId, prior);
    } else {
      unchanged = false;
    }
  }
  return unchanged && previous instanceof Map ? previous : next;
}
