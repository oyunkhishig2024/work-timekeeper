/** Rank (цол) and job position (албан тушаал) work the same way; only the tables and error codes differ (PRD 12, 22.1). */
export type JobKind = "rank" | "position";

export interface JobKindConfig {
  catalog: string;
  assignment: string;
  catalogColumn: string;
  label: string;
  code: string;
  auditAction: string;
}

export const JOB_KINDS: Record<JobKind, JobKindConfig> = {
  rank: {
    catalog: "job_rank",
    assignment: "employee_rank_assignment",
    catalogColumn: "job_rank_id",
    label: "rank",
    code: "RANK",
    auditAction: "employee.rank_changed",
  },
  position: {
    catalog: "job_position",
    assignment: "employee_position_assignment",
    catalogColumn: "job_position_id",
    label: "position",
    code: "POSITION",
    auditAction: "employee.position_changed",
  },
};
