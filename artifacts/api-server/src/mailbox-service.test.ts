import assert from "node:assert/strict";
import test from "node:test";
import { automatedMailReason, mailboxWorkerEnabled } from "./mailbox-service";

const headers = (entries: Record<string, string> = {}) => new Map(Object.entries(entries));
const mailboxUser = "support@computersystemsdepot.com";

test("customer mail becomes a ticket", () => {
  assert.equal(automatedMailReason({ fromEmail: "dana@example.com", mailboxUser, headers: headers() }), null);
  assert.equal(automatedMailReason({ fromEmail: "dana@example.com", mailboxUser, headers: headers({ "auto-submitted": "no" }) }), null);
});

test("bounces, auto-replies, list mail and our own messages never open tickets", () => {
  assert.ok(automatedMailReason({ fromEmail: "MAILER-DAEMON@mx.example.com", mailboxUser, headers: headers() }));
  assert.ok(automatedMailReason({ fromEmail: "postmaster@example.com", mailboxUser, headers: headers() }));
  assert.ok(automatedMailReason({ fromEmail: "noreply@vendor.example", mailboxUser, headers: headers() }));
  assert.ok(automatedMailReason({ fromEmail: "Support@ComputerSystemsDepot.com", mailboxUser, headers: headers() }));
  assert.ok(automatedMailReason({ fromEmail: "dana@example.com", mailboxUser, headers: headers({ "auto-submitted": "auto-replied" }) }));
  assert.ok(automatedMailReason({ fromEmail: "dana@example.com", mailboxUser, headers: headers({ precedence: "bulk" }) }));
  assert.ok(automatedMailReason({ fromEmail: "news@shop.example", mailboxUser, headers: headers({ "list-unsubscribe": "<mailto:x>" }) }));
});

test("only production polls the shared mailbox unless explicitly switched", () => {
  assert.equal(mailboxWorkerEnabled({ NODE_ENV: "production" }), true);
  assert.equal(mailboxWorkerEnabled({ NODE_ENV: "development" }), false);
  assert.equal(mailboxWorkerEnabled({ NODE_ENV: "development", CSD_MAIL_WORKER: "on" }), true);
  assert.equal(mailboxWorkerEnabled({ NODE_ENV: "production", CSD_MAIL_WORKER: "off" }), false);
});
