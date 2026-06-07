import type { Principal } from "../authz.js";
import type { FrickStore } from "../store.js";
import type { JobRow, JobStatus } from "../storage/job-store.js";

const DEFAULT_JOB_LIMIT = 50;
const MAX_JOB_LIMIT = 200;

const JOB_STATUSES = new Set<JobStatus>([
  "ready",
  "running",
  "completed",
  "dead_lettered",
]);

export interface DashboardJobRow {
  readonly id: number;
  readonly tenantId: string;
  readonly jobType: string;
  readonly status: JobStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly createdAt: string;
  readonly claimedAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly deadLetteredAt?: string;
  readonly lastErrorCode?: string;
}

export interface DashboardJobs {
  readonly schemaHash: string;
  readonly tenantId?: string;
  readonly scope: "tenant" | "admin";
  readonly status?: JobStatus;
  readonly jobType?: string;
  readonly limit: number;
  readonly count: number;
  readonly truncated: boolean;
  readonly jobs: readonly DashboardJobRow[];
}

export interface BuildDashboardJobsInput {
  readonly store: FrickStore;
  readonly principal: Principal;
  readonly tenantId?: string;
  readonly status?: string;
  readonly jobType?: string;
  readonly limit?: number;
}

export async function buildDashboardJobs(input: BuildDashboardJobsInput): Promise<DashboardJobs> {
  const scope = input.principal.scope === "admin" ? "admin" : "tenant";
  const tenantId = scope === "admin" ? input.tenantId : input.principal.tenantId;
  const status = normalizeDashboardJobStatus(input.status);
  const jobType = normalizeDashboardJobType(input.jobType);
  const limit = normalizeDashboardJobLimit(input.limit);
  const rows = await input.store.jobs.list({
    ...(tenantId ? { tenantId } : {}),
    ...(status ? { status } : {}),
    ...(jobType ? { jobType } : {}),
    limit: limit + 1,
  });
  const jobs = rows.slice(0, limit).map(toDashboardJobRow);

  return {
    schemaHash: input.store.schema.hash,
    ...(tenantId ? { tenantId } : {}),
    scope,
    ...(status ? { status } : {}),
    ...(jobType ? { jobType } : {}),
    limit,
    count: jobs.length,
    truncated: rows.length > jobs.length,
    jobs,
  };
}

export function normalizeDashboardJobLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_JOB_LIMIT;
  }
  return Math.min(MAX_JOB_LIMIT, Math.floor(value));
}

function normalizeDashboardJobStatus(value: string | undefined): JobStatus | undefined {
  return value !== undefined && JOB_STATUSES.has(value as JobStatus)
    ? value as JobStatus
    : undefined;
}

function normalizeDashboardJobType(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toDashboardJobRow(row: JobRow): DashboardJobRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    jobType: row.jobType,
    status: row.status,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    createdAt: row.createdAt,
    ...(row.claimedAt ? { claimedAt: row.claimedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.failedAt ? { failedAt: row.failedAt } : {}),
    ...(row.deadLetteredAt ? { deadLetteredAt: row.deadLetteredAt } : {}),
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
  };
}
