import twilio from "twilio";
import {
  canonicalPublicAppBaseUrl,
  reconcileCredentialListMappings,
  reconcileCredentialUsernames,
} from "../shared/roip-config";

const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
const password = process.env.ROIP_SIP_PASSWORD;
const username = process.env.ROIP_SIP_USERNAME?.trim();
const configuredDomain = process.env.ROIP_SIP_DOMAIN?.trim();
const appBaseUrl = canonicalPublicAppBaseUrl(process.env.APP_BASE_URL);

if (!appBaseUrl.ok) throw new Error(appBaseUrl.error);
if (!accountSid || !authToken || !password || !username || !configuredDomain) {
  throw new Error(
    "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ROIP_SIP_DOMAIN, ROIP_SIP_USERNAME, ROIP_SIP_PASSWORD, and APP_BASE_URL are required.",
  );
}
if (username.length > 32) throw new Error("ROIP_SIP_USERNAME must be at most 32 characters.");

const domainName = configuredDomain.endsWith(".sip.twilio.com")
  ? configuredDomain
  : `${configuredDomain}.sip.twilio.com`;
const voiceUrl = `${appBaseUrl.origin}/webhooks/roip/sip`;
const client = twilio(accountSid, authToken);

const domains = (await client.sip.domains.list({ limit: 1000 }))
  .filter((item) => item.domainName.toLowerCase() === domainName.toLowerCase());
if (domains.length > 1) throw new Error("Multiple Twilio SIP Domains match ROIP_SIP_DOMAIN; resolve the ambiguity before provisioning.");
let domain = domains[0];
if (!domain) {
  domain = await client.sip.domains.create({
    domainName,
    friendlyName: "CSD RoIP Gateway",
    voiceUrl,
    voiceMethod: "POST",
    sipRegistration: false,
  });
} else {
  domain = await client.sip.domains(domain.sid).update({
    friendlyName: "CSD RoIP Gateway",
    voiceUrl,
    voiceMethod: "POST",
    sipRegistration: false,
  });
}

const credentialListName = `CSD RoIP ${domainName}`;
const lists = (await client.sip.credentialLists.list({ limit: 1000 }))
  .filter((item) => item.friendlyName === credentialListName);
if (lists.length > 1) throw new Error("Multiple credential lists match this RoIP SIP Domain; resolve the ambiguity before provisioning.");
let credentialList = lists[0];
if (!credentialList) {
  credentialList = await client.sip.credentialLists.create({ friendlyName: credentialListName });
}

const credentials = await client.sip.credentialLists(credentialList.sid).credentials.list({ limit: 1000 });
const credentialDecision = reconcileCredentialUsernames(credentials.map((item) => item.username), username);
if (credentialDecision.action === "fail") throw new Error(credentialDecision.error);
const credential = credentials.find((item) => item.username === username);
if (credentialDecision.action === "update" && credential) {
  await client.sip.credentialLists(credentialList.sid).credentials(credential.sid).update({ password });
} else {
  await client.sip.credentialLists(credentialList.sid).credentials.create({ username, password });
}

const mappings = await client.sip.domains(domain.sid).auth.calls.credentialListMappings.list({ limit: 1000 });
const mappingDecision = reconcileCredentialListMappings(
  mappings.map((mapping) => mapping.credentialListSid),
  credentialList.sid,
);
if (mappingDecision.action === "fail") throw new Error(mappingDecision.error);
if (mappingDecision.action === "create") {
  await client.sip.domains(domain.sid).auth.calls.credentialListMappings.create({
    credentialListSid: credentialList.sid,
  });
}

process.stdout.write(`SIP URI: sip:${username}@${domainName}\nUsername: ${username}\n`);