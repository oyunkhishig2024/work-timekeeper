/** Tenant user roles (PRD 4). Super Admin accounts are platform users, not tenant users. */
export type Role = "ORG_ADMIN" | "HR" | "MANAGER" | "BOSS" | "EMPLOYEE";

/** PRD 15.2: two-step login is mandatory for Organization Admin and HR; optional for Manager. A Boss sees the whole organization, so it is mandatory for a Boss too. */
export const TOTP_REQUIRED_ROLES: readonly Role[] = ["ORG_ADMIN", "HR", "BOSS"];

export const requiresTotp = (role: Role): boolean => TOTP_REQUIRED_ROLES.includes(role);

/** Which roles a given actor may create / reset (PRD 4: Org Admin creates HR and Manager users). */
const MANAGEABLE: Record<Role, readonly Role[]> = {
  ORG_ADMIN: ["HR", "MANAGER", "BOSS", "EMPLOYEE"],
  HR: ["EMPLOYEE"],
  MANAGER: [],
  BOSS: [],
  EMPLOYEE: [],
};

export const canManageRole = (actor: Role, target: Role): boolean =>
  MANAGEABLE[actor].includes(target);
