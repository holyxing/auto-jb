import { expect, it } from "vitest";
import { sameView } from "../../extension/src/snapshot";
import type { Chat } from "../../extension/src/types";
it("server field ordering cannot invalidate an unchanged chat", () => {
  const chat: Chat = {
    key: "a",
    conversation: "c",
    contact: "CONTACT_INITIATED",
    resume: "READY",
    resume_name: "a.pdf",
    evidence: "sent",
    contact_at: 123,
    resume_at: 0,
  };
  const reordered = Object.fromEntries(Object.entries(chat).reverse()) as Chat;
  expect(sameView({ chat }, { chat: reordered })).toBe(true);
  expect(sameView({ chat }, { chat: { ...chat, conversation: "other" } })).toBe(
    false,
  );
});
