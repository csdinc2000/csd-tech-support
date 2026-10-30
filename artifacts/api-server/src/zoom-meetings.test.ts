import assert from "node:assert/strict";
import { after, test } from "node:test";
import { __setZoomFetchForTests, createZoomMeeting } from "./zoom-meetings.ts";

const secretKeys = ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"] as const;
const previousSecrets = Object.fromEntries(secretKeys.map((key) => [key, process.env[key]]));
process.env.ZOOM_ACCOUNT_ID = "test-account";
process.env.ZOOM_CLIENT_ID = "test-client";
process.env.ZOOM_CLIENT_SECRET = "test-secret";

after(() => {
  for (const key of secretKeys) {
    const previous = previousSecrets[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  __setZoomFetchForTests();
});

test("creates scheduled meetings for the signed-in host and reuses the OAuth token", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  __setZoomFetchForTests(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "https://zoom.us/oauth/token") {
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      id: 123456,
      join_url: "https://us02web.zoom.us/j/123456?pwd=example",
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  });

  const first = await createZoomMeeting({
    hostEmail: "owner@example.com",
    summary: "Weekly operations review",
    description: "Review current work",
    startIso: "2030-05-20T15:00:00.000Z",
    endIso: "2030-05-20T16:15:00.000Z",
    timezone: "America/New_York",
  });
  await createZoomMeeting({
    hostEmail: "owner@example.com",
    summary: "Follow-up",
    startIso: "2030-05-21T15:00:00.000Z",
    endIso: "2030-05-21T16:00:00.000Z",
    timezone: "America/New_York",
  });

  assert.deepEqual(first, {
    id: "123456",
    joinUrl: "https://us02web.zoom.us/j/123456?pwd=example",
  });
  assert.equal(requests.filter((request) => request.url === "https://zoom.us/oauth/token").length, 1);
  const createRequest = requests.find((request) => request.url.includes("/users/owner%40example.com/meetings"));
  assert.ok(createRequest);
  assert.equal(createRequest.init?.method, "POST");
  assert.equal(
    (createRequest.init?.headers as Record<string, string>).Authorization,
    `Bearer test-access-token`,
  );
  const body = JSON.parse(String(createRequest.init?.body)) as Record<string, unknown>;
  assert.equal(body.topic, "Weekly operations review");
  assert.equal(body.duration, 75);
  assert.equal(body.timezone, "America/New_York");
});
