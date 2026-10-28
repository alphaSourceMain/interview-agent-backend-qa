'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { calculateQualityScore } = require('../src/services/interviewQualityScoring');
const enabled = process.env.INTERVIEW_QUALITY_DISPOSABLE === 'true';
const db = `alphascreen_quality_${process.pid}`;
const bin = '/opt/homebrew/opt/postgresql@17/bin/';
function command(name,args,input) { const r=spawnSync(bin+name,args,{encoding:'utf8',input,env:{...process.env,PGHOST:'127.0.0.1',PGPORT:'55488',PGDATABASE:db}}); assert.equal(r.status,0,r.stderr);return r.stdout.trim(); }
const sql=q=>command('psql',['-X','-v','ON_ERROR_STOP=1','-At'],q);
const file=f=>sql(fs.readFileSync(path.join(__dirname,'..',f),'utf8'));
const quote=v=>"'"+String(typeof v==='string'?v:JSON.stringify(v)).replace(/'/g,"''")+"'";
const id='77000000-0000-4000-8000-000000000010';
const quality=Object.fromEntries(['response_specificity','answer_directness','answer_consistency','communication_structure'].map(k=>[k,80]));
const evaluations=[{question_order:1,scorable:true,score:70,anchor:'adequate',missing_reason:'none',evidence:'Synthetic example.'}];
const summary=calculateQualityScore(evaluations,quality);
const scores={overall:72,role_fit:72,technical_strength:72,communication_quality:72,confidence:80,ai_aided_risk:'low',ai_aided_risk_reason:'No content concern.'};
const details={version:'role_quality_v3',model:'synthetic',rubric:{questions:[{text:'Synthetic question?'}]},question_evaluations:evaluations,answer_quality_scores:quality,weights:summary.weights};
function apply(overrides={}) { const p={timestamp:sql(`select updated_at from interviews where id='${id}'`),hash:sql(`select encode(sha256(convert_to(transcript,'UTF8')),'hex') from interviews where id='${id}'`),scores,summary,details,...overrides};return sql(`select * from apply_interview_quality_score('${id}',${quote(p.timestamp)},${quote(p.hash)},${quote(p.scores)}::jsonb,'Synthetic calibrated summary',${quote(p.summary)}::jsonb,${quote(p.details)}::jsonb,'["What does onboarding involve?"]'::jsonb);`); }
test.before(()=>{
 if(!enabled)return;
 assert.match(db,/^alphascreen_quality_\d+$/);
 command('createdb',['-h','127.0.0.1','-p','55488','-E','UTF8','-T','template0',db]);
 file('test/fixtures/interview-recovery-core-disposable-bootstrap.sql');
 file('supabase/migrations/20260717120000_candidate_incident_phase_b.sql');
 file('supabase/migrations/20260721160715_interview_recovery_core.sql');
 file('supabase/migrations/20260724142720_final_transcript_reconciliation_serialization.sql');
 file('supabase/migrations/20260727185302_fix_recovery_digest_schema_compatibility.sql');
 sql('alter table interviews add column if not exists rubric jsonb; alter table interviews add column if not exists analysis jsonb; alter table interviews add column if not exists perception_scores jsonb;');
 sql(`insert into interviews(id,status,transcript) values('${id}','Completed','INTERVIEWER: Describe your work.\nCANDIDATE: I led a migration that reduced processing time by thirty percent.');`);
 file('supabase/migrations/20261028173607_interviewer_quality_scoring_v3.sql');


});
test.after(()=>{if(enabled)command('dropdb',['-h','127.0.0.1','-p','55488',db]);});
test('historical rows remain legacy; activation affects only new rows',{skip:!enabled},()=>{
 assert.equal(sql(`select interview_quality_version is null from interviews where id='${id}'`),'t');
 file('supabase/migrations/20261028174219_activate_interviewer_quality_default.sql');
 assert.equal(sql(`select interview_quality_version is null from interviews where id='${id}'`),'t');
 assert.equal(sql("insert into interviews(status) values('New') returning interview_quality_version"),'role_quality_v3\nINSERT 0 1');
});
test('validator recomputes means and fixed weights from private details',{skip:!enabled},()=>{
 const valid=(a,b,c)=>sql(`select private.is_valid_interview_quality_result(${quote(a)},${quote(b)},${quote(c)})`);
 assert.equal(valid(scores,summary,details),'t');
 assert.equal(valid(scores,{...summary,overall:99},details),'f');
 assert.equal(valid(scores,summary,{...details,question_evaluations:[{...evaluations[0],score:100}]}),'f');
 assert.equal(valid(scores,{...summary,answer_quality_scores:{}},details),'f');
 assert.equal(valid(scores,{...summary,private_rubric:'leak'},details),'f');
 assert.equal(valid({...scores,role_fit:71},summary,details),'f');
});
test('CAS rejects stale results; successful write and audit are atomic and idempotent',{skip:!enabled},()=>{
 assert.equal(apply({timestamp:'2000-01-01T00:00:00Z'}),'superseded');
 assert.equal(sql('select count(*) from private.interview_scoring_history'),'0');
 assert.equal(apply(),'applied');
 assert.equal(apply(),'already_applied');
 assert.equal(sql('select count(*) from private.interview_scoring_history'),'1');
 assert.equal(sql(`select status||'|'||(transcript_scores->>'overall')||'|'||interview_quality_version from interviews where id='${id}'`),'Completed|72|role_quality_v3');
 assert.equal(sql("select previous_scores='{}'::jsonb from private.interview_scoring_history"),'t');
});
test('private audit is unreadable and RPCs uncallable by client roles',{skip:!enabled},()=>{
 assert.equal(sql("select has_table_privilege('authenticated','private.interview_scoring_history','select')"),'f');
 assert.equal(sql("select has_table_privilege('anon','private.interview_scoring_history','select')"),'f');
 assert.equal(sql("select has_function_privilege('authenticated','public.apply_interview_quality_score(uuid,timestamptz,text,jsonb,text,jsonb,jsonb,jsonb,jsonb)','execute')"),'f');
 assert.equal(sql("select relrowsecurity and relforcerowsecurity from pg_class where oid='private.interview_scoring_history'::regclass"),'t');
});
test('old queued capture cannot refill an empty completed v3 question capture',{skip:!enabled},()=>{
 sql(`update interviews set unanswered_candidate_questions='{}' where id='${id}'`);
 assert.equal(sql(`select * from persist_interview_unanswered_questions_if_authoritative('${id}',1,repeat('a',64),'["Old stale question?"]')`),'already_present');
 assert.equal(sql(`select cardinality(unanswered_candidate_questions) from interviews where id='${id}'`),'0');
});
test('canonical wrapper finalizes score, capture and audit in one transaction',{skip:!enabled},()=>{
 const iv='77000000-0000-4000-8001-000000000011', conversation='quality-synthetic-11';
 const transcript='CANDIDATE: I led the synthetic migration and reduced the processing time.';
 const hash=sql(`select encode(sha256(convert_to(${quote(transcript)},'UTF8')),'hex')`);
 const evidence={has_substantive_response:true,substantive_response_count:1,candidate_utterance_count:1,candidate_word_count:12,classification_counts:{acknowledgment:0,repeat_request:0,hearing_or_audio_issue:0,clarification_request:0,filler:0,silence_or_empty:0,unknown_non_substantive:0,substantive_answer:1},conversation_progress_state:'CandidateResponded'};
 sql(`insert into interviews(id,tavus_application_id,status) values('${iv}','${conversation}','Incomplete');`);
 const claimed=sql(`select claim_token,claim_version from claim_interview_final_transcript_reconciliation('${iv}','${conversation}',repeat('b',64),'${hash}',${quote(evidence)},300)`);
 const [token,version]=claimed.split('|');
 const call=(metadata=summary)=>`select outcome from finalize_interview_quality_transcript('${iv}','${conversation}','${token}',${version},repeat('b',64),'${hash}','transcripts/interviews/${iv}/final-transcripts/${hash}.txt',${quote(transcript)},${quote(evidence)},${quote(scores)},'Synthetic calibrated result',${quote(metadata)},${quote(details)},'["What are the next steps?"]')`;
 const bad=spawnSync(bin+'psql',['-X','-v','ON_ERROR_STOP=1','-At'],{encoding:'utf8',input:call({...summary,overall:99}),env:{...process.env,PGHOST:'127.0.0.1',PGPORT:'55488',PGDATABASE:db}});
 assert.notEqual(bad.status,0);
 assert.equal(sql(`select status from interviews where id='${iv}'`),'Incomplete');
 assert.equal(sql(`select count(*) from private.interview_scoring_history where interview_id='${iv}'`),'0');
 assert.equal(sql(call()),'finalized');
 assert.equal(sql(`select transcript_scores->>'overall' from interviews where id='${iv}'`),'72');
 assert.equal(sql(`select unanswered_candidate_questions[1] from interviews where id='${iv}'`),'What are the next steps?');
 assert.equal(sql(call()),'already_reconciled');
 assert.equal(sql(`select count(*) from private.interview_scoring_history where interview_id='${iv}'`),'1');
});
test('text completion uses identical validated formula and private audit',{skip:!enabled},()=>{
 const result=sql(`select id from insert_interview_quality_text(null,null,null,'{}','CANDIDATE: I led a synthetic migration.',${quote(scores)},'Synthetic text result',${quote(summary)},${quote(details)},'[]','{"mode":"text"}','{"mode":"text"}')`);
 assert.match(result,/^[a-f0-9-]{36}$/);
 assert.equal(sql(`select (transcript_scores->>'overall')||'|'||interview_quality_version||'|'||status from interviews where id='${result}'`),'72|role_quality_v3|completed');
 assert.equal(sql(`select count(*) from private.interview_scoring_history where interview_id='${result}'`),'1');
});
