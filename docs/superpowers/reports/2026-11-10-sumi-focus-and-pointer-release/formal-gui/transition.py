import pathlib,time,subprocess,json,sys
r=pathlib.Path(__file__).resolve().parent;frames=r/'evidence/frames';case=sys.argv[1];marker=frames/'case.txt';events=[]
def event(name):events.append({'name':name,'monotonic_us':time.monotonic_ns()//1000})
marker.write_text(case);event('F11_before');subprocess.run([str(r.parent/'plugin-window-release/input-tools/keyboard'),'F11'],check=True);event('F11_tool_returned')
time.sleep(4);event('observation_end');(r/'evidence'/(case+'-events.json')).write_text(json.dumps(events,indent=2)+'\n')
rows=[json.loads(x) for x in (frames/('frames-'+case+'.jsonl')).read_text().splitlines()];last=None
for j in rows:
 key=(j['view_allocation'][2:],j['font_size_pango'],j['outer_allocation'][2:],j['vadjustment']['value'],j['window_xy'][1])
 if key!=last:print(round((j['monotonic_us']-events[0]['monotonic_us'])/1e6,3),key);last=key
