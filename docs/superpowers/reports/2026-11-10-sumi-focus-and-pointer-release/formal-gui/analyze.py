#!/usr/bin/env python3
"""Reject oscillation or vacuous clamp-boundary evidence in marked stable intervals."""
import argparse,json,pathlib

def analyze(records):
    if len(records)<20:raise ValueError('at least20 samples required')
    if (records[-1]['monotonic_us']-records[0]['monotonic_us'])<1_000_000:raise ValueError('stable interval must span at least1second')
    if not any(r['kind']=='after-paint' for r in records):raise ValueError('no actual painted frame observed')
    for r in records:
        a=r['vadjustment']
        if not (a['lower']+100<a['value']<a['upper']-a['page_size']-100):raise ValueError('mid-scroll gate failed; clamp boundary cannot prove stability')
        if not (r['line_count']>=200 and 40<=r['line']<r['line_count']-40):raise ValueError('long-document middle caret required')
    if max(r['vadjustment']['value'] for r in records)-min(r['vadjustment']['value'] for r in records)>1e-6:raise ValueError('adjustment oscillates in stable interval')
    for key in ['window_xy','gtk_cursor','view_allocation','outer_allocation','gdk_outer_geometry','font_size_pango','insert_offset']:
        values=[r[key] for r in records]
        if any(v!=values[0] for v in values):raise ValueError(f'{key} changes in fixed-insertion stable interval')
    if any(r['vscrollbar']['mapped'] or r['hscrollbar']['mapped'] or r['shadow_type']!=0 for r in records):raise ValueError('Sumi scrollbars/shadow still mapped')
    first=records[0]
    return {'passed':True,'samples':len(records),'paint_samples':sum(r['kind']=='after-paint' for r in records),'duration_us':records[-1]['monotonic_us']-first['monotonic_us'],'scale':first['scale'],'viewport_height':first['view_allocation'][3],'viewport_parity':first['view_allocation'][3]%2,'gtk_caret_height':first['gtk_cursor'][3],'caret_parity':first['gtk_cursor'][3]%2,'font_size_pango':first['font_size_pango'],'adjustment':first['vadjustment'],'window_y':first['window_xy'][1]}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('log',type=pathlib.Path);p.add_argument('--case',required=True);args=p.parse_args()
    rows=[json.loads(x) for x in args.log.read_text().splitlines() if x.strip()];rows=[x for x in rows if x['case'].strip()==args.case]
    print(json.dumps(analyze(rows),indent=2))
