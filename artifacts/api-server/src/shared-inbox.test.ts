import assert from "node:assert/strict";
import test from "node:test";
import {
  customerLabel,
  forwardBodyFor,
  mirrorBodyFor,
  parseRelayReply,
  staffDisplayName,
  threadKeyFor,
} from "./shared-inbox";

test("thread keys collapse US formatting variants to the same customer", () => {
  assert.equal(threadKeyFor("+1 (954) 555-0101"), "9545550101");
  assert.equal(threadKeyFor("9545550101"), "9545550101");
  assert.equal(threadKeyFor("19545550101"), "9545550101");
  assert.equal(threadKeyFor(null), "");
});

test("relay replies need a #code followed by a message", () => {
  assert.deepEqual(parseRelayReply("#12 On my way"), { conversationId: 12, message: "On my way" });
  assert.deepEqual(parseRelayReply("  #7   Ready for pickup\nSee you soon "), { conversationId: 7, message: "Ready for pickup\nSee you soon" });
  assert.equal(parseRelayReply("#12"), null);
  assert.equal(parseRelayReply("12 On my way"), null);
  assert.equal(parseRelayReply("CLIENT T-1: hi"), null);
  assert.equal(parseRelayReply("My order #12 is late"), null);
});

test("forwards carry the conversation code and reply instructions", () => {
  const body = forwardBodyFor({ conversationId: 12, label: customerLabel("+19545550101", "Maria Alvarez"), body: "Is my laptop ready?" });
  assert.equal(body, '#12 From Maria Alvarez (954) 555-0101: Is my laptop ready?\nReply "#12 your message" to text back as CSD.');
  // Without a conversation (inbox unavailable) the forward still goes out, just without a code.
  assert.equal(forwardBodyFor({ conversationId: null, label: "(954) 555-0101", body: "hi" }), "From (954) 555-0101: hi");
});

test("team mirrors say who replied so nobody double-answers", () => {
  assert.equal(
    mirrorBodyFor({ conversationId: 3, senderName: "Luis", label: "(954) 555-0101", body: "On my way" }),
    "#3 Luis replied to (954) 555-0101: On my way",
  );
});

test("staff display names fall back to email, then a generic label", () => {
  assert.equal(staffDisplayName({ firstName: "Ana", lastName: "Diaz", email: "ana@example.com" }), "Ana Diaz");
  assert.equal(staffDisplayName({ firstName: null, lastName: null, email: "ana@example.com" }), "ana@example.com");
  assert.equal(staffDisplayName(undefined), "CSD staff");
});
