'use strict';
const copy=require('../content/retail-sales-copy.json');
function retailContentForMode(value,enabled){
  if(enabled)return value;
  function visit(input){
    if(typeof input==='string')return copy.replacements.reduce((text,[from,to])=>text.split(from).join(to),input);
    if(Array.isArray(input))return input.map(visit);
    if(!input||typeof input!=='object')return input;
    const output=Object.fromEntries(Object.entries(input).map(([k,v])=>[k,visit(v)]));
    if(typeof input.question==='string'&&copy.answers[input.question])output.answer=copy.answers[input.question];
    return output;
  }
  return visit(value);
}
module.exports={retailContentForMode};
