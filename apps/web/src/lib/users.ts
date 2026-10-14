import { api, ApiRequestError } from "./api";

export type StaffRole = "ORG_ADMIN" | "HR" | "MANAGER" | "BOSS";

export interface StaffUser {
  id: string;
  username: string;
  displayName: string;
  role: StaffRole;
  status: "ACTIVE" | "DISABLED";
  totpEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  employeeId: string | null;
  employeeName: string | null;
  /** How many places or departments limit what the person sees (0 = no limit for HR, nothing visible for a Manager). */
  scopeRules: number;
}

export const ROLE_LABEL: Record<StaffRole, string> = {
  ORG_ADMIN: "Байгууллагын админ",
  HR: "Хүний нөөц",
  MANAGER: "Менежер",
  BOSS: "Дарга",
};

export interface Scope {
  locationIds: string[];
  departmentIds: string[];
}

export const fetchUsers = () => api<StaffUser[]>("/v1/users");
export const fetchScope = (id: string) => api<Scope>(`/v1/users/${id}/scope`);
export const putScope = (id: string, scope: Scope) =>
  api<Scope>(`/v1/users/${id}/scope`, { method: "PUT", body: scope });
export const linkEmployee = (id: string, employeeId: string | null) =>
  api(`/v1/users/${id}/employee`, { method: "PUT", body: { employeeId } });
export const setUserStatus = (id: string, status: "ACTIVE" | "DISABLED") =>
  api(`/v1/users/${id}/${status === "ACTIVE" ? "enable" : "disable"}`, {
    method: "POST",
    body: {},
  });
export const resetUserPassword = (id: string) =>
  api<{ temporaryPassword: string }>(`/v1/users/${id}/reset-password`, {
    method: "POST",
    body: {},
  });
export const resetUserAuthenticator = (id: string) =>
  api(`/v1/users/${id}/totp-reset`, { method: "POST", body: {} });

export interface NewUserForm {
  username: string;
  displayName: string;
  role: "HR" | "MANAGER" | "BOSS";
  /** A Manager is linked to an employee record (arrival and departure are registered); a Boss and HR have none. */
  employeeId: string | null;
}

export const createUser = (form: NewUserForm) =>
  api<{ id: string; username: string; temporaryPassword: string }>("/v1/users", {
    method: "POST",
    body: {
      username: form.username.trim(),
      displayName: form.displayName.trim(),
      role: form.role,
      ...(form.role === "MANAGER" ? { employeeId: form.employeeId } : {}),
    },
  });

/** A problem found before sending the form, and the field it is about. */
export function newUserIssue(form: NewUserForm): { field: string; message: string } | null {
  const username = form.username.trim();
  if (username.length < 3) {
    return { field: "username", message: "Нэвтрэх нэр дор хаяж 3 тэмдэгт байна." };
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(username)) {
    return {
      field: "username",
      message: "Нэвтрэх нэрд зөвхөн латин үсэг, тоо, цэг, зураас ашиглана.",
    };
  }
  if (username.length > 64) return { field: "username", message: "Нэвтрэх нэр хэт урт байна." };
  if (!form.displayName.trim()) return { field: "displayName", message: "Нэрээ бичнэ үү." };
  if (form.role === "MANAGER" && !form.employeeId) {
    return { field: "employee", message: "Менежерийн ажилтны бүртгэлийг сонгоно уу." };
  }
  return null;
}

/** The text shown for a refused users request. */
export function userErrorText(e: unknown): string {
  if (!(e instanceof ApiRequestError)) return "Холбогдож чадсангүй. Дахин оролдоно уу.";
  switch (e.code) {
    case "USERNAME_TAKEN":
      return "Энэ нэвтрэх нэр ашиглагдаж байна.";
    case "EMPLOYEE_HAS_ACCOUNT":
      return "Энэ ажилтанд аль хэдийн нэвтрэх эрх байна.";
    case "EMPLOYEE_NOT_ACTIVE":
      return "Зөвхөн идэвхтэй ажилтантай холбож болно.";
    case "BOSS_NOT_TRACKED":
      return "Дарга ирц бүртгүүлдэггүй тул ажилтны бүртгэлтэй холбохгүй.";
    case "FORBIDDEN":
      return "Энэ үйлдлийг хийх эрх байхгүй.";
    default:
      return e.message;
  }
}

/** What a person with this account can see, in words. */
export function scopeText(u: Pick<StaffUser, "role" | "scopeRules">): string {
  if (u.role === "ORG_ADMIN") return "Бүгд";
  if (u.role === "BOSS") return "Бүгд (зөвхөн харна)";
  if (u.scopeRules > 0) return `${u.scopeRules} хэсэг, салбар`;
  return u.role === "HR" ? "Бүгд" : "Юу ч харахгүй — хамрах хүрээ оноогоогүй";
}
