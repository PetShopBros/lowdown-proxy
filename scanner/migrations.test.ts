import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineSql, checksum, compare, createdObjects, label, packSql, versionOf } from './migrations-lib.ts';

test('checksum: BOM·CRLF 를 무시한다(Windows 체크아웃과 같은 값)', () => {
  assert.equal(checksum('a\r\nb\r\n'), checksum('a\nb\n'));
  assert.equal(checksum('﻿a\n'), checksum('a\n'));
  assert.notEqual(checksum('a\n'), checksum('b\n'));
  assert.equal(versionOf('supabase/2026-11-08_x.sql'), '2026-11-08_x');
});

test('createdObjects: 표·인덱스·뷰·함수·역할·추가 열, 주석은 무시', () => {
  const sql = `
    -- create table ignored_in_comment (x int);
    create table if not exists public.t1 (id int);
    create unique index concurrently if not exists t1_uq on public.t1 (id);
    create or replace view v1 as select 1;
    create materialized view if not exists mv1 as select 1;
    create or replace function public.f1(a int) returns int language sql as $$ select a $$;
    do $$ begin if not exists (select 1 from pg_roles where rolname = 'r1') then create role r1 nologin; end if; end $$;
    alter table public.t1 add column if not exists c1 text, add column c2 int;
    /* create table also_ignored (x int); */
  `;
  assert.deepEqual(createdObjects(sql).map(label), [
    'column:public.t1.c1',
    'column:public.t1.c2',
    'function:public.f1',
    'relation:public.mv1',
    'relation:public.t1',
    'relation:public.t1_uq',
    'relation:public.v1',
    'role:r1',
  ]);
});

test('createdObjects: 같은 파일에서 만든 뒤 drop 하면 뺀다, drop 뒤 다시 만들면 남긴다', () => {
  assert.deepEqual(createdObjects('create table a (x int); drop table a;').map(label), []);
  assert.deepEqual(createdObjects('drop view if exists b; create view b as select 1;').map(label), ['relation:public.b']);
});

test('baselineSql: 객체 없는 파일은 unverifiable 행, 있으면 존재 확인식', () => {
  const s = baselineSql([
    { filename: '2026-01-01_a.sql', text: 'create index if not exists i on t (x);' },
    { filename: '2026-01-02_b.sql', text: 'update t set x = 1;' },
  ]);
  assert.match(s, /'2026-01-01_a', '[0-9a-f]{64}', 'relation:public\.i', to_regclass\('public\.i'\) is not null\)/);
  assert.match(s, /'2026-01-02_b', '[0-9a-f]{64}', null, null\)/);
  assert.match(s, /on conflict \(version\) do nothing/);
});

test('packSql: concurrently 는 트랜잭션으로 감싸지 않는다, 나머지는 begin/commit', () => {
  const a = packSql({ filename: 'x.sql', text: 'create index concurrently if not exists i on t (x);\n' });
  assert.doesNotMatch(a, /^begin;$/m);
  assert.match(a, /insert into public\.schema_migrations/);
  const b = packSql({ filename: 'y.sql', text: 'create table if not exists t (x int);\n' });
  assert.match(b, /^begin;$/m);
  assert.match(b, /^commit;$/m);
  assert.match(b, /already applied: y/);
});

test('compare: 미등록·checksum 다름·DB 에만 있음', () => {
  const files = [
    { filename: 'a.sql', text: 'x' },
    { filename: 'b.sql', text: 'y' },
    { filename: 'c.sql', text: 'z' },
  ];
  const r = compare(files, [
    { version: 'a', checksum: checksum('x') },
    { version: 'b', checksum: 'different' },
    { version: 'old', checksum: 'h' },
  ]);
  assert.deepEqual(r, { unregistered: ['c.sql'], checksumDiffers: ['b.sql'], dbOnly: ['old'] });
});
