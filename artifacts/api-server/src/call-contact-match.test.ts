import assert from "node:assert/strict";
import test from "node:test";
import { matchUniqueCallContact, type CallContactCandidate } from "./call-contact-match";

const contact = (overrides: Partial<CallContactCandidate> = {}): CallContactCandidate => ({
  id: 1,
  fullName: "Pat Customer",
  mobilePhone: "954-235-9555",
  ...overrides,
});

test("matches formatting variants by complete canonical phone number", () => {
  const match = matchUniqueCallContact("+1 (954) 235-9555", [contact()]);
  assert.equal(match?.id, 1);
});

test("counts a contact once when both phone fields contain the same number", () => {
  const match = matchUniqueCallContact("+19542359555", [
    contact({ officePhone: "(954) 235-9555" }),
  ]);
  assert.equal(match?.id, 1);
});

test("does not match international numbers by a shared last ten digits", () => {
  const match = matchUniqueCallContact("+44 954 235 9555", [contact()]);
  assert.equal(match, null);
});

test("leaves a phone unlinked when multiple contacts share its canonical number", () => {
  const match = matchUniqueCallContact("+19542359555", [
    contact({ id: 1 }),
    contact({ id: 2, fullName: "Another Customer", officePhone: "+1 954 235 9555" }),
  ]);
  assert.equal(match, null);
});

test("does not match malformed phone numbers", () => {
  assert.equal(matchUniqueCallContact("not a phone number", [contact()]), null);
});
