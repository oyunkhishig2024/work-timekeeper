import { api } from "./api";

export type ReviewStatus = "PENDING" | "CONFIRMED" | "REJECTED" | "RECHECK_REQUESTED";
export type QueueFilter = "OPEN" | "ALL" | "CONFIRMED" | "REJECTED";
export type Decision = "CONFIRM" | "REJECT" | "REQUEST_RECHECK";

export interface AnomalyItem {
  id: string;
  employeeId: string;
  employeeNo: string;
  fullName: string;
  departmentName: string | null;
  locationName: string;
  type: "ENTER" | "EXIT";
  occurredAt: string;
  receivedAt: string;
  claimedAt: string | null;
  accuracyM: number | null;
  lat: number | null;
  lng: number | null;
  flags: string[];
  counted: boolean;
  reviewStatus: ReviewStatus | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  reviewedByName: string | null;
}

export interface RepeatedEmployee {
  employeeId: string;
  employeeNo: string;
  fullName: string;
  count: number;
}

export interface AnomalyResponse {
  total: number;
  items: AnomalyItem[];
  repeated: { threshold: number; days: number; employees: RepeatedEmployee[] };
}

export interface DeviceAlert {
  id: string;
  kind: "ATTESTATION_UNAVAILABLE_STREAK" | "DEVICE_CONFLICT";
  detail: string | null;
  createdAt: string;
  employeeId: string;
  employeeNo: string;
  fullName: string;
  model: string | null;
  platform: "ANDROID" | "IOS";
  lastBatchVerdict: string | null;
  unavailableStreak: number;
  relatedEmployeeId: string | null;
  relatedEmployeeNo: string | null;
  relatedFullName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
}

/** What a flag means for HR (PRD 6.7). Flags that are not suspicion (late sync, attestation unavailable) are only noted. */
export const FLAG_INFO: Record<string, { label: string; help: string; suspicious: boolean }> = {
  MOCK_LOCATION: {
    label: "Хуурамч байршил",
    help: "Утас байршлыг mock (хуурамч) эх сурвалжаас авсан гэж мэдэгдсэн.",
    suspicious: true,
  },
  LOW_ACCURACY: {
    label: "Нарийвчлал муу",
    help: "Байршлын нарийвчлал 50 м-ээс муу тул орсныг батлаагүй.",
    suspicious: true,
  },
  CLOCK_SKEW: {
    label: "Цаг зөрсөн",
    help: "Утасны цаг серверээс 2 минутаас илүү зөрсөн. Серверийн цагаар тооцсон.",
    suspicious: true,
  },
  IMPOSSIBLE_SPEED: {
    label: "Боломжгүй хурд",
    help: "Өмнөх/дараах байршлаас энэ хугацаанд 150 км/ц-аас илүү хурдтай явсан байх тул боломжгүй.",
    suspicious: true,
  },
  ATTESTATION_FAILED: {
    label: "Апп баталгаажаагүй",
    help: "Утас, апп эх хувилбар биш (эмулятор, root, өөрчилсөн апп) гэж шалгагч үзсэн.",
    suspicious: true,
  },
  DEVICE_CONFLICT: {
    label: "Төхөөрөмжийн зөрчил",
    help: "Өөр суулгацаас илгээсэн, эсвэл өөр ажилтантай яг ижил байршил, хөдөлгөөнтэй.",
    suspicious: true,
  },
  ATTESTATION_UNAVAILABLE: {
    label: "Баталгаажуулалт боломжгүй",
    help: "Google/Apple-ийн шалгагч хариу өгөөгүй. Зөвхөн тэмдэглэв.",
    suspicious: false,
  },
  LATE_SYNC: {
    label: "24 цагаас хоцорсон",
    help: "24 цагаас хуучин event тул ирцэд тооцогдохгүй.",
    suspicious: false,
  },
};

export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  PENDING: "Шалгаагүй",
  CONFIRMED: "Баталсан",
  REJECTED: "Няцаасан",
  RECHECK_REQUESTED: "Дахин шалгахыг хүссэн",
};

export const QUEUE_LABEL: Record<QueueFilter, string> = {
  OPEN: "Нээлттэй",
  ALL: "Бүгд",
  CONFIRMED: "Баталсан",
  REJECTED: "Няцаасан",
};

export const ALERT_LABEL: Record<DeviceAlert["kind"], string> = {
  ATTESTATION_UNAVAILABLE_STREAK: "Баталгаажуулалт тасарсан",
  DEVICE_CONFLICT: "Төхөөрөмжийн зөрчил",
};

/** A rejection must say why (PRD 6.7); a re-check request may add a note. */
export function decisionProblem(decision: Decision, note: string): string | null {
  if (decision === "REJECT" && note.trim().length < 3)
    return "Няцаах шалтгаанаа бичнэ үү (дор хаяж 3 тэмдэгт).";
  return null;
}

/** A map link for the coordinates; the page opens it only when HR clicks (the coordinates go to the map site then). */
export function mapUrl(lat: number, lng: number): string {
  const f = (n: number) => n.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${f(lat)}&mlon=${f(lng)}#map=17/${f(lat)}/${f(lng)}`;
}

export interface ReviewState {
  status: QueueFilter;
  employeeId: string | null;
}

export function parseReviewState(params: { get(name: string): string | null }): ReviewState {
  const status = params.get("status") as QueueFilter | null;
  const employee = params.get("employee");
  return {
    status: status && ["OPEN", "ALL", "CONFIRMED", "REJECTED"].includes(status) ? status : "OPEN",
    employeeId: employee && /^[0-9a-f-]{36}$/iu.test(employee) ? employee : null,
  };
}

export function reviewHref(s: Partial<ReviewState>): string {
  const q = new URLSearchParams();
  if (s.status && s.status !== "OPEN") q.set("status", s.status);
  if (s.employeeId) q.set("employee", s.employeeId);
  const text = q.toString();
  return text ? `/review?${text}` : "/review";
}

export const fetchAnomalies = (s: ReviewState, offset = 0) => {
  const q = new URLSearchParams({ status: s.status, limit: "100", offset: String(offset) });
  if (s.employeeId) q.set("employeeId", s.employeeId);
  return api<AnomalyResponse>(`/v1/attendance/anomalies?${q}`);
};

export const reviewEvent = (id: string, decision: Decision, note: string) =>
  api<AnomalyItem>(`/v1/attendance/anomalies/${id}/review`, {
    method: "POST",
    body: { decision, ...(note.trim() ? { note: note.trim() } : {}) },
  });

export const fetchAlerts = (status: "OPEN" | "ALL") =>
  api<{ total: number; items: DeviceAlert[] }>(`/v1/device-alerts?status=${status}&limit=200`);

export const resolveAlert = (id: string, note: string) =>
  api<DeviceAlert>(`/v1/device-alerts/${id}/resolve`, {
    method: "POST",
    body: note.trim() ? { note: note.trim() } : {},
  });

/** The API stores its alert explanations in English; these are the texts HR reads. Unknown ones are shown as they are. */
const ALERT_DETAIL: Record<string, string> = {
  "The attestation service did not answer for five batches in a row.":
    "Google/Apple-ийн баталгаажуулалт дараалан 5 багцад хариу өгсөнгүй.",
  "The install key belongs to another employee's device.":
    "Суулгацын түлхүүр өөр ажилтны төхөөрөмжийнх байна.",
  "The install key differs from the registered device.":
    "Суулгацын түлхүүр бүртгэлтэй төхөөрөмжийнхөөс өөр байна.",
  "Identical coordinates and movement as another employee's device.":
    "Өөр ажилтны төхөөрөмжтэй яг ижил байршил, хөдөлгөөнтэй байна.",
};

export const alertDetailText = (detail: string | null): string | null =>
  detail ? (ALERT_DETAIL[detail] ?? detail) : null;
