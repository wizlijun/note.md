from pathlib import Path
import subprocess,os,json,hashlib,shutil
r=Path('/Users/bruce/Faitc5-Releases/0.5.0.14');repo=Path('/Users/bruce/git/fcitx5-macos-sumi');candidate=r/'candidate';source=json.loads((r/'source-audit.json').read_text())['source_commit']
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def run(args, log):
 result=subprocess.run(args,capture_output=True,text=True)
 (r/log).write_text(result.stdout+result.stderr)
 if result.returncode:raise SystemExit('Command failed; see '+log)
 return result.stdout
archive=r/'Faitc5-0.5.0.14-app.zip';app=candidate/'root/Library/Input Methods/Fcitx5.app'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==source
run(['ditto','-c','-k','--keepParent',str(app),str(archive)],'archive.log')
auth=['--apple-id',os.environ['APPLE_ID'],'--password',os.environ['APPLE_PASSWORD'],'--team-id',os.environ['APPLE_TEAM_ID']]
state=json.loads(run(['xcrun','notarytool','submit',str(archive),*auth,'--wait','--output-format','json'],'notary-submit.log'))
state.update(source_commit=source,version='0.5.0.14',archive_sha256=sha(archive));(r/'notary-state.json').write_text(json.dumps(state,indent=2)+'\n')
if state.get('status')!='Accepted':raise SystemExit('Apple has not accepted the App; no final package produced')
run(['xcrun','notarytool','log',state['id'],*auth,str(r/'apple-notary-log.json')],'notary-log-fetch.log')
tickets=json.loads((r/'apple-notary-log.json').read_text());assert tickets['status']=='Accepted' and tickets['sha256']==sha(archive)
signing=json.loads((candidate/'developer-id/signing-receipt.json').read_text());coverage={(x['cdhash'],x['arch']) for x in tickets['ticketContents']}
assert all((v['cdhash'],'arm64') in coverage for v in signing['machos'].values())
shutil.copytree(candidate/'root',r/'root',symlinks=True);finalapp=r/'root/Library/Input Methods/Fcitx5.app'
run(['xcrun','stapler','staple',str(finalapp)],'final-staple.log')
run(['pkgbuild','--root',str(r/'root'),'--component-plist',str(candidate/'components.plist'),'--scripts',str(candidate/'installer-scripts'),'--identifier','org.fcitx.Fcitx5.sumi.local','--version','0.5.0.14','--install-location','/',str(r/'Fcitx5-Sumi-component.pkg')],'final-component.log')
package=r/'Faitc5-for-Sumi-0.5.0.14-arm64.pkg'
run(['productbuild','--distribution',str(repo/'scripts/sumi-package/Distribution.xml'),'--resources',str(repo/'scripts/sumi-package/resources'),'--package-path',str(r),str(package)],'final-product.log')
run(['pkgutil','--expand-full',str(package),str(r/'expanded')],'final-expand.log')
print(json.dumps({'status':'Accepted','source_commit':source,'submission_id':state['id'],'package':str(package),'sha256':sha(package)}))
