import re, json, sys
from spec import ENUMS, DOMAINS, T, AUDIT_EXCLUDE, APPEND_ONLY, NO_DELETE

def camel(s):
    p = s.split('_'); return p[0] + ''.join(x[:1].upper() + x[1:] for x in p[1:])
def pascal(s):
    return ''.join(x[:1].upper() + x[1:] for x in s.split('_'))
def plural(s):
    if s.endswith('y') and s[-2:-1] not in 'aeiou': return s[:-1] + 'ies'
    return s + ('es' if s.endswith(('s', 'x')) else 's')

TABLES = {t['name']: t for t in T}

# ---- parse columns ----
for t in T:
    cols = []
    for line in t['cols']:
        name, typ, flags, desc = [x.strip() for x in line.split('|')]
        c = dict(name=name, type=typ, nn='NN' in flags.split(), uk='UK' in flags.split(), desc=desc, default=None, ref=None, enum=None)
        m = re.search(r"=(\S+)", flags)
        if m: c['default'] = m.group(1)
        if typ.startswith('->'): c['ref'] = typ[2:]; assert c['ref'] in TABLES, (t['name'], name)
        if typ.startswith('E:'): c['enum'] = typ[2:]; assert c['enum'] in ENUMS, typ
        cols.append(c)
    t['parsed'] = cols

def common_cols(t):
    out = [dict(name='id', type='uuid', nn=True, pk=True, desc='기본키')]
    if t['mode'] != 'root':
        out.append(dict(name='tenant_id', type='->tenant', ref='tenant', nn=True, desc='테넌트'))
    out.append(dict(name='created_at', type='ts', nn=True, default='now', desc='생성 일시'))
    if t['mode'] in ('full', 'root'):
        out += [dict(name='created_by', type='uuid', nn=False, desc='생성자'),
                dict(name='updated_at', type='ts', nn=True, default='now', updated=True, desc='변경 일시'),
                dict(name='updated_by', type='uuid', nn=False, desc='변경자'),
                dict(name='version', type='int', nn=True, default='1', desc='낙관적 잠금')]
    return out

def all_cols(t):
    if '_all' in t: return t['_all']
    cc = common_cols(t)
    head = cc[:2] if t['mode'] != 'root' else cc[:1]
    tail = cc[len(head):]
    t['_all'] = head + t['parsed'] + tail
    return t['_all']

# ---- PG types ----
def pgtype(c):
    ty = c['type']
    if ty.startswith('->') or ty == 'uuid': return 'uuid'
    if ty.startswith('E:'): return snake_enum(ty[2:])
    m = re.match(r'vc\((\d+)\)', ty)
    if m: return f'varchar({m.group(1)})'
    m = re.match(r'num\((\d+),(\d+)\)', ty)
    if m: return f'numeric({m.group(1)},{m.group(2)})'
    return {'text': 'text', 'int': 'integer', 'bigint': 'bigint', 'bool': 'boolean', 'date': 'date',
            'ts': 'timestamptz', 'json': 'jsonb', 'inet': 'inet'}[ty]

def snake_enum(e):
    return re.sub(r'(?<!^)([A-Z])', r'_\1', e).lower()

def pgdefault(c):
    d = c.get('default')
    if d is None: return None
    if d == 'now': return 'now()'
    if d in ('true', 'false'): return d
    if re.fullmatch(r"-?\d+(\.\d+)?", d): return d
    if d.startswith("'"): return d
    return f"'{d}'"  # enum literal

# ---- Prisma ----
def prisma_scalar(c):
    ty = c['type']
    if ty.startswith('->') or ty == 'uuid': return 'String', '@db.Uuid'
    if ty.startswith('E:'): return ty[2:], ''
    m = re.match(r'vc\((\d+)\)', ty)
    if m: return 'String', f'@db.VarChar({m.group(1)})'
    m = re.match(r'num\((\d+),(\d+)\)', ty)
    if m: return 'Decimal', f'@db.Decimal({m.group(1)}, {m.group(2)})'
    return {'text': ('String', ''), 'int': ('Int', ''), 'bigint': ('BigInt', ''), 'bool': ('Boolean', ''),
            'date': ('DateTime', '@db.Date'), 'ts': ('DateTime', '@db.Timestamptz(6)'), 'json': ('Json', ''),
            'inet': ('String', '@db.Inet')}[ty]

def prisma_default(c):
    d = c.get('default')
    if d is None: return ''
    if d == 'now': return '@default(now())'
    if d in ('true', 'false') or re.fullmatch(r"-?\d+(\.\d+)?", d): return f'@default({d})'
    if d.startswith("'"): return '@default("' + d.strip("'") + '")'
    return f'@default({d})'

def build_prisma():
    models = {t['name']: [] for t in T}
    backrefs = {t['name']: [] for t in T}
    # FK counts per (source, target)
    for t in T:
        fks = [c for c in all_cols(t) if c.get('ref')]
        per_target = {}
        for c in fks: per_target.setdefault(c['ref'], []).append(c)
        for c in fks:
            src, tgt = t['name'], c['ref']
            relname = f'{src}_{c["name"]}'
            fname = camel(c['name'][:-3])
            many = len(per_target[tgt]) > 1 or src == tgt
            back = camel(plural(src)) + (pascal(c['name'][:-3]) if many else '')
            c['rel'] = dict(name=relname, field=fname, back=back)
            uniq = c.get('uk')
            backrefs[tgt].append((back, pascal(src), relname, uniq))
    out = ['// ALM data model — generated from db spec (WBS 2.5). Do not hand-edit table/column names;',
           '// change the spec and regenerate so that the table definition doc stays in sync.',
           '// Prisma 7: connection URL lives in prisma.config.ts (DATABASE_URL).',
           'generator client {', '  provider = "prisma-client"', '  output   = "../src/generated/prisma"', '}', '',
           'datasource db {', '  provider = "postgresql"', '}', '']
    for t in T:
        lines = [f'/// {t["ko"]} — {t["desc"]}', f'model {pascal(t["name"])} {{']
        for c in all_cols(t):
            fn = camel(c['name'])
            typ, dbattr = prisma_scalar(c)
            opt = '' if c['nn'] else '?'
            attrs = []
            if c.get('pk'): attrs.append('@id @default(uuid(7))')
            if c.get('uk'): attrs.append('@unique')
            d = prisma_default(c)
            if d: attrs.append(d)
            if c.get('updated'): attrs.append('@updatedAt')
            if fn != c['name']: attrs.append(f'@map("{c["name"]}")')
            if dbattr: attrs.append(dbattr)
            doc = f'  /// {c["desc"]}' if c.get('desc') and not c.get('pk') else None
            if doc: lines.append(doc)
            lines.append(f'  {fn} {typ}{opt} {" ".join(attrs)}'.rstrip())
            if c.get('rel'):
                r = c['rel']
                lines.append(f'  {r["field"]} {pascal(c["ref"])}{opt} @relation("{r["name"]}", fields: [{fn}], references: [id])')
        for back, srcmodel, relname, uniq in backrefs[t['name']]:
            lines.append(f'  {back} {srcmodel}{"?" if uniq else "[]"} @relation("{relname}")')
        for u in t['uniques']:
            lines.append(f'  @@unique([{", ".join(camel(x) for x in u)}])')
        for i in t['indexes']:
            lines.append(f'  @@index([{", ".join(camel(x) for x in i)}])')
        lines.append(f'  @@map("{t["name"]}")')
        lines.append('}')
        out += lines + ['']
    for e, (ko, vals) in ENUMS.items():
        out.append(f'/// {ko}')
        out.append(f'enum {e} {{')
        out += [f'  {v}' for v in vals]
        out.append(f'  @@map("{snake_enum(e)}")')
        out.append('}')
        out.append('')
    # field-name collision check
    for t in T:
        names = [camel(c['name']) for c in all_cols(t)] + [c['rel']['field'] for c in all_cols(t) if c.get('rel')] + [b[0] for b in backrefs[t['name']]]
        dup = {n for n in names if names.count(n) > 1}
        assert not dup, (t['name'], dup)
    return '\n'.join(out)

# ---- DDL ----
def build_ddl():
    o = ['-- ALM data model DDL (PostgreSQL 16). Generated from db spec (WBS 2.5).',
         '-- Prisma migrations are the deploy path; this file is the reviewed reference.', '',
         'BEGIN;', '']
    for e, (ko, vals) in ENUMS.items():
        o.append(f"CREATE TYPE {snake_enum(e)} AS ENUM ({', '.join(repr(v) for v in vals)});  -- {ko}")
    o.append('')
    fks = []
    for t in T:
        o.append(f'-- {t["ko"]}: {t["desc"]}')
        o.append(f'CREATE TABLE {t["name"]} (')
        defs = []
        for c in all_cols(t):
            s = f'  {c["name"]} {pgtype(c)}'
            if c.get('pk'): s += ' PRIMARY KEY'
            if c['nn'] and not c.get('pk'): s += ' NOT NULL'
            d = pgdefault(c)
            if d: s += f' DEFAULT {d}'
            if c.get('uk'): s += ' UNIQUE'
            defs.append(s)
            if c.get('ref'): fks.append((t['name'], c['name'], c['ref']))
        for u in t['uniques']:
            # user_role: 범위 컬럼이 NULL(=전체)인 같은 역할이 중복되지 않게 NULLS NOT DISTINCT (PG15+, Prisma 표현 불가)
            nnd = ' NULLS NOT DISTINCT' if t['name'] == 'user_role' and len(u) > 1 else ''
            defs.append(f'  UNIQUE{nnd} ({", ".join(u)})')
        if t['name'] == 'tenant':
            defs.append("  CHECK (idp_provider_name ~ '^T-[A-Z0-9-]+$')")
        if t['name'] == 'approval':
            defs.append('  CHECK (num_nonnulls(asset_request_id, purchase_request_id) = 1)')
        o.append(',\n'.join(defs))
        o.append(');')
        for c in all_cols(t):
            if c.get('desc'):
                o.append(f"COMMENT ON COLUMN {t['name']}.{c['name']} IS {sql_str(c['desc'])};")
        o.append(f"COMMENT ON TABLE {t['name']} IS {sql_str(t['ko'] + ' — ' + t['desc'])};")
        for i in t['indexes']:
            o.append(f'CREATE INDEX ix_{t["name"]}_{"_".join(i)} ON {t["name"]} ({", ".join(i)});')
        o.append('')
    for src, col, tgt in fks:
        o.append(f'ALTER TABLE {src} ADD CONSTRAINT fk_{src}_{col} FOREIGN KEY ({col}) REFERENCES {tgt}(id);')
    o.append('')
    o.append('-- Row level security: 앱은 트랜잭션마다 SET LOCAL app.tenant_id = <테넌트 id> 를 실행한다')
    for t in T:
        o.append(f"ALTER TABLE {t['name']} ENABLE ROW LEVEL SECURITY;")
        col = 'id' if t['mode'] == 'root' else 'tenant_id'
        o.append(f"CREATE POLICY p_{t['name']}_tenant ON {t['name']} USING ({col} = current_setting('app.tenant_id')::uuid);")
    o.append('')
    o.append(open('views.sql').read())
    o.append(open('security.sql').read())
    o.append('-- 추가만 되는 로그 테이블(앱 계정에서 수정·삭제 회수)')
    for n in APPEND_ONLY:
        o.append(f'REVOKE UPDATE, DELETE, TRUNCATE ON {n} FROM alm_app;')
    for n in NO_DELETE:
        o.append(f'REVOKE DELETE, TRUNCATE ON {n} FROM alm_app;')
    o.append('')
    for t in T:
        if t['mode'] != 'log' and t['name'] not in AUDIT_EXCLUDE:
            o.append(f"CREATE TRIGGER tr_{t['name']}_audit AFTER INSERT OR UPDATE OR DELETE ON {t['name']} FOR EACH ROW EXECUTE FUNCTION audit_row();")
    o.append('')
    o.append(open('security_end.sql').read())
    o.append('COMMIT;')
    return '\n'.join(o)

def sql_str(s): return "'" + s.replace("'", "''") + "'"

# ---- Doc markdown ----
def doc_type(c):
    if c.get('ref'): return 'uuid'
    if c.get('enum'): return c['enum']
    return pgtype(c)

def doc_table(t):
    lines = [f'### {t["name"]} · {t["ko"]}', '', t['desc'] + f'. 화면: {t["screens"]}.' if t['screens'] not in ('', '-') else t['desc'] + '.', '']
    lines += ['| 컬럼 | 타입 | 필수 | 키·기본값 | 설명 |', '| --- | --- | --- | --- | --- |']
    uk_cols = {u[0] for u in t['uniques'] if len(u) == 1}
    for c in t['parsed']:
        keys = []
        if c.get('ref'): keys.append(f'FK → {c["ref"]}')
        if c.get('uk') or c['name'] in uk_cols: keys.append('UK')
        d = c.get('default')
        if d: keys.append('기본 ' + ('now()' if d == 'now' else d.strip("'") if d != "''" else "''"))
        lines.append(f'| {c["name"]} | {doc_type(c)} | {"Y" if c["nn"] else ""} | {", ".join(keys)} | {c["desc"]} |')
    extra = []
    multi = [u for u in t['uniques'] if len(u) > 1 or u[0] not in [c['name'] for c in t['parsed']]]
    if multi: extra.append('UNIQUE ' + ' · '.join('(' + ', '.join(u) + ')' for u in multi))
    if t['indexes']: extra.append('INDEX ' + ' · '.join('(' + ', '.join(i) + ')' for i in t['indexes']))
    if t['name'] == 'approval': extra.append('CHECK asset_request_id·purchase_request_id 중 정확히 하나')
    if t['name'] == 'tenant': extra.append("CHECK idp_provider_name은 T-로 시작하는 대문자·숫자·하이픈(밑줄 금지)")
    if t['name'] == 'user_role': extra.append('UNIQUE는 NULLS NOT DISTINCT(범위가 빈 같은 역할 중복 방지)')
    if t['name'] in APPEND_ONLY: extra.append('앱 계정은 추가만(수정·삭제 불가)')
    if t['mode'] == 'log': extra.append('로그 테이블: 공통 컬럼 중 id·tenant_id·created_at만')
    if t['mode'] == 'root': extra.append('tenant_id 없음')
    if extra:
        lines += [''] + ['제약: ' + '; '.join(extra)]
    return '\n'.join(lines)

if __name__ == '__main__':
    # 실행: db/spec 에서 `python gen.py` → ../schema.prisma, ../ddl.sql, out/(문서 표)
    import os
    os.makedirs('out', exist_ok=True)
    open('../schema.prisma', 'w').write(build_prisma())
    open('../ddl.sql', 'w').write(build_ddl())
    docs = {}
    for d, ko in DOMAINS:
        docs[d] = '\n\n'.join(doc_table(t) for t in T if t['domain'] == d)
    json.dump(docs, open('out/doc_tables.json', 'w'), ensure_ascii=False, indent=1)
    summary = [(t['domain'], t['name'], t['ko'], t['desc'], len(t['parsed']), t['screens']) for t in T]
    json.dump(summary, open('out/summary.json', 'w'), ensure_ascii=False)
    print(len(T), 'tables', sum(len(t['parsed']) for t in T), 'business columns', len(ENUMS), 'enums')
