/** Tenant user roles (PRD 4). Super Admin accounts are platform users, not tenant users. */
export type Role = "ORG_ADMIN" | "HR" | "MANAGER" | "EMPLOYEE";

/** PRD 15.2: two-step login is mandatory for Organization Admin and HR; optional for Manager. */
export const TOTP_REQUIRED_ROLES: readonly Role[] = ["ORG_ADMIN", "HR"];

export const requiresTotp = (role: Role): boolean => TOTP_REQUIRED_ROLES.includes(role);

/** Which roles a given actor may create / reset (PRD 4: Org Admin creates HR and Manager users). */
const MANAGEABLE: Record<Role, readonly Role[]> = {
  ORG_ADMIN: ["HR", "MANAGER", "EMPLOYEE"],
  HR: ["EMPLOYEE"],
  MANAGER: [],
  EMPLOYEE: [],
};

export const canManageRole = (actor: Role, target: Role): boolean =>
  MANAGEABLE[actor].includes(target);
