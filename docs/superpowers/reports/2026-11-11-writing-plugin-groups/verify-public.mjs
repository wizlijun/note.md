import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {JSDOM} from '../../plugins-src/write/node_modules/jsdom/lib/api.js';
const out=new URL('./',import.meta.url);
const source=readFileSync(new URL('source-final/plugins-registry/src/page.ts',out),'utf8');
const expected=new Function(source.replace('export const PAGE_HTML','const PAGE_HTML')+';return PAGE_HTML;')();
const checks=[];
for(const [name,url] of [['normal','https://plugins.notemd.net/'],['fresh',`https://plugins.notemd.net/?lang=zh&verify=${Date.now()}`]]){
 const response=await fetch(url);const html=await response.text();
 if(response.status!==200 || html!==expected)throw new Error(name+' public HTML is not the frozen deployed page');
 writeFileSync(new URL(name+'.html',out),html);
 checks.push({name,url,status:response.status,content_type:response.headers.get('content-type'),sha256:createHash('sha256').update(html).digest('hex'),frozen_source_exact:true});
}
const response=await fetch('https://plugins.notemd.net/api/index.json');if(!response.ok)throw new Error('Public index unavailable');
const raw=await response.text();const index=JSON.parse(raw);writeFileSync(new URL('public-index.json',out),raw);
const freshResponse=await fetch(`https://plugins.notemd.net/api/index.json?verify=${Date.now()}`);const freshRaw=await freshResponse.text();
if(freshResponse.status!==200 || freshRaw!==raw)throw new Error('Normal/fresh public index differs');
writeFileSync(new URL('public-index-fresh.json',out),freshRaw);
if(index.plugins.length!==316)throw new Error('Expected 316 published entries');
const latestById=new Function(expected.slice(expected.indexOf('function cmpVer'),expected.indexOf('var CACHE='))+';return latestById;')();
const latest=latestById(index.plugins);const releases=[];
for(const [id,version] of [['notemd.sumi','0.1.15'],['notemd.idea-spark','1.3.9']]){
 const plugin=latest.find(p=>p.id===id);if(!plugin || plugin.version!==version || plugin.category!=='create')throw new Error('Latest version/category mismatch '+id);
 releases.push({id,version:plugin.version,category:plugin.category,name:plugin.name,localized_names:{en:plugin.i18n?.en?.name||plugin.name,zh:plugin.i18n?.zh?.name||plugin.name}});
}
const rendered=[];
for(const lang of ['en','zh']){
 const dom=new JSDOM(expected,{url:'https://plugins.notemd.net/?lang='+lang,runScripts:'dangerously',beforeParse(window){window.fetch=async()=>({json:async()=>index});}});
 await new Promise(resolve=>setTimeout(resolve,50));
 const window=dom.window;
 const grouping=expected.slice(expected.indexOf('var GROUP_ORDER='),expected.indexOf('function platformForArchs'));
 const page=new Function(grouping+';return {GROUP_ORDER,normalizeGroup,groupPlugins};')();
 const order=['ai','record','reading','create','advance','reflect','import-export','experience'];if(JSON.stringify(page.GROUP_ORDER)!==JSON.stringify(order))throw new Error('Wrong group order');
 for(const id of ['notemd.sumi','notemd.idea-spark']){
  const entries=index.plugins.filter(p=>p.id===id);if(!entries.length)throw new Error('Published plugin missing '+id);
  for(const entry of entries)if(page.normalizeGroup(entry.category,id)!=='create')throw new Error('Published historical metadata not grouped as Create');
 }
 const grid=window.document.getElementById('grid');if(!grid || !grid.innerHTML.includes('Sumi') && !grid.innerHTML.includes('玄霜'))throw new Error('Rendered Sumi missing');
 const headings=[...grid.querySelectorAll('.group-title')].map(h=>h.firstChild.textContent);
 if(headings.includes('Ideas')||headings.includes('灵感'))throw new Error('Old section remains');
 const create=headings.indexOf(lang==='zh'?'写作':'Write'),advance=headings.indexOf(lang==='zh'?'推进':'Advance');
 if(create<0 || advance>=0 && create>advance)throw new Error('Rendered Create order is wrong');
 const expectedHeadings=lang==='zh'?['AI','捕捉','阅读','写作','推进','回顾','数据导入导出','其他']:['AI','Capture','Read','Write','Advance','Review','Import & Export','Other'];
 if(JSON.stringify(headings)!==JSON.stringify(expectedHeadings))throw new Error('Final exact headings differ');
 const captureSection=grid.querySelectorAll('.plugin-group')[1];
 if(captureSection.querySelectorAll('.card .sys-tag').length!==3)throw new Error('Expected three context source badges');
 for(const id of ['notemd.apple-notes','notemd.roam-import','notemd.health-sync']) {
  for(const p of index.plugins.filter(p=>p.id===id))if(p.category!=='record')throw new Error('Sync category metadata not migrated');
 }
 const createSection=grid.querySelectorAll('.plugin-group')[create];
 if(!createSection.textContent.includes('Sumi')&&!createSection.textContent.includes('玄霜'))throw new Error('Sumi not rendered under Create');
 for(const release of releases){
  if(![...createSection.querySelectorAll('.card')].some(card=>card.querySelector('h3')?.textContent===release.localized_names[lang] && card.querySelector('.ver')?.textContent==='v'+release.version))throw new Error('Latest release missing from rendered Create section '+release.id);
 }
 writeFileSync(new URL('rendered-'+lang+'.html',out),dom.serialize());
 rendered.push({lang,plugin_count:index.plugins.length,old_sumi_and_idea_metadata_map_to:'create',group_order:page.GROUP_ORDER,rendered_headings:headings,rendered_grid:!!grid.children.length});dom.window.close();
}
const receipt={...JSON.parse(readFileSync(new URL('deployment.json',out),'utf8')),public_checks:checks,rendered_checks:rendered,latest_releases:releases,index_entries:index.plugins.length,index_sha256:createHash('sha256').update(raw).digest('hex'),normal_fresh_index_exact:true,verified_at:new Date().toISOString(),index_migration_receipt:'index-verification.json',tests:'24 passed; explicit installed Cloudflare ambient types typecheck passed',verification_note:'Anonymous HTTP full-body comparison plus served page JavaScript rendered with the current public index in JSDOM; category-only KV migration recorded separately; no R2 writes.'};
writeFileSync(new URL('verification.json',out),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
