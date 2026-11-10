import json,pathlib,hashlib
R=pathlib.Path(__file__).resolve().parent;E=R/'evidence'
def snap(name):return json.loads((E/(name+'.json')).read_text())
def windows(name):
 result={}
 def w(n):
  if n.get('app_id'):result[n['name']]=n
  for c in n.get('nodes',[])+n.get('floating_nodes',[]):w(c)
 w(snap(name)['tree']);return result
def dom(name,label):
 for p in (E/(name+'-observer')).glob('dom-*'):
  j=json.loads(p.read_text())
  if j['window']['label']==label:return j
 raise AssertionError((name,label))
for area in ['body','panel']:
 for cycle in [1,2]:
  for state,full in [('fullscreen',True),('restored',False)]:
   n=f'sumi-{area}-{state}-{cycle}';w=windows(n)['Sumi Typewriter'];d=dom(n,'plugin-notemd-sumi-main')
   assert w['fullscreen_mode']==int(full);assert d['dataset']['fullscreen']==str(full).lower()
   assert (d['innerWidth'],d['innerHeight'])==((1920,1200) if full else (960,720))
   b=next(c for c in d['controls'] if c['id']=='fullscreen');assert b['pressed']==str(full).lower();assert ('Exit' if full else 'Enter') in b['title']
   if area=='panel':assert 'Appearance' in d['body']
   if full:
    tools=next(c for c in d['controls'] if c['id']=='tools');assert tools['rect']['top']==0
for name,title in [('low-next','Next'),('low-sumi','Sumi Typewriter'),('low-idea','Idea Spark'),('scale3-next','Next'),('scale3-sumi','Sumi Typewriter'),('scale3-idea','Idea Spark')]:
 w=windows(name)[title]['rect'];out=next(o for o in snap(name)['outputs'] if o['active'])['rect'];assert w['y']>=0 and w['y']+w['height']<=out['height'];assert abs(w['x']+w['width']/2-out['width']/2)<=1 and abs(w['y']+w['height']/2-out['height']/2)<=1
assert windows('next-focused-ctrl-w').keys()=={'untitled.md — note.md'}
assert windows('idea-ctrl-w').keys()=={'untitled.md — note.md'}
for n in ['next-ctrl-s','next-after-rebuild-ctrl-n-s','idea-single-save']:
 assert dom(n,'main')['body'].strip().endswith('sentinel')
assert 'New Idea' in dom('next-after-rebuild-ctrl-n-s','plugin-notemd-next-main')['body']
assert (E/'idea-save-events.log').read_text().splitlines()==['CLOSE_WRITE,CLOSE 2026-11-10-1719-idea.md']
assert windows('scale3-sumi-fullscreen')['Sumi Typewriter']['fullscreen_mode']==1
assert windows('scale3-panel-restored')['Sumi Typewriter']['fullscreen_mode']==0
assert 'Appearance' in dom('scale3-panel-fullscreen','plugin-notemd-sumi-main')['body']
for before,after,title in [('next-initial','next-title-drag','Next'),('scale3-idea','scale3-idea-drag','Idea Spark'),('scale3-sumi','scale3-sumi-drag','Sumi Typewriter')]:
 a=windows(before)[title]['rect'];b=windows(after)[title]['rect'];assert (a['x'],a['y'])!=(b['x'],b['y']);assert(a['width'],a['height'])==(b['width'],b['height'])
print('Core formal GUI assertions passed: F11 8 transitions, 3-window centering/low-height/scale3, 3-title drag, menu isolation, Idea one write, top toolbar')

for name,title,before in [('next-resize-confirmed','Next',807),('idea-resize-confirmed','Idea Spark',687)]:
 r=windows(name)[title]['rect'];assert r['height']==before-53
r=windows('sumi-real-resize')['Sumi Typewriter']['rect'];assert (r['width'],r['height'])==(1065,515)
assert not (R/'fixture/ready.json').exists() and not (R/'old-client-fixture/ready.json').exists()
print('All three real edge resize and private fixture cleanup confirmed')
