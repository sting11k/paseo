import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForWorkspaceInSidebar } from "../support/helpers/workspace-ui";

// Laneworks fork: seats run in background workspaces the sidebar hides; the Supervisor's row
// carries their running state (packages/app/src/workspace-status/laneworks-related-activity.ts).
const PROJECT_KEY = "e2e-laneworks-project";

function laneworksLabels(role: string): Record<string, string> {
  return { "laneworks.project": PROJECT_KEY, "laneworks.role": role };
}

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

async function expectRowStatus(
  page: Page,
  workspaceId: string,
  status: "running" | "needs_input" | "none",
): Promise<void> {
  const row = workspaceRow(page, workspaceId);
  for (const indicator of ["running", "needs_input"] as const) {
    await expect(row.getByTestId(`workspace-status-indicator-${indicator}`)).toHaveCount(
      indicator === status ? 1 : 0,
      { timeout: 60_000 },
    );
  }
}

async function captureSidebar(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, clip: { x: 0, y: 0, width: 420, height: 520 } });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("a Laneworks Supervisor row shows the running state of its hidden seats", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = await seedWorkspace({
    repoPrefix: "laneworks-supervisor-status-",
    title: "Supervisor workspace",
  });

  try {
    const supervisor = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: seed.workspaceId,
      title: "Supervisor",
      modeId: "load-test",
      model: "thirty-minute-stream",
      labels: laneworksLabels("supervisor"),
    });
    const seatWorkspace = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: "Lead copy",
      background: true,
    });
    if (!seatWorkspace.workspace) {
      throw new Error(seatWorkspace.error ?? "Failed to create the background seat workspace");
    }
    const seatWorkspaceId = seatWorkspace.workspace.id;

    await gotoAppShell(page);
    await waitForWorkspaceInSidebar(page, {
      serverId: getServerId(),
      workspaceId: seed.workspaceId,
    });
    await expectRowStatus(page, seed.workspaceId, "none");
    await expect(workspaceRow(page, seatWorkspaceId)).toHaveCount(0);
    await captureSidebar(page, testInfo, "1-supervisor-idle");

    const lead = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: seatWorkspaceId,
      title: "Lead",
      modeId: "load-test",
      model: "thirty-minute-stream",
      initialPrompt: "keep streaming for the test",
      labels: laneworksLabels("lead"),
    });
    await expectRowStatus(page, seed.workspaceId, "running");
    await expect(workspaceRow(page, seatWorkspaceId)).toHaveCount(0);
    await captureSidebar(page, testInfo, "2-hidden-lead-running");

    await seed.client.sendAgentMessage(supervisor.id, "emit a synthetic plan approval");
    await expectRowStatus(page, seed.workspaceId, "needs_input");
    await captureSidebar(page, testInfo, "3-supervisor-needs-input-wins");

    await seed.client.cancelAgent(supervisor.id);
    await expectRowStatus(page, seed.workspaceId, "running");

    await seed.client.cancelAgent(lead.id);
    await expectRowStatus(page, seed.workspaceId, "none");
    await expect(workspaceRow(page, seatWorkspaceId)).toHaveCount(0);
    await captureSidebar(page, testInfo, "4-lead-stopped");
  } finally {
    await seed.cleanup().catch(() => undefined);
  }
});
