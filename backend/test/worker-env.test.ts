import test from 'node:test';
import assert from 'node:assert/strict';
import validation from '../scripts/check-worker-env.cjs';
const { configurationErrors } = validation;
const valid = { DATABASE_URL:'mongodb+srv://user:secret@cluster.example/smartsheet_gcal_sync?retryWrites=true', ENCRYPTION_KEY:'valid-encryption-key', GOOGLE_CLIENT_ID:'google-id', GOOGLE_CLIENT_SECRET:'google-secret', SMARTSHEET_CLIENT_ID:'sheet-id', SMARTSHEET_CLIENT_SECRET:'sheet-secret' };
test('workflow preflight lists missing secret names without values',()=>{
  const errors=configurationErrors({});assert.equal(errors.length,6);assert.ok(errors.some((e:string)=>e.includes('DATABASE_URL')));
});
test('workflow preflight requires MongoDB database name and rejects wrong provider',()=>{
  assert.equal(configurationErrors(valid).length,0);
  assert.equal(configurationErrors({...valid,DATABASE_URL:'mongodb+srv://user:private-password@cluster.example/?appName=x'}).length,1);
  assert.equal(configurationErrors({...valid,DATABASE_URL:'postgresql://user:password@host/db'}).length,1);
  assert.ok(!configurationErrors({...valid,DATABASE_URL:'private-password'}).join().includes('private-password'));
});
