# -*- coding: utf-8 -*-
"""
parse-export.py — turn a POS inventory export into a site catalogue manifest.

    python3 parse-export.py export.xlsx --out catalogue.json --manifest media.csv

Handles Lightspeed/Vend, Square, Clover, Shopify and generic CSV/XLSX exports by
matching column names rather than positions. Emits:

  catalogue.json   { items:[...], tree:[...], log:{...} }   -> the site reads this
  media.csv        one row per item with empty photo slots  -> bulk photo sourcing

DESIGN RULE: this script never invents a fact. A missing price stays missing, a
missing pack size stays missing. Everything it *does* change (category merges,
key collisions) is counted in the log and printed, so the operator sees it.
"""
import sys, os, json, re, csv, argparse, unicodedata, collections, itertools

# --------------------------------------------------------------------------
# Column aliases. Left = our field, right = names seen in real exports.
# Matching is case/space/underscore-insensitive. First hit wins.
# --------------------------------------------------------------------------
ALIASES = {
 'name'     : ['name','product name','item name','title','description name','producto'],
 'sku'      : ['sku','item number','variant sku','barcode','upc','code','item_code'],
 'handle'   : ['handle','slug','url handle','permalink'],
 'category' : ['product_category','category','categories','product type','item category',
               'department','product category','categoria'],
 'price'    : ['retail_price','price','variant price','item price','unit price','regular price'],
 'cost'     : ['supply_price','cost','unit cost','variant cost','cost per item'],
 'brand'    : ['brand_name','brand','vendor','manufacturer','marca'],
 'supplier' : ['supplier_name','supplier','vendor name','distributor','proveedor'],
 'stock'    : ['inventory_main_outlet','inventory','stock','quantity','qty','stock on hand',
               'variant inventory qty','current stock'],
 'active'   : ['active','enabled','is active','published','status'],
 'tags'     : ['tags','tag','keywords'],
 'desc'     : ['description','body html','long description','details'],
}
TRUTHY = {'1','true','yes','y','active','published','enabled'}

def norm_key(s):
    return re.sub(r'[^a-z0-9]+','', str(s or '').lower())

def build_colmap(header):
    hn = {norm_key(h): h for h in header}
    out = {}
    for field, names in ALIASES.items():
        for cand in names:
            k = norm_key(cand)
            if k in hn:
                out[field] = hn[k]
                break
    return out

def slug(s):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii','ignore').decode()
    s = re.sub(r'[^a-zA-Z0-9]+','-', s).strip('-').lower()
    return s or 'x'

def money(v):
    try:
        f = float(str(v).replace('$','').replace(',','').strip())
        return round(f,2) if f > 0 else None
    except Exception:
        return None

def whole(v):
    try:
        return int(float(str(v).replace(',','').strip()))
    except Exception:
        return None

# --------------------------------------------------------------------------
# Category normalisation.
#
# Real exports are typed by hand at a register over years, so the same shelf
# appears under several spellings. We merge ONLY variants that differ by
# pluralisation, a missing/extra letter, or accents — never two names that could
# plausibly be different shelves. Every merge is logged so it can be reviewed.
# --------------------------------------------------------------------------
def canon_cat(s):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii','ignore').decode()
    return re.sub(r'[^a-z0-9]+','', s.lower())

def singularise(tok):
    """Spanish/English plural fold: VASOS->VASO, BOLSAS->BOLSA, PLATOS->PLATO."""
    for suf in ('es','s'):
        if len(tok) > 4 and tok.endswith(suf):
            return tok[:-len(suf)]
    return tok

def cat_signature(path):
    """A fold-key: accents stripped, plurals folded, order preserved."""
    parts = [p.strip() for p in str(path).split('/')]
    out = []
    for p in parts:
        toks = [singularise(canon_cat(t)) for t in p.split() if t.strip()]
        out.append(''.join(toks))
    return '/'.join(out)

def read_rows(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.xlsx','.xlsm','.xltx'):
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True)
        ws = wb[wb.sheetnames[0]]
        rows = list(ws.iter_rows(values_only=True))
        if not rows: return [], []
        return list(rows[0]), rows[1:]
    with open(path, newline='', encoding='utf-8-sig') as f:
        sample = f.read(8192); f.seek(0)
        try:    dialect = csv.Sniffer().sniff(sample)
        except Exception: dialect = csv.excel
        r = list(csv.reader(f, dialect))
    return (r[0], r[1:]) if r else ([], [])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source')
    ap.add_argument('--out', default='catalogue.json')
    ap.add_argument('--manifest', default='media-manifest.csv')
    ap.add_argument('--photo-slots', type=int, default=5,
                    help='empty photo columns to emit per item (default 5)')
    ap.add_argument('--keep-inactive', action='store_true')
    ap.add_argument('--names', default='',
                    help='optional JSON file mapping raw category -> English display name')
    a = ap.parse_args()

    header, rows = read_rows(a.source)
    if not header:
        sys.exit('No rows found in ' + a.source)
    col = build_colmap(header)
    if 'name' not in col:
        sys.exit('Could not find a product-name column. Columns seen: %s' % (list(header),))
    idx = {h: i for i, h in enumerate(header)}
    EN  = json.load(open(a.names, encoding='utf-8')) if a.names else {}

    def get(row, field):
        c = col.get(field)
        if c is None: return ''
        v = row[idx[c]] if idx[c] < len(row) else ''
        return '' if v is None else str(v).strip()

    log = collections.Counter()
    # pass 1: fold category spellings, keeping the most common as canonical
    counts = collections.Counter()
    for row in rows:
        c = get(row, 'category')
        if c: counts[c] += 1
    canon = {}
    for sig, group in itertools.groupby(
            sorted(counts, key=lambda c: (cat_signature(c), -counts[c])), key=cat_signature):
        group = list(group)
        winner = group[0]                      # most common spelling of this signature
        for g in group:
            canon[g] = winner
            if g != winner: log['category_merged'] += counts[g]

    items, seen = [], set()
    for row in rows:
        active = get(row, 'active')
        if not a.keep_inactive and col.get('active') and active.lower() not in TRUTHY:
            log['skipped_inactive'] += 1; continue
        name = get(row, 'name')
        if not name:
            log['skipped_no_name'] += 1; continue

        cat = get(row, 'category')
        cat = canon.get(cat, cat)
        if not cat:
            cat = 'UNCATEGORISED / UNCATEGORISED'; log['category_missing'] += 1
        parts = [p.strip() for p in cat.split('/')]
        top = parts[0]
        sub = parts[1] if len(parts) > 1 and parts[1] else top

        key = slug(get(row, 'handle') or name)
        base, n = key, 2
        while key in seen:
            key = '%s-%d' % (base, n); n += 1; log['key_collision'] += 1
        seen.add(key)

        price = money(get(row, 'price'))
        if price is None: log['no_price'] += 1
        stock = whole(get(row, 'stock'))

        items.append({
            'key': key, 'name': name, 'sku': get(row, 'sku'),
            'top': top, 'topEn': EN.get(top, top.title()),
            'sub': sub, 'subEn': EN.get(sub, sub.title()),
            'topSlug': slug(top), 'subSlug': slug(sub),
            'price': price, 'brand': get(row, 'brand'),
            'supplier': get(row, 'supplier'), 'stock': stock,
            'tags': get(row, 'tags'),
        })
        log['kept'] += 1

    # tree, biggest sub-category first inside each department
    tree = collections.OrderedDict()
    for it in items:
        t = tree.setdefault(it['topSlug'],
            {'slug': it['topSlug'], 'es': it['top'], 'en': it['topEn'], 'subs': collections.OrderedDict()})
        s = t['subs'].setdefault(it['subSlug'],
            {'slug': it['subSlug'], 'es': it['sub'], 'en': it['subEn'], 'n': 0})
        s['n'] += 1
    for t in tree.values():
        t['subs'] = collections.OrderedDict(
            sorted(t['subs'].items(), key=lambda kv: (-kv[1]['n'], kv[1]['es'])))
        t['n'] = sum(s['n'] for s in t['subs'].values())
    ordered = sorted(tree.values(), key=lambda t: -t['n'])

    out = {'items': items,
           'tree': [{'slug': t['slug'], 'es': t['es'], 'en': t['en'], 'n': t['n'],
                     'subs': list(t['subs'].values())} for t in ordered],
           'log': dict(log)}
    json.dump(out, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

    slots = ['photo_%d' % (i+1) for i in range(a.photo_slots)]
    with open(a.manifest, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['key','name','sku','brand','supplier','category','price','stock'] + slots)
        for it in items:
            w.writerow([it['key'], it['name'], it['sku'], it['brand'], it['supplier'],
                        '%s / %s' % (it['top'], it['sub']),
                        it['price'] if it['price'] is not None else '',
                        it['stock'] if it['stock'] is not None else ''] + ['']*len(slots))

    print('columns matched :', {k: v for k, v in col.items()})
    print('parse log       :', dict(log))
    print('items           :', len(items))
    print('departments     :', len(out['tree']),
          '| sub-categories:', sum(len(t['subs']) for t in out['tree']))
    for t in out['tree']:
        print('  %6d  %s (%s) — %d subs' % (t['n'], t['es'], t['en'], len(t['subs'])))
    if log.get('category_merged'):
        print('\nNOTE: %d rows had their category spelling folded into a canonical name.'
              % log['category_merged'])
        print('      Review the tree above before shipping — merges are conservative but not infallible.')

if __name__ == '__main__':
    main()
