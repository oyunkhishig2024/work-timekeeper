/** Rank (цол) and job position (албан тушаал) are free text with an effective-dated history (PRD 12, 22.1). */
export type JobKind = "rank" | "position";

export interface JobKindConfig {
  assignment: string;
  label: string;
  code: string;
  auditAction: string;
}

export const JOB_KINDS: Record<JobKind, JobKindConfig> = {
  rank: {
    assignment: "employee_rank_assignment",
    label: "rank",
    code: "RANK",
    auditAction: "employee.rank_changed",
  },
  position: {
    assignment: "employee_position_assignment",
    label: "position",
    code: "POSITION",
    auditAction: "employee.position_changed",
  },
};
