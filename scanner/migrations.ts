// supabase/*.sql 적용 기록 도구(안정화 2단계). 설계: scanner/migrations-lib.ts 맨 위.
//   node scanner/migrations.ts baseline            → baseline SQL 출력(SQL Editor 에 붙여 실행)
//   node scanner/migrations.ts pack <file.sql>     → 적용+기록 SQL 출력 (PowerShell: ... | Set-Clipboard)
//   node scanner/migrations.ts check               → 저장소 파일과 DB 기록 비교(env LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY)
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { supabaseHeaders } from './lib.ts';
import { baselineSql, compare, packSql, type DbMigration, type SqlFile } from './migrations-lib.ts';

const DIR = 'supabase';

function sqlFiles(): SqlFile[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ filename: f, text: readFileSync(join(DIR, f), 'utf8') }));
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'baseline') {
    process.stdout.write(baselineSql(sqlFiles()));
    return;
  }
  if (cmd === 'pack') {
    if (!arg) throw new Error('usage: pack <supabase/file.sql>');
    process.stdout.write(packSql({ filename: basename(arg), text: readFileSync(arg, 'utf8') }));
    return;
  }
  if (cmd === 'check') {
    const url = process.env.LOWDOWN_SUPABASE_URL;
    const key = process.env.LOWDOWN_SCANNER_KEY;
    if (!url || !key) throw new Error('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY required');
    const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/schema_migrations?select=version,checksum&order=version.asc`, {
      headers: supabaseHeaders(key, { Accept: 'application/json' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`schema_migrations read failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`.trim());
    const r = compare(sqlFiles(), (await res.json()) as DbMigration[]);
    console.log(`unregistered ${r.unregistered.length}, checksum differs ${r.checksumDiffers.length}, db only ${r.dbOnly.length}`);
    for (const f of r.unregistered) console.log(`::warning::not recorded in schema_migrations: ${f}`);
    for (const f of r.checksumDiffers) console.log(`::warning::checksum differs from recorded (file changed after apply): ${f}`);
    for (const v of r.dbOnly) console.log(`::warning::recorded but no file: ${v}`);
    return;
  }
  throw new Error('usage: node scanner/migrations.ts baseline | pack <file.sql> | check');
}

main().catch((e: unknown) => {
  console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
