'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCorsOrigins, DEV_FRONTEND_ORIGIN, strictHttpsOrigin } = require('../src/config/corsOrigins');

test('isolated dev CORS accepts only the exact dev origin, excluding inherited origins', () => {
  const defaults = ['https://www.alphasourceai.com', 'https://ia-frontend-prod.onrender.com', 'https://alphasourceai-com.onrender.com', 'https://editor.wix.com', 'http://localhost:5173'];
  assert.deepEqual(resolveCorsOrigins({env:{APP_ENV:'development',CORS_ORIGINS:DEV_FRONTEND_ORIGIN},frontendUrl:DEV_FRONTEND_ORIGIN,defaultOrigins:defaults}),[DEV_FRONTEND_ORIGIN]);
});
test('dev CORS fails closed for missing, mismatched or malformed frontend/configured origins', () => {
  for (const frontendUrl of [undefined, '', 'https://www.alphasourceai.com', DEV_FRONTEND_ORIGIN+'/dashboard', DEV_FRONTEND_ORIGIN+'?token=x']) {
    assert.deepEqual(resolveCorsOrigins({env:{APP_ENV:'development'},frontendUrl}),[]);
  }
  for (const CORS_ORIGINS of ['', DEV_FRONTEND_ORIGIN+'/', 'https://editor.wix.com',DEV_FRONTEND_ORIGIN+',https://www.alphasourceai.com','not-a-url']) {
    assert.deepEqual(resolveCorsOrigins({env:{APP_ENV:'development',CORS_ORIGINS},frontendUrl:DEV_FRONTEND_ORIGIN}),[]);
  }
});
test('non-dev preserves existing CORS union and trimming behavior', () => {
  assert.deepEqual(resolveCorsOrigins({env:{APP_ENV:'production',CORS_ORIGINS:'https://extra.example, https://existing.example'},frontendUrl:'https://frontend.example/',defaultOrigins:['https://existing.example']}),['https://existing.example','https://frontend.example','https://extra.example']);
});
test('strict HTTPS origins reject credentials, paths, fragments and insecure URLs', () => {
  assert.equal(strictHttpsOrigin(DEV_FRONTEND_ORIGIN+'/'),DEV_FRONTEND_ORIGIN);
  for(const value of ['http://dev.example','https://u:p@dev.example','https://dev.example/a','https://dev.example#x','https://dev.example?x=1','javascript:alert(1)'])assert.equal(strictHttpsOrigin(value),null);
});
