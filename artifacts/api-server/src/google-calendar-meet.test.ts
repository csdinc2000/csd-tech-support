import assert from "node:assert/strict";
import test from "node:test";
import { buildGoogleMeetEventPayload, buildGoogleMeetEventRequestPath } from "./google-calendar";

test("Google Meet event requests enable conference creation and send attendee invitations", () => {
  const path = buildGoogleMeetEventRequestPath("team/calendar@example.com");
  const parsedPath = new URL(path, "https://calendar.googleapis.com");
  assert.equal(parsedPath.searchParams.get("conferenceDataVersion"), "1");
  assert.equal(parsedPath.searchParams.get("sendUpdates"), "all");
  assert.equal(parsedPath.pathname, "/calendar/v3/calendars/team%2Fcalendar%40example.com/events");

  const payload = buildGoogleMeetEventPayload({
    summary: "Staff planning",
    description: "Quarterly priorities",
    startIso: "2026-10-08T14:00:00.000Z",
    endIso: "2026-10-08T15:00:00.000Z",
    timezone: "America/New_York",
    attendees: [{ email: "staff@example.com", displayName: "Staff Member" }],
  });
  const conference = payload.conferenceData as {
    createRequest: { requestId: string; conferenceSolutionKey: { type: string } };
  };
  assert.match(conference.createRequest.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(conference.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.equal((payload.start as { timeZone: string }).timeZone, "America/New_York");
  assert.deepEqual(payload.attendees, [{ email: "staff@example.com", displayName: "Staff Member" }]);
});
