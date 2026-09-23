'use strict';

const QA_TEST_PHONE_ID = '21000000-0000-4000-8000-000000000003';

function isQaStagedSalesLine(record, env = process.env) {
  if (env.APP_ENV !== 'qa') return false;
  const memberId = String(env.SALES_TEAM_QA_STAGED_MEMBER_ID || '').trim();
  const phoneId = String(env.SALES_TEAM_QA_STAGED_PHONE_ID || '').trim();
  const phone = record?.phone;
  const sharedVoicePhone = record?.shared_voice_phone || phone;
  return Boolean(
    memberId && phoneId === QA_TEST_PHONE_ID && record?.member?.id === memberId &&
    phone?.id === phoneId && phone?.shared_voice_entrypoint === false &&
    sharedVoicePhone?.id && sharedVoicePhone.id !== phone.id && sharedVoicePhone.shared_voice_entrypoint === true &&
    ['pending', 'verified'].includes(phone?.ghl_setup_status) &&
    ['pending', 'verified'].includes(sharedVoicePhone?.xai_setup_status)
  );
}

module.exports = { isQaStagedSalesLine };
