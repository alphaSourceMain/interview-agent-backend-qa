'use strict';
const { OWNER } = require('./qa-config');
const { assertRuntimeProfile, safeExternalSender } = require('./runtime-profile');
// Compare every verified identity/content binding, without importing the legacy
// attended owner's hard-coded matcher into the production runtime.
function sameRuntimeRecord(a, b, profile) {
  assertRuntimeProfile(profile);
  return !!a && !!b && a.senderVerified === true && b.senderVerified === true &&
    (profile.ownerOnly ? b.sender === OWNER : safeExternalSender(b.sender)) &&
    ['fingerprint','sender','text','subject','threadKey','messageKey','gmailKey','gmailId','threadId','rfcMessageId'].every(k => a[k] === b[k]);
}
module.exports = { sameRuntimeRecord };
