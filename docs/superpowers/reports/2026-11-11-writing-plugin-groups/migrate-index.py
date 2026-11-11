"""Category-only metadata update; no immutable package/R2 changes."""
from pathlib import Path
import importlib.util,json,copy,sys,time
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('existing',HERE.parent/'creation-plugin-release-20261111/publish-plugin.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);p.HERE=HERE
SYNC={'notemd.apple-notes','notemd.roam-import','notemd.health-sync'}
def migrate(before):
 after=copy.deepcopy(before);changes=[]
 for row in after['plugins']:
  old=row.get('category');new='record' if row['id'] in SYNC else 'experience' if old=='other' else old
  if new!=old:
   changes.append({'id':row['id'],'version':row['version'],'before':old,'after':new});row['category']=new
 assert len(before['plugins'])==len(after['plugins'])
 for a,b in zip(before['plugins'],after['plugins']):
  assert {k:v for k,v in a.items() if k!='category'}=={k:v for k,v in b.items() if k!='category'}
 return after,changes
if __name__=='__main__':
 mode=sys.argv[1]
 if mode=='check':
  sample={'plugins':[{'id':'notemd.apple-notes','version':'1','category':'import-export','sha256':{'x':'h'}},{'id':'x','version':'1','category':'other'},{'id':'y','version':'1','category':'create'}]}
  a,c=migrate(sample);assert len(c)==2 and sample['plugins'][0]['category']=='import-export' and a['plugins'][2]==sample['plugins'][2]
  assert migrate(a)[1]==[]
  print('PASS category-only scope, input immutable, unknown unaffected, idempotent');sys.exit()
 assert mode=='publish'
 before=p.read_kv('index-before.json');after,changes=migrate(before);p.save('index-candidate.json',after)
 for name,url in [('normal',p.INDEX),('fresh',p.fresh(p.INDEX))]:
  path=HERE/f'index-before-public-{name}.json';assert p.fetch(url,path)==200;assert json.loads(path.read_text())==before
 assert changes,'No migration needed; inspect previous receipt rather than rewrite'
 assert p.read_kv('index-prewrite.json')==before,'Concurrent KV change; abort'
 result=p.wrangler(['kv:key','put','index','--binding','INDEX','--path',str(HERE/'index-candidate.json')],log='index-write.log')
 # Read back even after transport failures; never assume nonzero means no write.
 final=p.read_kv('index-final.json');assert final==after,f'KV differs; write exit {result.returncode}'
 for name,url in [('normal',p.INDEX),('fresh',p.fresh(p.INDEX))]:
  path=HERE/f'index-public-{name}.json';assert p.fetch(url,path)==200;assert json.loads(path.read_text())==after
 p.save('index-verification.json',{'entries':len(after['plugins']),'changes':changes,'changed_count':len(changes),'only_category_changed':True,'package_fields_unchanged':True,'kv_prewrite_equals_initial':True,'kv_and_normal_fresh_public_equal':True,'r2_writes':False,'write_exit':result.returncode,'verified_at':time.time()})
 print(json.dumps({'entries':len(after['plugins']),'changed_count':len(changes),'verified':True}))
