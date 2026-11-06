import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../src/features/uat/CrossRoleUatPage.jsx',import.meta.url),'utf8');

test('Automatic Tare UI is read-only and exposes every backend state',()=>{
 assert.doesNotMatch(source,/Simulate Tare|tare_auto|setTare|simulatedT:tare/);
 for(const state of ['TARE_PENDING','TARE_RECEIVED','TARE_INVALID','TARE_FAILED'])assert.match(source,new RegExp(state));
 assert.match(source,/UAT_SIMULATED/);
 assert.match(source,/UNVERIFIED/);
});

test('loading capacity uses backend DTO fields without frontend weight arithmetic',()=>{
 for(const field of ['gvwAvailableT','loadingLimitT','limitedBy'])assert.match(source,new RegExp(`capacity\\?\\.${field}`));
 assert.match(source,/browser tidak menghitung berat/);
 assert.doesNotMatch(source,/approvedGvwT\s*-|approvedPayloadT\s*-|remainingPlannedT\s*-/);
});

test('Automatic Tare refresh is GET polling and missing backend values stay unavailable',()=>{
 assert.match(source,/fetch\('\/api\/uat\/context',\{credentials:'same-origin'\}\)/);
 assert.match(source,/setInterval/);
 assert.doesNotMatch(source,/action:'tare'/);
 assert.match(source,/not exposed by backend/);
 assert.match(source,/Plate number','— · unavailable'/);
});
