"""월별 Parquet — 날짜별 CSV.gz(원본)를 모아 지난달 파일 1개를 만든다.

사용: python scanner/archive_parquet.py <outDir> [--dry-run]
- 원본은 날짜별 CSV.gz 다. Parquet 은 분석용 사본이며, 같은 달의 모든 날이 MANIFEST 에 있을 때만 만든다.
- 읽기 전에 각 날짜 파일의 SHA-256 을 MANIFEST 와 대조한다. 다르면 만들지 않고 실패한다.
- metadata JSON 의 키를 m_<키> 열로 펼친다(중첩 값과 형식이 섞인 키는 JSON 문자열). 한 번 만든 파일은 다시 만들지 않는다.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

import pyarrow as pa
import pyarrow.parquet as pq

MANIFEST_FILE = "MANIFEST.csv"
MANIFEST_COLUMNS = ["dataset", "day", "path", "rows", "bytes", "sha256", "written_at"]
OBSERVATIONS_FROM = "2026-10-06"
INT_COLUMNS = {"id": pa.int64(), "http_status": pa.int16(), "reached_level": pa.int16(), "latency_ms": pa.int32()}


def fail(msg: str) -> None:
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def read_manifest(path: str) -> list[dict[str, str]]:
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))
    if not rows:
        return []
    if rows[0] != MANIFEST_COLUMNS:
        fail("MANIFEST.csv: unexpected header")
    return [dict(zip(MANIFEST_COLUMNS, r)) for r in rows[1:] if r]


def write_manifest(path: str, entries: list[dict[str, str]]) -> None:
    # archive-lib.ts serializeManifest 와 같은 형식·정렬(dataset, day)
    lines = [",".join(MANIFEST_COLUMNS)]
    for e in sorted(entries, key=lambda e: (e["dataset"], e["day"])):
        lines.append(",".join(str(e[c]) for c in MANIFEST_COLUMNS))
    with open(path + ".tmp", "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(path + ".tmp", path)


def month_days(month: str) -> list[str]:
    y, m = map(int, month.split("-"))
    d = date(y, m, 1)
    out = []
    while d.month == m:
        s = d.isoformat()
        if s >= OBSERVATIONS_FROM:
            out.append(s)
        d += timedelta(days=1)
    return out


def column_type(values: list) -> str:
    kinds = {type(v) for v in values if v is not None}
    if not kinds:
        return "string"
    if kinds == {bool}:
        return "bool"
    if kinds == {int}:
        return "int"
    if kinds <= {int, float}:
        return "float"
    if kinds == {str}:
        return "string"
    return "json"


def to_arrow(values: list, kind: str) -> pa.Array:
    if kind == "bool":
        return pa.array(values, type=pa.bool_())
    if kind == "int":
        return pa.array(values, type=pa.int64())
    if kind == "float":
        return pa.array([None if v is None else float(v) for v in values], type=pa.float64())
    if kind == "string":
        return pa.array(values, type=pa.string())
    return pa.array([None if v is None else json.dumps(v, ensure_ascii=False, separators=(",", ":")) for v in values], type=pa.string())


def build_table(header: list[str], rows: list[list[str]]) -> pa.Table:
    cols: dict[str, pa.Array] = {}
    mi = header.index("metadata")
    for i, name in enumerate(header):
        if i == mi:
            continue
        raw = [None if r[i] == "" else r[i] for r in rows]
        if name in INT_COLUMNS:
            cols[name] = pa.array([None if v is None else int(v) for v in raw], type=INT_COLUMNS[name])
        elif name == "observed_at":
            cols[name] = pa.array([None if v is None else datetime.fromisoformat(v.replace("Z", "+00:00")) for v in raw], type=pa.timestamp("us", tz="UTC"))
        else:
            cols[name] = pa.array(raw, type=pa.string())
    meta = [json.loads(r[mi]) if r[mi] else {} for r in rows]
    for key in sorted({k for m in meta for k in m}):
        values = [m.get(key) for m in meta]
        cols[f"m_{key}"] = to_arrow(values, column_type(values))
    return pa.table(cols)


def main() -> None:
    args = sys.argv[1:]
    if not args or args[0].startswith("--"):
        fail("사용법: python scanner/archive_parquet.py <outDir> [--dry-run]")
    out_dir, dry_run = args[0], "--dry-run" in args
    manifest_path = os.path.join(out_dir, MANIFEST_FILE)
    entries = read_manifest(manifest_path)
    obs = {e["day"]: e for e in entries if e["dataset"] == "observations"}
    done = {e["day"] for e in entries if e["dataset"] == "observations_parquet"}
    current = datetime.now(timezone.utc).strftime("%Y-%m")
    months = sorted({d[:7] for d in obs if d[:7] < current} - done)

    for month in months:
        days = month_days(month)
        missing = [d for d in days if d not in obs]
        if missing:
            print(f"parquet {month}: {len(missing)} day(s) not archived yet (skip)")
            continue
        header: list[str] | None = None
        rows: list[list[str]] = []
        for d in days:
            e = obs[d]
            data = open(os.path.join(out_dir, e["path"]), "rb").read()
            if hashlib.sha256(data).hexdigest() != e["sha256"]:
                fail(f"{e['path']}: SHA-256 이 MANIFEST 와 다릅니다 (Parquet 만들지 않음)")
            reader = csv.reader(io.StringIO(gzip.decompress(data).decode("utf-8"), newline=""))
            h = next(reader)
            if header is None:
                header = h
            elif h != header:
                fail(f"{e['path']}: 열이 다른 날과 다릅니다")
            day_rows = list(reader)
            if len(day_rows) != int(e["rows"]):
                fail(f"{e['path']}: 행 수 {len(day_rows)} ≠ MANIFEST {e['rows']}")
            rows.extend(day_rows)
        assert header is not None
        table = build_table(header, rows)
        rel = f"scanner_observations/parquet/{month}.parquet"
        full = os.path.join(out_dir, rel)
        if os.path.exists(full):
            fail(f"{rel}: 파일은 있는데 MANIFEST 에 없습니다 (덮어쓰지 않음)")
        if dry_run:
            print(f"parquet {month}: {table.num_rows} rows, {table.num_columns} columns (dry-run, not written)")
            continue
        os.makedirs(os.path.dirname(full), exist_ok=True)
        pq.write_table(table, full + ".tmp", compression="zstd", compression_level=19)
        os.replace(full + ".tmp", full)
        data = open(full, "rb").read()
        entries.append({
            "dataset": "observations_parquet", "day": month, "path": rel, "rows": str(table.num_rows),
            "bytes": str(len(data)), "sha256": hashlib.sha256(data).hexdigest(),
            "written_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        })
        write_manifest(manifest_path, entries)
        print(f"parquet {month}: {table.num_rows} rows, {table.num_columns} columns, {len(data)} B")


if __name__ == "__main__":
    main()
