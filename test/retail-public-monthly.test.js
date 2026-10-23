'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {generationFixture}=require('./fixtures/generation-retail-funding-fixture');
const {readSavedRetailCheckoutTerms}=require('../src/services/savedMembershipCheckoutTerms');
const {normalizeRetailQuoteSelection,retailQuoteCatalog}=require('../src/services/retailQuoteSelection');
const env={MEMBERSHIP_PRICING_TERMS_ENABLED:'true'};
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`public saved current checkout ${plan}/${months}/${payment}/role=${role}`,()=>{
 const f=generationFixture(plan,months,payment,role);f.g.template_snapshot.source='public_purchase_intent';
 const read=()=>readSavedRetailCheckoutTerms({agreement:f.g,intent:f.i,deadlineMode:'stored'});
 const saved=read();assert.equal(saved.billingInterval,payment==='prepaid'?'prepaid':'monthly');
 assert.equal(saved.offer.platform_commitment_total_cents,saved.offer.platform_payment_cents*(payment==='prepaid'?1:months));
 assert.equal(saved.offer.first_role_prepay.selected,role);
 f.i.promotion_code_id='promo_FORGED';assert.throws(read,/retail_public_discount_denied|retail_prepaid_discount_denied/);
 delete f.i.promotion_code_id;f.i.selected_billing_cadence='annual';assert.throws(read,/package_snapshot_mismatch/);
});
test('public current catalog round-trips only server selection keys and never raw price/promotion',()=>{
 const catalog=retailQuoteCatalog('public',env);assert.equal(catalog.offers.length,12);
 for(const offer of catalog.offers){
  const selected=normalizeRetailQuoteSelection({plan_key:offer.plan_key,commitment_months:offer.commitment_months,
   payment_option:offer.payment_option,offer_version:offer.offer_version,platform_fee:1,promotion_code_id:'promo_FORGED'},
   {channel:'public',env});
  assert.equal(selected.payment_option,offer.payment_option);assert.equal(Object.hasOwn(selected,'promotion_code_id'),false);
 }
});
