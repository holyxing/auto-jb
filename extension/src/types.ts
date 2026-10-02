export type Card = {
  key: string;
  title: string;
  company: string;
  city: string;
};
export type Detail = Card & {
  description: string;
  recruiter: string;
  contact_button: "READY" | "ALREADY_CONTACTED" | "MISSING" | "DISABLED";
};
export type Chat = {
  key: string;
  conversation: string;
  contact:
    "CHAT_OPENED" | "CONTACT_INITIATED" | "ALREADY_CONTACTED" | "UNKNOWN";
  resume:
    | "NOT_CHECKED"
    | "READY"
    | "WAITING_PEER"
    | "UNAVAILABLE"
    | "SENT"
    | "UNKNOWN";
  resume_name: string;
  evidence: string;
  contact_at?: number;
  resume_at?: number;
};
export type Snapshot = {
  source: "fixture" | "boss" | "liepin";
  account: string;
  session: string;
  tab: number;
  document: string;
  profile: string;
  url: string;
  selection_epoch: number;
  phase: "LIST" | "CHAT" | "BLOCKED";
  cards: Card[];
  detail: Detail | null;
  chat: Chat | null;
  blocked: string;
  list_end: boolean;
  loading: boolean;
  list_signature: string;
  selected_key: string;
  send_ready: boolean;
  contact_click_ready: boolean;
  search_limited: boolean;
};
export type Command = {
  id: string;
  action: "SELECT" | "SCROLL" | "CONTACT" | "RESUME_SEND" | "RESTORE";
  job_key: string;
  epoch: number;
  binding: Partial<Snapshot>;
  expires: number;
  resume_name: string;
};
export type Profile = {
  name: string;
  calibrated: boolean;
  account: string;
  accountKey: string;
  list: string;
  card: string;
  cardKey: string;
  title: string;
  company: string;
  city: string;
  selected: string;
  detail: string;
  detailKey: string;
  detailTitle: string;
  detailCompany: string;
  detailCity: string;
  description: string;
  contact: string;
  loading: string;
  end: string;
  blocked: string;
  chat: string;
  chatKey: string;
  conversation: string;
  sent: string;
  resumeButton: string;
  resumeName: string;
  resumeSent: string;
  sentTime: string;
  resumeTime: string;
  waiting: string;
  restore: string;
};
