// supabase/*.sql 적용 기록(schema_migrations) — 안정화 2단계(2026-11-08).
//   - checksum: BOM 제거 + CRLF→LF 뒤 sha256(Windows 체크아웃과 Linux 가 같은 값).
//   - baseline: 파일이 만드는 객체(표·인덱스·뷰·함수·역할·추가 열)가 실제 DB 에 모두 있을 때만 등록. 파일이 있다는 이유만으로 등록하지 않는다.
//   - pack: 적용 SQL + 기록 insert 를 한 번에(가능하면 같은 트랜잭션). concurrently 가 있으면 트랜잭션으로 감싸지 않는다.
//   - check: 저장소 파일과 DB 기록 비교(미등록·checksum 다름·DB 에만 있음).
import { createHash } from 'node:crypto';

export function normalizeSql(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

export function checksum(text: string): string {
  return createHash('sha256').update(normalizeSql(text), 'utf8').digest('hex');
}

export function versionOf(filename: string): string {
  return filename.replace(/^.*[\\/]/, '').replace(/\.sql$/i, '');
}

export type ObjKind = 'relation' | 'function' | 'role' | 'column';
export interface ObjCheck {
  kind: ObjKind;
  schema: string;
  name: string;
  column?: string;
}

function stripComments(sql: string): string {
  return normalizeSql(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function splitName(raw: string): { schema: string; name: string } {
  const clean = raw.replace(/"/g, '').toLowerCase();
  const i = clean.lastIndexOf('.');
  return i < 0 ? { schema: 'public', name: clean } : { schema: clean.slice(0, i), name: clean.slice(i + 1) };
}

const IDENT = String.raw`((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)`;

/** 파일이 만드는 객체 목록(중복 제거, 정렬). 같은 파일 안에서 만든 뒤 drop 한 것은 뺀다. */
export function createdObjects(sql: string): ObjCheck[] {
  const s = stripComments(sql);
  const out = new Map<string, ObjCheck>();
  const add = (c: ObjCheck) => out.set(`${c.kind}:${c.schema}.${c.name}${c.column ? `.${c.column}` : ''}`, c);
  const rel = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:materialized\s+)?(?:table|index|view)\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?${IDENT}`, 'gi');
  for (const m of s.matchAll(rel)) if (!/^on$/i.test(m[1]!)) add({ kind: 'relation', ...splitName(m[1]!) }); // 이름 없는 create index on ... 은 건너뜀
  const fn = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+${IDENT}\s*\(`, 'gi');
  for (const m of s.matchAll(fn)) add({ kind: 'function', ...splitName(m[1]!) });
  for (const m of s.matchAll(/\bcreate\s+role\s+("?[\w$]+"?)/gi)) add({ kind: 'role', schema: '', name: m[1]!.replace(/"/g, '').toLowerCase() });
  // alter table X add column [if not exists] C, add column ...
  const alter = new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${IDENT}([^;]*)`, 'gi');
  for (const m of s.matchAll(alter)) {
    const t = splitName(m[1]!);
    for (const c of m[2]!.matchAll(/\badd\s+column\s+(?:if\s+not\s+exists\s+)?("?[\w$]+"?)/gi)) add({ kind: 'column', ...t, column: c[1]!.replace(/"/g, '').toLowerCase() });
  }
  // 같은 파일에서 drop 이 마지막 create 뒤에 오면 뺀다(드묾)
  const drop = new RegExp(String.raw`\bdrop\s+(?:materialized\s+)?(table|index|view|function)\s+(?:concurrently\s+)?(?:if\s+exists\s+)?${IDENT}`, 'gi');
  for (const m of s.matchAll(drop)) {
    const n = splitName(m[2]!);
    const kind: ObjKind = m[1]!.toLowerCase() === 'function' ? 'function' : 'relation';
    const key = `${kind}:${n.schema}.${n.name}`;
    const lastCreate = Math.max(
      ...[...s.matchAll(kind === 'function' ? fn : rel)].filter((x) => { const k = splitName(x[1]!); return k.schema === n.schema && k.name === n.name; }).map((x) => x.index ?? -1),
      -1,
    );
    if (lastCreate >= 0 && (m.index ?? 0) > lastCreate) out.delete(key);
  }
  return [...out.values()].sort((a, b) => `${a.kind}${a.schema}${a.name}${a.column ?? ''}`.localeCompare(`${b.kind}${b.schema}${b.name}${b.column ?? ''}`));
}

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

export function existsExpr(c: ObjCheck): string {
  switch (c.kind) {
    case 'relation':
      return `to_regclass(${lit(`${c.schema}.${c.name}`)}) is not null`;
    case 'function':
      return `exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = ${lit(c.schema)} and p.proname = ${lit(c.name)})`;
    case 'role':
      return `exists(select 1 from pg_roles where rolname = ${lit(c.name)})`;
    case 'column':
      return `exists(select 1 from information_schema.columns where table_schema = ${lit(c.schema)} and table_name = ${lit(c.name)} and column_name = ${lit(c.column ?? '')})`;
  }
}

export function label(c: ObjCheck): string {
  return c.kind === 'column' ? `column:${c.schema}.${c.name}.${c.column}` : c.kind === 'role' ? `role:${c.name}` : `${c.kind}:${c.schema}.${c.name}`;
}

export interface SqlFile {
  filename: string; // 예: 2026-11-08_analyst_role.sql
  text: string;
}

/** baseline SQL: 객체가 모두 있는 파일만 schema_migrations 에 baseline 으로 넣고, 파일별 결과를 보여 준다. */
export function baselineSql(files: readonly SqlFile[], appliedFrom = 'baseline 2026-11-08'): string {
  const rows: string[] = [];
  for (const f of files) {
    const v = versionOf(f.filename);
    const sum = checksum(f.text);
    const objs = createdObjects(f.text);
    if (objs.length === 0) rows.push(`(${lit(f.filename)}, ${lit(v)}, ${lit(sum)}, null, null)`);
    for (const o of objs) rows.push(`(${lit(f.filename)}, ${lit(v)}, ${lit(sum)}, ${lit(label(o))}, ${existsExpr(o)})`);
  }
  return [
    `-- 생성: node scanner/migrations.ts baseline (${files.length}개 파일). postgres 로 실행(분석 역할 아님). 여러 번 실행해도 안전.`,
    `set statement_timeout = '60s';`,
    `create temp table if not exists _mig_check (filename text, version text, checksum text, obj text, present boolean);`,
    `truncate _mig_check;`,
    `insert into _mig_check values`,
    rows.join(',\n') + ';',
    `insert into public.schema_migrations (version, filename, checksum, baseline, note)`,
    `select version, filename, checksum, true, ${lit(appliedFrom)} || ': ' || count(obj) || ' objects present'`,
    `from _mig_check group by version, filename, checksum`,
    `having count(obj) > 0 and bool_and(present)`,
    `on conflict (version) do nothing;`,
    `select filename,`,
    `  case when count(obj) = 0 then 'unverifiable' when bool_and(present) then 'baseline' else 'missing' end as status,`,
    `  string_agg(case when not present then obj end, ', ') as missing`,
    `from _mig_check group by filename order by 2, 1;`,
    '',
  ].join('\n');
}

/** 적용용 SQL: 본문 + 기록. concurrently 가 없으면 begin/commit 으로 감싸 적용과 기록을 같이 성공·실패시킨다. */
export function packSql(f: SqlFile): string {
  const v = versionOf(f.filename);
  const sum = checksum(f.text);
  const body = normalizeSql(f.text).trimEnd();
  const concurrent = /\bconcurrently\b/i.test(stripComments(f.text));
  const hasTx = /^\s*(begin|commit)\s*;/im.test(stripComments(f.text));
  const guard = [
    `do $mig$ begin`,
    `  if exists (select 1 from public.schema_migrations where version = ${lit(v)} and checksum = ${lit(sum)}) then raise exception 'already applied: ${v}'; end if;`,
    `  if exists (select 1 from public.schema_migrations where version = ${lit(v)}) then raise exception 'checksum differs from recorded: ${v} (do not re-apply; make a new file)'; end if;`,
    `end $mig$;`,
  ].join('\n');
  const record = `insert into public.schema_migrations (version, filename, checksum, execution_ms) select ${lit(v)}, ${lit(f.filename)}, ${lit(sum)}, (extract(epoch from clock_timestamp() - t0) * 1000)::int from _mig_t0;`;
  const t0 = `create temp table if not exists _mig_t0 as select clock_timestamp() as t0;`;
  if (concurrent || hasTx) {
    return [`-- ${f.filename} (${concurrent ? 'concurrently' : 'own transaction'}: 트랜잭션으로 감싸지 않음 — 본문을 단독 실행한 뒤 마지막 insert 를 실행)`, guard, t0, '', body, '', record, ''].join('\n');
  }
  return [`-- ${f.filename}: 적용과 기록을 한 트랜잭션으로`, guard, 'begin;', t0, '', body, '', record, 'commit;', ''].join('\n');
}

export interface DbMigration {
  version: string;
  checksum: string | null;
}

export interface CheckResult {
  unregistered: string[];
  checksumDiffers: string[];
  dbOnly: string[];
}

export function compare(files: readonly SqlFile[], db: readonly DbMigration[]): CheckResult {
  const byV = new Map(db.map((r) => [r.version, r]));
  const fileVs = new Set(files.map((f) => versionOf(f.filename)));
  const unregistered: string[] = [];
  const checksumDiffers: string[] = [];
  for (const f of files) {
    const r = byV.get(versionOf(f.filename));
    if (!r) unregistered.push(f.filename);
    else if (r.checksum && r.checksum !== checksum(f.text)) checksumDiffers.push(f.filename);
  }
  const dbOnly = db.map((r) => r.version).filter((v) => !fileVs.has(v)).sort();
  return { unregistered: unregistered.sort(), checksumDiffers: checksumDiffers.sort(), dbOnly };
}
